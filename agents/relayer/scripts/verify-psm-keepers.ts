/**
 * Verification harness for the PSM keepers and watchers, no network.
 *
 * Every RPC call goes to a mock that answers `eth_call` by (contract, selector) from a scripted
 * chain state, so the keepers run for real: real viem clients, real ABI encoding and decoding,
 * real `submit` (simulate, then sign and send) and the real shared queue with its nonce.
 *
 * Covers: the drain keeper's head classification, its drain(1) fallback and retirement alerts, the
 * flush keeper's budget, revert handling and pointers, the watchers' alerts, the alerter's dedup,
 * the parked-delivery middleware, the loop helper, and the queue's crash paths.
 *
 * Run with: pnpm --filter @whm/relayer verify:psm-keepers
 */
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  http,
  keccak256,
  parseTransaction,
  toFunctionSelector,
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { base, hydration, WORMHOLE } from "../src/chains";
import { optWhole } from "../src/config";
import type { ChainClients } from "../src/engine/hydration";
import { every } from "../src/engine/loop";
import { createAlerter, notifyDiscord, type Alerter } from "../src/engine/notify";
import { parkedAlert } from "../src/engine/parked";
import { createQueue } from "../src/engine/queue";
import logger from "../src/logger";
import { erc20Abi, facilitatorKeeperAbi, ghoAbi, receiverAbi, vaultKeeperAbi, wormholeCoreAbi } from "../src/apps/psm/abi";
import { wireRoutes } from "../src/apps/psm/app";
import type { PsmRoute } from "../src/apps/psm/routes";
import {
  BOOKS_STALL_MS,
  FLUSH_MAX_PER_TICK,
  KEEPER_TX_STUCK_MS,
  LIQUIDITY_STALL_MS,
  LOG_OVERLAP_BLOCKS,
  psmWebhook,
  rpcBase,
} from "../src/apps/psm/config";
import type { KeeperCtx } from "../src/apps/psm/keepers/common";
import { drainTick, type DrainState } from "../src/apps/psm/keepers/drain";
import { flushState, flushTick, type FlushTarget } from "../src/apps/psm/keepers/flush";
import { keeperLoop } from "../src/apps/psm/keepers/index";
import { baseWatch, baseWatchTick, hydrationWatch, hydrationWatchTick } from "../src/apps/psm/keepers/watch";
import type { RelayerApp, RelayerCtx } from "../src/types";

const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const VAULT = "0x1111111111111111111111111111111111111111" as Address;
const FACILITATOR = "0x2222222222222222222222222222222222222222" as Address;
const HOLLAR = "0x3333333333333333333333333333333333333333" as Address;
const USDC = "0x4444444444444444444444444444444444444444" as Address;
const AUSDC = "0x5555555555555555555555555555555555555555" as Address;
const CORE = "0x6666666666666666666666666666666666666666" as Address;
const ALICE = "0xa11ce00000000000000000000000000000000001" as Address;
const BOB = "0xb0b0000000000000000000000000000000000002" as Address;
const SCALE = 10n ** 12n;
const UNLIMITED = (1n << 256n) - 1n;
const DAY = 86_400n;

let failed = false;
function record(ok: boolean, label: string, detail?: unknown) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log("   ", detail);
    failed = true;
  }
}

// ─── RPC mock ────────────────────────────────────────────────────────────────────

type Answer = { result: Hex } | { revert: Hex } | { error: { code: number; message: string; data?: Hex } };
type CallHandler = (data: Hex, from: Address | undefined) => Answer;

interface MockLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

interface Mock {
  chainId: number;
  calls: Map<string, CallHandler>;
  blockNumber: bigint;
  nonce: number;
  /** Logs the next mined transaction's receipt carries. */
  nextLogs: MockLog[];
  /** Hashes with a receipt; anything else is pending. */
  mined: Map<Hex, MockLog[]>;
  /** Hashes whose nonce another transaction took: no receipt, and no longer pending. */
  replaced: Set<Hex>;
  /** Runs on every eth_getTransactionCount, before it answers. */
  onNonceRead?: () => void;
  /** When set, receipts are withheld (the transaction stays pending). */
  withhold: boolean;
  rawTxs: Hex[];
  getLogs: () => MockLog[] | Error;
  failBalance: boolean;
  failNonce: boolean;
  /** When set, eth_getTransactionReceipt fails with an RPC error (not "not found"). */
  receiptError: boolean;
  methods: string[];
  /** Every eth_call: target, selector, and the block it was asked at. */
  callLog: { to: string; selector: string; block: unknown }[];
  /** Every eth_getLogs range. */
  logRanges: { from: bigint; to: bigint }[];
}

function key(to: Address, selector: Hex) {
  return `${to.toLowerCase()}:${selector.toLowerCase()}`;
}

function newMock(chainId: number): Mock {
  return {
    chainId,
    calls: new Map(),
    blockNumber: 100n,
    nonce: 0,
    nextLogs: [],
    mined: new Map(),
    replaced: new Set(),
    withhold: false,
    rawTxs: [],
    getLogs: () => [],
    failBalance: false,
    failNonce: false,
    receiptError: false,
    methods: [],
    callLog: [],
    logRanges: [],
  };
}

let mock = newMock(base.id);

/** Route `functionName` on `to` to a handler returning the decoded result, or throwing to revert. */
function on(to: Address, abi: Abi, functionName: string, fn: (args: readonly unknown[], from?: Address) => unknown) {
  const item = (abi as readonly { type: string; name?: string }[]).find((i) => i.type === "function" && i.name === functionName)!;
  const selector = toFunctionSelector(item as never);
  mock.calls.set(key(to, selector), (data, from) => {
    const { args } = decodeFunctionData({ abi, data });
    try {
      const out = fn(args ?? [], from);
      return { result: encodeFunctionResult({ abi, functionName, result: out } as never) };
    } catch (e) {
      if (e instanceof Revert) return { revert: e.data };
      throw e;
    }
  });
}

class Revert extends Error {
  constructor(public data: Hex) {
    super("revert");
  }
}

function revert(abi: Abi, errorName: string, args: readonly unknown[] = []): never {
  throw new Revert(encodeErrorResult({ abi, errorName, args } as never));
}

function selectorOf(abi: Abi, functionName: string): string {
  const item = (abi as readonly { type: string; name?: string }[]).find((i) => i.type === "function" && i.name === functionName)!;
  return toFunctionSelector(item as never).toLowerCase();
}

/** Route `functionName` on `to` to a raw node error, as the RPC would send it. */
function fault(to: Address, abi: Abi, functionName: string, error: { code: number; message: string; data?: Hex }) {
  mock.calls.set(key(to, selectorOf(abi, functionName) as Hex), () => ({ error }));
}

function rpc(id: number, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

function answer(req: { id: number; method: string; params?: unknown[] }) {
  const { id, method, params } = req;
  mock.methods.push(method);
  switch (method) {
    case "eth_chainId":
      return rpc(id, `0x${mock.chainId.toString(16)}`);
    case "eth_blockNumber":
      return rpc(id, `0x${mock.blockNumber.toString(16)}`);
    case "eth_call": {
      const [tx, block] = params as [{ to: Address; data: Hex; from?: Address }, unknown];
      mock.callLog.push({ to: tx.to.toLowerCase(), selector: tx.data.slice(0, 10).toLowerCase(), block });
      const handler = mock.calls.get(key(tx.to, tx.data.slice(0, 10) as Hex));
      if (!handler) return { jsonrpc: "2.0" as const, id, error: { code: -32000, message: `mock: no route ${tx.to} ${tx.data.slice(0, 10)}` } };
      const a = handler(tx.data, tx.from);
      if ("error" in a) return { jsonrpc: "2.0" as const, id, error: a.error };
      return "revert" in a
        ? { jsonrpc: "2.0" as const, id, error: { code: 3, message: "execution reverted", data: a.revert } }
        : rpc(id, a.result);
    }
    case "eth_estimateGas":
      return rpc(id, "0x30d40");
    case "eth_getBlockByNumber":
      return rpc(id, { number: `0x${mock.blockNumber.toString(16)}`, baseFeePerGas: undefined });
    case "eth_gasPrice":
      return rpc(id, "0x12a05f200");
    case "eth_getBalance":
      if (mock.failBalance) return { jsonrpc: "2.0" as const, id, error: { code: -32000, message: "mock: balance down" } };
      return rpc(id, `0x${(10n ** 18n).toString(16)}`);
    case "eth_getTransactionCount": {
      if (mock.failNonce) return { jsonrpc: "2.0" as const, id, error: { code: -32000, message: "mock: nonce down" } };
      mock.onNonceRead?.();
      // `latest` counts mined transactions only, as a node does: one still pending is left out.
      const pending =
        (params as [Address, string?])[1] === "pending"
          ? 0
          : mock.rawTxs.map((raw) => keccak256(raw)).filter((h) => !mock.mined.has(h) && !mock.replaced.has(h)).length;
      return rpc(id, `0x${(mock.nonce - pending).toString(16)}`);
    }
    case "eth_maxPriorityFeePerGas":
      return { jsonrpc: "2.0" as const, id, error: { code: -32601, message: "Method not found" } };
    case "eth_sendRawTransaction": {
      const raw = (params as [Hex])[0];
      mock.rawTxs.push(raw);
      const hash = keccak256(raw);
      if (!mock.withhold) mock.mined.set(hash, mock.nextLogs);
      mock.nextLogs = [];
      mock.nonce += 1;
      return rpc(id, hash);
    }
    case "eth_getTransactionReceipt": {
      const hash = (params as [Hex])[0];
      if (mock.receiptError) return { jsonrpc: "2.0" as const, id, error: { code: -32603, message: "mock: receipt backend down" } };
      const logs = mock.mined.get(hash);
      if (!logs) return rpc(id, null);
      return rpc(id, {
        blockHash: `0x${"ab".repeat(32)}`,
        blockNumber: `0x${mock.blockNumber.toString(16)}`,
        contractAddress: null,
        cumulativeGasUsed: "0x5208",
        effectiveGasPrice: "0x12a05f200",
        from: `0x${"11".repeat(20)}`,
        gasUsed: "0x5208",
        logs: logs.map((l, i) => ({
          ...l,
          blockHash: `0x${"ab".repeat(32)}`,
          blockNumber: `0x${mock.blockNumber.toString(16)}`,
          transactionHash: hash,
          transactionIndex: "0x0",
          logIndex: `0x${i.toString(16)}`,
          removed: false,
        })),
        logsBloom: `0x${"00".repeat(256)}`,
        status: "0x1",
        to: `0x${"22".repeat(20)}`,
        transactionHash: hash,
        transactionIndex: "0x0",
        type: "0x0",
      });
    }
    case "eth_getLogs": {
      const [filter] = params as [{ fromBlock: Hex; toBlock: Hex }];
      mock.logRanges.push({ from: BigInt(filter.fromBlock), to: BigInt(filter.toBlock) });
      const out = mock.getLogs();
      if (out instanceof Error) return { jsonrpc: "2.0" as const, id, error: { code: -32011, message: out.message } };
      return rpc(
        id,
        out.map((l, i) => ({
          ...l,
          blockHash: `0x${"cd".repeat(32)}`,
          blockNumber: `0x${mock.blockNumber.toString(16)}`,
          transactionHash: `0x${"ef".repeat(32)}`,
          transactionIndex: "0x0",
          logIndex: `0x${i.toString(16)}`,
          removed: false,
        })),
      );
    }
    default:
      return { jsonrpc: "2.0" as const, id, error: { code: -32601, message: `mock: unhandled ${method}` } };
  }
}

const posts: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).startsWith("https://discord.invalid")) {
    posts.push({ url: String(url), body: String(init?.body) });
    return new Response(null, { status: String(url).endsWith("/429") ? 429 : 204 });
  }
  const body = JSON.parse((init?.body as string) ?? "{}");
  const payload = Array.isArray(body) ? body.map(answer) : answer(body);
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

function clientsFor(chain: Chain): ChainClients {
  const account = privateKeyToAccount(TEST_KEY);
  const transport = http("http://mock-rpc.invalid", { retryCount: 0 });
  // No block-number cache: the scenarios move the chain between ticks faster than any cache window.
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 10, cacheTime: 0 }) as unknown as PublicClient<Transport, Chain>;
  const wallet = createWalletClient({ account, chain, transport, pollingInterval: 10 }) as unknown as WalletClient<Transport, Chain, Account>;
  return { account, publicClient, wallet };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────────

interface Alerts {
  alerter: Alerter;
  raised: { key: string; state: string; message: string }[];
  keys(): string[];
}

function captureAlerts(): Alerts {
  const raised: Alerts["raised"] = [];
  const inner = createAlerter({ repeatMs: 3_600_000, post: async () => true, log: { warn: () => logger } as never });
  return {
    raised,
    keys: () => raised.map((r) => r.key),
    alerter: {
      alert(key, state, message) {
        raised.push({ key, state, message });
        inner.alert(key, state, message);
      },
      clear: (key) => inner.clear(key),
    },
  };
}

async function keeperCtx(chain: Chain, opts: { enabled?: boolean; now?: () => number } = {}) {
  mock = newMock(chain.id);
  const clients = clientsFor(chain);
  const queue = createQueue({ publicClient: clients.publicClient, account: clients.account, warnMultiplier: 1n });
  await queue.init();
  const alerts = captureAlerts();
  const ctx: KeeperCtx = {
    clients,
    queue,
    alerter: alerts.alerter,
    enabled: opts.enabled ?? true,
    log: logger,
    now: opts.now ?? Date.now,
  };
  return { ctx, alerts, queue };
}

function sentGas(): bigint[] {
  return mock.rawTxs.map((raw) => parseTransaction(raw).gas ?? 0n);
}

/** Settles `p`, or resolves "timeout" after `ms`: a check that hangs must fail, not end the run quietly. */
function within<T>(ms: number, p: Promise<T>): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);
}

function sentCalls(abi: Abi): { functionName: string; args: readonly unknown[] }[] {
  return mock.rawTxs.map((raw) => {
    const tx = parseTransaction(raw);
    const { functionName, args } = decodeFunctionData({ abi, data: tx.data! });
    return { functionName, args: args ?? [] };
  });
}

function vaultLog(eventName: "Claimed" | "CreditUnpayable" | "Disputed", args: Record<string, unknown>): MockLog {
  const topics = encodeEventTopics({ abi: vaultKeeperAbi, eventName, args } as never) as Hex[];
  const data =
    eventName === "Claimed"
      ? encodeAbiParameters([{ type: "uint256" }], [args.amount as bigint])
      : eventName === "CreditUnpayable"
        ? encodeAbiParameters([{ type: "uint256" }], [args.amount as bigint])
        : encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [args.amount as bigint, args.principal as bigint]);
  return { address: VAULT, topics, data };
}

interface VaultState {
  claimsPaused: boolean;
  head: [Address, bigint];
  index: bigint;
  headSince: bigint;
  claim: () => void;
  limits: [bigint, bigint, bigint, bigint, bigint, bigint];
  drain: (maxEntries: bigint) => bigint;
}

function vault(s: VaultState) {
  on(VAULT, vaultKeeperAbi, "claimsPaused", () => s.claimsPaused);
  on(VAULT, vaultKeeperAbi, "queueHeadEntry", () => s.head);
  on(VAULT, vaultKeeperAbi, "queueHead", () => s.index);
  on(VAULT, vaultKeeperAbi, "headSince", () => s.headSince);
  on(VAULT, vaultKeeperAbi, "claim", () => s.claim());
  on(VAULT, vaultKeeperAbi, "limits", () => s.limits);
  on(VAULT, vaultKeeperAbi, "drain", ([n]) => s.drain(n as bigint));
}

function payableVault(over: Partial<VaultState> = {}): VaultState {
  return {
    claimsPaused: false,
    head: [ALICE, 100_000_000n],
    index: 7n,
    headSince: BigInt(Math.floor(Date.now() / 1000)),
    claim: () => {},
    limits: [10_000_000_000n, DAY, 10_000_000_000n, 10_000_000_000n, DAY, 10_000_000_000n],
    drain: () => 100_000_000n,
    ...over,
  };
}

const vErr = (name: string, args: readonly unknown[] = []) => () => revert(vaultKeeperAbi, name, args);

// ─── Drain keeper ────────────────────────────────────────────────────────────────

async function drainChecks() {
  {
    const { ctx } = await keeperCtx(base);
    vault(payableVault({ claimsPaused: true }));
    const out = await drainTick(ctx, VAULT, {});
    record(out.kind === "paused" && mock.rawTxs.length === 0, "drain: claims paused → nothing sent", out);
  }
  {
    const { ctx } = await keeperCtx(base);
    vault(payableVault({ head: ["0x0000000000000000000000000000000000000000", 0n] }));
    const out = await drainTick(ctx, VAULT, {});
    record(out.kind === "empty" && mock.rawTxs.length === 0, "drain: empty queue → nothing sent", out);
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault());
    mock.nextLogs = [
      vaultLog("Claimed", { recipient: ALICE, amount: 99_950_000n }),
      vaultLog("Claimed", { recipient: BOB, amount: 49_975_000n }),
    ];
    const out = await drainTick(ctx, VAULT, {});
    const calls = sentCalls(vaultKeeperAbi);
    record(
      out.kind === "sent" && out.maxEntries === 10n && out.settled === 2 && out.paid === 149_925_000n,
      "drain: payable head → drain(10) sent, receipt counted (2 paid, 149.925 USDC)",
      out,
    );
    record(calls.length === 1 && calls[0].functionName === "drain" && calls[0].args[0] === 10n, "drain: the signed transaction is drain(10) to the vault", calls);
    record(
      sentGas()[0] === 3_600_000n,
      "drain: drain(10) carries the full-batch gas floor (100k + 10 × 350k), above estimate + 20%",
      sentGas(),
    );
    record(alerts.raised.length === 0, "drain: a clean drain raises no alert", alerts.raised);
  }
  {
    const { ctx } = await keeperCtx(base);
    vault(payableVault());
    mock.receiptError = true;
    const state: DrainState = {};
    const out = await drainTick(ctx, VAULT, state);
    record(
      out.kind === "sent" && mock.rawTxs.length === 1 && state.inflight?.hash === keccak256(mock.rawTxs[0]),
      "drain: a receipt wait that fails after the broadcast leaves the transaction in flight, not forgotten",
      { out, inflight: state.inflight },
    );
    mock.receiptError = false;
    mock.mined.set(state.inflight!.hash, []);
    const next = await drainTick(ctx, VAULT, state);
    record(state.inflight === undefined && next.kind === "sent" && mock.rawTxs.length === 2, "drain: once it is seen mined, the next tick goes on", next);
  }
  {
    const { ctx } = await keeperCtx(base);
    let from: Address | undefined;
    vault(payableVault());
    on(VAULT, vaultKeeperAbi, "claim", (_args, f) => {
      from = f;
    });
    await drainTick(ctx, VAULT, {});
    record(from?.toLowerCase() === ALICE.toLowerCase(), "drain: claim() is simulated from the head's own address", from);
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault({ claim: vErr("RecipientUnpayable", [ALICE]) }));
    mock.nextLogs = [vaultLog("CreditUnpayable", { index: 7n, recipient: ALICE, amount: 99_950_000n })];
    const out = await drainTick(ctx, VAULT, {});
    record(
      out.kind === "sent" && out.retired === 1 && mock.rawTxs.length === 1,
      "drain: blacklisted head (RecipientUnpayable) is drained, the retirement counted",
      out,
    );
    record(
      alerts.keys().includes("psm:head-blacklisted:7") && alerts.keys().includes("psm:retired:7"),
      "drain: blacklisted head and its retirement are both alerted",
      alerts.keys(),
    );
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault({ claim: vErr("InsufficientLiquidity", [100_000_000n, 5_000_000n]) }));
    const out = await drainTick(ctx, VAULT, {});
    record(out.kind === "held" && out.reason === "InsufficientLiquidity" && mock.rawTxs.length === 0, "drain: head held by liquidity → nothing sent", out);
    record(alerts.raised.length === 0, "drain: a fresh liquidity hold raises no alert", alerts.raised);
  }
  {
    const old = BigInt(Math.floor((Date.now() - LIQUIDITY_STALL_MS - 60_000) / 1000));
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault({ headSince: old, claim: vErr("InsufficientLiquidity", [100_000_000n, 5_000_000n]) }));
    await drainTick(ctx, VAULT, {});
    record(alerts.keys().includes("psm:head-liquidity:7"), "drain: a liquidity hold past LIQUIDITY_STALL_MS is alerted", alerts.keys());
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(
      payableVault({
        claim: vErr("InsufficientPayoutAllowance", [100_000_000n, 0n]),
        limits: [10_000_000_000n, DAY, 10_000_000_000n, 0n, 0n, 0n],
      }),
    );
    let threw: unknown;
    try {
      await drainTick(ctx, VAULT, {});
    } catch (e) {
      threw = e;
    }
    record(threw === undefined && alerts.keys().includes("psm:payout-closed"), "drain: payout capacity 0 → 'payout closed' alert, no division", threw ?? alerts.keys());
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(
      payableVault({
        head: [ALICE, 20_000_000_000n],
        claim: vErr("InsufficientPayoutAllowance", [20_000_000_000n, 10_000_000_000n]),
      }),
    );
    await drainTick(ctx, VAULT, {});
    record(alerts.keys().includes("psm:head-above-capacity:7"), "drain: head above the payout capacity → 'never payable' alert", alerts.keys());
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(
      payableVault({
        claim: vErr("InsufficientPayoutAllowance", [100_000_000n, 40_000_000n]),
        limits: [10_000_000_000n, DAY, 10_000_000_000n, 10_000_000_000n, DAY, 40_000_000n],
      }),
    );
    const out = await drainTick(ctx, VAULT, {});
    record(out.kind === "held" && alerts.raised.length === 0 && mock.rawTxs.length === 0, "drain: head waiting on the allowance → held, no alert", out);
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault({ claim: vErr("PayoutFailed", [ALICE]) }));
    const out = await drainTick(ctx, VAULT, {});
    record(
      out.kind === "held" && alerts.keys().includes("psm:head-unpayable:7") && mock.rawTxs.length === 0,
      "drain: PayoutFailed on claim → alerted, nothing sent",
      out,
    );
  }
  {
    const { ctx } = await keeperCtx(base);
    vault(
      payableVault({
        drain: (n) => (n === 10n ? revert(vaultKeeperAbi, "PayoutFailed", [BOB]) : 100_000_000n),
      }),
    );
    const out = await drainTick(ctx, VAULT, {});
    const calls = sentCalls(vaultKeeperAbi);
    record(
      out.kind === "sent" && out.maxEntries === 1n && calls.length === 1 && calls[0].args[0] === 1n,
      "drain: drain(10) reverting falls back to drain(1), which is what gets signed",
      { out, calls },
    );
    record(sentGas()[0] === 450_000n, "drain: drain(1) carries its own floor (100k + 350k)", sentGas());
  }
  {
    const { ctx, alerts, queue } = await keeperCtx(base);
    const nonceBefore = queue.nonce;
    vault(payableVault({ drain: () => revert(vaultKeeperAbi, "PayoutFailed", [BOB]) }));
    const out = await drainTick(ctx, VAULT, {});
    record(
      out.kind === "reverting" && out.reason === "PayoutFailed" && mock.rawTxs.length === 0 && alerts.keys().includes("psm:drain-reverting"),
      "drain: drain(10) and drain(1) both reverting → alerted, nothing sent",
      out,
    );
    record(queue.nonce === nonceBefore, "drain: the reverted simulations spent no nonce", { before: nonceBefore, after: queue.nonce });
  }
  {
    const { ctx, alerts } = await keeperCtx(base, { enabled: false });
    vault(payableVault({ claim: vErr("RecipientUnpayable", [ALICE]) }));
    const out = await drainTick(ctx, VAULT, {});
    record(
      out.kind === "disabled" && mock.rawTxs.length === 0 && alerts.keys().includes("psm:head-blacklisted:7"),
      "drain: PSM_KEEPER=off → nothing sent, alerts still raised",
      out,
    );
  }
  {
    const t0 = Date.now();
    let now = t0;
    const { ctx, alerts } = await keeperCtx(base, { now: () => now });
    vault(payableVault());
    const state: DrainState = { inflight: { hash: `0x${"77".repeat(32)}`, nonce: 0, label: "drain(10)", sentAt: t0 } };
    const first = await drainTick(ctx, VAULT, state);
    now = t0 + KEEPER_TX_STUCK_MS + 1_000;
    const second = await drainTick(ctx, VAULT, state);
    record(
      first.kind === "inflight" && second.kind === "inflight" && mock.rawTxs.length === 0,
      "drain: an unmined keeper transaction blocks further sends",
      { first, second },
    );
    record(
      alerts.keys().filter((k) => k.startsWith("psm:keeper-stuck:")).length === 1,
      "drain: past KEEPER_TX_STUCK_MS the stuck transaction is alerted, once",
      alerts.keys(),
    );
    mock.mined.set(state.inflight!.hash, [vaultLog("Claimed", { recipient: ALICE, amount: 1n })]);
    const third = await drainTick(ctx, VAULT, state);
    record(third.kind === "sent" && state.inflight === undefined, "drain: once it mines, the keeper clears it and goes on", third);
  }
  {
    const { ctx } = await keeperCtx(base);
    vault(payableVault());
    mock.withhold = true;
    const state: DrainState = {};
    // A receipt that never arrives: drive the in-flight path rather than wait out the timeout.
    const hash = `0x${"88".repeat(32)}` as Hex;
    state.inflight = { hash, nonce: 0, label: "drain(10)", sentAt: Date.now() };
    const out = await drainTick(ctx, VAULT, state);
    record(out.kind === "inflight" && state.inflight?.hash === hash, "drain: in flight is carried across ticks", out);
  }
  {
    const t0 = Date.now();
    const { ctx, alerts } = await keeperCtx(base, { now: () => t0 + KEEPER_TX_STUCK_MS + 1_000 });
    vault(payableVault());
    const state: DrainState = { inflight: { hash: `0x${"99".repeat(32)}`, nonce: 0, label: "drain(10)", sentAt: t0 } };
    const stuck = await drainTick(ctx, VAULT, state);
    mock.nonce = 1; // nonce 0 mined, as another transaction
    const out = await drainTick(ctx, VAULT, state);
    record(
      stuck.kind === "inflight" && alerts.keys().some((k) => k.startsWith("psm:keeper-stuck:")) &&
        out.kind === "sent" && mock.rawTxs.length === 1 && state.inflight === undefined,
      "drain: an in-flight transaction whose nonce another took is dropped, and the keeper drains again at once",
      { stuck, out },
    );
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault());
    const hash = `0x${"aa".repeat(32)}` as Hex;
    const state: DrainState = { inflight: { hash, nonce: 0, label: "drain(10)", sentAt: Date.now() } };
    mock.nonce = 1;
    mock.onNonceRead = () => {
      mock.onNonceRead = undefined;
      mock.mined.set(hash, [vaultLog("CreditUnpayable", { index: 3n, recipient: ALICE, amount: 5n })]);
    };
    const out = await drainTick(ctx, VAULT, state);
    record(
      out.kind === "sent" && alerts.keys().includes("psm:retired:3"),
      "drain: a transaction mined between the receipt read and the nonce read is counted as mined, not replaced",
      { out, keys: alerts.keys() },
    );
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault());
    fault(VAULT, vaultKeeperAbi, "claim", { code: -32603, message: "Internal error" });
    const out = await drainTick(ctx, VAULT, {}).then(
      (o) => o,
      (e: Error) => e,
    );
    record(
      out instanceof Error && mock.rawTxs.length === 0 && !alerts.keys().some((k) => k.startsWith("psm:head-")),
      "drain: a -32603 node fault on the head check throws for the loop: no head alert, nothing sent",
      out instanceof Error ? out.message.split("\n")[0] : out,
    );
  }
  {
    const { ctx } = await keeperCtx(base);
    vault(payableVault());
    fault(VAULT, vaultKeeperAbi, "claim", {
      code: -32603,
      message: "VM Exception while processing transaction: revert",
      data: encodeErrorResult({ abi: vaultKeeperAbi, errorName: "InsufficientLiquidity", args: [1n, 0n] } as never),
    });
    const out = await drainTick(ctx, VAULT, {});
    record(
      out.kind === "held" && out.reason === "InsufficientLiquidity",
      "drain: a -32603 carrying revert bytes, as Hydration's node sends a revert, is a named revert",
      out,
    );
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    vault(payableVault({ drain: () => revert(vaultKeeperAbi, "ClaimsPaused") }));
    const out = await drainTick(ctx, VAULT, {});
    record(
      out.kind === "paused" && mock.rawTxs.length === 0 && !alerts.keys().includes("psm:drain-reverting"),
      "drain: claims paused between the head check and the send reads as paused, not as a reverting drain",
      out,
    );
  }
  {
    const { ctx } = await keeperCtx(base);
    const posts: string[] = [];
    ctx.alerter = createAlerter({ repeatMs: 3_600_000, post: async (_w, m) => (posts.push(m), true), log: { warn: () => logger } as never });
    const v = payableVault({
      claim: vErr("InsufficientPayoutAllowance", [100_000_000n, 0n]),
      limits: [10_000_000_000n, DAY, 10_000_000_000n, 0n, DAY, 0n],
    });
    vault(v);
    await drainTick(ctx, VAULT, {});
    v.limits = [10_000_000_000n, DAY, 10_000_000_000n, 10_000_000_000n, DAY, 0n];
    await drainTick(ctx, VAULT, {});
    v.limits = [10_000_000_000n, DAY, 10_000_000_000n, 0n, DAY, 0n];
    await drainTick(ctx, VAULT, {});
    await new Promise((r) => setTimeout(r, 5));
    const closed = posts.filter((m) => m.includes("payout limit is closed")).length;
    record(closed === 2, "drain: a payout limit closed, reopened and closed again within the hour is alerted twice", closed);
  }
  {
    const { ctx } = await keeperCtx(base);
    const posts: string[] = [];
    ctx.alerter = createAlerter({ repeatMs: 3_600_000, post: async (_w, m) => (posts.push(m), true), log: { warn: () => logger } as never });
    let failing = true;
    vault(payableVault({ drain: () => (failing ? revert(vaultKeeperAbi, "PayoutFailed", [ALICE]) : 100_000_000n) }));
    await drainTick(ctx, VAULT, {});
    failing = false;
    await drainTick(ctx, VAULT, {});
    failing = true;
    await drainTick(ctx, VAULT, {});
    await new Promise((r) => setTimeout(r, 5));
    const reverting = posts.filter((m) => m.includes("drain(1) revert")).length;
    record(reverting === 2, "drain: a drain that reverts, recovers and reverts again within the hour is alerted twice", reverting);
  }
}

// ─── Flush keeper ────────────────────────────────────────────────────────────────

interface FacilitatorState {
  mintPaused: boolean;
  entries: bigint[];
  bucket: [bigint, bigint];
  inbound: bigint;
  flush: (id: bigint) => void;
}

function facilitator(s: FacilitatorState) {
  on(FACILITATOR, facilitatorKeeperAbi, "mintPaused", () => s.mintPaused);
  on(FACILITATOR, facilitatorKeeperAbi, "pendingTail", () => BigInt(s.entries.length));
  on(FACILITATOR, facilitatorKeeperAbi, "pendingMints", ([id]) => [ALICE, BOB, false, s.entries[Number(id)] ?? 0n]);
  on(FACILITATOR, facilitatorKeeperAbi, "limits", () => [10_000_000_000n, s.inbound, 10_000_000_000n, 10_000_000_000n]);
  on(FACILITATOR, facilitatorKeeperAbi, "flushPendingMint", ([id]) => {
    s.flush(id as bigint);
    return [];
  });
  on(HOLLAR, ghoAbi, "getFacilitatorBucket", () => s.bucket);
}

const TARGET: FlushTarget = { facilitator: FACILITATOR, hollar: HOLLAR, scale: SCALE, fromId: 0n };

const ids = (a: readonly bigint[]): string => a.map(String).join(",");

function flushedIds(): bigint[] {
  return sentCalls(facilitatorKeeperAbi).map((c) => c.args[0] as bigint);
}

async function flushChecks() {
  const roomy: [bigint, bigint] = [10_000n * 10n ** 18n, 0n];
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({ mintPaused: true, entries: [100n], bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const out = await flushTick(ctx, TARGET, flushState(TARGET));
    record(out.kind === "paused" && mock.rawTxs.length === 0, "flush: mint paused → nothing sent", out);
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({ mintPaused: false, entries: [], bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const out = await flushTick(ctx, TARGET, flushState(TARGET));
    record(out.kind === "idle", "flush: no pending ids → idle", out);
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({
      mintPaused: false,
      entries: [0n, 100_000_000n, 50_000_000_000n, 0n, 10_000_000n],
      bucket: [1_000n * 10n ** 18n, 0n],
      inbound: 10_000_000_000n,
      flush: () => {},
    });
    const state = flushState(TARGET);
    const out = await flushTick(ctx, TARGET, state);
    record(
      out.kind === "scanned" && ids(flushedIds()) === ids([1n, 4n]) && out.skipped.includes(2n),
      "flush: entries that fit the bucket are flushed oldest first, the one too big is skipped",
      { out, sent: flushedIds() },
    );
    record(sentGas().every((g) => g === 240_000n), "flush: each flush carries the PSM gas margin (estimate + 20%)", sentGas());
    record(state.frontier === 5n && state.live.has(2n) && !state.live.has(0n), "flush: the frontier passes every id read; live ids are kept, dead ones are not", {
      frontier: state.frontier,
      live: [...state.live],
    });
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({
      mintPaused: false,
      entries: [600_000_000n, 600_000_000n],
      bucket: [1_000n * 10n ** 18n, 0n],
      inbound: UNLIMITED,
      flush: () => {},
    });
    await flushTick(ctx, TARGET, flushState(TARGET));
    record(ids(flushedIds()) === ids([0n]), "flush: two entries that each fit but not together → only the first is sent", flushedIds());
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({
      mintPaused: false,
      entries: [100n, 100n, 100n],
      bucket: [1_000n * 10n ** 18n, 0n],
      inbound: 250n,
      flush: () => {},
    });
    await flushTick(ctx, TARGET, flushState(TARGET));
    record(ids(flushedIds()) === ids([0n, 1n]), "flush: the inbound allowance is budgeted too", flushedIds());
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({
      mintPaused: false,
      entries: [100n, 100n],
      bucket: roomy,
      inbound: UNLIMITED,
      flush: (id) => {
        if (id === 0n) revert(facilitatorKeeperAbi, "NotQueued", [0n]);
      },
    });
    const out = await flushTick(ctx, TARGET, flushState(TARGET));
    record(
      out.kind === "scanned" && out.skipped.includes(0n) && ids(flushedIds()) === ids([1n]),
      "flush: NotQueued (flushed or cancelled by someone else) is skipped, the next one still sent",
      { out, sent: flushedIds() },
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({
      mintPaused: false,
      entries: [100n, 100n],
      bucket: roomy,
      inbound: UNLIMITED,
      flush: () => revert(facilitatorKeeperAbi, "MintPausedError"),
    });
    const out = await flushTick(ctx, TARGET, flushState(TARGET));
    record(
      out.kind === "scanned" && ids(out.skipped) === ids([0n]) && mock.rawTxs.length === 0,
      "flush: MintPausedError stops the tick at the entry that met it",
      out,
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({ mintPaused: false, entries: Array(FLUSH_MAX_PER_TICK + 2).fill(100n), bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    await flushTick(ctx, TARGET, flushState(TARGET));
    record(flushedIds().length === FLUSH_MAX_PER_TICK, `flush: at most ${FLUSH_MAX_PER_TICK} flushes per tick`, flushedIds().length);
  }
  {
    const { ctx } = await keeperCtx(hydration, { enabled: false });
    facilitator({ mintPaused: false, entries: [100n], bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const out = await flushTick(ctx, TARGET, flushState(TARGET));
    record(out.kind === "scanned" && mock.rawTxs.length === 0 && out.skipped.includes(0n), "flush: PSM_KEEPER=off → nothing sent", out);
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const entries = Array(150).fill(0n) as bigint[];
    entries[120] = 100n;
    facilitator({ mintPaused: false, entries, bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const state = flushState(TARGET);
    const first = await flushTick(ctx, TARGET, state);
    const second = await flushTick(ctx, TARGET, state);
    record(
      first.kind === "scanned" && !first.live.includes(120n) && state.frontier === 150n && second.kind === "scanned" && second.flushed.includes(120n),
      "flush: new ids are read a batch per tick; one past the first batch is flushed on the next",
      { first, second, frontier: state.frontier },
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const entries = Array(10_001).fill(0n) as bigint[];
    entries[10_000] = 100n;
    facilitator({ mintPaused: false, entries, bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const state = flushState(TARGET);
    state.frontier = 10_000n;
    state.sweep = 9_990n;
    const out = await flushTick(ctx, TARGET, state);
    record(
      out.kind === "scanned" && out.flushed.includes(10_000n),
      "flush: once caught up, a new entry is flushed within one tick however long the history behind it",
      out,
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const entries = Array(50).fill(0n) as bigint[];
    entries[3] = 100n;
    facilitator({ mintPaused: false, entries, bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const state = flushState(TARGET);
    state.frontier = 50n;
    const out = await flushTick(ctx, TARGET, state);
    record(out.kind === "scanned" && out.flushed.includes(3n), "flush: an already-read id that is live again is found by the sweep", out);
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const s: FacilitatorState = { mintPaused: false, entries: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], bucket: roomy, inbound: UNLIMITED, flush: () => {} };
    facilitator(s);
    const state = flushState(TARGET);
    state.frontier = 8n;
    state.sweep = 0n;
    state.live = new Set([7n]);
    await flushTick(ctx, TARGET, state);
    record(!state.live.has(7n), "flush: a live id that has since died is dropped", [...state.live]);
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const entries = Array(1_000).fill(0n) as bigint[];
    entries[500] = 100n;
    facilitator({ mintPaused: false, entries, bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const state = flushState(TARGET);
    state.frontier = 1_000n;
    state.sweep = 0n;
    state.live = new Set([500n]);
    const out = await flushTick(ctx, TARGET, state);
    record(
      out.kind === "scanned" && out.flushed.includes(500n),
      "flush: a known live id far from the frontier and the sweep is re-read and flushed every tick",
      out,
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({ mintPaused: false, entries: [100n], bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    const state = flushState(TARGET);
    state.inflight = { hash: `0x${"bb".repeat(32)}`, nonce: 0, label: "flushPendingMint(0)", sentAt: Date.now() };
    const held = await flushTick(ctx, TARGET, state);
    mock.nonce = 1; // nonce 0 mined, as another transaction
    const out = await flushTick(ctx, TARGET, state);
    record(
      held.kind === "inflight" && out.kind === "scanned" && ids(flushedIds()) === "0" && state.inflight === undefined,
      "flush: an in-flight flush whose nonce another took is dropped, and the keeper flushes again",
      { held, out },
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const entries = [0n, 100n, 0n, 200n];
    let down = true;
    facilitator({ mintPaused: false, entries, bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    on(FACILITATOR, facilitatorKeeperAbi, "pendingMints", ([id]) => {
      if (id === 7n && down) throw new Error("node down");
      return [ALICE, BOB, false, entries[Number(id)] ?? 0n];
    });
    const state = flushState(TARGET);
    state.live = new Set([7n]);
    const failed = await flushTick(ctx, TARGET, state).then(
      () => false,
      () => true,
    );
    record(
      failed && state.frontier === 4n && state.live.has(1n) && state.live.has(3n),
      "flush: a read that fails after the frontier moved keeps the live ids the scan found",
      { failed, frontier: state.frontier, live: [...state.live] },
    );
    down = false;
    const out = await flushTick(ctx, TARGET, state);
    record(out.kind === "scanned" && ids(flushedIds()) === "1,3", "flush: the next tick flushes them", { out, sent: flushedIds() });
  }
  {
    const { ctx } = await keeperCtx(hydration);
    facilitator({ mintPaused: false, entries: [0n, 100n], bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    await flushTick(ctx, TARGET, flushState(TARGET));
    const pinned = new Set([
      selectorOf(facilitatorKeeperAbi, "mintPaused"),
      selectorOf(facilitatorKeeperAbi, "pendingTail"),
      selectorOf(facilitatorKeeperAbi, "pendingMints"),
      selectorOf(facilitatorKeeperAbi, "limits"),
      selectorOf(ghoAbi, "getFacilitatorBucket"),
    ]);
    const blocks = mock.callLog.filter((c) => pinned.has(c.selector)).map((c) => c.block);
    record(
      blocks.length >= 5 && blocks.every((b) => typeof b === "string" && b.startsWith("0x") && b === blocks[0]),
      "flush: a tick reads the pause, the tail, every entry, the bucket and the limits at one block",
      blocks,
    );
  }
  {
    const { ctx } = await keeperCtx(hydration);
    const entries = [0n, 0n, 0n, 0n];
    facilitator({ mintPaused: false, entries, bucket: roomy, inbound: UNLIMITED, flush: () => {} });
    on(FACILITATOR, facilitatorKeeperAbi, "pendingMints", ([id]) => {
      if (id === 2n) throw new Error("node down");
      return [ALICE, BOB, false, entries[Number(id)] ?? 0n];
    });
    const state = flushState(TARGET);
    state.frontier = 4n;
    state.sweep = 2n;
    const failed = await flushTick(ctx, TARGET, state).then(
      () => false,
      () => true,
    );
    record(failed && state.sweep === 2n, "flush: a sweep read that fails leaves the sweep on that id", { failed, sweep: state.sweep });
  }
}

// ─── Watchers ────────────────────────────────────────────────────────────────────

interface BooksState {
  idle: bigint;
  supplied: bigint;
  principal: bigint;
  owed: bigint;
  outstanding: bigint;
  pending: bigint;
}

/** A vault and facilitator in balance: 10,000 USDC held against 9,000 principal and 1,000 owed. */
function booksState(): BooksState {
  return {
    idle: 1_000_000_000n,
    supplied: 9_000_000_000n,
    principal: 9_000_000_000n,
    owed: 1_000_000_000n,
    outstanding: 9_000n * 10n ** 18n,
    pending: 0n,
  };
}

function books(s: BooksState) {
  on(VAULT, vaultKeeperAbi, "usdc", () => USDC);
  on(VAULT, vaultKeeperAbi, "aUsdc", () => AUSDC);
  on(VAULT, vaultKeeperAbi, "wormhole", () => CORE);
  for (const f of ["depositsPaused", "claimsPaused", "investPaused"]) on(VAULT, vaultKeeperAbi, f, () => false);
  on(VAULT, vaultKeeperAbi, "principal", () => s.principal);
  on(VAULT, vaultKeeperAbi, "totalOwed", () => s.owed);
  on(VAULT, vaultKeeperAbi, "totalUnpayable", () => 0n);
  on(CORE, wormholeCoreAbi, "messageFee", () => 0n);
  on(USDC, erc20Abi, "balanceOf", () => s.idle);
  on(AUSDC, erc20Abi, "balanceOf", () => s.supplied);
  on(FACILITATOR, facilitatorKeeperAbi, "scale", () => SCALE);
  on(FACILITATOR, facilitatorKeeperAbi, "outstanding", () => s.outstanding);
  on(FACILITATOR, facilitatorKeeperAbi, "totalPendingMint", () => s.pending);
}

async function watchChecks() {
  {
    const t0 = Date.now();
    let now = t0;
    const { ctx, alerts } = await keeperCtx(base, { now: () => now });
    const s = booksState();
    books(s);
    const w = baseWatch(VAULT, { reader: async () => ctx.clients.publicClient, facilitator: FACILITATOR });
    const deposit = (amount: bigint) => {
      s.principal += amount;
      s.idle += amount;
    };
    deposit(100_000_000n); // booked on Base, never minted on Hydration
    await baseWatchTick(ctx, w);
    now = t0 + 50 * 60_000;
    deposit(50_000_000n);
    await baseWatchTick(ctx, w);
    const at50 = alerts.keys().includes("psm:books-stalled");
    now = t0 + BOOKS_STALL_MS + 60_000;
    await baseWatchTick(ctx, w);
    const at61 = alerts.keys().includes("psm:books-stalled");
    s.outstanding += 150_000_000n * SCALE;
    await baseWatchTick(ctx, w);
    record(
      !at50 && at61 && w.inFlight === undefined,
      "watch: USDC in flight an hour with no delivery landing is alerted, and the clock clears once it lands",
      { at50, at61, inFlight: w.inFlight },
    );
  }
  {
    const t0 = Date.now();
    let now = t0;
    const { ctx, alerts } = await keeperCtx(base, { now: () => now });
    const s = booksState();
    books(s);
    const w = baseWatch(VAULT, { reader: async () => ctx.clients.publicClient, facilitator: FACILITATOR });
    s.principal += 150_000_000n;
    s.idle += 150_000_000n;
    await baseWatchTick(ctx, w);
    now = t0 + 50 * 60_000;
    s.outstanding += 50_000_000n * SCALE; // one delivery lands
    await baseWatchTick(ctx, w);
    now = t0 + BOOKS_STALL_MS + 60_000;
    await baseWatchTick(ctx, w);
    const early = alerts.keys().includes("psm:books-stalled");
    now = t0 + 50 * 60_000 + BOOKS_STALL_MS + 60_000;
    await baseWatchTick(ctx, w);
    record(
      !early && alerts.keys().includes("psm:books-stalled"),
      "watch: a delivery landing restarts the in-flight clock",
      { early, keys: alerts.keys() },
    );
  }
  {
    const { ctx } = await keeperCtx(base);
    books(booksState());
    const w = baseWatch(VAULT);
    mock.blockNumber = 20_000n;
    await baseWatchTick(ctx, w);
    const firstEnd = w.logCursor!;
    mock.blockNumber += 30n;
    mock.logRanges.length = 0;
    await baseWatchTick(ctx, w);
    const from = mock.logRanges[0]?.from;
    const second = w.logCursor!;
    mock.blockNumber -= 100n; // a pool node well behind
    await baseWatchTick(ctx, w);
    record(
      from === firstEnd - LOG_OVERLAP_BLOCKS && w.logCursor === second && second > firstEnd,
      "watch: each log pass re-reads LOG_OVERLAP_BLOCKS behind where the last ended, and a node behind never moves the cursor back",
      { firstEnd, from, second, after: w.logCursor },
    );
  }
  {
    let now = Date.now();
    const { ctx, alerts } = await keeperCtx(base, { now: () => now });
    const s = {
      claimsPaused: false,
      fee: 0n,
      idle: 1_000_000_000n,
      supplied: 9_000_000_000n,
      principal: 9_000_000_000n,
      owed: 1_000_000_000n,
      unpayable: 0n,
      outstanding: 9_000n * 10n ** 18n,
      pending: 0n,
    };
    on(VAULT, vaultKeeperAbi, "usdc", () => USDC);
    on(VAULT, vaultKeeperAbi, "aUsdc", () => AUSDC);
    on(VAULT, vaultKeeperAbi, "wormhole", () => CORE);
    on(VAULT, vaultKeeperAbi, "depositsPaused", () => false);
    on(VAULT, vaultKeeperAbi, "claimsPaused", () => s.claimsPaused);
    on(VAULT, vaultKeeperAbi, "investPaused", () => false);
    on(VAULT, vaultKeeperAbi, "principal", () => s.principal);
    on(VAULT, vaultKeeperAbi, "totalOwed", () => s.owed);
    on(VAULT, vaultKeeperAbi, "totalUnpayable", () => s.unpayable);
    on(CORE, wormholeCoreAbi, "messageFee", () => s.fee);
    on(USDC, erc20Abi, "balanceOf", () => s.idle);
    on(AUSDC, erc20Abi, "balanceOf", () => s.supplied);
    on(FACILITATOR, facilitatorKeeperAbi, "scale", () => SCALE);
    on(FACILITATOR, facilitatorKeeperAbi, "outstanding", () => s.outstanding);
    on(FACILITATOR, facilitatorKeeperAbi, "totalPendingMint", () => s.pending);
    const reader = async () => ctx.clients.publicClient;
    const w = baseWatch(VAULT, { reader, facilitator: FACILITATOR });

    await baseWatchTick(ctx, w);
    record(alerts.raised.length === 0, "watch: a healthy vault on the first tick raises nothing", alerts.raised);
    const reserveReads = new Set([selectorOf(erc20Abi, "balanceOf"), selectorOf(vaultKeeperAbi, "totalOwed"), selectorOf(vaultKeeperAbi, "totalUnpayable")]);
    const blocks = mock.callLog.filter((c) => reserveReads.has(c.selector)).map((c) => c.block);
    record(
      blocks.length === 4 && blocks.every((b) => typeof b === "string" && b.startsWith("0x") && b === blocks[0]),
      "watch: the reserve check reads both balances and the liabilities at one block, not at latest",
      blocks,
    );

    s.claimsPaused = true;
    s.fee = 1n;
    await baseWatchTick(ctx, w);
    record(alerts.keys().includes("psm:flag:vault.claimsPaused"), "watch: a pause flipping is alerted", alerts.keys());
    record(alerts.keys().includes("psm:message-fee"), "watch: a non-zero Base message fee is alerted", alerts.keys());

    s.idle = 0n;
    await baseWatchTick(ctx, w);
    const shortAfterOne = alerts.keys().includes("psm:reserve-short");
    await baseWatchTick(ctx, w);
    record(
      !shortAfterOne && alerts.keys().includes("psm:reserve-short"),
      "watch: a reserve below what the vault owes is alerted on the second tick in a row, not the first",
      alerts.keys(),
    );

    s.idle = 1_000_000_000n;
    s.outstanding = 9_500n * 10n ** 18n;
    const before = alerts.raised.length;
    await baseWatchTick(ctx, w);
    const booksAfterOne = alerts.raised.slice(before).some((r) => r.key === "psm:books");
    await baseWatchTick(ctx, w);
    const booksAfterTwo = alerts.raised.some((r) => r.key === "psm:books");
    record(!booksAfterOne && booksAfterTwo, "watch: principal below Hydration's minted + queued is alerted on the second tick, not the first", alerts.keys());

    now += 1;
    s.outstanding = 9_000n * 10n ** 18n;
    s.pending = 0n;
    await baseWatchTick(ctx, w);
    record(w.booksStrikes === 0, "watch: books back in line reset the strike count", w.booksStrikes);
  }
  {
    const { ctx, alerts } = await keeperCtx(base);
    on(VAULT, vaultKeeperAbi, "usdc", () => USDC);
    on(VAULT, vaultKeeperAbi, "aUsdc", () => AUSDC);
    on(VAULT, vaultKeeperAbi, "wormhole", () => CORE);
    for (const f of ["depositsPaused", "claimsPaused", "investPaused"]) on(VAULT, vaultKeeperAbi, f, () => false);
    for (const f of ["principal", "totalOwed", "totalUnpayable"]) on(VAULT, vaultKeeperAbi, f, () => 0n);
    on(CORE, wormholeCoreAbi, "messageFee", () => 0n);
    on(USDC, erc20Abi, "balanceOf", () => 0n);
    on(AUSDC, erc20Abi, "balanceOf", () => 0n);
    mock.getLogs = () => [vaultLog("Disputed", { recipient: BOB, amount: 5_000_000n, principal: 1_000_000n })];
    const w = baseWatch(VAULT);
    await baseWatchTick(ctx, w);
    record(alerts.keys().some((k) => k.startsWith("psm:disputed:")), "watch: a Disputed log is alerted", alerts.keys());

    mock.getLogs = () => new Error("request limit reached");
    let afterFour = false;
    for (let i = 0; i < 5; i++) {
      mock.blockNumber += 10n;
      await baseWatchTick(ctx, w).catch(() => {});
      if (i === 3) afterFour = alerts.keys().includes("psm:getlogs");
    }
    record(
      !afterFour && alerts.keys().includes("psm:getlogs") && w.failed.includes("logs"),
      "watch: eth_getLogs failing is alerted on the 5th failure in a row, not before",
      { afterFour, keys: alerts.keys(), failed: w.failed },
    );
  }
  {
    let now = Date.now();
    const { ctx, alerts } = await keeperCtx(hydration, { now: () => now });
    let pending = 100_000_000n;
    on(FACILITATOR, facilitatorKeeperAbi, "hollar", () => HOLLAR);
    on(FACILITATOR, facilitatorKeeperAbi, "scale", () => SCALE);
    on(FACILITATOR, facilitatorKeeperAbi, "mintPaused", () => true);
    on(FACILITATOR, facilitatorKeeperAbi, "redeemPaused", () => false);
    on(FACILITATOR, facilitatorKeeperAbi, "totalPendingMint", () => pending);
    on(FACILITATOR, facilitatorKeeperAbi, "limits", () => [1n, 1n, 1n, 1n]);
    on(HOLLAR, ghoAbi, "getFacilitatorBucket", () => [10n ** 22n, 10n ** 21n]);
    const w = hydrationWatch(FACILITATOR);
    await hydrationWatchTick(ctx, w);
    record(!alerts.keys().includes("psm:pending"), "watch: freshly queued mints are not alerted", alerts.keys());
    now += LIQUIDITY_STALL_MS + 1;
    await hydrationWatchTick(ctx, w);
    record(alerts.keys().includes("psm:pending"), "watch: mints queued past an hour are alerted", alerts.keys());
    pending = 0n;
    await hydrationWatchTick(ctx, w);
    record(w.pendingSince === undefined, "watch: the queued-since clock resets once nothing is queued", w.pendingSince);
  }
}

// ─── Alerter, middleware, loop, notify, queue ───────────────────────────────────

async function plumbingChecks() {
  const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
  {
    let now = 0;
    const sent: string[] = [];
    const a = createAlerter({ repeatMs: 1_000, now: () => now, post: async (_w, m) => (sent.push(m), true), log: { warn: () => logger } as never });
    a.alert("k", "s1", "one");
    await settle();
    a.alert("k", "s1", "two");
    now = 1_001;
    a.alert("k", "s1", "three");
    await settle();
    a.alert("k", "s2", "four");
    await settle();
    a.clear("k");
    a.alert("k", "s2", "five");
    await settle();
    record(JSON.stringify(sent) === JSON.stringify(["one", "three", "four", "five"]), "alerter: dedup by state, hourly repeat, immediate on change and after clear", sent);
  }
  {
    const results = [false, false, true];
    let posted = 0;
    const a = createAlerter({
      repeatMs: 3_600_000,
      retryDelaysMs: [0, 0, 0],
      post: async () => results[posted++] ?? true,
      log: { warn: () => logger } as never,
    });
    a.alert("k", "s", "m");
    a.alert("k", "s", "m");
    await settle(50);
    const delivered = posted;
    a.alert("k", "s", "m");
    await settle(20);
    record(
      delivered === 3 && posted === 3,
      "alerter: a refused post is retried until it goes through, a same-state raise meanwhile posts nothing, and only then is it raised",
      { delivered, posted },
    );
  }
  {
    let posted = 0;
    const warned: string[] = [];
    const a = createAlerter({
      repeatMs: 3_600_000,
      retryDelaysMs: [0, 1],
      post: async () => (posted += 1) >= 6,
      log: { warn: (m: string) => void warned.push(m) } as never,
    });
    a.alert("k", "s", "m");
    await settle(100);
    const delivered = posted;
    a.alert("k", "s", "m");
    await settle(20);
    record(
      delivered === 6 &&
        posted === 6 &&
        warned.filter((w) => w.includes("retrying every")).length === 1 &&
        warned.some((w) => w.startsWith("ALERT delivered after 6 attempts")),
      "alerter: past its schedule a failing post retries at the last wait until Discord takes it, logging once on settling in and once on delivery",
      { delivered, posted, warned },
    );
  }
  {
    const seen: string[] = [];
    const warned: string[] = [];
    const a = createAlerter({
      repeatMs: 3_600_000,
      retryDelaysMs: [5],
      maxUndelivered: 2,
      post: async (_w, m) => (seen.push(m), false),
      log: { warn: (m: string) => void warned.push(m) } as never,
    });
    a.alert("k1", "s", "k1");
    a.alert("k2", "s", "k2");
    a.alert("k3", "s", "k3");
    await settle(30);
    a.clear("k2");
    a.clear("k3");
    const k1 = seen.filter((m) => m === "k1").length;
    record(
      k1 === 1 && warned.some((w) => w.includes("dropped undelivered") && w.endsWith(": k1")),
      "alerter: past the cap the oldest undelivered alert is dropped, with a log line",
      { k1, warned },
    );
  }
  {
    const seen: string[] = [];
    const a = createAlerter({
      repeatMs: 3_600_000,
      retryDelaysMs: [30, 30, 30],
      post: async (_w, m) => (seen.push(m), m === "s2"),
      log: { warn: () => logger } as never,
    });
    a.alert("k", "s1", "s1");
    a.alert("j", "x", "x");
    await settle(10);
    a.alert("k", "s2", "s2");
    a.clear("j");
    await settle(150);
    record(
      JSON.stringify(seen) === JSON.stringify(["s1", "x", "s2"]),
      "alerter: a changed state takes over a post being retried, and clear drops one",
      seen,
    );
  }
  {
    let unhandled = 0;
    const onUnhandled = () => void (unhandled += 1);
    process.on("unhandledRejection", onUnhandled);
    let posted = 0;
    const rejecting = createAlerter({
      repeatMs: 1,
      retryDelaysMs: [],
      post: () => ((posted += 1), Promise.reject(new Error("down"))),
      log: { warn: () => logger } as never,
    });
    rejecting.alert("k", "s", "m");
    await new Promise((r) => setTimeout(r, 20));
    let thrown = 0;
    const throwingPost = createAlerter({
      repeatMs: 1,
      retryDelaysMs: [],
      post: () => {
        thrown += 1;
        throw new Error("sync");
      },
      log: { warn: () => logger } as never,
    });
    throwingPost.alert("k", "s", "m");
    await settle(20);
    throwingPost.alert("k", "s", "m");
    await settle(20);
    process.off("unhandledRejection", onUnhandled);
    record(posted === 1 && unhandled === 0, "alerter: a rejecting post is reached and its rejection is handled", { posted, unhandled });
    record(thrown === 2, "alerter: a post that throws outright counts as failed, and the key is not left blocked", thrown);

    const throwing = createAlerter({ repeatMs: 1, post: async () => true, log: { warn: () => { throw new Error("log down"); } } as never });
    let threw = false;
    try {
      throwing.alert("k", "s", "m");
    } catch {
      threw = true;
    }
    record(!threw, "alerter: a throwing log never reaches the caller");
  }
  {
    const alerts = captureAlerts();
    const mw = parkedAlert(alerts.alerter, { app: "psm-test", earlyAttempt: 5 });
    record(mw.length === 3, "parked: exactly three parameters, so the engine files it as error middleware", mw.length);
    const ctxFor = (attempts: number | undefined) =>
      ({
        vaa: { emitterChain: 30, emitterAddress: Buffer.alloc(32, 1), sequence: 9n },
        ...(attempts === undefined ? {} : { storage: { job: { attempts, maxAttempts: 250 } } }),
      }) as unknown as RelayerCtx;
    let nexts = 0;
    for (const a of [undefined, 3, 5, 250]) mw(new Error("boom"), ctxFor(a), () => void (nexts += 1));
    record(
      JSON.stringify(alerts.raised.map((r) => r.state)) === JSON.stringify(["failing", "parked"]) && nexts === 4,
      "parked: silent before the early attempt and without a job, 'failing' at 5, 'parked' at the last; next always called",
      alerts.raised,
    );
    const broken = parkedAlert({ alert: () => { throw new Error("x"); }, clear: () => {} }, { app: "t", earlyAttempt: 5 });
    let threw = false;
    try {
      broken(new Error("e"), ctxFor(250), () => { throw new Error("next"); });
    } catch {
      threw = true;
    }
    record(!threw, "parked: a throwing alerter or next never escapes");
  }
  {
    let ticks = 0;
    const failures: number[] = [];
    const stop = every("test", 5, async () => {
      ticks += 1;
      if (ticks <= 3) throw new Error("tick down");
    }, (n) => failures.push(n));
    await new Promise((r) => setTimeout(r, 120));
    stop();
    record(ticks > 4 && JSON.stringify(failures) === JSON.stringify([1, 2, 3]), "loop: failing ticks are counted and the loop goes on", { ticks, failures });
  }
  {
    let posted = 0;
    const alerter = createAlerter({ repeatMs: 3_600_000, post: async () => ((posted += 1), true), log: { warn: () => logger } as never });
    let n = 0;
    // Five failures, one good tick, five more failures, then good ticks.
    const stop = keeperLoop("psm-test", alerter, "drain", 2, async () => {
      n += 1;
      if (n !== 6 && n <= 11) throw new Error("tick down");
    });
    await settle(250);
    stop();
    record(
      n > 11 && posted === 2,
      "loop: a good tick clears a keeper loop's failure alert, so the next run of failures alerts again",
      { n, posted },
    );
  }
  {
    const name = "PSM_VERIFY_WHOLE";
    const parse = (v: string | undefined, fallback: bigint, min?: bigint): string => {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
      try {
        return String(optWhole(name, fallback, min));
      } catch {
        return "throws";
      }
    };
    const chunk = [undefined, "", "500", " 250 ", "0", "-5", "1e3", "abc"].map((v) => parse(v, 1_000n, 1n));
    const fromId = [undefined, "0", "17", "-1", "0x10"].map((v) => parse(v, 0n));
    delete process.env[name];
    record(
      JSON.stringify(chunk) === JSON.stringify(["1000", "1000", "500", "250", "throws", "throws", "throws", "throws"]) &&
        JSON.stringify(fromId) === JSON.stringify(["0", "0", "17", "throws", "throws"]),
      "config: PSM_LOG_CHUNK_BLOCKS takes a whole number of at least 1, PSM_FLUSH_FROM_ID one of at least 0, or the start stops",
      { chunk, fromId },
    );
  }
  {
    const saved = { webhook: process.env.DISCORD_WEBHOOK_URL, rpc: process.env.RPC_BASE };
    const webhook = (v: string | undefined): string => {
      if (v === undefined) delete process.env.DISCORD_WEBHOOK_URL;
      else process.env.DISCORD_WEBHOOK_URL = v;
      try {
        psmWebhook();
        return "ok";
      } catch (e) {
        return (e as Error).message.includes("must be https") ? "http" : "throws";
      }
    };
    const got = [undefined, "FILL THIS URL ALWAYS", "http://discord.invalid/x", "https://discord.com/api/webhooks/1/a"].map(webhook);
    delete process.env.RPC_BASE;
    let rpcUnset = "ok";
    try {
      rpcBase();
    } catch {
      rpcUnset = "throws";
    }
    if (saved.webhook === undefined) delete process.env.DISCORD_WEBHOOK_URL;
    else process.env.DISCORD_WEBHOOK_URL = saved.webhook;
    if (saved.rpc !== undefined) process.env.RPC_BASE = saved.rpc;
    record(
      JSON.stringify(got) === JSON.stringify(["throws", "throws", "http", "ok"]) && rpcUnset === "throws",
      "config: the psm services require an https DISCORD_WEBHOOK_URL, and psm-base an RPC_BASE",
      { got, rpcUnset },
    );
  }
  {
    let posted = 0;
    const alerter = createAlerter({ repeatMs: 3_600_000, post: async () => ((posted += 1), true), log: { warn: () => logger } as never });
    let n = 0;
    const stop = keeperLoop(
      "psm-test",
      alerter,
      "vault watch",
      2,
      async () => {
        n += 1;
        throw new Error("check down");
      },
      () => (n < 8 ? "logs" : "logs,books"),
    );
    await settle(120);
    stop();
    record(
      n > 8 && posted === 2,
      "loop: a watcher loop's alert posts again at once when a second check starts failing",
      { n, posted },
    );
  }
  {
    posts.length = 0;
    const ok = await notifyDiscord("https://discord.invalid/ok", "x".repeat(3000));
    const refused = await notifyDiscord("https://discord.invalid/429", "y");
    const none = await notifyDiscord(undefined, "z");
    const content = JSON.parse(posts[0]?.body ?? "{}").content as string;
    record(
      posts.length === 2 && content.length === 1900 && ok && !refused && none,
      "notify: posts the content truncated to Discord's limit; reports a refusal as undelivered without throwing; no webhook sends nothing",
      { posts: posts.length, len: content?.length, ok, refused, none },
    );
  }
  {
    const warnings = async (webhook: string): Promise<number> => {
      posts.length = 0;
      mock = newMock(base.id);
      const clients = clientsFor(base);
      // 1000 submissions' worth to warn below: the mock's 1 ETH is under it.
      const queue = createQueue({ publicClient: clients.publicClient, account: clients.account, discordWebhook: webhook, warnMultiplier: 1_000n });
      await queue.init();
      await within(5_000, queue.add({ label: "t", logger, submit: async () => `0x${"03".repeat(32)}` }));
      await settle(50);
      return posts.length;
    };
    const delivered = await warnings("https://discord.invalid/ok");
    const refused = await warnings("https://discord.invalid/429");
    record(
      delivered === 1 && refused === 2,
      "queue: the low-gas warning posts once when Discord takes it, and again at the next check when Discord refused it",
      { delivered, refused },
    );
  }
  {
    let unhandled = 0;
    const onUnhandled = () => void (unhandled += 1);
    process.on("unhandledRejection", onUnhandled);
    mock = newMock(base.id);
    const clients = clientsFor(base);
    const queue = createQueue({ publicClient: clients.publicClient, account: clients.account, warnMultiplier: 1n });
    await queue.init();
    mock.failBalance = true;
    await within(5_000, queue.add({ label: "t1", logger, submit: async () => `0x${"01".repeat(32)}` }));
    await new Promise((r) => setTimeout(r, 50));
    mock.failBalance = false;
    let ran = false;
    const t2 = await within(5_000, queue.add({ label: "t2", logger, submit: async () => ((ran = true), `0x${"02".repeat(32)}`) }));
    mock.failNonce = true;
    const r = await within(
      5_000,
      queue
        .add({ label: "t3", logger, submit: async () => { throw new Error("nonce too low"); } })
        .then(() => "resolved", () => "rejected"),
    );
    await new Promise((res) => setTimeout(res, 50));
    process.off("unhandledRejection", onUnhandled);
    record(unhandled === 0 && ran && t2 !== "timeout", "queue: a failing balance read after a task neither crashes nor stalls the next", { unhandled, ran, t2 });
    record(r === "rejected" && unhandled === 0, "queue: a failing nonce reload rejects the task instead of crashing or hanging", r);
  }
  {
    // The delivery path: the psm handler sends receiveMessage through the queue with the margin.
    mock = newMock(base.id);
    const clients = clientsFor(base);
    const queue = createQueue({ publicClient: clients.publicClient, account: clients.account, warnMultiplier: 1n });
    await queue.init();
    on(VAULT, receiverAbi, "receiveMessage", () => []);
    const handlers = new Map<string, (ctx: RelayerCtx, next: () => Promise<void>) => Promise<void>>();
    const app = {
      chain: () => ({ _addressHandlers: new Proxy({}, { set: (_t, k, v) => (handlers.set(String(k), v), true) }) }),
    } as unknown as RelayerApp;
    const route: PsmRoute = {
      name: "redeem",
      sourceChain: WORMHOLE.hydration,
      sourceEmitter: FACILITATOR,
      destinationChain: WORMHOLE.base,
      destinationContract: VAULT,
    };
    wireRoutes(app, [route], clients, queue);
    const handler = [...handlers.values()][0];
    const ctx = {
      vaa: { bytes: Buffer.from("cafebabe", "hex"), payload: Buffer.alloc(0), sequence: 1n, emitterChain: 73, emitterAddress: Buffer.alloc(32), timestamp: 0 },
      sourceTxHash: "0x",
      logger,
    } as unknown as RelayerCtx;
    await within(10_000, handler(ctx, async () => {}));
    record(
      mock.rawTxs.length === 1 && sentGas()[0] === 240_000n,
      "delivery: the psm handler sends receiveMessage with the PSM gas margin (estimate + 20%)",
      sentGas(),
    );
  }
}

async function main() {
  // Fails closed: only a run that reaches the end clears this, so a check that hangs and lets the
  // event loop drain exits non-zero instead of looking like a pass.
  process.exitCode = 1;
  await drainChecks();
  await flushChecks();
  await watchChecks();
  await plumbingChecks();
  globalThis.fetch = realFetch;
  if (failed) {
    console.error("\nverify-psm-keepers: FAILED");
    process.exit(1);
  }
  console.log("\nverify-psm-keepers: all checks passed");
  process.exitCode = 0;
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
