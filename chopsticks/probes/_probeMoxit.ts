/**
 * PROBE (Moonbeam eXIT / "moxit"): verify a governance-driven Wormhole TokenBridge transfer that
 * originates on Hydration and lands on Moonbeam **as the Hydration Sovereign Account (SA)**.
 *
 * Flow simulated (end-to-end, both chopsticks forks + auto-HRMP):
 *
 *   Hydration governance (Root) ──PolkadotXcm.send──▶ Moonbeam
 *      inner XCM Transact (originKind: SovereignAccount) runs as para-2034 SA:
 *          EthereumXcm.transact → Utility.batch([ ERC20.approve, TokenBridge.transferTokens* ])
 *      TokenBridge calls Wormhole Core → **LogMessagePublished**
 *
 * You supply the encoded `PolkadotXcm.send(dest, message)` RuntimeCall (the WHOLE call, SCALE hex —
 * pallet+call index + args, NOT a signed extrinsic) in `XCM_SEND_CALL`. The probe dispatches it with
 * a **Root** origin on Hydration (via a one-shot Scheduler.Agenda injection — a Signed origin would
 * descend into a *derivative* account on Moonbeam, not the SA), relays HRMP → Moonbeam, then scans
 * Moonbeam's events for the Wormhole Core `LogMessagePublished` EVM log = "the calldata worked".
 *
 * Leave XCM_SEND_CALL empty to run DEMO mode: builds a trivial Root `PolkadotXcm.send([ClearOrigin])`
 * to exercise the Root-dispatch + HRMP plumbing end-to-end (no TokenBridge — used to validate the
 * harness itself).
 *
 *   RUNTIME_LOG_LEVEL=3 npx tsx chopsticks/_probeMoxit.ts
 */
import {
  createPublicClient,
  decodeEventLog,
  encodeEventTopics,
  erc20Abi,
  getAddress,
  http,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { Binary } from "polkadot-api";

import { acc } from "@galacticcouncil/common";

import { configs } from "../lib/configs";
import {
  checkIfQueueFailed,
  checkIfQueueProcessed,
  checkIfXcmError,
  checkIfXcmSent,
  findEvent,
  logEvents,
  type EventRecord,
} from "../lib/events";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { getEventsAt } from "../lib/queries";
import { toJson } from "../lib/utils";

import { PRIME_TEST_EXIT } from "./payloads";

// ─── Chains / addresses ──────────────────────────────────────────

const HYDRATION_PARA_ID = 2034;
const MOONBEAM_PARA_ID = 2004;

/** Wormhole Core + TokenBridge on Moonbeam (prod — nintent/basejump env files). */
const WORMHOLE_CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3");
const TOKEN_BRIDGE = getAddress("0xB1731c586ca89a23809861c6103F0b96B3F57D92");

/** Token the batch bridges (transferTokensWithPayload arg0 in PRIME_TEST_EXIT). */
const PRIME_TOKEN = getAddress("0x52b2f622f5676e92dbea3092004eb9ffb85a8d07");

/** Hydration's Sovereign Account on Moonbeam (H160) — the msg.sender of the batch. */
const HYDRATION_SA_MOONBEAM = acc.getSovereignAccounts(HYDRATION_PARA_ID).moonbeam as Hex;

// ─── Inputs ──────────────────────────────────────────────────────

/**
 * PASTE YOUR CALLDATA HERE — the full SCALE-encoded `PolkadotXcm.send(dest, message)` RuntimeCall
 * as it would be dispatched on Hydration. Empty string ⇒ DEMO mode (see file header).
 */
const XCM_SEND_CALL: Hex | "" = PRIME_TEST_EXIT;
/** GLMR to top the SA up with on Moonbeam so its Transact/BuyExecution + EVM gas is covered. */
const SA_GLMR_TOPUP = 100n * 10n ** 18n; // 100 GLMR

/** How many Moonbeam blocks to build while waiting for the relayed XCM to land + execute. */
const MOONBEAM_RELAY_BLOCKS = 3;

// ─── Wormhole Core LogMessagePublished topic0 ────────────────────

const WORMHOLE_CORE_ABI = [
  {
    type: "event",
    name: "LogMessagePublished",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "sequence", type: "uint64", indexed: false },
      { name: "nonce", type: "uint32", indexed: false },
      { name: "payload", type: "bytes", indexed: false },
      { name: "consistencyLevel", type: "uint8", indexed: false },
    ],
  },
] as const satisfies Abi;

const LOG_MESSAGE_PUBLISHED = encodeEventTopics({
  abi: WORMHOLE_CORE_ABI,
  eventName: "LogMessagePublished",
})[0]!.toLowerCase();

// ─── Helpers ─────────────────────────────────────────────────────

/** Normalize a papi byte value (Binary / FixedSizeBinary / Uint8Array / hex string) to lowercase hex. */
function toHexStr(x: unknown): string {
  if (x == null) return "";
  if (typeof x === "string") return x.toLowerCase();
  const anyx = x as { asHex?: () => string };
  if (typeof anyx.asHex === "function") return anyx.asHex().toLowerCase();
  if (x instanceof Uint8Array) {
    return "0x" + Array.from(x, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return String(x).toLowerCase();
}

/**
 * Dispatch an arbitrary encoded RuntimeCall with a **Root** origin by scheduling it for the next
 * block (chopsticks' `Scheduler::on_initialize` runs it as Root — the standard way to simulate a
 * governance/referenda outcome on a fork). Returns the sealed block hash + its events.
 *
 * The call is stored as a **preimage** and referenced by `Bounded::Lookup{hash,len}` rather than
 * `Inline`: a large call (a `PolkadotXcm.send` is ~900 bytes) overflows `BoundedInline`, so an
 * inlined agenda entry decodes as "Corrupted state" in the runtime and is silently skipped (no
 * dispatch). Lookup keeps the agenda entry tiny (just hash+len). blake2-256 comes from the fork's
 * own `@polkadot/types` registry (the @polkadot/* packages don't hoist to this package).
 */
async function dispatchCallAsRoot(
  net: Network,
  callHex: Hex,
): Promise<{ blockHash: string; events: EventRecord[] }> {
  const when = net.chain.head.number + 1;

  const callBytes = Binary.fromHex(callHex);
  const len = callBytes.length;
  const registry = await net.chain.head.registry;
  const hash = registry.hash(callBytes).toHex() as Hex; // blake2-256(call)

  await net.setStorage({
    // Note the preimage so the scheduler can `fetch(hash, len)` the call at dispatch time. Pass the
    // bytes as a number[] (not a hex string) so chopsticks SCALE-encodes it as BoundedVec<u8> with a
    // compact length prefix — a raw hex string gets stored verbatim and the runtime then misreads the
    // call's leading bytes as the length ⇒ "Corrupted state".
    Preimage: { PreimageFor: [[[[hash, len]], Array.from(callBytes)]] },
    Scheduler: {
      Agenda: [
        [
          [when],
          [
            {
              maybeId: null,
              priority: 0,
              call: { Lookup: { hash, len } },
              maybePeriodic: null,
              origin: { system: "Root" },
            },
          ],
        ],
      ],
    },
  });

  const block = await net.chain.newBlock();
  const events = await eventsAt(net, block.hash, true); // Hydration → typed decoder
  return { blockHash: block.hash, events };
}

/**
 * Build a trivial Root `PolkadotXcm.send([ClearOrigin])` to Moonbeam (DEMO-mode plumbing check).
 * Uses the **unsafe** api so the call is encoded against the live runtime metadata — the typed
 * descriptor's `PolkadotXcm.send` entry has drifted from mainnet ("Incompatible runtime entry").
 * The real path never hits this: it injects your pre-encoded hex straight into Scheduler.Inline.
 */
async function buildDemoSendCall(net: Network): Promise<Hex> {
  const api = net.client.getUnsafeApi();
  const call = api.tx.PolkadotXcm.send({
    dest: {
      type: "V4",
      value: {
        parents: 1,
        interior: { type: "X1", value: [{ type: "Parachain", value: MOONBEAM_PARA_ID }] },
      },
    },
    message: { type: "V4", value: [{ type: "ClearOrigin", value: undefined }] },
  });
  return Binary.toHex(await call.getEncodedData()) as Hex;
}

/** Scan events (Moonbeam, via unsafe api shape) for an EVM.Log from `address` with `topic0`. */
function findEvmLog(
  events: EventRecord[],
  address: string,
  topic0: string,
): { found: boolean; topics: Hex[]; data: Hex } {
  const addr = address.toLowerCase();
  for (const { event } of events) {
    const ev = event as {
      type: string;
      value: {
        type: string;
        value: { log?: { address?: unknown; topics?: unknown[]; data?: unknown } };
      };
    };
    if (ev.type !== "EVM" || ev.value?.type !== "Log") continue;
    const log = ev.value.value?.log;
    if (!log) continue;
    if (toHexStr(log.address) !== addr) continue;
    const topics = ((log.topics ?? []) as unknown[]).map((t) => toHexStr(t) as Hex);
    if (topics[0] === topic0.toLowerCase()) {
      return { found: true, topics, data: toHexStr(log.data) as Hex };
    }
  }
  return { found: false, topics: [], data: "0x" };
}

/**
 * Decode a Wormhole TokenBridge transfer body (the `payload` of `LogMessagePublished`). Branches on
 * payloadID: 1 = `Transfer` (…toChain, **fee**), 3 = `TransferWithPayload` (…toChain, fromAddress,
 * arbitrary app payload). Common head: id(1) amount(32) tokenAddress(32) tokenChain(2) to(32) toChain(2).
 * `tokenChain` ≠ Moonbeam (16) ⇒ the asset is Wormhole-wrapped, so a transfer **burns** it.
 */
function decodeTransfer(payload: Hex): Record<string, string | number | bigint> {
  const b = payload.slice(2);
  const slice = (o: number, n: number): Hex => `0x${b.slice(o * 2, (o + n) * 2)}`;
  const num = (o: number, n: number): number => parseInt(b.slice(o * 2, (o + n) * 2) || "0", 16);
  const id = num(0, 1);
  const head = {
    payloadId: id,
    amount: BigInt(slice(1, 32)),
    tokenAddress: slice(33, 32),
    tokenChain: num(65, 2),
    to: slice(67, 32),
    toChain: num(99, 2),
  };
  return id === 3
    ? { ...head, fromAddress: slice(101, 32), appPayload: `0x${b.slice(133 * 2)}` }
    : { ...head, fee: BigInt(slice(101, 32)) };
}

/** Read an ERC20 `totalSupply` against the Moonbeam fork (drops when a wrapped asset is burned). */
async function erc20TotalSupply(client: PublicClient, token: Hex): Promise<bigint> {
  return client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" });
}

/** Read an ERC20 `balanceOf` against the Moonbeam fork's eth RPC (current head). */
async function erc20BalanceOf(client: PublicClient, token: Hex, owner: Hex): Promise<bigint> {
  return client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read a block's events, retrying through papi's chainHead-pinning lag (right after `newBlock` the
 * follow subscription may not have pinned the new hash yet → `BlockNotPinnedError`).
 *
 * `typed` picks the decoder: the typed `hydration` descriptor for Hydration (its unsafe decoder
 * throws "Cannot mix BigInt and other types" on some event types), the unsafe api for Moonbeam
 * (which has no descriptor and decodes cleanly).
 */
async function eventsAt(
  net: Network,
  at: string,
  typed = false,
  tries = 12,
): Promise<EventRecord[]> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      if (typed) return await getEventsAt(net, at);
      return (await net.client
        .getUnsafeApi()
        .query.System.Events.getValue({ at })) as EventRecord[];
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const demo = XCM_SEND_CALL === "";
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;

  try {
    console.log(`\n🥢 MOXIT probe (${demo ? "DEMO — trivial ClearOrigin send" : "REAL calldata"})`);
    console.log(`   Hydration SA on Moonbeam : ${HYDRATION_SA_MOONBEAM}`);
    console.log(`   Wormhole Core (Moonbeam) : ${WORMHOLE_CORE}`);
    console.log(`   TokenBridge (Moonbeam)   : ${TOKEN_BRIDGE}`);

    // ── seed SA GLMR on Moonbeam (ERC20 balances come from the forked mainnet state) ──
    await moonbeam.setStorage({
      System: {
        Account: [[[HYDRATION_SA_MOONBEAM], { providers: 1, data: { free: SA_GLMR_TOPUP } }]],
      },
    });
    console.log(`   seeded SA with ${SA_GLMR_TOPUP} GLMR (wei)`);

    // ── PRIME balances BEFORE (read via the Moonbeam fork's eth RPC) ──
    const moonEth = createPublicClient({
      transport: http(`http://127.0.0.1:${configs.moonbeam.port}`),
    }) as PublicClient;
    const balBefore = { sa: 0n, bridge: 0n, supply: 0n };
    try {
      balBefore.sa = await erc20BalanceOf(moonEth, PRIME_TOKEN, HYDRATION_SA_MOONBEAM);
      balBefore.bridge = await erc20BalanceOf(moonEth, PRIME_TOKEN, TOKEN_BRIDGE);
      balBefore.supply = await erc20TotalSupply(moonEth, PRIME_TOKEN);
      console.log(
        `   PRIME before: SA ${balBefore.sa} | TokenBridge ${balBefore.bridge} | totalSupply ${balBefore.supply}`,
      );
    } catch (e) {
      console.log(`   ⚠️ could not read PRIME balances via eth_call: ${(e as Error).message}`);
    }

    // ── dispatch the PolkadotXcm.send as Root on Hydration ──
    const callHex = demo ? await buildDemoSendCall(hydration) : XCM_SEND_CALL;
    console.log(`\n🥢 Hydration: dispatch PolkadotXcm.send as Root`);
    console.log(`   call: ${callHex.slice(0, 66)}${callHex.length > 66 ? "…" : ""}`);

    const { blockHash: hydHash, events: hydEvents } = await dispatchCallAsRoot(hydration, callHex);

    const dispatched = findEvent(hydEvents, "Scheduler", "Dispatched");
    const sent = checkIfXcmSent(hydEvents);
    console.log(
      `   ${dispatched ? "✅" : "❌"} Scheduler.Dispatched (Root) ${dispatched ? toJson(dispatched) : ""}`,
    );
    console.log(`   ${sent ? "✅" : "❌"} PolkadotXcm.Sent @ ${hydHash}`);
    if (!dispatched || !sent) logEvents(hydEvents);

    // ── relay HRMP → Moonbeam and scan for the Wormhole event ──
    console.log(`\n🥢 Relay → Moonbeam (up to ${MOONBEAM_RELAY_BLOCKS} blocks)`);
    await hydration.chain.newBlock(); // flush HRMP outbound

    let hit = false;
    for (let i = 0; i < MOONBEAM_RELAY_BLOCKS && !hit; i++) {
      const blk = await moonbeam.chain.newBlock();
      const mEvents = await eventsAt(moonbeam, blk.hash);

      const processed = checkIfQueueProcessed(mEvents);
      const failed = checkIfQueueFailed(mEvents) || checkIfXcmError(mEvents);
      const executed = mEvents.some(
        ({ event }) =>
          (event as { type: string }).type === "Ethereum" &&
          (event.value as { type: string }).type === "Executed",
      );
      const wormhole = findEvmLog(mEvents, WORMHOLE_CORE, LOG_MESSAGE_PUBLISHED);

      console.log(
        `   #${blk.number}: queue ${processed ? "processed" : failed ? "FAILED" : "—"}` +
          ` | Ethereum.Executed ${executed ? "yes" : "—"}` +
          ` | LogMessagePublished ${wormhole.found ? "✅" : "—"}`,
      );

      if (wormhole.found) {
        hit = true;
        const { args } = decodeEventLog({
          abi: WORMHOLE_CORE_ABI,
          data: wormhole.data,
          topics: wormhole.topics as [Hex, ...Hex[]],
        });
        const a = args as unknown as {
          sender: string;
          sequence: bigint;
          nonce: number;
          payload: Hex;
          consistencyLevel: number;
        };
        console.log(`\n🥢 ✅ Wormhole Core LogMessagePublished:`);
        console.log(`   sender           ${a.sender}  (TokenBridge)`);
        console.log(`   sequence         ${a.sequence}`);
        console.log(`   nonce            ${a.nonce}`);
        console.log(`   consistencyLevel ${a.consistencyLevel}`);
        console.log(`   payload          ${a.payload}`);
        console.log(`\n🥢 Decoded TokenBridge transfer (payload):`);
        console.log(`   ${toJson(decodeTransfer(a.payload), 2)}`);
      } else if (failed || executed) {
        // Something ran (or failed) in this block — surface it for diagnosis.
        logEvents(mEvents);
      }
    }

    // ── PRIME balances AFTER — a wrapped asset (tokenChain≠16) is BURNED, so SA↓ + totalSupply↓ and
    //    the TokenBridge balance stays flat (it only grows for locked, Moonbeam-native tokens). ──
    if (hit) {
      try {
        const saAfter = await erc20BalanceOf(moonEth, PRIME_TOKEN, HYDRATION_SA_MOONBEAM);
        const bridgeAfter = await erc20BalanceOf(moonEth, PRIME_TOKEN, TOKEN_BRIDGE);
        const supplyAfter = await erc20TotalSupply(moonEth, PRIME_TOKEN);
        const dSupply = supplyAfter - balBefore.supply;
        console.log(`\n🥢 PRIME balances (before → after):`);
        console.log(`   SA          ${balBefore.sa} → ${saAfter}   (Δ ${saAfter - balBefore.sa})`);
        console.log(
          `   TokenBridge ${balBefore.bridge} → ${bridgeAfter}   (Δ ${bridgeAfter - balBefore.bridge})`,
        );
        console.log(`   totalSupply ${balBefore.supply} → ${supplyAfter}   (Δ ${dSupply})`);
        console.log(
          `   ⇒ ${dSupply < 0n ? "BURNED (wrapped asset): SA↓ + supply↓, bridge flat" : "LOCKED (native asset): SA↓ + bridge↑, supply flat"}`,
        );
      } catch (e) {
        console.log(`   ⚠️ could not read PRIME balances after: ${(e as Error).message}`);
      }
    }

    if (!hit) {
      console.log(
        `\n🥢 ❌ No LogMessagePublished from ${WORMHOLE_CORE} within ${MOONBEAM_RELAY_BLOCKS} blocks.` +
          (demo ? " (DEMO mode sends no TokenBridge call — this is expected.)" : ""),
      );
    }
  } finally {
    await teardownForks(nets);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
