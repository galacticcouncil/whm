/**
 * PROBE (Basejump park run): a real park, end to end, on a Hydration fork. The live landing is
 * upgraded to this branch's BasejumpLanding through the Technical Committee origin, then the
 * relayer's own keeper parks a funded head whose dispatch fails, pays the entry behind it, and alerts
 * on the parked one; a human then pays the parked entry with `fulfillParked`.
 *
 * Runs the relayer's code: `createPayoutKeeper` (agents/relayer/src/apps/basejump/payouts.ts), the
 * app's submission queue and `hydrationClients`, against the REAL landing proxy on a chopsticks fork.
 * What is not production:
 *
 * - The upgrade. The implementation is deployed from `contracts/out` by a throwaway deployer
 *   (whitelisted in `EVMAccounts.ContractDeployer` by a storage override). The proxy's owner is the
 *   runtime's EmergencyAdminAccount; the call `dispatcher.dispatchAsEmergencyAdmin(evm.call(admin,
 *   landing, upgradeToAndCall(impl, 0x)))` is put in `Preimage.PreimageFor` and scheduled in
 *   `Scheduler.Agenda` for the next block with the origin `TechnicalCommittee.Members(threshold, n)`,
 *   a TC majority, as `_probeBasejumpLandingUpgrade.ts` does. So the runtime's own origin check, the
 *   dispatcher and the proxy's `_authorizeUpgrade` all run; only the TC vote is skipped.
 * - Storage overrides: a throwaway key is made an authorized bridge of the landing (it queues payouts
 *   the way a receiver does); the pool's USDC balance is set; the keys get gas; and, to make the
 *   parked payout payable, its empty recipient is given the asset's existential deposit.
 * - The JSON-RPC shim of `_probeBasejumpQueuedPayouts.ts`, copied unchanged except that it also
 *   records every eth_call / eth_estimateGas (sender and selector) for the dry-run checks, and
 *   that `eth_getStorageAt` reads pallet_evm's `AccountStorages` AT THE BLOCK THE CALLER NAMES (a
 *   number or tag, resolved with the fork's `chain_getBlockHash`), not at the fork head: the keeper
 *   reads parked entries at one block. `SHIM_STORAGE_AT_HEAD=1` restores the head-only answer.
 *   `eth_getBlockByNumber("finalized")` is answered from the fork's own finalized head
 *   (`chain_getFinalizedHead`), since the keeper reads parked entries at the finalized head.
 *
 *   CHOPSTICKS_PORT=8283 SHIM_PORT=8284 npx tsx chopsticks/probes/_probeBasejumpParkRun.ts
 *
 * Prints numbered PASS/FAIL checks; exits 1 on any FAIL.
 */
// MUST come first, as in the relayer's boot.ts (see _probeBasejumpQueuedPayouts.ts).
import * as fetchModule from "../../agents/relayer/src/fetch";

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  toFunctionSelector,
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
import { checkIfEthereumExecuted, findEvmLogs, logEvents, type EventRecord } from "../lib/events";

const cjs = <T>(m: T): T => ((m as { default?: T }).default ?? m) as T;
const { restoreNativeFetch } = cjs(fetchModule);
const { hydrationClients } = cjs(clientsModule);
const { createQueue } = cjs(queueModule);
const { createPayoutKeeper, discordNotifier } = cjs(payoutsModule);

/** ERC-1967 implementation slot, and the `parkedTransfers(uint256)` selector: local, so this probe runs against either keeper. */
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const PARKED_TRANSFERS_SELECTOR = toFunctionSelector("parkedTransfers(uint256)").slice(2);

restoreNativeFetch();

// ─── Constants ───────────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const CHOPSTICKS_PORT = Number(process.env.CHOPSTICKS_PORT ?? 8283);
const SHIM_PORT = Number(process.env.SHIM_PORT ?? 8284);

const LANDING = "0x70e9b12c3b19cb5f0e59984a5866278ab69df976" as Hex;
const ETHEREUM_RECEIVER = "0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a" as Hex;
const USDC_SOURCE = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const USDC_PRECOMPILE = "0x0000000000000000000000000000000100000015" as Hex;
const USDC_ASSET_ID = 21;
const WETH_ASSET_ID = 20;
const HDX_UNIT = 10n ** 12n;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
const UPGRADE_GAS_LIMIT = 300_000n;
const UPGRADE_MAX_FEE_PER_GAS = 10_000_000_000n;

const LEGACY = 5_000_000n; // 5 USDC, queued on the pre-upgrade implementation
const BEHIND = 1_000_000n; // 1 USDC, queued behind the unpayable head
const FLOAT = 10_000_000n; // 10 USDC
const ALERT_AFTER_MS = 30 * 60_000;
const RECEIPT_TIMEOUT_MS = 240_000; // a fork block takes 20-90 s; the keeper must see its own receipt
const GAS_PRICE_HEADROOM = BigInt(process.env.GAS_PRICE_HEADROOM ?? 2);

/** Throwaway keys (anvil #0, #2, #3): deployer and stand-in for the human, bridge, keeper wallet. */
const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const BRIDGE_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const KEEPER_PK = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex;

/** Alice's public key (a well-known test account). */
const RECIPIENT = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d" as Hex;
/** A fresh account holding nothing (a different seed from the queued-payout probe's). */
const EMPTY_RECIPIENT = keccak256(toHex("basejump park run probe: empty recipient"));

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING_ARTIFACT = JSON.parse(
  readFileSync(resolve(HERE, "../../contracts/out/BasejumpLanding.sol/BasejumpLanding.json"), "utf8"),
) as { bytecode: { object: Hex } };

const LANDING_ABI = parseAbi([
  "function transfer(address sourceAsset, uint256 amount, bytes32 recipient, bytes data) external",
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "function owner() view returns (address)",
  "function authorizedBridges(address) view returns (bool)",
  "function destAssetFor(address) view returns (address)",
  "function pendingHead() view returns (uint256)",
  "function pendingTail() view returns (uint256)",
  "function pendingTransfers(uint256) view returns (address sourceAsset, uint256 amount, bytes32 recipient)",
  "function reservedFor(address) view returns (uint256)",
  "function reservedAssetOf(uint256) view returns (address)",
  "function parkedTransfers(uint256) view returns (address sourceAsset, uint256 amount, bytes32 recipient)",
  "function PARK_DISPATCH_GAS() view returns (uint256)",
  "function fulfillPending() external",
  "function parkPending() external",
  "function fulfillParked(uint256 id) external",
  "error NoPendingTransfers()",
  "error InsufficientBalance()",
  "error DispatchFailed()",
  "error InsufficientGas()",
  "error NotParked(uint256 id)",
]);
const SEL = {
  fulfillPending: toFunctionSelector("fulfillPending()"),
  parkPending: toFunctionSelector("parkPending()"),
  fulfillParked: toFunctionSelector("fulfillParked(uint256)"),
  transfer4: toFunctionSelector("transfer(address,uint256,bytes32,bytes)"),
};
const topic = (sig: string) => keccak256(toHex(sig));
const T = {
  queued: topic("TransferQueued(uint256,address,address,bytes32,uint256)"),
  fulfilled: topic("PendingTransferFulfilled(uint256,address,address,bytes32,uint256)"),
  parked: topic("TransferParked(uint256,address,address,bytes32,uint256)"),
  parkedFulfilled: topic("ParkedTransferFulfilled(uint256,address,address,bytes32,uint256)"),
  upgraded: topic("Upgraded(address)"),
};
const ZERO = "0x0000000000000000000000000000000000000000";

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

/** A `BoundedVec<u8>` storage value: compact(len) ++ bytes (from _probeBasejumpLandingUpgrade.ts). */
function boundedBytes(hex: string): string {
  const n = (hex.length - 2) / 2;
  const byte = (v: number) => (v & 0xff).toString(16).padStart(2, "0");
  let prefix: string;
  if (n < 1 << 6) prefix = byte(n << 2);
  else if (n < 1 << 14) prefix = byte((n << 2) | 0b01) + byte((n << 2) >> 8);
  else if (n < 1 << 30) prefix = [0, 8, 16, 24].map((s) => byte(((n << 2) | 0b10) >>> s)).join("");
  else throw new Error(`boundedBytes: ${n} exceeds the 4-byte compact mode`);
  return `0x${prefix}${hex.slice(2)}`;
}

/** Solidity mapping slot: keccak256(abi.encode(key, slot)). */
const mapSlot = (keyType: "address" | "uint256", key: Hex | bigint, slot: bigint): Hex =>
  keccak256(encodeAbiParameters([{ type: keyType }, { type: "uint256" }], [key as never, slot]));
const plusSlot = (base: Hex, i: bigint): Hex => numberToHex(BigInt(base) + i, { size: 32 });
const simpleSlot = (n: bigint): Hex => numberToHex(n, { size: 32 });

const results: { step: string; ok: boolean }[] = [];
const record = (step: string, ok: boolean, detail = ""): boolean => {
  results.push({ step, ok });
  const n = String(results.length).padStart(2, "0");
  console.log(`   ${n} ${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
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
  const accepted: { hash: Hex; from: Hex; to: string | undefined; data: Hex; nonce: number }[] = [];
  const sent: Sent[] = [];
  const nonces = new Map<string, number>();
  /** Every eth_call / eth_estimateGas seen, with its sender and selector: the dry-run checks read these. */
  const calls: { method: string; from: string; to: string; selector: string }[] = [];
  /** Every eth_getStorageAt answered, with the block it was read at. */
  const storageReads: { slot: string; at: string }[] = [];
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
        accepted.push({ hash, from: from as Hex, to: tx.to ?? undefined, data: (tx.data ?? "0x") as Hex, nonce: tx.nonce ?? expected });
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
      case "eth_getTransactionByHash": {
        // viem's waitForTransactionReceipt starts here; the fork has no such method, which made it
        // throw at once, so a poke returned before its own receipt. Answered like a node: pending
        // (blockNumber null) until sealed.
        const h = String(params[0]).toLowerCase();
        const a = accepted.find((x) => x.hash.toLowerCase() === h);
        if (!a) return null;
        const s = sent.find((x) => x.hash.toLowerCase() === h);
        return {
          hash: a.hash,
          from: a.from,
          to: a.to ?? null,
          input: a.data,
          nonce: numberToHex(a.nonce),
          value: "0x0",
          gas: "0x0",
          gasPrice: "0x0",
          type: "0x0",
          blockHash: s?.blockHash ?? null,
          blockNumber: s ? numberToHex(s.blockNumber) : null,
          transactionIndex: s ? "0x0" : null,
          v: "0x0",
          r: "0x0",
          s: "0x0",
        };
      }
      case "eth_gasPrice": {
        // The fork's quote can sit below the price it charges when it seals the next block, and a
        // transaction priced under that is not included at all. Quote twice the fork's price, so
        // the probe tests the relayer and not the fork's fee drift (see the report).
        return numberToHex(BigInt((await forward("eth_gasPrice", [])) as string) * GAS_PRICE_HEADROOM);
      }
      case "eth_getBlockByNumber": {
        // The keeper reads parked entries at the finalized head. Answer that tag from the fork's
        // own finalized head (chain_getFinalizedHead), asked for by number; any other tag forwards.
        if (params[0] !== "finalized") throw new Error("forward");
        const hash = (await forward("chain_getFinalizedHead", [])) as string;
        const header = (await forward("chain_getHeader", [hash])) as { number: string };
        return forward("eth_getBlockByNumber", [header.number, params[1] ?? false]);
      }
      case "eth_getStorageAt": {
        const tag = params[2];
        let at: string | undefined;
        if (!process.env.SHIM_STORAGE_AT_HEAD && typeof tag === "string" && /^0x[0-9a-fA-F]+$/.test(tag) && tag.length <= 18) {
          at = (await net.client._request<string | null>("chain_getBlockHash", [Number(BigInt(tag))])) ?? undefined;
          if (!at) throw new Error(`no block ${tag}`);
        }
        storageReads.push({ slot: String(params[1]), at: at ?? "head" });
        const raw = await retry("AccountStorages", () =>
          api.query.EVM.AccountStorages.getValue(params[0] as Hex, params[1] as Hex, at ? { at } : {}),
        );
        const hex = typeof raw === "string" ? raw : (raw as { asHex?: () => string })?.asHex?.() ?? "0x";
        return pad((hex === "0x" ? "0x00" : hex) as Hex, { size: 32 });
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
      default: {
        if (method === "eth_call" || method === "eth_estimateGas") {
          const p = (params[0] ?? {}) as { from?: string; to?: string; data?: string; input?: string };
          calls.push({
            method,
            from: String(p.from ?? "").toLowerCase(),
            to: String(p.to ?? "").toLowerCase(),
            selector: String(p.data ?? p.input ?? "0x").slice(0, 10).toLowerCase(),
          });
        }
        throw new Error("forward");
      }
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
    calls: typeof calls;
    storageReads: typeof storageReads;
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
        calls,
        storageReads,
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
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> }).registry) as any;
    const bridge = privateKeyToAccount(BRIDGE_PK);
    const keeperKey = privateKeyToAccount(KEEPER_PK);
    const deployer = privateKeyToAccount(DEPLOYER_PK);
    const bridgeClient = new EthClient(hydration, bridge, { chainId: HYDRATION_EVM_CHAIN_ID });
    const deployerClient = new EthClient(hydration, deployer, { chainId: HYDRATION_EVM_CHAIN_ID });
    const landingSub = ss58(truncatedEvmAccount(LANDING));
    const keeperAddr = keeperKey.address.toLowerCase();

    const clients = await hydrationClients(shim.url, KEEPER_PK);
    const pub = clients.publicClient;
    const read = <R>(fn: string, args: unknown[] = []): Promise<R> =>
      retry(fn, () => pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: fn as never, args: args as never })) as Promise<R>;
    const usdc = async (acct: string): Promise<bigint> => {
      const v = (await retry("usdc", () => api.query.Tokens.Accounts.getValue(acct, USDC_ASSET_ID))) as
        | { free?: bigint }
        | undefined;
      return v?.free ?? 0n;
    };
    const setPool = async (free: bigint) => {
      await shim.sealed();
      await hydration.setStorage({ Tokens: { Accounts: [[[landingSub, USDC_ASSET_ID], { free }]] } });
    };
    /** pallet_evm storage word of the landing proxy, at the fork head. */
    const word = async (slot: Hex): Promise<Hex> => {
      const raw = await retry("AccountStorages", () => api.query.EVM.AccountStorages.getValue(LANDING, slot));
      const hex = typeof raw === "string" ? raw : (raw as { asHex?: () => string })?.asHex?.() ?? "0x";
      return pad((hex === "0x" ? "0x00" : hex) as Hex, { size: 32 });
    };
    const implNow = async (): Promise<Hex> => getAddress(`0x${(await word(ERC1967_IMPL_SLOT as Hex)).slice(-40)}`);
    const eventsAt = async (at: string) =>
      (await retry("events", () => api.query.System.Events.getValue({ at }))) as EventRecord[];
    const revertOf = async (fn: "fulfillPending" | "parkPending" | "fulfillParked", args: unknown[] = []): Promise<string> => {
      try {
        await pub.simulateContract({ address: LANDING, abi: LANDING_ABI, functionName: fn as never, args: args as never, account: deployer.address });
        return "no revert";
      } catch (e) {
        const m = (e as Error).message ?? String(e);
        return /Error: (\w+)\(/.exec(m)?.[1] ?? m.split("\n")[0];
      }
    };

    const blockNo = await retry("block", () => pub.getBlockNumber());
    console.log(`\n🥢 Basejump park run — fork of Hydration at block ${blockNo}`);
    const assetInfo = await retry("registry", () => api.query.AssetRegistry.Assets.getValue(USDC_ASSET_ID));
    const ed = (assetInfo as { existential_deposit?: bigint } | undefined)?.existential_deposit ?? 0n;
    const TINY = ed > 1n ? ed - 1n : 1n;
    console.log(`   USDC (asset 21) existential deposit ${ed}; the unpayable head is ${TINY} units`);

    // ── setup: gas for the three keys, deployer whitelisted, bridge authorized ──
    for (const who of [bridge.address, keeperKey.address, deployer.address]) {
      const sub = ss58(truncatedEvmAccount(who));
      await hydration.setStorage({
        System: { Account: [[[sub], { providers: 1, data: { free: 1_000_000n * HDX_UNIT } }]] },
        Tokens: { Accounts: [[[sub, WETH_ASSET_ID], { free: 10n ** 18n }]] },
      });
    }
    await hydration.setStorage({ EVMAccounts: { ContractDeployer: [[[deployer.address], true]] } });
    await hydration.setStorage({
      EVM: { AccountStorages: [[[LANDING, mapSlot("address", bridge.address, 1n)], pad(numberToHex(1), { size: 32 })]] },
    });

    const queuePayout = async (amount: bigint, recipient: Hex): Promise<bigint | undefined> => {
      await shim.sealed();
      const res = await bridgeClient.call(
        LANDING,
        encodeFunctionData({ abi: LANDING_ABI, functionName: "transfer", args: [USDC_SOURCE, amount, recipient, "0x"] }),
      );
      const evs = await eventsAt(res.blockHash);
      const logs = findEvmLogs(evs, T.queued, LANDING);
      return checkIfEthereumExecuted(evs) && logs.length === 1 ? BigInt(logs[0].topics[1] as string) : undefined;
    };

    // The relayer: queue (nonce lane), keeper, alert sink, a clock we hold still (no time-based alerts).
    const clock = 0;
    const newKeeper = async () => {
      const queue = createQueue({ publicClient: pub, account: clients.account, warnMultiplier: 2n });
      await queue.init();
      return createPayoutKeeper({
        clients,
        queue,
        landing: LANDING,
        alertAfterMs: ALERT_AFTER_MS,
        receiptTimeoutMs: RECEIPT_TIMEOUT_MS,
        notify: discordNotifier(hook.url),
        now: () => clock,
      });
    };
    const keeperTxs = () => shim.accepted.filter((s) => s.from === keeperAddr);
    const keeperSealed = () => shim.sent.filter((s) => s.from === keeperAddr);
    const keeperCalls = () => shim.calls.filter((c) => c.from === keeperAddr && c.to === LANDING);
    const pokeSettled = async (k: { poke: () => Promise<void> }, n = 1) => {
      for (let i = 0; i < n; i++) {
        await k.poke();
        await shim.sealed();
      }
    };

    // ── 1. Before the upgrade ──
    console.log(`\n── 1. Live landing before the upgrade ──`);
    const implBefore = await implNow();
    const codeBefore = ((await pub.getCode({ address: implBefore })) ?? "0x").toLowerCase();
    record(
      "live implementation cannot park (no parkedTransfers / parkPending selector) and takes the 4-argument transfer",
      codeBefore.length > 2 &&
        !codeBefore.includes(PARKED_TRANSFERS_SELECTOR) &&
        !codeBefore.includes(SEL.parkPending.slice(2)) &&
        codeBefore.includes(SEL.transfer4.slice(2)),
      `${implBefore}, ${(codeBefore.length - 2) / 2} bytes`,
    );
    const head0 = await read<bigint>("pendingHead");
    const tail0 = await read<bigint>("pendingTail");
    record("live queue empty at the fork block", head0 === tail0, `head ${head0}, tail ${tail0}`);

    await setPool(0n);
    const idL = await queuePayout(LEGACY, RECIPIENT);
    record(`a ${LEGACY}-unit payout queues on the PRE-upgrade implementation (legacy entry)`, idL === tail0, `id ${idL}`);

    const keeper1 = await newKeeper();
    await pokeSettled(keeper1, 2);
    record("pre-upgrade, pool empty: the keeper sends nothing and posts nothing", keeperTxs().length === 0 && hook.posts.length === 0);

    // Raw storage of everything the upgrade must keep, plus the slots 6-8 entries it appends.
    const L = idL ?? tail0;
    const ptBase = mapSlot("uint256", L, 5n);
    const watched: Record<string, Hex> = {
      "slot0 owner": simpleSlot(0n),
      "slot3 pendingHead": simpleSlot(3n),
      "slot4 pendingTail": simpleSlot(4n),
      "authorizedBridges[receiver]": mapSlot("address", ETHEREUM_RECEIVER, 1n),
      "authorizedBridges[bridge]": mapSlot("address", bridge.address, 1n),
      "destAssetFor[Ethereum USDC]": mapSlot("address", USDC_SOURCE, 2n),
      "pendingTransfers[L].sourceAsset": plusSlot(ptBase, 0n),
      "pendingTransfers[L].amount": plusSlot(ptBase, 1n),
      "pendingTransfers[L].recipient": plusSlot(ptBase, 2n),
      "reservedFor[USDC] (slot 6)": mapSlot("address", USDC_PRECOMPILE, 6n),
      "reservedAssetOf[L] (slot 7)": mapSlot("uint256", L, 7n),
      "parkedTransfers[L].sourceAsset (slot 8)": mapSlot("uint256", L, 8n),
    };
    const snapshot = async () => {
      const out: Record<string, Hex> = {};
      for (const [k, s] of Object.entries(watched)) out[k] = await word(s);
      return out;
    };
    const before = await snapshot();
    const poolBeforeUpgrade = await usdc(landingSub);
    const getterBefore = {
      owner: await read<Hex>("owner"),
      head: await read<bigint>("pendingHead"),
      tail: await read<bigint>("pendingTail"),
      entry: await read<[Hex, bigint, Hex]>("pendingTransfers", [L]),
    };
    record(
      "slots 6-8 entries read zero before the upgrade",
      BigInt(before["reservedFor[USDC] (slot 6)"]) === 0n &&
        BigInt(before["reservedAssetOf[L] (slot 7)"]) === 0n &&
        BigInt(before["parkedTransfers[L].sourceAsset (slot 8)"]) === 0n,
    );
    record(
      "owner is the emergency admin",
      getterBefore.owner.toLowerCase() === EMERGENCY_ADMIN.toLowerCase(),
    );

    // ── 2. Upgrade through the TC origin ──
    console.log(`\n── 2. Deploy this branch's BasejumpLanding and upgrade the proxy (TC origin, scheduler) ──`);
    await shim.sealed();
    const { address: impl, res: dep } = await deployerClient.deploy(LANDING_ARTIFACT.bytecode.object);
    record("implementation deployed", checkIfEthereumExecuted(await eventsAt(dep.blockHash)), impl);
    const members = (await retry("TC members", () => api.query.TechnicalCommittee.Members.getValue())) as unknown[];
    const threshold = Math.ceil(members.length / 2);
    const evmInput = encodeFunctionData({ abi: LANDING_ABI, functionName: "upgradeToAndCall", args: [impl, "0x"] });
    const inner = meta.tx.evm.call(EMERGENCY_ADMIN, LANDING, evmInput, 0, UPGRADE_GAS_LIMIT, UPGRADE_MAX_FEE_PER_GAS, null, null, [], []);
    const call = meta.tx.dispatcher.dispatchAsEmergencyAdmin(inner);
    const callBytes = call.toU8a();
    const callHash = registry.hash(callBytes).toHex();
    const nowBlock = (await retry("number", () => api.query.System.Number.getValue())) as number;
    await hydration.setStorage({ Preimage: { PreimageFor: [[[[callHash, callBytes.length]], boundedBytes(call.toHex())]] } });
    await hydration.setStorage({
      Scheduler: {
        Agenda: [[[nowBlock + 1], [{
          call: { Lookup: { hash: callHash, len: callBytes.length } },
          origin: { TechnicalCommittee: { Members: [threshold, members.length] } },
          maybeId: null, priority: 0, maybePeriodic: null,
        }]]],
      },
    });
    const { hash: upgradeBlock } = await (hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }).newBlock();
    const upEvs = await eventsAt(upgradeBlock);
    const dispatched = upEvs.some(({ event }) => event.type === "Scheduler" && event.value.type === "Dispatched");
    if (!dispatched) logEvents(upEvs);
    record(
      `scheduler dispatched the call from TechnicalCommittee.Members(${threshold}, ${members.length})`,
      dispatched,
    );
    record("Upgraded(impl) logged by the landing proxy", findEvmLogs(upEvs, T.upgraded, LANDING).some((l) => (l.topics[1] as string).toLowerCase().endsWith(impl.slice(2).toLowerCase())));
    const implAfter = await implNow();
    record("ERC-1967 slot now names the new implementation", implAfter.toLowerCase() === impl.toLowerCase(), implAfter);

    // ── 3. Storage survived ──
    console.log(`\n── 3. Storage across the upgrade ──`);
    const after = await snapshot();
    const changed = Object.keys(watched).filter((k) => before[k] !== after[k]);
    record(`all ${Object.keys(watched).length} watched raw storage words byte-identical`, changed.length === 0, changed.join(", ") || "none changed");
    const entryAfter = await read<[Hex, bigint, Hex]>("pendingTransfers", [L]);
    record(
      "getters agree: owner, head, tail and the legacy entry unchanged",
      (await read<Hex>("owner")) === getterBefore.owner &&
        (await read<bigint>("pendingHead")) === getterBefore.head &&
        (await read<bigint>("pendingTail")) === getterBefore.tail &&
        entryAfter[0] === getterBefore.entry[0] && entryAfter[1] === getterBefore.entry[1] && entryAfter[2] === getterBefore.entry[2],
      `entry #${L}: ${entryAfter[1]} units`,
    );
    record(
      "new getters: reservedFor[USDC] 0, reservedAssetOf[L] 0, parkedTransfers[L] empty, PARK_DISPATCH_GAS 500000",
      (await read<bigint>("reservedFor", [USDC_PRECOMPILE])) === 0n &&
        (await read<Hex>("reservedAssetOf", [L])) === ZERO &&
        (await read<[Hex, bigint, Hex]>("parkedTransfers", [L]))[0] === ZERO &&
        (await read<bigint>("PARK_DISPATCH_GAS")) === 500_000n,
    );
    record("pool balance unchanged", (await usdc(landingSub)) === poolBeforeUpgrade);

    // ── 4. A funded head whose dispatch fails, with a payable entry behind it ──
    console.log(`\n── 4. Queue the unpayable head A and the payable entry B ──`);
    const idA = await queuePayout(TINY, EMPTY_RECIPIENT);
    const idB = await queuePayout(BEHIND, RECIPIENT);
    record(`A: ${TINY} units to an empty account queues`, idA === L + 1n, `id ${idA}`);
    record(`B: ${BEHIND} units to a funded account queues behind it`, idB === L + 2n, `id ${idB}`);
    const A = idA ?? L + 1n;
    const B = idB ?? L + 2n;
    record(
      "reservations: reservedFor[USDC] = A + B (the legacy entry reserved nothing), reservedAssetOf[A] = USDC",
      (await read<bigint>("reservedFor", [USDC_PRECOMPILE])) === TINY + BEHIND &&
        (await read<Hex>("reservedAssetOf", [A])).toLowerCase() === USDC_PRECOMPILE &&
        (await read<Hex>("reservedAssetOf", [L])) === ZERO,
    );

    // The legacy head is paid; A becomes the head with the pool empty again.
    await setPool(LEGACY);
    const recip0 = await usdc(ss58(RECIPIENT));
    await pokeSettled(keeper1);
    await pokeSettled(keeper1);
    record("the keeper paid the legacy head with fulfillPending (one send, succeeded)",
      keeperSealed().length === 1 && keeperSealed()[0].data === SEL.fulfillPending && keeperSealed()[0].ok &&
        (await usdc(ss58(RECIPIENT))) - recip0 === LEGACY,
      `${keeperSealed().length} sent`);
    record("A is the head, pool empty", (await read<bigint>("pendingHead")) === A && (await usdc(landingSub)) === 0n);

    // Unfunded head: never parked.
    const callsBeforeUnfunded = keeperCalls().length;
    await pokeSettled(keeper1, 3);
    record("unfunded A: the keeper sends nothing over 3 pokes", keeperTxs().length === 1, `${keeperTxs().length - 1} new`);
    record("unfunded A: the keeper does not even dry-run parkPending",
      !keeperCalls().slice(callsBeforeUnfunded).some((c) => c.selector === SEL.parkPending));
    record("the landing refuses to park an unfunded head (parkPending dry run reverts InsufficientBalance)",
      (await revertOf("parkPending")) === "InsufficientBalance");
    record("no post yet", hook.posts.length === 0, hook.posts.join(" | "));

    // Funded: fulfillPending reverts DispatchFailed independently of the keeper.
    await setPool(FLOAT);
    record("funded A: fulfillPending dry run reverts DispatchFailed (independent of the keeper)",
      (await revertOf("fulfillPending")) === "DispatchFailed");

    // ── 5. The keeper parks A ──
    console.log(`\n── 5. The keeper parks A ──`);
    const callsBeforePark = keeperCalls().length;
    const txBeforePark = keeperTxs().length;
    const postsBeforePark = hook.posts.length;
    await pokeSettled(keeper1);
    const parkTxs = keeperSealed().slice(txBeforePark);
    const parkCalls = keeperCalls().slice(callsBeforePark);
    const firstFp = parkCalls.findIndex((c) => c.method === "eth_call" && c.selector === SEL.fulfillPending);
    const firstPp = parkCalls.findIndex((c) => c.method === "eth_call" && c.selector === SEL.parkPending);
    record("dry runs: fulfillPending first, then parkPending", firstFp >= 0 && firstPp > firstFp, `fp@${firstFp} pp@${firstPp}`);
    record("exactly one transaction: parkPending(), mined, status ok",
      parkTxs.length === 1 && parkTxs[0].data === SEL.parkPending && parkTxs[0].to?.toLowerCase() === LANDING && parkTxs[0].ok,
      parkTxs.map((t) => `${t.data} ${t.ok ? "ok" : "reverted"}`).join(", "));
    let parkBlock = "";
    if (parkTxs[0]) {
      parkBlock = parkTxs[0].blockHash;
      const evs = await eventsAt(parkBlock);
      const parkedLogs = findEvmLogs(evs, T.parked, LANDING);
      record(`TransferParked(#${A}) in its block, no PendingTransferFulfilled`,
        parkedLogs.length === 1 && BigInt(parkedLogs[0].topics[1] as string) === A && findEvmLogs(evs, T.fulfilled, LANDING).length === 0);
    } else {
      record(`TransferParked(#${A}) in its block, no PendingTransferFulfilled`, false, "no park tx");
    }
    const parkedA = await read<[Hex, bigint, Hex]>("parkedTransfers", [A]);
    record("parkedTransfers[A] holds (Ethereum USDC, amount, recipient)",
      parkedA[0].toLowerCase() === USDC_SOURCE.toLowerCase() && parkedA[1] === TINY && parkedA[2].toLowerCase() === EMPTY_RECIPIENT.toLowerCase());
    record("head advanced to B; pool untouched; A keeps its reservation",
      (await read<bigint>("pendingHead")) === B && (await usdc(landingSub)) === FLOAT &&
        (await read<bigint>("reservedFor", [USDC_PRECOMPILE])) === TINY + BEHIND &&
        (await read<Hex>("reservedAssetOf", [A])).toLowerCase() === USDC_PRECOMPILE);
    const parkPosts = hook.posts.slice(postsBeforePark);
    record("one parked alert, naming A, this keeper's own parkPending and the pool",
      parkPosts.length === 1 && parkPosts[0].includes(`payout #${A} of`) && parkPosts[0].includes("parked on landing") &&
        parkPosts[0].includes("by this keeper's parkPending") && parkPosts[0].includes("pool holding"),
      parkPosts[0] ?? "none");
    record("the park ended the round: B not paid in the same poke", (await read<bigint>("pendingHead")) === B);

    // ── 6. The next poke pays B ──
    console.log(`\n── 6. The keeper moves on and pays B ──`);
    const recipB = await usdc(ss58(RECIPIENT));
    const txBeforeB = keeperTxs().length;
    await pokeSettled(keeper1, 2);
    const bTxs = keeperSealed().slice(txBeforeB);
    record("B paid with one fulfillPending", bTxs.length === 1 && bTxs[0].data === SEL.fulfillPending && bTxs[0].ok, `${bTxs.length} sent`);
    record("recipient +1 USDC; queue empty; reservation left = A only",
      (await usdc(ss58(RECIPIENT))) - recipB === BEHIND && (await read<bigint>("pendingHead")) === (await read<bigint>("pendingTail")) &&
        (await read<bigint>("reservedFor", [USDC_PRECOMPILE])) === TINY);
    record("still exactly one parked alert (scan reached A and did not repost)", hook.posts.length === postsBeforePark + 1, `${hook.posts.length - postsBeforePark}`);
    record("exactly one parkPending ever sent", keeperTxs().filter((t) => t.data === SEL.parkPending).length === 1);

    // ── 7. Restart: the startup scan from id 0 re-alerts A ──
    console.log(`\n── 7. Restart ──`);
    const postsBeforeRestart = hook.posts.length;
    const txBeforeRestart = keeperTxs().length;
    const keeper2 = await newKeeper();
    await pokeSettled(keeper2, 2);
    const restartPosts = hook.posts.slice(postsBeforeRestart);
    record("restarted keeper: exactly one alert, A parked, read from the scan (not its own park)",
      restartPosts.length === 1 && restartPosts[0].includes(`payout #${A} of`) && restartPosts[0].includes("parked on landing") &&
        !restartPosts[0].includes("by this keeper's") && restartPosts[0].includes("head then"),
      restartPosts[0] ?? "none");
    record("restarted keeper sends nothing", keeperTxs().length === txBeforeRestart);

    // ── 8. The cause is fixed; a human pays the parked entry ──
    console.log(`\n── 8. A becomes payable; fulfillParked by a human ──`);
    const emptySub = ss58(EMPTY_RECIPIENT);
    await shim.sealed();
    await hydration.setStorage({
      System: { Account: [[[emptySub], { providers: 1, data: { free: 0n } }]] },
      Tokens: { Accounts: [[[emptySub, USDC_ASSET_ID], { free: ed }]] },
    });
    record("fulfillParked(A) dry run now passes", (await revertOf("fulfillParked", [A])) === "no revert");
    const txBeforeFix = keeperTxs().length;
    const postsBeforeFix = hook.posts.length;
    await pokeSettled(keeper1, 2);
    await pokeSettled(keeper2, 2);
    record("with A payable, neither keeper sends anything (it never calls fulfillParked)", keeperTxs().length === txBeforeFix);
    record("no keeper dry run of fulfillParked either", !shim.calls.some((c) => c.from === keeperAddr && c.selector === SEL.fulfillParked));

    await shim.sealed();
    const poolBeforeFp = await usdc(landingSub);
    const emptyBefore = await usdc(emptySub);
    const fp = await deployerClient.call(LANDING, encodeFunctionData({ abi: LANDING_ABI, functionName: "fulfillParked", args: [A] }));
    const fpEvs = await eventsAt(fp.blockHash);
    const fpLogs = findEvmLogs(fpEvs, T.parkedFulfilled, LANDING);
    record(`fulfillParked(#${A}) succeeded: ParkedTransferFulfilled(#${A})`,
      checkIfEthereumExecuted(fpEvs) && fpLogs.length === 1 && BigInt(fpLogs[0].topics[1] as string) === A);
    record("payout landed: recipient +amount, pool -amount",
      (await usdc(emptySub)) - emptyBefore === TINY && poolBeforeFp - (await usdc(landingSub)) === TINY,
      `${emptyBefore} -> ${await usdc(emptySub)}`);
    record("A left parkedTransfers; reservedFor[USDC] 0; reservedAssetOf[A] 0",
      (await read<[Hex, bigint, Hex]>("parkedTransfers", [A]))[0] === ZERO &&
        (await read<bigint>("reservedFor", [USDC_PRECOMPILE])) === 0n &&
        (await read<Hex>("reservedAssetOf", [A])) === ZERO);

    await pokeSettled(keeper1, 2);
    await pokeSettled(keeper2, 2);
    const afterFix = hook.posts.slice(postsBeforeFix);
    record("after the human paid A, the running keepers post nothing (no all-clear, no false alert)", afterFix.length === 0, afterFix.join(" | ") || "0 posts");
    const keeper3 = await newKeeper();
    const postsBefore3 = hook.posts.length;
    await pokeSettled(keeper3, 2);
    record("a fresh restart after the fix posts nothing (the entry is gone from parkedTransfers)", hook.posts.length === postsBefore3, hook.posts.slice(postsBefore3).join(" | ") || "0 posts");

    // ── 9. Totals ──
    console.log(`\n── 9. Totals ──`);
    const all = keeperTxs();
    record("keeper wallet sent exactly 3 transactions: fulfillPending, parkPending, fulfillPending",
      all.map((t) => t.data).join(",") === [SEL.fulfillPending, SEL.parkPending, SEL.fulfillPending].join(","),
      all.map((t) => t.data).join(","));
    record("keeper wallet never sent fulfillParked", !all.some((t) => t.data.startsWith(SEL.fulfillParked)));
    record("the fork included every transaction sent", shim.dropped.length === 0, `${shim.dropped.length} not included`);
    const atBlock = shim.storageReads.filter((r) => r.at !== "head").length;
    console.log(`\n   eth_getStorageAt answered: ${shim.storageReads.length} (${atBlock} at a named block, ${shim.storageReads.length - atBlock} at head)`);
    console.log(`\n── Every post ──`);
    hook.posts.forEach((p, i) => console.log(`   [${i}] ${p}`));
    console.log(`\n── Every transaction the keeper wallet sent ──`);
    for (const s of keeperSealed()) console.log(`   block ${s.blockNumber} ${s.hash} data ${s.data} ${s.ok ? "ok" : "reverted"}`);
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
