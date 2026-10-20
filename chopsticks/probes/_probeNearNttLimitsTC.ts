/**
 * PROBE (ZEC + NEAR NTT limits, TECH COMMITTEE motion): enacts the motion's own bytes against a
 * fork of live Hydration, under the origin pallet_collective hands the runtime when it closes —
 * `TechnicalCommittee.Members(4, total)` — and reads every value back.
 *
 * The motion raises both corridors to match the NEAR side (crates/near/scripts/ntt-manager/limits.sh):
 *
 *   ZEC   asset 1001357  xcm_rate_limit 100      manager 0xe20c…  outbound 100     inbound(15) 100
 *   NEAR  asset 1001358  xcm_rate_limit 25,000   manager 0x374e…  outbound 25,000  inbound(15) 25,000
 *
 * WHAT THIS IS ACTUALLY TESTING. Two things decoding the bytes cannot answer:
 *   1. That `AssetRegistry.update` accepts a TC Members(4, 7) origin. It is called bare, not through
 *      the dispatcher, so if its UpdateOrigin wants more than that, `batch_all` reverts whole and
 *      no leg lands.
 *   2. That the emergency admin holds the WETH the four EVM legs reserve up front (200k gas × 1 gwei
 *      each). Short of it, `dispatch_as_emergency_admin` still returns Ok — the motion "executes"
 *      while the managers are untouched. Run against live balances first, so the answer is real.
 *
 *   npx tsx chopsticks/probes/_probeNearNttLimitsTC.ts
 */
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { logEvents, type EventRecord } from "../lib/events";
import { toJson } from "../lib/utils";

// ─── The motion, as submitted ────────────────────────────────────

/** technicalCommittee.propose(4, utility.batchAll([...6 calls]), 761) — exactly what a member signs. */
const MOTION =
  "0x1902100d021833018d470f00000100000100e40b54020000000000000000000000010100000028055a01aa7e0000000000000000000000000000000aa7e1e20ced5f5798cd4febc7ae182309b9f51345e0cc901901717500000000000000000000000000000000000000000000000000000002540be4000000000000000000000000000000000000000000000000000000000000000000400d03000000000000ca9a3b000000000000000000000000000000000000000000000000000000000000000028055a01aa7e0000000000000000000000000000000aa7e1e20ced5f5798cd4febc7ae182309b9f51345e0cc1101186ce61200000000000000000000000000000000000000000000000000000002540be400000000000000000000000000000000000000000000000000000000000000000f0000000000000000000000000000000000000000000000000000000000000000400d03000000000000ca9a3b000000000000000000000000000000000000000000000000000000000000000033018e470f000001000001000000a8f2855c9beb83c75000000000010100000028055a01aa7e0000000000000000000000000000000aa7e1374e5239a2342be6bf31b410ec03984d03a8b7de9019017175000000000000000000000000000000000000000050c783eb9b5c85f2a80000000000000000000000000000000000000000000000000000000000000000000000400d03000000000000ca9a3b000000000000000000000000000000000000000000000000000000000000000028055a01aa7e0000000000000000000000000000000aa7e1374e5239a2342be6bf31b410ec03984d03a8b7de1101186ce612000000000000000000000000000000000000000050c783eb9b5c85f2a8000000000000000000000000000000000000000000000000000000000000000000000f0000000000000000000000000000000000000000000000000000000000000000400d03000000000000ca9a3b0000000000000000000000000000000000000000000000000000000000000000e50b";

/** `1902` propose · `10` threshold 4 · proposal · `e50b` length bound 761. */
const THRESHOLD = 4;
const PROPOSAL = `0x${MOTION.slice(2 + 6, -4)}` as Hex;
const LENGTH_BOUND = 761;

// ─── Live deployment ─────────────────────────────────────────────

const CHAIN_NEAR = 15;

const CORRIDORS = [
  {
    sym: "ZEC",
    assetId: 1001357,
    /** hydration-ntt tokens/zec/deployment.json — chains.Hydration.manager. */
    manager: "0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC" as Hex,
    decimals: 8,
    limit: 100n * 10n ** 8n,
  },
  {
    sym: "NEAR",
    assetId: 1001358,
    /** hydration-ntt tokens/near/deployment.json — chains.Hydration.manager. */
    manager: "0x374E5239a2342Be6Bf31B410EC03984D03A8b7dE" as Hex,
    decimals: 24,
    limit: 25_000n * 10n ** 24n,
  },
];

/** NTT trims to min(8, token decimals); the rate limiter stores limits trimmed. */
const TRIMMED_DECIMALS = 8;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
/** Unbound in pallet-evm-accounts, so pallet_evm debits b"ETH\0" ++ h160 ++ [0u8;8]. */
const EMERGENCY_ADMIN_EVM_ACCOUNT =
  "0x45544800aa7e0000000000000000000000000000000aa7e10000000000000000" as Hex;
const WETH_ASSET_ID = 20;

/** Per EVM leg, from the motion's bytes: gas_limit 200,000 × max_fee_per_gas 1 gwei. */
const RESERVE_PER_LEG = 200_000n * 1_000_000_000n;
const EVM_LEGS = 4;
/** Fallback top-up for phase 2, only if the live balance cannot clear one leg's reserve. */
const GAS_WETH = 6_000_000_000_000_000n; // 0.006 WETH

const HYDRATION_SS58_PREFIX = 63;

const MANAGER_ABI = parseAbi([
  "struct RateLimitParams { uint72 limit; uint72 currentCapacity; uint64 lastTxTimestamp; }",
  "function getOutboundLimitParams() view returns (RateLimitParams)",
  "function getInboundLimitParams(uint16) view returns (RateLimitParams)",
  "function owner() view returns (address)",
]);

// ─── Helpers ─────────────────────────────────────────────────────

/** `compact(len) ++ bytes` — a preimage written verbatim, see _probeWethNttTobinhoodTC. */
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

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);

/** A TrimmedAmount (uint72): amount in the high 64 bits, its decimals in the low byte. */
const trimmed = (v: bigint): { amount: bigint; decimals: number } => ({
  amount: v >> 8n,
  decimals: Number(v & 0xffn),
});

const fmt = (v: bigint, decimals: number): string => {
  const s = v.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

const weth = (v: bigint): string => `${fmt(v, 18)} WETH`;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

const count = (events: EventRecord[], name: string): number =>
  events.filter((e) => evName(e) === name).length;

/** Inner results of dispatcher's *CallDispatched events, Err told apart by its `error` payload. */
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

/** The scheduler's own verdict on the batch — Err here is batch_all reverting whole. */
function schedulerResult(events: EventRecord[]): string | null {
  const d = events.find((e) => evName(e) === "Scheduler.Dispatched");
  return d ? toJson((d.event as { value: { value: { result: unknown } } }).value.value.result) : null;
}

function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  const b = (v as { asBytes?: () => Uint8Array } | undefined)?.asBytes?.();
  return b instanceof Uint8Array ? b : undefined;
}

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
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> })
      .registry) as any;

    const limits = async (manager: Hex) => {
      const out = (await retry("getOutboundLimitParams", () =>
        pub.readContract({ address: manager, abi: MANAGER_ABI, functionName: "getOutboundLimitParams" }),
      )) as { limit: bigint; currentCapacity: bigint };
      const inb = (await retry("getInboundLimitParams", () =>
        pub.readContract({
          address: manager,
          abi: MANAGER_ABI,
          functionName: "getInboundLimitParams",
          args: [CHAIN_NEAR],
        }),
      )) as { limit: bigint; currentCapacity: bigint };
      return { out: trimmed(out.limit), in: trimmed(inb.limit) };
    };
    const asset = (id: number) =>
      retry("AssetRegistry.Assets", () => api.query.AssetRegistry.Assets.getValue(id)) as Promise<
        { xcm_rate_limit?: bigint; is_sufficient?: boolean; asset_type?: { type: string } } | undefined
      >;
    const gasBalance = async () =>
      ((await retry("Tokens.Accounts", () =>
        api.query.Tokens.Accounts.getValue(ss58(EMERGENCY_ADMIN_EVM_ACCOUNT), WETH_ASSET_ID),
      )) as { free?: bigint } | undefined)?.free ?? 0n;

    // ── the bytes ──
    const proposalBytes = Buffer.from(PROPOSAL.slice(2), "hex");
    record(
      "proposal length matches the motion's length bound",
      proposalBytes.length === LENGTH_BOUND,
      `${proposalBytes.length} bytes`,
    );

    // ── the committee ──
    const members = (await retry("TechnicalCommittee.Members", () =>
      api.query.TechnicalCommittee.Members.getValue(),
    )) as string[];
    const total = members.length;
    console.log(`\n── Tech Committee ──`);
    console.log(`   members    ${total}`);
    console.log(`   threshold  ${THRESHOLD}/${total} (the motion's own)`);
    record("threshold is a majority — what EmergencyAdminOrigin wants", THRESHOLD * 2 >= total);

    // ── before ──
    console.log(`\n── Before ──`);
    const before: Record<string, Awaited<ReturnType<typeof limits>>> = {};
    for (const c of CORRIDORS) {
      const owner = (await retry("owner", () =>
        pub.readContract({ address: c.manager, abi: MANAGER_ABI, functionName: "owner" }),
      )) as Hex;
      before[c.sym] = await limits(c.manager);
      const a = await asset(c.assetId);
      console.log(`   ${c.sym}`);
      console.log(`     manager owner      ${owner}`);
      console.log(`     outbound limit     ${fmt(before[c.sym].out.amount, TRIMMED_DECIMALS)}`);
      console.log(`     inbound(15) limit  ${fmt(before[c.sym].in.amount, TRIMMED_DECIMALS)}`);
      console.log(
        `     xcm_rate_limit     ${a?.xcm_rate_limit === undefined ? "none" : fmt(a.xcm_rate_limit, c.decimals)}`,
      );
      console.log(`     asset_type         ${a?.asset_type?.type}   is_sufficient ${a?.is_sufficient}`);
      record(`${c.sym} manager is owned by the emergency admin`, owner.toLowerCase() === EMERGENCY_ADMIN.toLowerCase(), owner);
    }
    const gasLive = await gasBalance();
    console.log(`   admin gas            ${weth(gasLive)}   (each EVM leg reserves ${weth(RESERVE_PER_LEG)})`);

    /** Enact the batch as a closed motion: Members(THRESHOLD, total), through a preimage lookup. */
    const enact = async (label: string): Promise<EventRecord[]> => {
      const head = (await retry("head", () => api.query.System.Number.getValue())) as number;
      const callHash = registry.hash(proposalBytes).toHex();
      const len = proposalBytes.length;
      await hydration.setStorage({
        Preimage: { PreimageFor: [[[[callHash, len]], boundedBytes(PROPOSAL)]] },
      });
      const stored = await retry("PreimageFor", () => api.query.Preimage.PreimageFor.getValue([callHash, len]));
      if ((asBytes(stored)?.length ?? -1) !== len) throw new Error(`preimage stored wrong length`);
      await hydration.setStorage({
        Scheduler: {
          Agenda: [
            [
              [head + 1],
              [
                {
                  call: { Lookup: { hash: callHash, len } },
                  origin: { TechnicalCommittee: { Members: [THRESHOLD, total] } },
                  maybeId: null,
                  priority: 0,
                  maybePeriodic: null,
                },
              ],
            ],
          ],
        },
      });
      const { hash } = await (
        hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }
      ).newBlock();
      const evs = await eventsAt(hydration, hash);
      const inner = dispatchInnerResults(evs);
      console.log(`   · ${label}`);
      console.log(`       scheduler   ${schedulerResult(evs) ?? "NOT DISPATCHED"}`);
      console.log(`       dispatcher  [${inner.map((r) => (r.ok ? "Ok" : "Err")).join(" ")}]`);
      for (const r of inner.filter((r) => r.err)) console.log(`       inner err   ${r.err}`);
      console.log(
        `       events      AssetRegistry.Updated×${count(evs, "AssetRegistry.Updated")}  ` +
          `EVM.Executed×${count(evs, "EVM.Executed")}  EVM.ExecutedFailed×${count(evs, "EVM.ExecutedFailed")}  ` +
          `Utility.BatchCompleted×${count(evs, "Utility.BatchCompleted")}`,
      );
      return evs;
    };

    const check = async (phase: string) => {
      for (const c of CORRIDORS) {
        const after = await limits(c.manager);
        const want = c.limit / 10n ** BigInt(c.decimals - TRIMMED_DECIMALS);
        record(`${phase}: ${c.sym} outbound limit`, after.out.amount === want, fmt(after.out.amount, TRIMMED_DECIMALS));
        record(`${phase}: ${c.sym} inbound(15) limit`, after.in.amount === want, fmt(after.in.amount, TRIMMED_DECIMALS));
        const a = await asset(c.assetId);
        record(
          `${phase}: ${c.sym} xcm_rate_limit`,
          a?.xcm_rate_limit === c.limit,
          a?.xcm_rate_limit === undefined ? "none" : fmt(a.xcm_rate_limit, c.decimals),
        );
        record(`${phase}: ${c.sym} still sufficient`, a?.is_sufficient === true);
      }
    };

    // ── phase 1: live state, untouched ──
    console.log(`\n── Phase 1: the motion against live state ──`);
    const live = await enact("batchAll (live balances)");
    const liveInner = dispatchInnerResults(live);
    record("scheduler dispatched the batch", live.some((e) => evName(e) === "Scheduler.Dispatched"));
    record("batch_all completed — AssetRegistry accepted the TC origin", count(live, "Utility.BatchCompleted") === 1);
    record("both asset updates landed", count(live, "AssetRegistry.Updated") === 2);
    const liveEvmOk = liveInner.length === EVM_LEGS && liveInner.every((r) => r.ok) && count(live, "EVM.Executed") === EVM_LEGS;
    record("all four EVM legs executed with the admin's live gas", liveEvmOk, `${count(live, "EVM.Executed")}/${EVM_LEGS}`);
    if (count(live, "EVM.ExecutedFailed")) logEvents(live);

    if (liveEvmOk) {
      await check("live");
      const gasAfter = await gasBalance();
      console.log(`\n   admin gas after  ${weth(gasAfter)}  (spent ${weth(gasLive - gasAfter)})`);
      record("admin keeps enough for another EA action", gasAfter >= RESERVE_PER_LEG, weth(gasAfter));
    } else {
      // ── phase 2: the same bytes, the admin funded ──
      console.log(`\n── Phase 2: the identical batch, admin funded with ${weth(GAS_WETH)} ──`);
      console.log(`   (live gas ${weth(gasLive)} — the motion needs it topped up before it closes)`);
      await hydration.setStorage({
        Tokens: {
          Accounts: [
            [[ss58(EMERGENCY_ADMIN_EVM_ACCOUNT), WETH_ASSET_ID], { free: GAS_WETH, reserved: 0n, frozen: 0n }],
          ],
        },
      });
      const funded = await enact("batchAll (funded)");
      const fundedInner = dispatchInnerResults(funded);
      record(
        "all four EVM legs executed once funded",
        fundedInner.length === EVM_LEGS && fundedInner.every((r) => r.ok) && count(funded, "EVM.Executed") === EVM_LEGS,
        `${count(funded, "EVM.Executed")}/${EVM_LEGS}`,
      );
      if (count(funded, "EVM.ExecutedFailed")) logEvents(funded);
      await check("funded");
    }

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
