/**
 * PROBE (WETH NTT — Robinhood peer, TECH COMMITTEE route): the same two Root calls as
 * `_probeWethNttRobinhood`, but enacted under a TECH COMMITTEE origin instead of Root, against a
 * fork of live Hydration.
 *
 * WHY A SECOND PROBE. `pallet_dispatcher` gates its two entry points differently
 * (runtime/hydradx/src/governance/mod.rs):
 *
 *   type TreasuryManagerOrigin = EitherOf<EnsureRoot<AccountId>, Treasurer>;
 *   type EmergencyAdminOrigin  = EitherOf<EnsureRoot<AccountId>, TechCommitteeMajority>;
 *
 * Both NTT legs go through `dispatch_as_emergency_admin`, so a TC majority is enough for them. The
 * Root probe's leg 0 — `dispatch_as_treasury`, funding the admin's gas — is what forces track 0.
 * Drop that leg and the proposal stops needing a referendum, a 1,000,000 HDX decision deposit, and
 * a 7-day decision period.
 *
 * GAS IS A PRECONDITION HERE, NOT A LEG. The emergency admin still has to pay WETH-denominated EVM
 * gas, but that is an ordinary token transfer to an ordinary account — ANY signed account can send
 * it, and the leftover persists for every future EA action. It does not belong to governance and
 * it does not belong in the motion.
 *
 * WHAT THIS IS ACTUALLY TESTING. Four things the Root probe cannot answer:
 *   1. That `EmergencyAdminOrigin` really does accept a TC `Members` origin — that the two legs
 *      enact with no Root anywhere in the dispatch.
 *   2. That an UNFUNDED admin fails SILENTLY. `dispatch_as_emergency_admin` emits the inner result
 *      as an event and then returns `Ok(..)` regardless, so `batch_all` is never interrupted: the
 *      motion closes as executed while both contracts are untouched. Phase 1 runs deliberately
 *      unfunded and requires exactly that shape — outer success, inner Err, peer still unset.
 *   3. That the SAME bytes then land once the gas is there — peer address, 18 decimals, and the
 *      69 WETH inbound limit, asserted against `scripts/robinhood/weth.sh govref`.
 *   4. That the ETHEREUM leg is untouched throughout. Peer 2 carries live intent and basejump
 *      settlements; it is re-read after every phase.
 *
 * IT ALSO PRINTS what a TC member signs: `technicalCommittee.propose(threshold, batchAll, len)`,
 * built against the fork's own metadata, with the threshold derived from the REAL committee read
 * off live state rather than assumed.
 *
 *   npx tsx chopsticks/probes/_probeWethNttTobinhoodTC.ts
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
/**
 * 69 WETH/24h — deliberately far tighter than the Ethereum hub leg, which keeps its own 10k. Two
 * locking hubs sit over this one burning leg, so this caps how much custody drift Robinhood can
 * introduce per day. Mirrors LIMIT_HYD_IN in ops/scripts/robinhood/weth.sh.
 */
const INBOUND_LIMIT = 69n * 10n ** 18n;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
/**
 * Where the gas MUST sit. 0xAA7e…AA7E1 is unbound in `pallet-evm-accounts` — verified against
 * mainnet, `EVMAccounts.AccountExtension` returns nothing — so `pallet_evm` charges
 * `b"ETH\0" ++ h160 ++ [0u8;8]`, NOT the native AccountId form.
 */
const EMERGENCY_ADMIN_EVM_ACCOUNT =
  "0x45544800aa7e0000000000000000000000000000000aa7e10000000000000000" as Hex;

const WETH_ASSET_ID = 20;

/**
 * MUST exceed the base fee — 0 is rejected as GasPriceTooLow before execution.
 *
 * FROZEN: this and GAS_LIMIT are inside motion 387's calldata (read back off-chain, both legs carry
 * `gas_limit: 500000, max_fee_per_gas: 10000000000`). Change either and the batch hashes
 * differently, and the probe stops describing what the committee is voting on.
 */
const MAX_FEE_PER_GAS = 10_000_000_000n; // 10 gwei
/** setWormholePeer also publishes a Wormhole registration message, so it is not a bare SSTORE. */
const GAS_LIMIT = 500_000n;
/**
 * What `pallet_evm` withdraws UP FRONT per leg, refunding the unused remainder after execution —
 * the `Tokens.Withdrawn`/`Tokens.Deposited` pair a funded block emits. The admin is only CHARGED
 * base fee × gas used, but `with_balance_for` rejects the call unless the balance covers this.
 * Printed against the real spend below so the two are never confused again.
 */
const RESERVE_PER_LEG = GAS_LIMIT * MAX_FEE_PER_GAS;
/**
 * The one-off top-up. Not a treasury matter — any signed account can send this.
 *
 * Sized off RESERVE_PER_LEG, not off the burn: the two legs together spend a fraction of a cent,
 * but each has to CLEAR 0.005 before it runs. Leg 1 reserves 0.005 and refunds all but its burn,
 * so leg 2 re-reserves out of the remainder — two legs need `reserve + burn`, not 2x reserve.
 * Measured: 0.001 reproduces phase 1 exactly (BalanceLow, both peers unset).
 *
 * Almost none of this is consumed. It is a balance the account must HOLD, and it stays there for
 * the next emergency-admin action.
 */
const GAS_WETH = 6_000_000_000_000_000n; // 0.006 WETH

const HYDRATION_SS58_PREFIX = 63;

/**
 * The EXACT bytes `scripts/robinhood/weth.sh govref` printed. Asserted against what this probe
 * builds, so a drift between the reviewed calldata and the enacted call is a failed check rather
 * than a silent divergence.
 */
const GOVREF_SET_PEER =
  "0x7c9186340000000000000000000000000000000000000000000000000000000000000048000000000000000000000000b1a2abcbc1fa276212f6ed239645161deea9861a0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000003bd913e6c1df40000" as Hex;
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

/** One call of the proposal: its calldata is what the motion carries, its `call` what we enact. */
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
 * The inner results carried by dispatcher's *CallDispatched events — outer success hides these,
 * and that is the whole point of phase 1. One entry per leg, in dispatch order.
 *
 * Discriminated by PAYLOAD, not by a variant tag: the Err arm is `DispatchErrorWithPostInfo`
 * (`{post_info, error}`), the Ok arm a bare `PostDispatchInfo` (`{pays_fee, ..}`).
 */
function dispatchInnerResults(events: EventRecord[]): { ok: boolean; err: string | null }[] {
  const out: { ok: boolean; err: string | null }[] = [];
  for (const { event } of events) {
    const e = event as {
      type: string;
      value: { type: string; value?: { result?: { value?: { error?: unknown } } } };
    };
    if (e.type === "Dispatcher" && e.value?.type?.endsWith("CallDispatched")) {
      const err = e.value.value?.result?.value?.error;
      out.push(err === undefined ? { ok: true, err: null } : { ok: false, err: toJson(err) });
    }
  }
  return out;
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
    const gasBalance = () =>
      retry("Tokens.Accounts", () =>
        api.query.Tokens.Accounts.getValue(
          ss58(truncatedEvmAccount(EMERGENCY_ADMIN)),
          WETH_ASSET_ID,
        ),
      ) as Promise<{ free?: bigint } | undefined>;

    // ── the real committee, read off live state ──
    //
    // TechCommitteeMajority is EnsureProportionAtLeast<_, TechnicalCollective, 1, 2>, i.e.
    // yes * 2 >= total. Derived from the ACTUAL member set, never assumed — a committee that
    // grew since this was written changes the threshold a member has to pass.
    const members = (await retry("TechnicalCommittee.Members", () =>
      api.query.TechnicalCommittee.Members.getValue(),
    )) as string[];
    const total = members.length;
    const threshold = Math.ceil(total / 2);

    console.log(`\n── Tech Committee ──`);
    console.log(`   members    ${total}`);
    for (const m of members) console.log(`     · ${m}`);
    console.log(`   threshold  ${threshold}/${total} (EnsureProportionAtLeast 1/2)`);
    record("committee is non-empty", total > 0, `${total} members`);
    record("threshold satisfies 1/2", threshold * 2 >= total, `${threshold}*2 >= ${total}`);

    // ── before ──
    const ownerBefore = (await retry("owner", () =>
      pub.readContract({ address: MANAGER, abi: MANAGER_ABI, functionName: "owner" }),
    )) as Hex;
    const ethPeerBefore = await peer(CHAIN_ETHEREUM);
    const ethWhPeerBefore = await whPeer(CHAIN_ETHEREUM);
    const ethInboundBefore = await inbound(CHAIN_ETHEREUM);
    const rhPeerBefore = await peer(CHAIN_ROBINHOOD);
    const rhWhPeerBefore = await whPeer(CHAIN_ROBINHOOD);
    const gasBefore = (await gasBalance())?.free ?? 0n;

    console.log(`\n── Before ──`);
    console.log(`   manager owner        ${ownerBefore}`);
    console.log(
      `   peer(2)  eth         ${ethPeerBefore.peerAddress} / ${ethPeerBefore.tokenDecimals}dp`,
    );
    console.log(`   inbound(2) capacity  ${weth(ethInboundBefore)}`);
    console.log(`   peer(72) robinhood   ${rhPeerBefore.peerAddress}`);
    console.log(`   whPeer(72)           ${rhWhPeerBefore}`);
    console.log(`   admin gas            ${weth(gasBefore)}`);

    record(
      "manager is owned by the emergency admin",
      ownerBefore.toLowerCase() === EMERGENCY_ADMIN.toLowerCase(),
      ownerBefore,
    );
    record("peer(72) starts unset", rhPeerBefore.peerAddress === pad("0x00", { size: 32 }));
    record(
      "whPeer(72) starts unset — SET-ONCE not yet spent",
      rhWhPeerBefore === pad("0x00", { size: 32 }),
    );
    record("admin starts with no gas", gasBefore === 0n, weth(gasBefore));

    // ── the two legs ──
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

    /** An NTT leg: the emergency admin calling one of the two contracts through pallet_dispatcher. */
    const adminLeg = (label: string, target: Hex, evmInput: Hex): Leg => ({
      label,
      target,
      evmInput,
      call: meta.tx.dispatcher.dispatchAsEmergencyAdmin(
        meta.tx.evm.call(
          EMERGENCY_ADMIN,
          target,
          evmInput,
          0,
          GAS_LIMIT,
          MAX_FEE_PER_GAS,
          null,
          null,
          [],
          [],
        ),
      ),
    });

    // Ordering is load-bearing: peer before wormhole peer — a transceiver peer over a manager with
    // no peer is a half-open route. NO treasury leg: gas is a precondition, funded outside this.
    const legs: Leg[] = [
      adminLeg(
        `1 manager.setPeer(${CHAIN_ROBINHOOD}, RH manager, 18dp, 69 WETH)`,
        MANAGER,
        setPeerInput,
      ),
      adminLeg(
        `2 transceiver.setWormholePeer(${CHAIN_ROBINHOOD}, RH transceiver) — SET-ONCE`,
        TRANSCEIVER,
        setWormholePeerInput,
      ),
    ];

    const batch = meta.tx.utility.batchAll(legs.map((l) => l.call));
    const batchBytes = batch.toU8a();
    const batchHash = registry.hash(batchBytes).toHex();

    // ── what a TC member signs ──
    //
    // propose() with threshold > 1 opens a motion; the remaining members vote() and anyone close()s
    // it. At threshold 1 pallet_collective executes inside propose() itself.
    const proposeCall = meta.tx.technicalCommittee.propose(threshold, batch, batchBytes.length);

    console.log(`\n── Calldata ──`);
    for (const { label, call, target, evmInput } of legs) {
      console.log(`\n   ${label}`);
      console.log(`     target    : ${target}`);
      console.log(`     evm input : ${evmInput}`);
      console.log(`     call      : ${call.toHex()}`);
    }
    console.log(`\n   batchAll — the motion's proposal, ${batchBytes.length} bytes`);
    console.log(`     hash      : ${batchHash}`);
    console.log(`     call      : ${batch.toHex()}`);
    console.log(`\n   technicalCommittee.propose(${threshold}, batchAll, ${batchBytes.length})`);
    console.log(`     SIGN THIS : ${proposeCall.toHex()}`);
    console.log(`\n   Precondition — send ${weth(GAS_WETH)} (asset ${WETH_ASSET_ID}) to`);
    console.log(`     ${ss58(truncatedEvmAccount(EMERGENCY_ADMIN))}`);
    console.log(`     any signed account; one-off, the remainder persists for future EA actions`);

    /**
     * Enact under a TC origin — `Members(yes, total)`, exactly what pallet_collective hands the
     * runtime when a motion closes. NO Root anywhere.
     *
     * Scheduled through a PREIMAGE, not Inline: `BoundedInline` caps at 128 bytes and this batch
     * encodes well past that — an inline agenda entry is dropped silently, with no
     * Scheduler.Dispatched at all.
     */
    const enactAsCommittee = async (
      label: string,
      call: any,
    ): Promise<{ hash: string; events: EventRecord[] }> => {
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
                  origin: { TechnicalCommittee: { Members: [threshold, total] } },
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
      const inner = dispatchInnerResults(evs);
      console.log(
        `   · ${label}: dispatcher=[${inner.map((r) => (r.ok ? "Ok" : "Err")).join(" ")}]` +
          (inner.find((r) => r.err) ? ` ${inner.find((r) => r.err)!.err}` : "") +
          `  [${[...new Set(evs.map(evName))]
            .filter((n) => !n.startsWith("System.Extrinsic") && !n.startsWith("RelayChainInfo"))
            .join(" ")}]`,
      );
      if (!schedulerDispatched(evs)) {
        throw new Error(
          `"${label}" never dispatched (${len} bytes) — the scheduler dropped it. If the agenda ` +
            `origin shape is wrong for this runtime, that is where to look.`,
        );
      }
      return { hash, events: evs };
    };

    // ── phase 1: UNFUNDED, the silent failure ──
    //
    // The admin has no WETH, so every evm.call is rejected before execution. The point is what the
    // caller sees: dispatch_as_emergency_admin returns Ok, batch_all is never interrupted, and the
    // motion closes as executed with both contracts untouched.
    console.log(`\n── Phase 1: unfunded — proving the motion "succeeds" while doing nothing ──`);
    const unfunded = await enactAsCommittee("batchAll (no gas)", batch);
    const unfundedInner = dispatchInnerResults(unfunded.events);

    record("TC origin was accepted — the batch dispatched", schedulerDispatched(unfunded.events));
    record(
      "batch was NOT interrupted — outer success hides the failure",
      !unfunded.events.some((e) => evName(e) === "Utility.BatchInterrupted"),
    );
    record(
      "both legs report an inner Err",
      unfundedInner.length === 2 && unfundedInner.every((r) => !r.ok),
      `[${unfundedInner.map((r) => (r.ok ? "Ok" : "Err")).join(" ")}]`,
    );
    record("no EVM leg executed", !evmSucceeded(unfunded.events));

    const rhPeerUnfunded = await peer(CHAIN_ROBINHOOD);
    record(
      "peer(72) still unset after the 'successful' motion",
      rhPeerUnfunded.peerAddress === pad("0x00", { size: 32 }),
      rhPeerUnfunded.peerAddress,
    );

    // ── the precondition ──
    //
    // Mirrors the real-world one-off transfer. orml_tokens keeps its own accounting, so writing
    // Tokens.Accounts is equivalent to having received it.
    console.log(`\n── Funding the admin — ${weth(GAS_WETH)}, outside governance ──`);
    await hydration.setStorage({
      Tokens: {
        Accounts: [
          [
            [ss58(truncatedEvmAccount(EMERGENCY_ADMIN)), WETH_ASSET_ID],
            { free: GAS_WETH, reserved: 0n, frozen: 0n },
          ],
        ],
      },
    });
    const gasFunded = (await gasBalance())?.free ?? 0n;
    record("gas landed in the account pallet_evm debits", gasFunded === GAS_WETH, weth(gasFunded));

    // ── phase 2: the same bytes, now that gas is there ──
    console.log(`\n── Phase 2: the identical batch, funded ──`);
    const funded = await enactAsCommittee("batchAll (funded)", batch);
    const fundedInner = dispatchInnerResults(funded.events);

    record(
      "both legs report an inner Ok",
      fundedInner.length === 2 && fundedInner.every((r) => r.ok),
      `[${fundedInner.map((r) => (r.ok ? "Ok" : "Err")).join(" ")}]`,
    );
    record(
      "both EVM legs ran in the one block",
      funded.events.filter((e) => evName(e) === "EVM.Executed").length === 2,
      `${funded.events.filter((e) => evName(e) === "EVM.Executed").length}/2 EVM.Executed`,
    );
    if (evmFailed(funded.events)) logEvents(funded.events);

    // ── what the two legs actually cost ──
    //
    // The number that decides how big the top-up has to be. SPENT is base fee × gas used and is
    // tiny; RESERVE is what each leg has to have sitting there before pallet_evm will run it at
    // all. Whichever of the two the funding fails to clear, it fails the same silent way phase 1
    // does, so both are printed side by side rather than either being assumed.
    const gasLeft = (await gasBalance())?.free ?? 0n;
    const spent = gasFunded - gasLeft;
    const baseFee = await retry("gasPrice", () => pub.getGasPrice());
    console.log(`\n── Gas accounting ──`);
    console.log(`   base fee           ${Number(baseFee) / 1e9} gwei`);
    console.log(`   funded             ${weth(gasFunded)}`);
    console.log(
      `   spent (2 legs)     ${weth(spent)}` +
        (baseFee > 0n ? `  ≈ ${spent / baseFee} gas @ ${GAS_LIMIT} limit` : ""),
    );
    console.log(`   left               ${weth(gasLeft)}`);
    console.log(`   reserve per leg    ${weth(RESERVE_PER_LEG)}  (${GAS_LIMIT} × max_fee_per_gas)`);
    console.log(`   minimum top-up     ${weth(RESERVE_PER_LEG + spent)}  (reserve + burn)`);
    record("the batch burned far less than one leg's reserve", spent < RESERVE_PER_LEG, weth(spent));
    record(
      "funding cleared the reserve — what actually gates the legs",
      gasFunded >= RESERVE_PER_LEG,
      `${weth(gasFunded)} vs ${weth(RESERVE_PER_LEG)}`,
    );
    record("leftover still covers another EA action", gasLeft >= RESERVE_PER_LEG, weth(gasLeft));

    const p = await peer(CHAIN_ROBINHOOD);
    record(
      "peer(72) address set",
      p.peerAddress.toLowerCase() === b32(RH_MANAGER).toLowerCase(),
      p.peerAddress,
    );
    record("peer(72) decimals are 18", p.tokenDecimals === PEER_DECIMALS, `${p.tokenDecimals}dp`);
    const cap = await inbound(CHAIN_ROBINHOOD);
    record("inbound(72) limit is 69 WETH", cap === INBOUND_LIMIT, weth(cap));
    const wp = await whPeer(CHAIN_ROBINHOOD);
    record("whPeer(72) set", wp.toLowerCase() === b32(RH_TRANSCEIVER).toLowerCase(), wp);

    // ── the rail accepts 72 as a destination ──
    const quoted = await retry("quoteDeliveryPrice", () =>
      pub.readContract({
        address: MANAGER,
        abi: MANAGER_ABI,
        functionName: "quoteDeliveryPrice",
        args: [CHAIN_ROBINHOOD, "0x00"],
      }),
    ).catch(() => null);
    record("quoteDeliveryPrice(72) prices once peered", quoted !== null);

    // ── SET-ONCE ──
    //
    // A second setWormholePeer must be refused. This one reverts inside the EVM rather than being
    // rejected before it, so it surfaces as ExecutedFailed, not as a dispatch error.
    console.log(`\n── Re-dispatching setWormholePeer — must be refused ──`);
    const again = await enactAsCommittee("setWormholePeer (retry)", legs[1].call);
    record("second setWormholePeer is rejected", evmFailed(again.events) || !evmSucceeded(again.events));
    const wpAfter = await whPeer(CHAIN_ROBINHOOD);
    record(
      "whPeer(72) unchanged by the retry",
      wpAfter.toLowerCase() === b32(RH_TRANSCEIVER).toLowerCase(),
      wpAfter,
    );
    if (!evmFailed(again.events) && evmSucceeded(again.events)) logEvents(again.events);

    // ── the Ethereum leg is untouched ──
    const ethPeerAfter = await peer(CHAIN_ETHEREUM);
    const ethWhPeerAfter = await whPeer(CHAIN_ETHEREUM);
    const ethInboundAfter = await inbound(CHAIN_ETHEREUM);
    record(
      "peer(2) address unchanged",
      ethPeerAfter.peerAddress === ethPeerBefore.peerAddress,
      ethPeerAfter.peerAddress,
    );
    record(
      "peer(2) decimals unchanged",
      ethPeerAfter.tokenDecimals === ethPeerBefore.tokenDecimals,
      `${ethPeerAfter.tokenDecimals}dp`,
    );
    record("whPeer(2) unchanged", ethWhPeerAfter === ethWhPeerBefore, ethWhPeerAfter);
    record(
      "inbound(2) capacity unchanged",
      ethInboundAfter === ethInboundBefore,
      weth(ethInboundAfter),
    );

    const failed = results.filter((r) => !r.ok);
    console.log(`\n── ${results.length - failed.length}/${results.length} checks passed ──`);
    for (const f of failed) console.log(`   ❌ ${f.leg}`);
    if (failed.length) process.exitCode = 1;
  } finally {
    await teardownForks(nets);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
