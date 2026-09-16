/**
 * PROBE (Basejump receiver upgrade): the TC motion that upgrades the live receiver `0x35bf…7c8a`
 * to the current `BasejumpReceiver`, enacted on a Hydration fork through the real governance path,
 * then proven by replaying the REAL guardian-signed fast-path VAAs waiting on the corridor.
 *
 * The pool's `transfer` takes three arguments (0x57cfeeee). The receiver must call exactly that,
 * so a receiver implementation calling any other selector reverts inside the pool on every
 * `completeTransfer`. The receiver's storage layout is unchanged by the upgrade.
 *
 * Owner of the proxy is `0xAA7e…AA7E1`, the runtime's EmergencyAdminAccount. `EmergencyAdminOrigin`
 * is `EitherOf<EnsureRoot, TechCommitteeMajority>`, so the call is a TC motion, not a referendum:
 *
 *   technicalCommittee.propose(threshold,
 *     dispatcher.dispatchAsEmergencyAdmin(
 *       evm.call(admin, receiver, upgradeToAndCall(impl, 0x), 0, gas, maxFee, ..)))
 *
 * What runs here:
 *   1. deploy the current BasejumpReceiver implementation (or take a live one via `--impl`)
 *   2. print the calldata: evm input, the dispatcher call, its hash/len, and the TC `propose`
 *   3. replay VAA seq 0 against the receiver as deployed → must revert
 *   4. enact the dispatcher call from a `TechnicalCommittee.Members(threshold, n)` origin via the
 *      scheduler, assert `Upgraded`, assert the ERC1967 slot, assert wiring unchanged
 *   5. replay every fixture VAA → all must pay
 *
 *   npx tsx chopsticks/probes/_probeBasejumpReceiverUpgrade.ts [--impl <address>] [--root]
 *
 * `--root` enacts from Root instead of the TC origin (what a referendum would do).
 * Fixtures: `_canary-vaa*.json`, Wormholescan `/api/v1/vaas/2/<emitter>/<seq>` responses.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  createPublicClient,
  decodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  pad,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { logEvents, type EventRecord } from "../lib/events";
import { toJson } from "../lib/utils";

// ─── Live deployment ─────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const WETH_ASSET_ID = 20;
const USDC_ASSET_ID = 21;

const LANDING = "0x70e9b12c3b19cb5f0e59984a5866278ab69df976" as Hex;
const RECEIVER = "0x35bf3a1b9ac564c8f66c97cea1ee410cd3f97c8a" as Hex;
const ETH_EMITTER = "0xa72e2bf29c840eb93adbb9ee1aa41580f01c9944" as Hex;
const WORMHOLE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as Hex;
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;
/** b"ETH\0" ++ h160 ++ [0u8;8] — the account pallet_evm charges for the admin's gas (unbound H160). */
const EMERGENCY_ADMIN_EVM_ACCOUNT =
  "0x45544800aa7e0000000000000000000000000000000aa7e10000000000000000" as Hex;

// ─── Governance call parameters ──────────────────────────────────

/** upgradeToAndCall with no initializer is ~50k gas. */
const GAS_LIMIT = 300_000n;
/** Must exceed the base fee (~5 gwei). */
const MAX_FEE_PER_GAS = 10_000_000_000n;

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const HYDRATION_SS58_PREFIX = 63;

const implArg = process.argv.indexOf("--impl");
/** A mainnet implementation to vet instead of deploying one from the artifact. */
const IMPL_OVERRIDE = implArg >= 0 ? process.argv[implArg + 1] : undefined;
if (implArg >= 0 && !isAddress(IMPL_OVERRIDE ?? "")) throw new Error("--impl needs an address");
const ENACT_AS_ROOT = process.argv.includes("--root");

const HERE = dirname(fileURLToPath(import.meta.url));
const RECEIVER_ARTIFACT = JSON.parse(
  readFileSync(resolve(HERE, "../../contracts/out/BasejumpReceiver.sol/BasejumpReceiver.json"), "utf8"),
) as { bytecode: { object: Hex } };

type VaaFixture = { data: { vaa: string; sequence: number; txHash: string } };
const FIXTURES = readdirSync(HERE)
  .filter((f) => /^_canary-vaa\d+\.json$/.test(f))
  .sort()
  .map((f) => JSON.parse(readFileSync(resolve(HERE, f), "utf8")) as VaaFixture);

const RECEIVER_ABI = parseAbi([
  "function upgradeToAndCall(address newImplementation, bytes data) payable",
  "function proxiableUUID() view returns (bytes32)",
  "function owner() view returns (address)",
  "function landing() view returns (bytes32)",
  "function wormhole() view returns (address)",
  "function authorizedEmitters(uint16) view returns (bytes32)",
  "function processedVaas(bytes32) view returns (bool)",
  "function completeTransfer(bytes)",
]);
const LANDING_ABI = parseAbi([
  "function pendingHead() view returns (uint256)",
  "function pendingTail() view returns (uint256)",
  "function authorizedBridges(address) view returns (bool)",
]);

const TOPICS: Record<string, string> = {
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b": "Upgraded",
  "0x975e82bfde4922e2ce69ecae9a999f21616c5511424de460faee50bfaea5da02": "TransferExecuted",
  "0xf2770afbd8ca70ed04ee6d74687d59e173c6b48585241f5fef3bf03f61aa6149": "TransferQueued",
  "0x35b9c14063e796b0ea3be322495ccdd9c07dcad47b1298400a98fbdbd150f66d": "TransferProcessed",
};

// ─── Helpers ─────────────────────────────────────────────────────

const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const usdc = (v: bigint): string => `${(Number(v) / 1e6).toFixed(6)} USDC`;

/** A `BoundedVec<u8>` storage value — `compact(len) ++ bytes`; dev_setStorage writes hex verbatim. */
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

/** pallet_evm reports success by variant; pallet_ethereum always `Executed` with an exit_reason. */
function evmSucceeded(events: EventRecord[]): boolean {
  return events.some(({ event }) => {
    const ev = event as { type: string; value: { type: string; value?: { exit_reason?: unknown } } };
    if (ev.type === "EVM") return ev.value?.type === "Executed";
    if (ev.type !== "Ethereum" || ev.value?.type !== "Executed") return false;
    return (ev.value.value?.exit_reason as { type?: string } | undefined)?.type === "Succeed";
  });
}

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

function evmLogs(events: EventRecord[]): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = [];
  for (const { event } of events) {
    const ev = event as { type: string; value: { type: string; value?: { log?: { address: string; topics: string[] } } } };
    if (ev.type === "EVM" && ev.value.type === "Log" && ev.value.value?.log) {
      const { address, topics } = ev.value.value.log;
      out.push({ address: String(address).toLowerCase(), name: TOPICS[String(topics[0])] ?? String(topics[0]) });
    }
  }
  return out;
}

function asBytes(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  const b = (v as { asBytes?: () => Uint8Array } | undefined)?.asBytes?.();
  return b instanceof Uint8Array ? b : undefined;
}

/** Decode the fast-path payload out of a raw VAA: body starts after 6 + 66·n signature bytes. */
function decodeVaa(vaa: Hex): { hash: Hex; recipient: Hex; amount: bigint; transferSequence: bigint; sequence: bigint } {
  const bytes = Buffer.from(vaa.slice(2), "hex");
  const nSigs = bytes[5];
  const body = bytes.subarray(6 + 66 * nSigs);
  const sequence = body.readBigUInt64BE(4 + 4 + 2 + 32);
  const payload = `0x${body.subarray(51).toString("hex")}` as Hex;
  const [t] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "sourceAsset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "bytes32" },
          { name: "transferSequence", type: "uint64" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    payload,
  );
  // Wormhole's VM.hash = keccak256(keccak256(body)); the receiver keys processedVaas on it.
  const hash = keccak256(keccak256(`0x${body.toString("hex")}` as Hex));
  return { hash, recipient: t.recipient, amount: t.amount, transferSequence: t.transferSequence, sequence };
}

const results: { step: string; ok: boolean }[] = [];
const record = (step: string, ok: boolean, detail = ""): boolean => {
  results.push({ step, ok });
  console.log(`   ${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (FIXTURES.length === 0) throw new Error("no _canary-vaa*.json fixtures beside this probe");
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const rpc = hydration.url.replace("ws://", "http://").replace("[::]", "127.0.0.1");
    const pub = createPublicClient({ transport: http(rpc) });
    const api = hydration.client.getUnsafeApi();
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> }).registry) as any;

    const account = privateKeyToAccount(DEPLOYER_PK);
    const client = new EthClient(hydration, account, { chainId: HYDRATION_EVM_CHAIN_ID });
    const deployerSub = ss58(truncatedEvmAccount(account.address));
    const landingSub = ss58(truncatedEvmAccount(LANDING));

    const tokenBalance = async (acct: string, assetId: number, at?: string): Promise<bigint> => {
      const v = (await retry(`Tokens.Accounts(${assetId})`, () =>
        api.query.Tokens.Accounts.getValue(acct, assetId, at ? { at } : {}),
      )) as { free?: bigint } | undefined;
      return v?.free ?? 0n;
    };
    // Read pallet_evm's storage directly: chopsticks' eth_getStorageAt answers zero here.
    const implSlot = async (): Promise<Hex> => {
      const raw = await retry("EVM.AccountStorages", () =>
        api.query.EVM.AccountStorages.getValue(RECEIVER, ERC1967_IMPL_SLOT),
      );
      const hex = typeof raw === "string" ? raw : (raw as { asHex?: () => string })?.asHex?.() ?? "0x";
      return getAddress(`0x${hex.slice(-40)}`);
    };
    const read = <T>(fn: string, args: unknown[] = []) =>
      retry(fn, () => pub.readContract({ address: RECEIVER, abi: RECEIVER_ABI, functionName: fn as never, args: args as never })) as Promise<T>;

    // ── deployer: funded. The fork does not gate CREATE on EVMAccounts.ContractDeployer. ──
    await hydration.setStorage({
      System: { Account: [[[deployerSub], { providers: 1, data: { free: 1_000_000n * 10n ** 12n } }]] },
      Tokens: { Accounts: [[[deployerSub, WETH_ASSET_ID], { free: 1_000n * 10n ** 18n }]] },
    });

    console.log(`\n🥢 Basejump receiver upgrade — real pool, real receiver, real VAAs`);
    console.log(`   receiver  ${RECEIVER}`);
    console.log(`   landing   ${LANDING}`);
    console.log(`   admin     ${EMERGENCY_ADMIN}`);

    // ── before ──
    const implBefore = await implSlot();
    const owner = await read<Hex>("owner");
    const wiringBefore = {
      landing: await read<Hex>("landing"),
      wormhole: await read<Hex>("wormhole"),
      emitter2: await read<Hex>("authorizedEmitters", [2]),
    };
    const members = (await retry("TC members", () => api.query.TechnicalCommittee.Members.getValue())) as unknown[];
    const n = members.length;
    // TechCommitteeMajority = EnsureProportionAtLeast<1, 2>: yes · 2 ≥ n.
    const threshold = Math.ceil(n / 2);
    const adminGas = await tokenBalance(ss58(EMERGENCY_ADMIN_EVM_ACCOUNT), WETH_ASSET_ID);
    console.log(`\n── Before ──`);
    console.log(`   impl                 ${implBefore}`);
    console.log(`   owner                ${owner}`);
    console.log(`   admin gas (WETH)     ${adminGas}  (ETH\\0-derived account)`);
    console.log(`   TC members           ${n}  → majority threshold ${threshold}`);
    console.log(`   pool USDC            ${usdc(await tokenBalance(landingSub, USDC_ASSET_ID))}`);
    record("owner is the emergency admin", owner.toLowerCase() === EMERGENCY_ADMIN.toLowerCase(), owner);
    record("admin has WETH for gas", adminGas > 0n, adminGas.toString());
    record("receiver wired to the landing", wiringBefore.landing.toLowerCase() === pad(LANDING, { size: 32 }).toLowerCase());
    record("receiver wired to the core", wiringBefore.wormhole.toLowerCase() === WORMHOLE_CORE.toLowerCase());
    record("Ethereum emitter authorized", wiringBefore.emitter2.toLowerCase() === pad(ETH_EMITTER, { size: 32 }).toLowerCase());
    record("receiver authorized on the landing", await retry("authorizedBridges", () =>
      pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: "authorizedBridges", args: [RECEIVER] })));

    // ── 1. the implementation ──
    let impl: Hex;
    if (IMPL_OVERRIDE) {
      impl = getAddress(IMPL_OVERRIDE);
    } else {
      const { address, res } = await client.deploy(RECEIVER_ARTIFACT.bytecode.object);
      const evs = await eventsAt(hydration, res.blockHash);
      if (!evmSucceeded(evs)) {
        logEvents(evs);
        throw new Error("impl deploy failed");
      }
      impl = address;
    }
    const code = await retry("code", () => pub.getCode({ address: impl }));
    record(`implementation has code (${IMPL_OVERRIDE ? "live" : "deployed here"})`, !!code && code !== "0x", impl);
    const uuid = await retry("proxiableUUID", () => pub.readContract({ address: impl, abi: RECEIVER_ABI, functionName: "proxiableUUID" }));
    record("proxiableUUID == ERC1967 impl slot", uuid === ERC1967_IMPL_SLOT, uuid);

    // ── 2. the calldata ──
    const evmInput = encodeFunctionData({ abi: RECEIVER_ABI, functionName: "upgradeToAndCall", args: [impl, "0x"] });
    const inner = meta.tx.evm.call(EMERGENCY_ADMIN, RECEIVER, evmInput, 0, GAS_LIMIT, MAX_FEE_PER_GAS, null, null, [], []);
    const call = meta.tx.dispatcher.dispatchAsEmergencyAdmin(inner);
    const callBytes = call.toU8a();
    const callHash = registry.hash(callBytes).toHex();
    const propose = meta.tx.technicalCommittee.propose(threshold, call, callBytes.length);

    console.log(`\n── Calldata ──`);
    console.log(`   upgradeToAndCall(${impl}, 0x)`);
    console.log(`     evm input           : ${evmInput}`);
    console.log(`   evm.call(admin → receiver, gas ${GAS_LIMIT}, maxFee ${MAX_FEE_PER_GAS})`);
    console.log(`     call                : ${inner.toHex()}`);
    console.log(`   dispatcher.dispatchAsEmergencyAdmin(evm.call)   ← what the TC motion carries`);
    console.log(`     len                 : ${callBytes.length} bytes`);
    console.log(`     hash                : ${callHash}`);
    console.log(`     call                : ${call.toHex()}`);
    console.log(`   technicalCommittee.propose(${threshold}, <call>, ${callBytes.length})   ← submit this`);
    console.log(`     call                : ${propose.toHex()}`);
    if (!IMPL_OVERRIDE) {
      console.log(`\n   NOTE: impl ${impl} exists on THIS FORK only. For mainnet, deploy with`);
      console.log(`   pnpm migrate:basejump-receiver-upgrade, re-run with --impl <address>, and submit that output.`);
    }

    // ── VAA delivery ──
    const vaas = FIXTURES.map((f) => {
      const vaa = `0x${Buffer.from(f.data.vaa, "base64").toString("hex")}` as Hex;
      return { vaa, srcTx: f.data.txHash, ...decodeVaa(vaa) };
    });
    const deliver = async (v: (typeof vaas)[number], expectPay: boolean): Promise<boolean> => {
      const recipientSub = ss58(v.recipient);
      const poolBefore = await tokenBalance(landingSub, USDC_ASSET_ID);
      const recipBefore = await tokenBalance(recipientSub, USDC_ASSET_ID);
      const data = encodeFunctionData({ abi: RECEIVER_ABI, functionName: "completeTransfer", args: [v.vaa] });
      const res = await client.call(RECEIVER, data);
      const evs = await eventsAt(hydration, res.blockHash);
      const ok = evmSucceeded(evs);
      const poolAfter = await tokenBalance(landingSub, USDC_ASSET_ID, res.blockHash);
      const recipAfter = await tokenBalance(recipientSub, USDC_ASSET_ID, res.blockHash);
      const processed = await read<boolean>("processedVaas", [v.hash]);
      console.log(`\n   seq ${v.sequence}: net ${usdc(v.amount)}, NTT transferSequence ${v.transferSequence}, source tx 0x${v.srcTx}`);
      console.log(`     completeTransfer  ${ok ? "Succeed" : "Revert"}   logs: ${evmLogs(evs).map((l) => l.name).join(" ") || "none"}`);
      console.log(`     pool       ${usdc(poolBefore)} → ${usdc(poolAfter)}`);
      console.log(`     recipient  ${usdc(recipBefore)} → ${usdc(recipAfter)}   (${ss58(v.recipient)})`);
      console.log(`     processedVaas[${v.hash.slice(0, 10)}…] = ${processed}`);
      const paid = ok && recipAfter - recipBefore === v.amount && poolBefore - poolAfter === v.amount && processed;
      return expectPay ? paid : !ok && !processed && recipAfter === recipBefore;
    };

    // ── 3. receiver as deployed → revert ──
    console.log(`\n── 3. Receiver as deployed (impl ${implBefore}) ──`);
    record(`seq ${vaas[0].sequence} reverts on the deployed receiver`, await deliver(vaas[0], false));

    // ── 4. enact the upgrade through the scheduler with the TC origin ──
    const origin = ENACT_AS_ROOT
      ? { system: "Root" }
      : { TechnicalCommittee: { Members: [threshold, n] } };
    console.log(`\n── 4. Enacting dispatcher.dispatchAsEmergencyAdmin from ${JSON.stringify(origin)} ──`);
    const head = (await retry("head", () => api.query.System.Number.getValue())) as number;
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[callHash, callBytes.length]], boundedBytes(call.toHex())]] },
    });
    const stored = asBytes(await retry("PreimageFor", () => api.query.Preimage.PreimageFor.getValue([callHash, callBytes.length])))?.length ?? -1;
    if (stored !== callBytes.length) throw new Error(`preimage stored ${stored} bytes, want ${callBytes.length}`);
    await hydration.setStorage({
      Scheduler: {
        Agenda: [[[head + 1], [{ call: { Lookup: { hash: callHash, len: callBytes.length } }, origin, maybeId: null, priority: 0, maybePeriodic: null }]]],
      },
    });
    const { hash: upgradeBlock } = await (hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }).newBlock();
    const evs = await eventsAt(hydration, upgradeBlock);
    const names = [...new Set(evs.map(evName))].filter((x) => !x.startsWith("System.Extrinsic") && !x.startsWith("RelayChainInfo"));
    const dispatched = evs.some((e) => evName(e) === "Scheduler.Dispatched");
    const innerRes = dispatchInnerResult(evs);
    console.log(`   events: ${names.join(" ")}`);
    if (!dispatched) {
      logEvents(evs);
      throw new Error("scheduler never dispatched the call — origin shape or preimage problem, not the proposal");
    }
    record("EmergencyAdminOrigin accepted the origin", innerRes?.ok === true, innerRes?.err ?? "");
    record("EVM.call executed", evmSucceeded(evs));
    record("Upgraded event from the receiver", evmLogs(evs).some((l) => l.address === RECEIVER && l.name === "Upgraded"));
    const implAfter = await implSlot();
    record("ERC1967 slot points at the new impl", implAfter.toLowerCase() === impl.toLowerCase(), implAfter);
    record("owner unchanged", (await read<Hex>("owner")).toLowerCase() === owner.toLowerCase());
    record("landing unchanged", (await read<Hex>("landing")).toLowerCase() === wiringBefore.landing.toLowerCase());
    record("core unchanged", (await read<Hex>("wormhole")).toLowerCase() === wiringBefore.wormhole.toLowerCase());
    record("emitter authorization unchanged", (await read<Hex>("authorizedEmitters", [2])).toLowerCase() === wiringBefore.emitter2.toLowerCase());

    // ── 5. every waiting VAA now pays ──
    console.log(`\n── 5. Receiver on current code (impl ${impl}) ──`);
    for (const v of vaas) record(`seq ${v.sequence} pays`, await deliver(v, true));
    const pendingHead = await pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: "pendingHead" });
    const pendingTail = await pub.readContract({ address: LANDING, abi: LANDING_ABI, functionName: "pendingTail" });
    record("nothing queued", pendingHead === pendingTail, `${pendingHead}/${pendingTail}`);

    const failed = results.filter((r) => !r.ok);
    console.log(
      failed.length === 0
        ? `\n🥢 ✅ ${results.length}/${results.length} — the TC call upgrades the receiver in place and every waiting payout lands.`
        : `\n🥢 ❌ ${failed.length} failed: ${failed.map((f) => f.step).join("; ")}`,
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
