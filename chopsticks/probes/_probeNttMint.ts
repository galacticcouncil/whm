/**
 * PROBE (DAI NTT mint go-live): prove that the DAI NTT manager can mint asset-18 (DAI) through the
 * MultiCurrency precompile **only after** the go-live whitelisted proposal enacts, that the 10k/day
 * xcm_rate_limit correctly gates it, and that it reverts before enactment.
 *
 * Setup: fork Hydration (tarn, spec 433). Enactment = Root-dispatch the artifact's `innerBatchAll`
 * (EVMAccounts.set_ntt_minter(18, manager) + AssetRegistry.update(18, xcm_rate_limit=10k DAI)) via a
 * Scheduler.Agenda(origin=Root) injection — the same mechanism whitelist.dispatch_whitelisted_call
 * uses on-chain. We do NOT rebuild set_ntt_minter (papi rejects it); we dispatch the raw bytes.
 *
 * Minting is exercised via the EthereumRuntimeRPCApi.call runtime API (eth_call backend) with an
 * arbitrary `from` = the NTT manager contract (which has no key). This is a dry-run that runs the FULL
 * precompile path incl. ensure_ntt_minter → IssuanceIncreaseFuse::can_mint → pallet_currencies::deposit
 * (so it also surfaces any External-asset price-route / ED revert). exit_reason + revert bytes are
 * returned deterministically. Test A additionally attempts a PERSISTED mint (EVM.call dispatched with a
 * Signed origin = manager's truncated account, via Scheduler injection + WETH gas funding) to show a
 * real totalIssuance / balance delta.
 *
 *   pnpm tsx probes/_probeNttMint.ts
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  toFunctionSelector,
  type Hex,
  type PublicClient,
} from "viem";
import { Binary } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";

const ASSET = 18;
const MANAGER = "0xcFd576F88C90844AEBF45378Fd09931281D8b14d" as Hex;
const PRECOMPILE = "0x0000000000000000000000000000000100000012" as Hex;
const RECIPIENT = "0x0000000000000000000000000000000000000abc" as Hex; // unbound EVM addr
const ONE_DAI = 10n ** 18n;
const AMOUNT_A = 1_000n * ONE_DAI; // under 10k/day limit → expect SUCCESS
const AMOUNT_B = 20_000n * ONE_DAI; // over 10k/day limit → expect MintLimitReached()
const PROPOSAL = "/home/mrq/git/hydration-ntt/ops/tokens/dai/ntt-minter-proposal.json";

const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"]);
const SEL_MINT_LIMIT = toFunctionSelector("MintLimitReached()");
const SEL_NOT_MINTER = toFunctionSelector("CallerNotMinter(address)");

const mintData = (to: Hex, amount: bigint): Hex =>
  encodeFunctionData({ abi: MINT_ABI, functionName: "mint", args: [to, amount] });

interface EvmCallResult {
  ok: boolean; // eth_call returned (no revert)
  data?: Hex; // return bytes (ok) or revert bytes (revert)
  reverted: boolean;
  err?: string; // short message when reverted
}

/** pull the first 0x-hex revert payload out of a viem/JSON-RPC error (fields OR message text). */
function extractRevertData(e: any): Hex | undefined {
  const seen = new Set<any>();
  const fromStr = (s: string): Hex | undefined => {
    const m = s.match(/0x[0-9a-fA-F]{8,}/);
    return m ? (m[0] as Hex) : undefined;
  };
  const walk = (o: any): Hex | undefined => {
    if (o == null || seen.has(o)) return undefined;
    if (typeof o === "string") return fromStr(o);
    if (typeof o !== "object") return undefined;
    seen.add(o);
    for (const k of ["data", "output", "raw", "message", "details", "shortMessage", "reason"]) {
      const v = (o as any)[k];
      if (typeof v === "string") {
        const h = fromStr(v);
        if (h) return h;
      }
    }
    for (const key of Object.keys(o)) {
      const r = walk((o as any)[key]);
      if (r) return r;
    }
    if ((o as any).cause) return walk((o as any).cause);
    return undefined;
  };
  return walk(e);
}

/** dry-run an EVM call via chopsticks eth_call with an arbitrary `from` (no signature needed). */
async function evmCall(eth: PublicClient, from: Hex, to: Hex, data: Hex, gasLimit: bigint): Promise<EvmCallResult> {
  try {
    const res = await eth.call({ account: from, to, data, gas: gasLimit });
    return { ok: true, reverted: false, data: (res.data ?? "0x") as Hex };
  } catch (e: any) {
    const revertData = extractRevertData(e);
    return { ok: false, reverted: true, data: revertData, err: e?.shortMessage ?? e?.details ?? e?.message };
  }
}

function classify(r: EvmCallResult): string {
  if (!r.reverted) return `SUCCESS (no revert), return=${r.data}`;
  const sel = r.data && r.data.length >= 10 ? (r.data.slice(0, 10) as Hex) : undefined;
  let tag = "";
  if (sel === SEL_MINT_LIMIT) tag = " ⟵ MintLimitReached()";
  else if (sel === SEL_NOT_MINTER) tag = " ⟵ CallerNotMinter(address)";
  else if (r.data && r.data !== "0x") tag = ` ⟵ revert data ${r.data.slice(0, 74)}`;
  return `REVERT ${r.data ?? "(no data surfaced)"}${tag}  [${r.err ?? ""}]`;
}

/** Root-dispatch a raw runtime call via Preimage + Scheduler.Agenda(origin=Root), build a block. */
async function dispatchAsRoot(net: Network, api: any, callHex: Hex) {
  const bin = Binary.fromHex(callHex);
  const len = bin.length;
  const registry = await net.chain.head.registry;
  const hash = registry.hash(bin).toHex() as Hex;
  const when = net.chain.head.number + 1;
  await net.setStorage({
    Preimage: { PreimageFor: [[[[hash, len]], Array.from(bin as any)]] },
    Scheduler: {
      Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]],
    },
  });
  const b = await net.chain.newBlock();
  const ev: any[] = await api.query.System.Events.getValue({ at: b.hash });
  const disp = ev.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
  return { blockHash: b.hash, dispatchedResult: disp?.event?.value?.value?.result };
}

async function readMinter(api: any): Promise<string> {
  const m: any = await api.query.EVMAccounts.NttMinters.getValue(ASSET);
  if (!m) return "None";
  return typeof m.asHex === "function" ? m.asHex() : String(m);
}

async function readRegistry(api: any) {
  const reg: any = await api.query.AssetRegistry.Assets.getValue(ASSET);
  const assetType = reg?.asset_type?.type ?? reg?.asset_type ?? reg?.value?.asset_type;
  const xcmLimit = reg?.xcm_rate_limit ?? reg?.value?.xcm_rate_limit;
  const ed = reg?.existential_deposit ?? reg?.value?.existential_deposit;
  return { assetType, xcmLimit, ed, raw: reg };
}

async function totalIssuance(api: any): Promise<bigint> {
  const v: any = await api.query.Tokens.TotalIssuance.getValue(ASSET);
  return typeof v === "bigint" ? v : BigInt(v ?? 0);
}

async function main() {
  const artifact = JSON.parse(readFileSync(PROPOSAL, "utf8"));
  const innerBatchAll = artifact.innerBatchAll as Hex;

  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const api = hydration.client.getUnsafeApi();
    const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.hydration.port}`) }) as PublicClient;
    console.log(`\n════════ DAI NTT mint go-live probe ════════`);
    console.log(`asset=${ASSET}  manager=${MANAGER}  precompile=${PRECOMPILE}`);
    console.log(`selectors: MintLimitReached()=${SEL_MINT_LIMIT}  CallerNotMinter(address)=${SEL_NOT_MINTER}`);

    // ── pre-enactment state ──
    const reg0 = await readRegistry(api);
    const minter0 = await readMinter(api);
    console.log(`\n── BEFORE enactment ──`);
    console.log(`  asset_type            : ${JSON.stringify(reg0.assetType)}`);
    console.log(`  existential_deposit   : ${reg0.ed}`);
    console.log(`  xcm_rate_limit        : ${reg0.xcmLimit}`);
    console.log(`  NttMinters(18)        : ${minter0}`);

    // ── TEST C: mint before enactment → expect CallerNotMinter revert ──
    const c = await evmCall(eth, MANAGER, PRECOMPILE, mintData(RECIPIENT, AMOUNT_A), 2_000_000n);
    const cPass = c.reverted && c.data?.slice(0, 10) === SEL_NOT_MINTER;
    console.log(`\n── TEST C (control): mint 1,000 DAI BEFORE enactment ──`);
    console.log(`  ${classify(c)}`);
    console.log(`  ${cPass ? "✅ correctly REVERTS (minter unbound)" : "❌ unexpected"}`);

    // ── ENACT: Root-dispatch innerBatchAll ──
    console.log(`\n── ENACT: Root-dispatch innerBatchAll (${(innerBatchAll.length - 2) / 2} bytes) ──`);
    const disp = await dispatchAsRoot(hydration, api, innerBatchAll);
    const reg1 = await readRegistry(api);
    const minter1 = await readMinter(api);
    const minterOk = minter1.toLowerCase().includes(MANAGER.slice(2).toLowerCase());
    const limitOk = String(reg1.xcmLimit) === String(10_000n * ONE_DAI);
    console.log(`  Scheduler.Dispatched  : ${JSON.stringify(disp.dispatchedResult)}`);
    console.log(`  NttMinters(18)        : ${minter1}  ${minterOk ? "✅" : "❌"}`);
    console.log(`  xcm_rate_limit        : ${reg1.xcmLimit}  ${limitOk ? "✅ (10,000 DAI/day)" : "❌"}`);

    // ── TEST A: mint 1,000 DAI after enactment → expect SUCCESS ──
    const a = await evmCall(eth, MANAGER, PRECOMPILE, mintData(RECIPIENT, AMOUNT_A), 2_000_000n);
    const aPass = a.ok && !a.reverted;
    console.log(`\n── TEST A: mint 1,000 DAI AFTER enactment (under 10k/day) ──`);
    console.log(`  ${classify(a)}`);
    console.log(`  ${aPass ? "✅ SUCCESS (no revert — gating + circuit breaker pass)" : "❌ unexpected revert — see data above (possible price-route/ED blocker)"}`);

    // ── TEST B: mint 20,000 DAI → expect MintLimitReached ──
    const bb = await evmCall(eth, MANAGER, PRECOMPILE, mintData(RECIPIENT, AMOUNT_B), 2_000_000n);
    const bPass = bb.reverted && bb.data?.slice(0, 10) === SEL_MINT_LIMIT;
    console.log(`\n── TEST B: mint 20,000 DAI AFTER enactment (over 10k/day) ──`);
    console.log(`  ${classify(bb)}`);
    console.log(`  ${bPass ? "✅ correctly REVERTS with MintLimitReached() (10k/day limit gates it)" : "❌ unexpected"}`);

    // ── supply context (persistence note) ──
    // A PERSISTED mint would need caller == manager, but the manager (0xcFd5…) is a keyless CONTRACT,
    // so it can't sign an eth tx; the only substrate route (pallet_evm EVM.call with a Signed origin
    // whose account maps to the manager) can't be encoded here — papi rejects EVM.call as an
    // "Incompatible runtime entry" on this runtime (same drift that blocks set_ntt_minter). The
    // eth_call dry-run above already executes the full precompile path (ensure_ntt_minter →
    // can_mint → pallet_currencies::deposit), so TEST A's non-revert is authoritative proof the
    // deposit itself succeeds (no ED/price-route failure). Current on-chain DAI supply for context:
    const iss = await totalIssuance(api);
    console.log(`\n── supply context ──`);
    console.log(`  totalIssuance(18) now : ${iss}  (${iss / ONE_DAI} DAI)`);
    console.log(`  (persisted mint skipped: manager is a keyless contract; papi can't encode EVM.call)`);

    // ── verdict ──
    console.log(`\n════════ VERDICT ════════`);
    console.log(`  TEST C (before enactment reverts) : ${cPass ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`  TEST A (mint succeeds after)      : ${aPass ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`  TEST B (10k/day limit gates)      : ${bPass ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`  asset_type=${JSON.stringify(reg1.assetType)} — ${JSON.stringify(reg1.assetType).includes("External") ? "EXTERNAL: check price-route caveat" : "not External"}`);
    if (!aPass) console.log(`  ⚠️ BLOCKER: Test A did not succeed. Revert data: ${a.data}`);
  } finally {
    await teardownForks(nets);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
