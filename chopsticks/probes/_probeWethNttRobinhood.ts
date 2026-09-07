/**
 * PROBE (WETH NTT — Robinhood peer): runs the two Root calls that add Robinhood (chain 72) as a peer
 * of the Hydration WETH NTT leg, against a fork of live Hydration, one per block, then reads the
 * result back off the real contracts.
 *
 * Everything here is the REAL DEPLOYED STATE — the WETH NttManager and its WormholeTransceiver as
 * they stand on mainnet, both owned by the aave emergency admin 0xAA7e…AA7E1. Nothing is deployed
 * and nothing is mocked. Each leg runs through the real `pallet_dispatcher` with a Root origin
 * injected into `Scheduler.Agenda`, which is the same dispatch a referendum performs on enactment.
 *
 * It also PRINTS the calldata — every leg, the `utility.batchAll` wrapping them, and the preimage
 * hash to reference it by — built against the fork's own metadata, and ASSERTS the EVM inputs match
 * `scripts/robinhood/weth.sh govref` byte for byte. So what is enacted here cannot drift from what
 * is submitted.
 *
 * WHAT THIS IS ACTUALLY TESTING. Five things state-reading cannot answer:
 *   1. Whether `dispatch_as_emergency_admin` → `EVM.call` reaches these two contracts at all.
 *      0xAA7e…AA7E1 has nonce 0 and zero balance on mainnet and Hydration EVM gas is
 *      WETH-denominated, so leg 0 funds it — and funds the ETH\0-DERIVED account, which is the one
 *      pallet_evm debits (see _probeBasejumpGoLive, which measured this the hard way).
 *   2. That `setPeer` lands BOTH halves: the peer address AND the 10,000 WETH inbound limit for 72.
 *      They are one call, and a wrong `decimals` silently rescales the limit rather than reverting.
 *   3. That `setWormholePeer` is genuinely SET-ONCE here. The probe re-dispatches it and requires
 *      the second attempt to FAIL — `PeerAlreadySet`. One shot, so governance gets one shot.
 *   4. That the ETHEREUM leg is untouched. This manager carries live intent and basejump
 *      settlements; peer 2, its decimals, its transceiver peer and its inbound capacity are all
 *      re-read after both legs and must be identical.
 *   5. That the rail actually accepts 72 as a destination afterwards — `quoteDeliveryPrice(72)`
 *      reverts while unpeered and must price once peered.
 *
 * DUAL-HUB NOTE. Ethereum and Robinhood are both LOCKING hubs over one burning Hydration leg, and
 * are deliberately not peered to each other. This probe only touches the Hydration side; it cannot
 * see the hub<->hub surface, so it asserts Hydration's peer set is exactly {2, 72} and nothing else
 * appeared.
 *
 *   npx tsx chopsticks/probes/_probeWethNttRobinhood.ts            # calldata, then leg by leg
 *   npx tsx chopsticks/probes/_probeWethNttRobinhood.ts --batch    # …as the one atomic call
 */
import { createPublicClient, encodeFunctionData, http, pad, parseAbi, type Hex } from "viem";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { logEvents, type EventRecord } from "../lib/events";
import { toJson } from "../lib/utils";

// ─── Live deployment ─────────────────────────────────────────────

/** ops/tokens/weth/deployment.json — chains.Hydration.manager (burning leg, owner = emergency admin). */
const MANAGER = "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7" as Hex;
/** …chains.Hydration.transceivers.wormhole.address. */
const TRANSCEIVER = "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae" as Hex;

/** …chains.Robinhood.manager — the peer being registered. */
const RH_MANAGER = "0xB1A2ABCbC1FA276212f6eD239645161DeeA9861a" as Hex;
/** …chains.Robinhood.transceivers.wormhole.address. */
const RH_TRANSCEIVER = "0x1352881a04cb9f9f5fB8442bc925e99EC15D3642" as Hex;

const CHAIN_ROBINHOOD = 72;
const CHAIN_ETHEREUM = 2;

/** WETH is 18dp on both hubs; a wrong value here rescales the limit instead of reverting. */
const PEER_DECIMALS = 18;
/** 10,000 WETH — mirrors the Ethereum hub leg, and throttles dual-hub custody drift. */
const INBOUND_LIMIT = 10_000n * 10n ** 18n;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
/**
 * Where leg 0's gas MUST go. 0xAA7e…AA7E1 is unbound in `pallet-evm-accounts`, so `pallet_evm`
 * charges `b"ETH\0" ++ h160 ++ [0u8;8]` — NOT the native AccountId form. Measured in
 * _probeBasejumpGoLive: funding the native form leaves every EVM leg failing `EVM.BalanceLow`.
 */
const EMERGENCY_ADMIN_EVM_ACCOUNT =
  "0x45544800aa7e0000000000000000000000000000000aa7e10000000000000000" as Hex;

const WETH_ASSET_ID = 20;

/** MUST exceed the base fee — 0 is rejected as GasPriceTooLow before execution. */
const MAX_FEE_PER_GAS = 10_000_000_000n; // 10 gwei
/** setWormholePeer also publishes a Wormhole registration message, so it is not a bare SSTORE. */
const GAS_LIMIT = 500_000n;
/** Leg 0: treasury → admin. It has nonce 0 and 0 WETH; EVM gas here is WETH-denominated. */
const GAS_WETH = 10_000_000_000_000_000n; // 0.01 WETH

const HYDRATION_SS58_PREFIX = 63;

/** Enact the batchAll governance submits, rather than the legs one per block. */
const RUN_BATCH = process.argv.includes("--batch");

/**
 * The EXACT bytes `scripts/robinhood/weth.sh govref` printed. Asserted against what this probe
 * builds, so a drift between the reviewed calldata and the enacted call is a failed check rather
 * than a silent divergence.
 */
const GOVREF_SET_PEER =
  "0x7c9186340000000000000000000000000000000000000000000000000000000000000048000000000000000000000000b1a2abcbc1fa276212f6ed239645161deea9861a000000000000000000000000000000000000000000000000000000000000001200000000000000000000000000000000000000000000021e19e0c9bab2400000" as Hex;
const GOVREF_SET_WORMHOLE_PEER =
  "0x7ab5640300000000000000000000000000000000000000000000000000000000000000480000000000000000000000001352881a04cb9f9f5fb8442bc925e99ec15d3642" as Hex;

const MANAGER_ABI = parseAbi([
  "function setPeer(uint16,bytes32,uint8,uint256)",
  "function getPeer(uint16) view returns ((bytes32 peerAddress, uint8 tokenDecimals))",
  "function getCurrentInboundCapacity(uint16) view returns (uint256)",
  "function quoteDeliveryPrice(uint16,bytes) view returns (uint256[],uint256)",
  "function token() view returns (address)",
  "function owner() view returns (address)",
]);
const TRANSCEIVER_ABI = parseAbi([
  "function setWormholePeer(uint16,bytes32)",
  "function getWormholePeer(uint16) view returns (bytes32)",
]);

// ─── Helpers ─────────────────────────────────────────────────────

/** One call of the proposal: its calldata is what governance submits, its `call` what we enact. */
type Leg = { label: string; call: any; target?: Hex; evmInput?: Hex };

/**
 * A `BoundedVec<u8>` storage value — `compact(len) ++ bytes` — from a call's hex.
 *
 * `dev_setStorage` writes a `0x` string VERBATIM (chopsticks-core `utils/set-storage.js`), so the
 * length prefix is the caller's to add. Writing a bare call hex stores a preimage that decodes to
 * LENGTH ZERO, and the scheduler drops the entry as `CallUnavailable` with nothing else to show.
 */
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

/** Hydration's unbound-H160 → AccountId32 mapping: b"ETH\0" ++ h160 ++ [0u8;8]. */
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);

const b32 = (h160: Hex): Hex => pad(h160.toLowerCase() as Hex, { size: 32 });

const weth = (v: bigint): string => `${(Number(v) / 1e18).toFixed(6)} WETH`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry a read through chopsticks' post-block lag. */
async function retry<T>(what: string, fn: () => Promise<T>, tries = 10): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(500);
    }
  }
  throw new Error(`${what}: ${String((last as Error)?.message ?? last).slice(0, 160)}`);
}

async function eventsAt(net: Network, at: string, tries = 12): Promise<EventRecord[]> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return (await net.client.getUnsafeApi().query.System.Events.getValue({ at })) as EventRecord[];
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

const evName = ({ event }: EventRecord): string => {
  const e = event as { type: string; value: { type: string } };
  return `${e.type}.${e.value?.type}`;
};

/**
 * TWO pallets emit an `Executed`, and only pallet_evm's is a variant. `EVM.call` — every leg here —
 * reports success as `EVM.Executed` vs `EVM.ExecutedFailed`.
 */
function evmSucceeded(events: EventRecord[]): boolean {
  return events.some((e) => evName(e) === "EVM.Executed");
}

const evmFailed = (events: EventRecord[]): boolean =>
  events.some((e) => evName(e) === "EVM.ExecutedFailed");

/**
 * The inner result carried by dispatcher's *CallDispatched events — outer success hides this.
 *
 * Discriminated by PAYLOAD, not by a variant tag: the Err arm is `DispatchErrorWithPostInfo`
 * (`{post_info, error}`), the Ok arm a bare `PostDispatchInfo` (`{pays_fee, ..}`).
 */
function dispatchInnerResult(events: EventRecord[]): { ok: boolean; err: string | null } | null {
  for (const { event } of events) {
    const e = event as {
      type: string;
      value: { type: string; value?: { result?: { value?: { error?: unknown } } } };
    };
    if (e.type === "Dispatcher" && e.value?.type?.endsWith("CallDispatched")) {
      const err = e.value.value?.result?.value?.error;
      return err === undefined ? { ok: true, err: null } : { ok: false, err: toJson(err) };
    }
  }
  return null;
}

/** Raw bytes of a papi storage value — `Vec<u8>` comes back as a Uint8Array, not always a Binary. */
function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  const b = (v as { asBytes?: () => Uint8Array } | undefined)?.asBytes?.();
  return b instanceof Uint8Array ? b : undefined;
}

/** Did the scheduler actually run the looked-up call? CallUnavailable == a silently dropped leg. */
const schedulerDispatched = (events: EventRecord[]): boolean =>
  events.some((e) => evName(e) === "Scheduler.Dispatched");

const results: { leg: string; ok: boolean }[] = [];
const record = (leg: string, ok: boolean, detail = ""): boolean => {
  results.push({ leg, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${leg}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;

  try {
    const rpc = hydration.url.replace("ws://", "http://").replace("[::]", "127.0.0.1");
    const pub = createPublicClient({ transport: http(rpc) });
    const api = hydration.client.getUnsafeApi();
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> })
      .registry) as any;

    const peer = (chain: number) =>
      retry("getPeer", () =>
        pub.readContract({
          address: MANAGER,
          abi: MANAGER_ABI,
          functionName: "getPeer",
          args: [chain],
        }),
      ) as Promise<{ peerAddress: Hex; tokenDecimals: number }>;
    const inbound = (chain: number) =>
      retry("getCurrentInboundCapacity", () =>
        pub.readContract({
          address: MANAGER,
          abi: MANAGER_ABI,
          functionName: "getCurrentInboundCapacity",
          args: [chain],
        }),
      ) as Promise<bigint>;
    const whPeer = (chain: number) =>
      retry("getWormholePeer", () =>
        pub.readContract({
          address: TRANSCEIVER,
          abi: TRANSCEIVER_ABI,
          functionName: "getWormholePeer",
          args: [chain],
        }),
      ) as Promise<Hex>;
    const quotes = async (chain: number): Promise<boolean> => {
      try {
        await pub.readContract({
          address: MANAGER,
          abi: MANAGER_ABI,
          functionName: "quoteDeliveryPrice",
          args: [chain, "0x00"],
        });
        return true;
      } catch {
        return false;
      }
    };

    console.log(`\n🥢 WETH NTT — add Robinhood (chain ${CHAIN_ROBINHOOD}) as a peer`);
    console.log(`   manager      ${MANAGER}`);
    console.log(`   transceiver  ${TRANSCEIVER}`);
    console.log(`   admin        ${EMERGENCY_ADMIN}  (funded by leg 0)`);

    // ── pre-state ──
    console.log(`\n── Before ──`);
    const ownerBefore = (await retry("owner", () =>
      pub.readContract({ address: MANAGER, abi: MANAGER_ABI, functionName: "owner" }),
    )) as Hex;
    const ethPeerBefore = await peer(CHAIN_ETHEREUM);
    const ethWhPeerBefore = await whPeer(CHAIN_ETHEREUM);
    const ethInboundBefore = await inbound(CHAIN_ETHEREUM);
    const rhPeerBefore = await peer(CHAIN_ROBINHOOD);
    const rhWhPeerBefore = await whPeer(CHAIN_ROBINHOOD);

    console.log(`   manager owner        ${ownerBefore}`);
    console.log(`   peer(2)  eth         ${ethPeerBefore.peerAddress} / ${ethPeerBefore.tokenDecimals}dp`);
    console.log(`   whPeer(2) eth        ${ethWhPeerBefore}`);
    console.log(`   inbound(2) capacity  ${weth(ethInboundBefore)}`);
    console.log(`   peer(72) robinhood   ${rhPeerBefore.peerAddress}`);
    console.log(`   whPeer(72)           ${rhWhPeerBefore}`);
    console.log(`   quotes to 72?        ${await quotes(CHAIN_ROBINHOOD)}`);

    // The whole point of the proposal is that these are empty. If they are not, the SET-ONCE leg
    // has already been spent and the run below proves nothing.
    record(
      "owner is the emergency admin",
      ownerBefore.toLowerCase() === EMERGENCY_ADMIN.toLowerCase(),
      ownerBefore,
    );
    record("peer(72) starts unset", rhPeerBefore.peerAddress === pad("0x00", { size: 32 }));
    record("whPeer(72) starts unset — SET-ONCE not yet spent", rhWhPeerBefore === pad("0x00", { size: 32 }));

    // ── one Root call per block, so a failure names its own leg ──
    //
    // Scheduled through a PREIMAGE, not Inline. `BoundedInline` caps at 128 bytes and a
    // dispatchAsEmergencyAdmin(evm.call(..)) encodes well past that — an inline agenda entry is
    // dropped silently, with no Scheduler.Dispatched at all. A referendum enacts via preimage too.
    const enact = async ({ label, call }: Leg): Promise<{ hash: string; events: EventRecord[] }> => {
      const head = (await retry("head", () => api.query.System.Number.getValue())) as number;
      const bytes = call.toU8a();
      const callHash = registry.hash(bytes).toHex();
      const len = bytes.length;
      await hydration.setStorage({
        Preimage: { PreimageFor: [[[[callHash, len]], boundedBytes(call.toHex())]] },
      });
      // Assert the LENGTH, not mere presence: an empty/truncated value reads back truthy.
      const stored = await retry("PreimageFor", () =>
        api.query.Preimage.PreimageFor.getValue([callHash, len]),
      );
      const storedLen = asBytes(stored)?.length ?? -1;
      if (storedLen !== len) {
        throw new Error(`preimage for "${label}" stored ${storedLen} bytes, want ${len}`);
      }
      await hydration.setStorage({
        Scheduler: {
          Agenda: [
            [
              [head + 1],
              [
                {
                  call: { Lookup: { hash: callHash, len } },
                  origin: { system: "Root" },
                  maybeId: null,
                  priority: 0,
                  maybePeriodic: null,
                },
              ],
            ],
          ],
        },
      });
      // Build IN-PROCESS, not through the dev_newBlock RPC — on a heavy block that request never
      // returns and chopsticks keeps rebuilding. chain.newBlock() hands back exactly one block.
      const { hash } = await (
        hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }
      ).newBlock();
      const evs = await eventsAt(hydration, hash);
      const res = dispatchInnerResult(evs);
      const inner = res === null ? null : res.ok;
      const evm = evs.some((e) => evName(e).startsWith("EVM."));
      console.log(
        `   · ${label}: dispatcher=${inner === null ? "n/a" : inner ? "Ok" : "Err"}` +
          (res?.err ? ` ${res.err}` : "") +
          (evm ? ` evm=${evmSucceeded(evs) ? "Succeed" : "FAILED"}` : "") +
          `  [${[...new Set(evs.map(evName))]
            .filter((n) => !n.startsWith("System.Extrinsic") && !n.startsWith("RelayChainInfo"))
            .join(" ")}]`,
      );
      if (!schedulerDispatched(evs)) {
        throw new Error(`"${label}" never dispatched (${len} bytes) — the scheduler dropped it`);
      }
      return { hash, events: evs };
    };

    /** An NTT leg: the emergency admin calling one of the two contracts through pallet_dispatcher. */
    const adminLeg = (label: string, target: Hex, evmInput: Hex): Leg => ({
      label,
      target,
      evmInput,
      call: meta.tx.dispatcher.dispatchAsEmergencyAdmin(
        meta.tx.evm.call(EMERGENCY_ADMIN, target, evmInput, 0, GAS_LIMIT, MAX_FEE_PER_GAS, null, null, [], []),
      ),
    });

    const setPeerInput = encodeFunctionData({
      abi: MANAGER_ABI,
      functionName: "setPeer",
      args: [CHAIN_ROBINHOOD, b32(RH_MANAGER), PEER_DECIMALS, INBOUND_LIMIT],
    });
    const setWormholePeerInput = encodeFunctionData({
      abi: TRANSCEIVER_ABI,
      functionName: "setWormholePeer",
      args: [CHAIN_ROBINHOOD, b32(RH_TRANSCEIVER)],
    });

    // Built here, reviewed there. A mismatch means the govref output and this run are not the same
    // proposal, and every check below would be measuring the wrong bytes.
    record(
      "setPeer calldata matches govref",
      setPeerInput.toLowerCase() === GOVREF_SET_PEER.toLowerCase(),
      setPeerInput === GOVREF_SET_PEER ? "" : setPeerInput,
    );
    record(
      "setWormholePeer calldata matches govref",
      setWormholePeerInput.toLowerCase() === GOVREF_SET_WORMHOLE_PEER.toLowerCase(),
      setWormholePeerInput === GOVREF_SET_WORMHOLE_PEER ? "" : setWormholePeerInput,
    );

    const gasLeg: Leg = {
      label: "0 fund gas — treasury → admin's ETH\\0 account, 0.01 WETH",
      call: meta.tx.dispatcher.dispatchAsTreasury(
        meta.tx.currencies.transfer(EMERGENCY_ADMIN_EVM_ACCOUNT, WETH_ASSET_ID, GAS_WETH),
      ),
    };
    // Ordering is load-bearing: gas before the EVM legs, and peer before wormhole peer — a
    // transceiver peer over a manager with no peer is a half-open route.
    const legs: Leg[] = [
      adminLeg(`1 manager.setPeer(${CHAIN_ROBINHOOD}, RH manager, 18dp, 10000 WETH)`, MANAGER, setPeerInput),
      adminLeg(`2 transceiver.setWormholePeer(${CHAIN_ROBINHOOD}, RH transceiver) — SET-ONCE`, TRANSCEIVER, setWormholePeerInput),
    ];

    // ── the calldata to submit ──
    //
    // Built against the FORK's own metadata, not @galacticcouncil/descriptors — those are stale
    // against runtime 440 (Currencies/EVM fail checksum there).
    console.log(`\n── Calldata ──`);
    for (const { label, call, target, evmInput } of [gasLeg, ...legs]) {
      console.log(`\n   ${label}`);
      if (target) console.log(`     target    : ${target}`);
      if (evmInput) console.log(`     evm input : ${evmInput}`);
      console.log(`     call      : ${call.toHex()}`);
    }
    const batch = meta.tx.utility.batchAll([gasLeg, ...legs].map((l) => l.call));
    const batchBytes = batch.toU8a();
    console.log(`\n   batchAll — what governance submits, as ONE atomic Root call`);
    console.log(`     len       : ${batchBytes.length} bytes`);
    console.log(`     preimage  : ${registry.hash(batchBytes).toHex()}`);
    console.log(`     call      : ${batch.toHex()}`);

    if (RUN_BATCH) {
      console.log(`\n── Enacting the batchAll — one atomic Root call ──`);
      const { events } = await enact({
        label: `batchAll (${legs.length + 1} legs, ${batchBytes.length} bytes)`,
        call: batch,
      });
      record("batch completed, not reverted", events.some((e) => evName(e) === "Utility.BatchCompleted"));
      record(
        "both EVM legs ran in the one block",
        events.filter((e) => evName(e) === "EVM.Executed").length === 2,
        `${events.filter((e) => evName(e) === "EVM.Executed").length}/2 EVM.Executed`,
      );
    } else {
      console.log(`\n── Enacting, one leg per block ──`);
      await enact(gasLeg);
      const adminDerived = (await retry("Tokens.Accounts", () =>
        api.query.Tokens.Accounts.getValue(ss58(truncatedEvmAccount(EMERGENCY_ADMIN)), WETH_ASSET_ID),
      )) as { free?: bigint } | undefined;
      record(
        "gas landed in the account pallet_evm debits",
        (adminDerived?.free ?? 0n) === GAS_WETH,
        `${adminDerived?.free ?? 0n}`,
      );

      await enact(legs[0]);
      const p = await peer(CHAIN_ROBINHOOD);
      record("peer(72) address set", p.peerAddress.toLowerCase() === b32(RH_MANAGER).toLowerCase(), p.peerAddress);
      record("peer(72) decimals are 18", p.tokenDecimals === PEER_DECIMALS, `${p.tokenDecimals}dp`);
      const cap = await inbound(CHAIN_ROBINHOOD);
      record("inbound(72) limit is 10000 WETH", cap === INBOUND_LIMIT, weth(cap));

      const { events: whEvents } = await enact(legs[1]);
      const wp = await whPeer(CHAIN_ROBINHOOD);
      record("whPeer(72) set", wp.toLowerCase() === b32(RH_TRANSCEIVER).toLowerCase(), wp);
      // setWormholePeer publishes a TransceiverRegistration through the core bridge. No log means
      // the registration never went out, even though the storage write did.
      record(
        "transceiver registration was published",
        whEvents.some((e) => evName(e) === "EVM.Log"),
      );
    }

    // ── verify by reading the contracts, never by the dispatch outcome ──
    console.log(`\n── After ──`);
    const rhPeer = await peer(CHAIN_ROBINHOOD);
    const rhWh = await whPeer(CHAIN_ROBINHOOD);
    console.log(`   peer(72)             ${rhPeer.peerAddress} / ${rhPeer.tokenDecimals}dp`);
    console.log(`   whPeer(72)           ${rhWh}`);
    console.log(`   inbound(72) capacity ${weth(await inbound(CHAIN_ROBINHOOD))}`);

    record("rail now quotes to 72", await quotes(CHAIN_ROBINHOOD));

    // The Ethereum leg carries live intent and basejump settlements. Nothing above should have
    // touched it, and a rescale would show up here rather than as a revert.
    const ethPeer = await peer(CHAIN_ETHEREUM);
    const ethWh = await whPeer(CHAIN_ETHEREUM);
    const ethCap = await inbound(CHAIN_ETHEREUM);
    record(
      "ethereum peer(2) untouched",
      ethPeer.peerAddress === ethPeerBefore.peerAddress &&
        ethPeer.tokenDecimals === ethPeerBefore.tokenDecimals,
      `${ethPeer.peerAddress} / ${ethPeer.tokenDecimals}dp`,
    );
    record("ethereum whPeer(2) untouched", ethWh === ethWhPeerBefore, ethWh);
    record("ethereum inbound(2) untouched", ethCap === ethInboundBefore, weth(ethCap));

    // Dual-hub: only 2 and 72 may be peered here. A third would mean `ntt push` meshed the chains.
    const strays: number[] = [];
    for (const c of [1, 4, 5, 6, 10, 23, 24, 30]) {
      const q = await peer(c);
      if (q.peerAddress !== pad("0x00", { size: 32 })) strays.push(c);
    }
    record("no peer beyond {2, 72}", strays.length === 0, strays.length ? `stray: ${strays}` : "");

    // ── SET-ONCE: the second attempt must fail ──
    //
    // Governance gets one shot at the transceiver peer. Proving that here is what makes the
    // reviewed calldata worth reviewing: a wrong address is not fixable by re-running.
    console.log(`\n── SET-ONCE re-dispatch (expected to FAIL) ──`);
    const { events: again } = await enact({
      ...legs[1],
      label: `2' setWormholePeer AGAIN — must revert PeerAlreadySet`,
    });
    record("second setWormholePeer is rejected", evmFailed(again) || !evmSucceeded(again));
    const wpAfter = await whPeer(CHAIN_ROBINHOOD);
    record("whPeer(72) unchanged by the retry", wpAfter.toLowerCase() === b32(RH_TRANSCEIVER).toLowerCase(), wpAfter);
    if (!evmFailed(again) && evmSucceeded(again)) logEvents(again);

    const failed = results.filter((r) => !r.ok);
    console.log(
      failed.length === 0
        ? `\n🥢 ✅ PROPOSAL ENACTS — all ${results.length} checks pass. Robinhood peered, Ethereum untouched.`
        : `\n🥢 ❌ ${failed.length}/${results.length} failed: ${failed.map((f) => f.leg).join(", ")}`,
    );
    if (failed.length) process.exitCode = 1;
  } finally {
    await teardownForks(nets).catch(() => {});
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
