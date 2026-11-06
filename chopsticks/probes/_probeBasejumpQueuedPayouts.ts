/**
 * PROBE (Basejump queued payouts): the basejump relayer app pays a queued payout once the landing
 * can cover it, and alerts, sending nothing, on a head that stays unpayable.
 *
 * Runs the relayer's own code: `createPayoutKeeper` (agents/relayer/src/apps/basejump/payouts.ts),
 * the app's submission queue and `hydrationClients`, against the REAL landing on a chopsticks
 * fork of Hydration. Only two things are not production:
 *
 * - Storage overrides: a throwaway key is made an authorized bridge of the landing, so it can call
 *   `transfer` and queue payouts the way a receiver does; the pool's USDC balance is set to empty
 *   or funded; the two keys get gas.
 * - A small JSON-RPC shim in front of the fork's eth RPC, because chopsticks 2.0.0 serves it
 *   read-only: `eth_sendRawTransaction` becomes `pallet_ethereum::transact` in one new block,
 *   `eth_getTransactionReceipt` is answered from that block's events, `eth_getBalance` reads the
 *   WETH (asset 20) that pallet_evm charges gas from, and `eth_getTransactionCount` is tracked
 *   locally (the fork mis-decodes it), `eth_gasPrice` is quoted with headroom, and a revert's data
 *   is moved from the message into `error.data` where a live node puts it. Everything else is
 *   forwarded untouched. The shim also records every transaction the relayer sends, which is
 *   what the "sent nothing" checks count.
 *
 *   CHOPSTICKS_PORT=8263 SHIM_PORT=8264 npx tsx chopsticks/probes/_probeBasejumpQueuedPayouts.ts
 */
// MUST come first, as in the relayer's boot.ts: the relayer's chain module pulls the Wormhole SDK,
// which replaces globalThis.fetch with a polyfill viem cannot read.
import * as fetchModule from "../../agents/relayer/src/fetch";

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AccountId } from "polkadot-api";

import * as clientsModule from "../../agents/relayer/src/clients/hydration";
import * as queueModule from "../../agents/relayer/src/engine/queue";
import * as payoutsModule from "../../agents/relayer/src/apps/basejump/payouts";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { sendRawEthTx } from "../lib/eth/submit";
import { checkIfEthereumExecuted, findEvmLogs, type EventRecord } from "../lib/events";

/**
 * The relayer is a CommonJS package and this one is ESM, so Node hands its modules over as a
 * default export; take the named ones from there.
 */
const cjs = <T>(m: T): T => ((m as { default?: T }).default ?? m) as T;
const { restoreNativeFetch } = cjs(fetchModule);
const { hydrationClients } = cjs(clientsModule);
const { createQueue } = cjs(queueModule);
const { createPayoutKeeper, discordNotifier, landingsOf } = cjs(payoutsModule);

restoreNativeFetch();

// ─── Constants ───────────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const CHOPSTICKS_PORT = Number(process.env.CHOPSTICKS_PORT ?? 8263);
const SHIM_PORT = Number(process.env.SHIM_PORT ?? 8264);

/** The live landing and the live Ethereum corridor's receiver, which points at it. */
const LANDING = "0x70e9b12c3b19cb5f0e59984a5866278ab69df976" as Hex;
const ETHEREUM_RECEIVER = "0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a" as Hex;
/** USDC on Ethereum, mapped by the landing to Hydration asset 21. */
const USDC_SOURCE = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const USDC_ASSET_ID = 21;
const WETH_ASSET_ID = 20;
const HDX_UNIT = 10n ** 12n;

const PAYOUT = 5_000_000n; // 5 USDC
const BEHIND = 1_000_000n; // 1 USDC, queued behind the unpayable head
const FLOAT = 10_000_000n; // 10 USDC
const ALERT_AFTER_MS = 30 * 60_000;
const GAS_PRICE_HEADROOM = BigInt(process.env.GAS_PRICE_HEADROOM ?? 2);

/** Throwaway keys (anvil #2, #3). The bridge stands in for a receiver; the keeper is the app's wallet. */
const BRIDGE_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const KEEPER_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;

/** Alice's public key (a well-known test account). */
const RECIPIENT = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;
/** A fresh account holding nothing: a payout to it below the asset's existential deposit can never dispatch. */
const EMPTY_RECIPIENT = keccak256(toHex("basejump queued payout probe: empty recipient"));

const LANDING_ABI = parseAbi([
  "function transfer(address sourceAsset, uint256 amount, bytes32 recipient, bytes data) external",
  "function pendingHead() view returns (uint256)",
  "function pendingTail() view returns (uint256)",
  "function fulfillPending() external",
]);
const FULFILL_SELECTOR = encodeFunctionData({ abi: LANDING_ABI, functionName: "fulfillPending" });
const TRANSFER_QUEUED = keccak256(
  toHex("TransferQueued(uint256,address,address,bytes32,uint256)"),
);
const FULFILLED = keccak256(
  toHex("PendingTransferFulfilled(uint256,address,address,bytes32,uint256)"),
);

// ─── Helpers ─────────────────────────────────────────────────────

const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;
const ss58 = (pubkey: Hex): string => AccountId(63).dec(pubkey);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function retry<T>(what: string, fn: () => Promise<T>, tries = 12): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(400);
    }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last).slice(0, 200)}`);
}

const results: { step: string; ok: boolean }[] = [];
const record = (step: string, ok: boolean, detail = ""): boolean => {
  results.push({ step, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface Sent {
  hash: Hex;
  to: string | undefined;
  data: Hex;
  ok: boolean;
  blockHash: string;
  blockNumber: number;
  from: Hex;
}

/** JSON-RPC shim in front of the fork's eth RPC (see the header). */
function startShim(net: Network, forkHttp: string) {
  const api = net.client.getUnsafeApi();
  /** Every transaction accepted, in order; `sent` holds the sealed ones with their outcome. */
  const accepted: { hash: Hex; from: Hex; to: string | undefined; data: Hex }[] = [];
  const sent: Sent[] = [];
  const nonces = new Map<string, number>();
  const dropped: { hash: Hex; gasPrice: bigint; priceAtSeal: bigint }[] = [];
  let sealing: Promise<void> = Promise.resolve();
  /** Run around sealing one accepted tx: lets the probe change state between simulation and block. */
  const hooks: {
    beforeSeal?: (from: string) => Promise<unknown>;
    afterSeal?: (from: string) => Promise<unknown>;
  } = {};

  async function forward(method: string, params: unknown[]): Promise<unknown> {
    const r = await fetch(forkHttp, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = (await r.json()) as { result?: unknown; error?: { message: string } };
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }

  async function handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_sendRawTransaction": {
        // Like a node: check the nonce, accept, return the hash at once, and seal the block in the
        // background (a fork block takes longer than viem's request timeout). The receipt reads
        // null until the block is sealed.
        const raw = params[0] as Hex;
        const tx = parseTransaction(raw);
        const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase();
        const expected = nonces.get(from) ?? 0;
        if (tx.nonce !== expected) {
          throw new Error(tx.nonce! < expected ? "nonce too low" : `nonce gap: ${tx.nonce} > ${expected}`);
        }
        nonces.set(from, expected + 1);
        const hash = keccak256(raw);
        accepted.push({ hash, from: from as Hex, to: tx.to ?? undefined, data: (tx.data ?? "0x") as Hex });
        sealing = sealing.then(async () => {
          await hooks.beforeSeal?.(from);
          const res = await sendRawEthTx(net, raw).finally(() => hooks.afterSeal?.(from));
          const events = (await retry("events", () =>
            api.query.System.Events.getValue({ at: res.blockHash }),
          )) as EventRecord[];
          const executed = events.some(
            ({ event }) => event.type === "Ethereum" && event.value.type === "Executed",
          );
          if (!executed) {
            // Not included at all. A node returns no receipt for such a transaction, so neither
            // does the shim; it is recorded so the probe can report it.
            const quote = BigInt((await forward("eth_gasPrice", [])) as string);
            dropped.push({ hash: keccak256(raw), gasPrice: tx.gasPrice ?? 0n, priceAtSeal: quote });
            console.log(`   [shim] ${keccak256(raw)} NOT INCLUDED by the fork (tx gasPrice ${tx.gasPrice}, fork price now ${quote})`);
            return;
          }
          sent.push({
            hash: res.ethHash,
            to: tx.to ?? undefined,
            data: (tx.data ?? "0x") as Hex,
            ok: checkIfEthereumExecuted(events),
            blockHash: res.blockHash,
            blockNumber: res.blockNumber,
            from: from as Hex,
          });
        });
        return hash;
      }
      case "eth_getTransactionReceipt": {
        const s = sent.find((x) => x.hash.toLowerCase() === String(params[0]).toLowerCase());
        if (!s) return null;
        return {
          transactionHash: s.hash,
          transactionIndex: "0x0",
          blockHash: s.blockHash,
          blockNumber: numberToHex(s.blockNumber),
          from: s.from,
          to: s.to ?? null,
          status: s.ok ? "0x1" : "0x0",
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          gasUsed: "0x0",
          cumulativeGasUsed: "0x0",
          effectiveGasPrice: "0x0",
          contractAddress: null,
          type: "0x2",
        };
      }
      case "eth_gasPrice": {
        // The fork's quote can sit below the price it charges when it seals the next block, and a
        // transaction priced under that is not included at all. Quote twice the fork's price, so
        // the probe tests the relayer and not the fork's fee drift (see the report).
        return numberToHex(BigInt((await forward("eth_gasPrice", [])) as string) * GAS_PRICE_HEADROOM);
      }
      case "eth_getTransactionCount":
        return numberToHex(nonces.get(String(params[0]).toLowerCase()) ?? 0);
      case "eth_getBalance": {
        const acct = ss58(truncatedEvmAccount(params[0] as Hex));
        const v = (await retry("weth", () =>
          api.query.Tokens.Accounts.getValue(acct, WETH_ASSET_ID),
        )) as { free?: bigint } | undefined;
        return numberToHex(v?.free ?? 0n);
      }
      default:
        throw new Error("forward");
    }
  }

  const server: Server = createServer(async (req, res) => {
    const text = await body(req);
    const msg = JSON.parse(text) as { id: number; jsonrpc: string; method: string; params?: unknown[] };
    try {
      const result = await handle(msg.method, msg.params ?? []);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    } catch (e) {
      if ((e as Error).message !== "forward") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: (e as Error).message },
          }),
        );
        return;
      }
      const upstream = await fetch(forkHttp, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      // The fork sends a revert as {message: "execution reverted: 0x<selector>"}, with no code or
      // data. A live Hydration node sends {code: -32603, data: "0x<selector>"} (measured on
      // rpc.hydradx.cloud: fulfillPending on an empty queue returns data 0xfaf967df), which is the
      // shape viem decodes an error name from. Rewrite to the live shape.
      const out = (await upstream.json()) as {
        error?: { code?: number; message?: string; data?: unknown };
      };
      if (out.error && !(typeof out.error.data === "string" && /^0x[0-9a-fA-F]*$/.test(out.error.data))) {
        const m = /reverted:? (0x[0-9a-fA-F]+)/i.exec(`${out.error.message ?? ""} ${String(out.error.data ?? "")}`);
        if (process.env.SHIM_DEBUG) console.log(`   [shim] ${msg.method} error ${JSON.stringify(out.error)}`);
        if (m) {
          out.error.data = m[1];
          out.error.code ??= -32603; // the fork sends no code; viem decodes reverts only under 3 / -32603
        }
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    }
  });

  return new Promise<{
    url: string;
    accepted: typeof accepted;
    sent: Sent[];
    dropped: typeof dropped;
    hooks: typeof hooks;
    sealed: () => Promise<void>;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(SHIM_PORT, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        accepted,
        sent,
        dropped,
        hooks,
        sealed: () => sealing,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

/** A stand-in Discord webhook: records every message the relayer posts. */
function startWebhook() {
  const posts: string[] = [];
  const server = createServer(async (req, res) => {
    posts.push((JSON.parse(await body(req)) as { content: string }).content);
    res.statusCode = 204;
    res.end();
  });
  return new Promise<{ url: string; posts: string[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook`,
        posts,
        close: () => new Promise((r) => server.close(() => r())),
      }),
    );
  });
}

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([{ ...configs.hydration, port: CHOPSTICKS_PORT }]);
  const { hydration } = nets;
  const forkHttp = `http://127.0.0.1:${CHOPSTICKS_PORT}`;
  const shim = await startShim(hydration, forkHttp);
  const hook = await startWebhook();

  try {
    const api = hydration.client.getUnsafeApi();
    const bridge = privateKeyToAccount(BRIDGE_PK);
    const keeperKey = privateKeyToAccount(KEEPER_PK);
    const bridgeClient = new EthClient(hydration, bridge, { chainId: HYDRATION_EVM_CHAIN_ID });
    const landingSub = ss58(truncatedEvmAccount(LANDING));

    // The relayer's own clients, through the shim.
    const clients = await hydrationClients(shim.url, KEEPER_PK);
    const read = (fn: "pendingHead" | "pendingTail") =>
      retry(fn, () => clients.publicClient.readContract({ address: LANDING, abi: LANDING_ABI, functionName: fn }));
    const usdc = async (acct: string): Promise<bigint> => {
      const v = (await retry("usdc", () => api.query.Tokens.Accounts.getValue(acct, USDC_ASSET_ID))) as
        | { free?: bigint }
        | undefined;
      return v?.free ?? 0n;
    };
    const setPool = async (free: bigint) =>
      (await shim.sealed(), hydration).setStorage({ Tokens: { Accounts: [[[landingSub, USDC_ASSET_ID], { free }]] } });

    const blockNo = await retry("block", () => clients.publicClient.getBlockNumber());
    console.log(`\n🥢 Basejump queued-payout probe — fork of Hydration at block ${blockNo}`);
    console.log(`   landing ${LANDING}`);
    console.log(`   keeper  ${keeperKey.address} (the app's wallet)`);
    console.log(`   bridge  ${bridge.address} (stands in for a receiver)`);

    const assetInfo = await retry("registry", () => api.query.AssetRegistry.Assets.getValue(USDC_ASSET_ID));
    const ed = (assetInfo as { existential_deposit?: bigint } | undefined)?.existential_deposit ?? 0n;
    console.log(`   USDC (asset 21) existential deposit ${ed}`);

    // ── setup ──
    const authSlot = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [bridge.address, 1n]),
    );
    for (const who of [bridge.address, keeperKey.address]) {
      const sub = ss58(truncatedEvmAccount(who));
      await hydration.setStorage({
        System: { Account: [[[sub], { providers: 1, data: { free: 1_000_000n * HDX_UNIT } }]] },
        Tokens: { Accounts: [[[sub, WETH_ASSET_ID], { free: 10n ** 18n }]] },
      });
    }
    await hydration.setStorage({
      EVM: { AccountStorages: [[[LANDING, authSlot], pad(numberToHex(1), { size: 32 })]] },
    });

    console.log(`\n── Discovery ──`);
    const landings = await landingsOf(clients, [ETHEREUM_RECEIVER]);
    record("the app finds the landing through the live receiver", landings.length === 1 && landings[0] === LANDING, landings.join(","));

    const head0 = await read("pendingHead");
    const tail0 = await read("pendingTail");
    record("live queue is empty at the fork block", head0 === tail0, `head ${head0}, tail ${tail0}`);

    // Never build a block while the shim is sealing one: two concurrent newBlock calls deadlock.
    const queuePayout = async (amount: bigint, recipient: Hex) => {
      await shim.sealed();
      const res = await bridgeClient.call(
        LANDING,
        encodeFunctionData({ abi: LANDING_ABI, functionName: "transfer", args: [USDC_SOURCE, amount, recipient, "0x"] }),
      );
      const evs = (await retry("events", () => api.query.System.Events.getValue({ at: res.blockHash }))) as EventRecord[];
      return checkIfEthereumExecuted(evs) && findEvmLogs(evs, TRANSFER_QUEUED, LANDING).length === 1;
    };

    // The relayer: its queue (nonce lane), the keeper, an alert sink, and a clock we move.
    const queue = createQueue({ publicClient: clients.publicClient, account: clients.account, warnMultiplier: 2n });
    await queue.init();
    let clock = 0;
    const keeper = createPayoutKeeper({
      clients,
      queue,
      landing: LANDING,
      alertAfterMs: ALERT_AFTER_MS,
      receiptTimeoutMs: 20_000,
      notify: discordNotifier(hook.url),
      now: () => clock,
    });
    // Everything the keeper wallet broadcast, sealed or not: the "sent nothing" checks count these.
    const keeperAddr = keeperKey.address.toLowerCase();
    const sentToLanding = () => shim.accepted.filter((s) => s.from === keeperAddr);
    const sealedFromKeeper = () => shim.sent.filter((s) => s.from === keeperAddr);

    // ── A. Queue a payout against an empty pool ──
    console.log(`\n── A. Payout #${head0} queues against an empty pool ──`);
    const poolLive = await usdc(landingSub);
    console.log(`   pool's live USDC ${poolLive}; emptied for the probe`);
    await setPool(0n);
    record(`a ${PAYOUT} USDC-unit payout queues (TransferQueued)`, await queuePayout(PAYOUT, RECIPIENT));
    record("queue holds one payout", (await read("pendingTail")) === head0 + 1n);

    await keeper.poke();
    await keeper.poke();
    clock = ALERT_AFTER_MS - 60_000;
    await keeper.poke();
    record("pool empty: the relayer sends nothing", sentToLanding().length === 0, `${sentToLanding().length} sent`);
    record("before 30 min: no alert", hook.posts.length === 0, `${hook.posts.length} posts`);

    clock = ALERT_AFTER_MS + 60_000;
    await keeper.poke();
    await keeper.poke();
    await keeper.poke();
    record("after 30 min: exactly one alert", hook.posts.length === 1, hook.posts[0] ?? "none");
    record("the alert names the payout and asset", (hook.posts[0] ?? "").includes(`#${head0} of 5 USDC`));
    record("still nothing sent", sentToLanding().length === 0);

    // ── B. The settlement refills the pool; the timer pays the payout once ──
    console.log(`\n── B. Pool refilled; the relayer's timer pays it ──`);
    await setPool(FLOAT);
    const recipSub = ss58(RECIPIENT);
    const recipBefore = await usdc(recipSub);
    const stop = keeper.start(1_000);
    for (let i = 0; i < 60 && (await read("pendingHead")) === head0; i++) await sleep(1_000);
    stop();
    record("the timer alone paid it", (await read("pendingHead")) === head0 + 1n);
    await shim.sealed();
    await keeper.poke();
    await keeper.poke();
    await shim.sealed();
    const headB = await read("pendingHead");
    const recipAfter = await usdc(recipSub);
    const poolAfter = await usdc(landingSub);
    const sentB = sealedFromKeeper();
    record("exactly one transaction sent", sentToLanding().length === 1, `${sentToLanding().length} sent`);
    record("it is fulfillPending() on the landing", sentToLanding().every((s) => s.to?.toLowerCase() === LANDING && s.data === FULFILL_SELECTOR));
    record("it succeeded on chain", sentB.length === 1 && sentB.every((s) => s.ok));
    if (sentB[0]) {
      const evs = (await retry("events", () => api.query.System.Events.getValue({ at: sentB[0].blockHash }))) as EventRecord[];
      const logs = findEvmLogs(evs, FULFILLED, LANDING);
      record(`PendingTransferFulfilled(#${head0})`, logs.length === 1 && BigInt(logs[0].topics[1] as string) === head0);
    }
    record("queue empty", headB === head0 + 1n && headB === (await read("pendingTail")), `head ${headB}`);
    record("recipient +5 USDC", recipAfter - recipBefore === PAYOUT, `${recipBefore} → ${recipAfter}`);
    record("pool −5 USDC", poolAfter === FLOAT - PAYOUT, `${poolAfter}`);
    record("one all-clear after the alert", hook.posts.length === 2 && hook.posts[1].startsWith(`OK queued Basejump payout #${head0} paid`), hook.posts[1] ?? "none");

    // ── D. A call that simulates clean and reverts on chain, three times ──
    // Constructs the race where a delivery this app sent just before spends the float: the shim
    // empties the pool after the keeper's simulation and before its call is sealed, then refills
    // it. The keeper must stop after 3 reverts, alert at once, and try again one alert interval
    // later, when it pays.
    console.log(`\n── D. Three calls lose the float race; the cap pauses, then resets ──`);
    const D_PAYOUT = 2_000_000n;
    await setPool(0n);
    record(`a ${D_PAYOUT} USDC-unit payout queues`, await queuePayout(D_PAYOUT, RECIPIENT));
    await setPool(FLOAT);
    const headD = await read("pendingHead");
    const recipD = await usdc(recipSub);
    const sentBeforeD = sentToLanding().length;
    const sealedBeforeD = sealedFromKeeper().length;
    const postsBeforeD = hook.posts.length;
    const poolTo = (free: bigint) =>
      hydration.setStorage({ Tokens: { Accounts: [[[landingSub, USDC_ASSET_ID], { free }]] } });
    shim.hooks.beforeSeal = async (from) => from === keeperAddr && poolTo(0n);
    shim.hooks.afterSeal = async (from) => from === keeperAddr && poolTo(FLOAT);
    clock = 0;
    const revertedD = () => sealedFromKeeper().slice(sealedBeforeD).filter((x) => !x.ok).length;
    for (let i = 0; i < 30 && revertedD() < 3; i++) {
      await keeper.poke();
      await shim.sealed();
    }
    await keeper.poke(); // observes the third revert and hits the cap
    shim.hooks.beforeSeal = undefined;
    shim.hooks.afterSeal = undefined;
    const capSends = sentToLanding().length - sentBeforeD;
    record("three calls sent, all reverted on chain", capSends === 3 && revertedD() === 3, `${capSends} sent, ${revertedD()} reverted`);
    const capPosts = hook.posts.slice(postsBeforeD);
    record(
      "one alert at once, before 30 min",
      capPosts.length === 1 && capPosts[0].includes("simulated clean, then reverted"),
      capPosts[0] ?? "none",
    );
    clock = ALERT_AFTER_MS - 60_000;
    for (let i = 0; i < 3; i++) await keeper.poke();
    await shim.sealed();
    record("within the interval: nothing more sent", sentToLanding().length - sentBeforeD === 3);
    clock = ALERT_AFTER_MS + 60_000;
    await keeper.poke();
    await shim.sealed();
    await keeper.poke();
    await shim.sealed();
    record("after one interval the cap resets and pays it", (await read("pendingHead")) === headD + 1n, `head ${await read("pendingHead")}`);
    record("recipient +2 USDC", (await usdc(recipSub)) - recipD === D_PAYOUT);
    record("four calls in total for this payout", sentToLanding().length - sentBeforeD === 4);
    record(
      "all-clear after the paid payout",
      hook.posts.slice(postsBeforeD).some((m) => m.startsWith(`OK queued Basejump payout #${headD} paid`)),
    );

    // ── C. A head that can never be paid ──
    console.log(`\n── C. A head that can never be paid ──`);
    const tiny = ed > 1n ? ed - 1n : 1n;
    const emptySub = ss58(EMPTY_RECIPIENT);
    await setPool(0n);
    record(`a ${tiny}-unit payout to an empty account queues`, await queuePayout(tiny, EMPTY_RECIPIENT));
    record(`a ${BEHIND}-unit payout queues behind it`, await queuePayout(BEHIND, RECIPIENT));
    await setPool(FLOAT);
    const headC = await read("pendingHead");
    const recipC = await usdc(recipSub);

    // Independently of the relayer: the call reverts with the pool covering the head.
    let direct = "";
    try {
      await clients.publicClient.simulateContract({ address: LANDING, abi: parseAbi(["function fulfillPending()", "error DispatchFailed()"]), functionName: "fulfillPending", account: clients.account });
      direct = "did not revert";
    } catch (e) {
      direct = (e as Error).message ?? String(e); // carries "Error: DispatchFailed()" once decoded
    }
    record(
      "fulfillPending reverts DispatchFailed with the pool covering the head",
      direct.includes("DispatchFailed()"),
      direct.split("\n").find((l) => l.includes("Error:"))?.trim() ?? direct.split("\n")[0],
    );

    clock = 0;
    const postsBefore = hook.posts.length;
    const sentBefore = sentToLanding().length;
    await keeper.poke();
    await keeper.poke();
    record("before 30 min: no alert", hook.posts.length === postsBefore);
    clock = ALERT_AFTER_MS + 60_000;
    for (let i = 0; i < 4; i++) await keeper.poke();
    const stopC = keeper.start(500);
    await sleep(3_000);
    stopC();
    const newPosts = hook.posts.slice(postsBefore);
    record("after 30 min: exactly one alert", newPosts.length === 1, newPosts[0] ?? "none");
    record("the alert names the head and the revert", (newPosts[0] ?? "").includes(`#${headC} of`) && (newPosts[0] ?? "").includes("DispatchFailed"));
    record("nothing sent for it", sentToLanding().length === sentBefore, `${sentToLanding().length - sentBefore} sent`);
    record("head did not move; the payout behind it waits", (await read("pendingHead")) === headC && (await usdc(recipSub)) === recipC);
    record("the empty account received nothing", (await usdc(emptySub)) === 0n);

    record("the fork included every transaction sent", shim.dropped.length === 0, `${shim.dropped.length} not included`);
    console.log(`\n── Every transaction the keeper wallet sent ──`);
    await shim.sealed();
    for (const s of sealedFromKeeper()) console.log(`   ${s.hash} to ${s.to} data ${s.data} ${s.ok ? "ok" : "reverted"}`);
  } finally {
    await shim.close();
    await hook.close();
    await teardownForks(nets);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n🥢 ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exitCode = 1;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
