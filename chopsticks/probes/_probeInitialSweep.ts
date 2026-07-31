/**
 * End-to-end INITIAL-SWEEP gov flow (Hydration + Moonbeam fork).
 *   1. deploy MrlSweeperHardcoded on Moonbeam (inject runtime bytecode; immutables SA/OWNER/BRIDGE
 *      identified by sentinel; destinations are in the bytecode, no storage to seed).
 *   2. supply-back the 11 MRL tokens onto the SA.
 *   3. Root-dispatch the initial-sweep call on Hydration:
 *        PolkadotXcm.send(Moonbeam, Transact{SA, batch[ approve(sweeper,MAX), sweeper.sweep(token) ]×11}).
 *   4. verify each token drained to 0, one Wormhole VAA per token with amount==normalize(balance) and
 *      recipientChain+recipient == the sweeper's HARDCODED destOf(token), and the standing approval
 *      survives (allowance(SA,sweeper) > 0) so the OWNER EOA can backstop stragglers.
 *
 *   pnpm tsx probes/_probeInitialSweep.ts
 */
import {
  createPublicClient, http, decodeEventLog, encodeEventTopics, encodeFunctionData, getAddress, keccak256, pad,
  parseAbi, erc20Abi, type Abi, type Hex, type PublicClient,
} from "viem";
import { readFileSync } from "node:fs";
import { acc } from "@galacticcouncil/common";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { ASSETS } from "./exitAssets";
import { buildInitialSweepInner } from "./_buildInitialSweepProposal";
import { WH_ORIGIN, WH_GENERALKEY_DATA } from "./_buildSweepProposal";

const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const BRIDGE = getAddress("0xb1731c586ca89a23809861c6103f0b96b3f57d92");
const CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3");
const ART = "/home/mrq/git/whm/contracts/out/MrlSweeperHardcoded.sol/MrlSweeperHardcoded.json";
const SWEEPER = getAddress("0x00000000000000000000000000000000005A7EE9"); // test deploy addr
const OWNER = getAddress("0x000000000000000000000000000000000000bEEF"); // test owner EOA

const GETTER_ABI = parseAbi([
  "function SA() view returns (address)", "function OWNER() view returns (address)",
  "function BRIDGE() view returns (address)", "function destOf(address) view returns (uint16, bytes32)",
]);
const CORE_ABI = [{ type: "event", name: "LogMessagePublished", inputs: [
  { name: "sender", type: "address", indexed: true }, { name: "sequence", type: "uint64" },
  { name: "nonce", type: "uint32" }, { name: "payload", type: "bytes" }, { name: "consistencyLevel", type: "uint8" }] }] as const satisfies Abi;
const LOG_TOPIC = encodeEventTopics({ abi: CORE_ABI, eventName: "LogMessagePublished" })[0]!.toLowerCase();
const CHAIN_NAME: Record<number, string> = { 1: "Solana", 2: "Ethereum", 21: "Sui", 30: "Base" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hx = (x: any): string => x == null ? "" : typeof x === "string" ? x.toLowerCase()
  : typeof x?.asHex === "function" ? x.asHex().toLowerCase() : x instanceof Uint8Array ? "0x" + Buffer.from(x).toString("hex") : String(x).toLowerCase();
const norm = (bal: bigint, dec: number): bigint => dec > 8 ? bal / 10n ** BigInt(dec - 8) : bal;

async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}
interface Transfer { amount: bigint; tokenChain: number; toChain: number; recipient: Hex; }
function decodeTransfer(payload: Hex): Transfer {
  const b = payload.slice(2);
  return { amount: BigInt("0x" + b.slice(2, 66)), tokenChain: parseInt(b.slice(130, 134), 16),
    recipient: ("0x" + b.slice(134, 198)) as Hex, toChain: parseInt(b.slice(198, 202), 16) };
}
function coreLogsIn(events: any[]) {
  const out: { topics: Hex[]; data: Hex }[] = [];
  for (const { event } of events) {
    if (event?.type !== "EVM" || event?.value?.type !== "Log") continue;
    const log = event.value.value?.log; if (!log || hx(log.address) !== CORE.toLowerCase()) continue;
    const topics = (log.topics ?? []).map((tp: any) => hx(tp) as Hex);
    if (topics[0] === LOG_TOPIC) out.push({ topics, data: hx(log.data) as Hex });
  }
  return out;
}
async function collectVaas(moonbeam: Network, n = 8): Promise<Transfer[]> {
  const logs: { topics: Hex[]; data: Hex }[] = [];
  for (let i = 0; i < n; i++) { const b = await moonbeam.chain.newBlock(); logs.push(...coreLogsIn(await evAt(moonbeam, b.hash))); }
  await sleep(300);
  return logs.map((l) => decodeTransfer((decodeEventLog({ abi: CORE_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as any).payload as Hex));
}

// deploy sweeper by injecting resolved runtime bytecode; 3 immutables (SA/OWNER/BRIDGE) identified by sentinel
async function deploySweeper(moonbeam: Network, eth: PublicClient) {
  const art = JSON.parse(readFileSync(ART, "utf8"));
  const refs: Record<string, { start: number }[]> = art.deployedBytecode.immutableReferences;
  const ids = Object.keys(refs);
  const build = (vals: Record<string, string>) => {
    let code = (art.deployedBytecode.object as string).replace(/^0x/, "");
    for (const [id, offs] of Object.entries(refs)) {
      const v = vals[id].replace(/^0x/, "").toLowerCase().padStart(64, "0");
      for (const { start } of offs) code = code.slice(0, start * 2) + v + code.slice(start * 2 + 64);
    }
    return code;
  };
  const inject = async (code: string) => {
    await moonbeam.setStorage({
      EVM: { AccountCodes: [[[SWEEPER], Array.from(Buffer.from(code, "hex"))]],
             AccountCodesMetadata: [[[SWEEPER], { size: code.length / 2, hash: keccak256(("0x" + code) as Hex) }]] },
      System: { Account: [[[SWEEPER], { nonce: 1, providers: 1, data: { free: 0n } }]] },
    });
  };
  // 1. identify each immutable id via a distinct sentinel address
  const sentinel: Record<string, string> = {};
  ids.forEach((id, i) => (sentinel[id] = "0x" + (i + 1).toString(16).padStart(40, "0")));
  await inject(build(sentinel));
  const rd = (fn: string) => eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: fn as any }) as Promise<Hex>;
  const saS = await rd("SA"), owS = await rd("OWNER"), brS = await rd("BRIDGE");
  const idOf = (v: string) => ids.find((id) => sentinel[id].toLowerCase() === v.toLowerCase())!;
  // 2. inject the real values
  await inject(build({ [idOf(saS)]: SA, [idOf(owS)]: OWNER, [idOf(brS)]: BRIDGE }));
  const saOk = getAddress(await rd("SA")) === SA, owOk = getAddress(await rd("OWNER")) === OWNER, brOk = getAddress(await rd("BRIDGE")) === BRIDGE;
  return { saOk, owOk, brOk };
}

const slotKey = (holder: Hex, slot: number): Hex =>
  keccak256(("0x" + pad(holder, { size: 32 }).slice(2) + pad(("0x" + slot.toString(16)) as Hex, { size: 32 }).slice(2)) as Hex);
async function findBalSlot(moonbeam: Network, eth: PublicClient, token: Hex, dec: number) {
  const probe = getAddress("0x000000000000000000000000000000000000bEEF");
  const sentinel = 777n * 10n ** BigInt(dec);
  for (let slot = 0; slot < 30; slot++) {
    const key = slotKey(probe, slot);
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad(("0x" + sentinel.toString(16)) as Hex, { size: 32 })]] } });
    const got = await eth.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [probe] }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad("0x0", { size: 32 })]] } });
    if (got === sentinel) return slot;
  }
  return null;
}
// find the totalSupply scalar slot (write sentinel to slot i, read totalSupply)
async function findSupplySlot(moonbeam: Network, eth: PublicClient, token: Hex, dec: number) {
  const sentinel = 999n * 10n ** BigInt(dec + 6);
  for (let slot = 0; slot < 30; slot++) {
    const key = pad(("0x" + slot.toString(16)) as Hex, { size: 32 });
    const prev = await eth.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad(("0x" + sentinel.toString(16)) as Hex, { size: 32 })]] } });
    const got = await eth.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad(("0x" + prev.toString(16)) as Hex, { size: 32 })]] } });
    if (got === sentinel) return slot;
  }
  return null;
}

async function main() {
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.moonbeam.port}`) }) as PublicClient;
  const registry: any = await hydration.chain.head.registry;
  const results: { pass: boolean; label: string }[] = [];
  const rec = (label: string, pass: boolean) => { results.push({ pass, label }); return pass; };
  const bal = (t: Hex) => eth.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [SA] }) as Promise<bigint>;
  const allowance = (t: Hex) => eth.readContract({ address: t, abi: erc20Abi, functionName: "allowance", args: [SA, SWEEPER] }) as Promise<bigint>;

  try {
    console.log(`\n════════ initial-sweep gov flow ════════`);
    console.log(`SA=${SA}  sweeper=${SWEEPER}  owner=${OWNER}`);
    await moonbeam.setStorage({ System: { Account: [[[SA], { providers: 1, data: { free: 20000n * 10n ** 18n } }]] } });

    const dep = await deploySweeper(moonbeam, eth);
    rec("sweeper deployed (SA/OWNER/BRIDGE immutables)", dep.saOk && dep.owOk && dep.brOk);
    console.log(`  SA() ${dep.saOk ? "✅" : "❌"}  OWNER() ${dep.owOk ? "✅" : "❌"}  BRIDGE() ${dep.brOk ? "✅" : "❌"}`);

    // supply-back all 11 tokens (clean 8dp-aligned amounts)
    console.log(`\n── supply-back SA balances ──`);
    const before: Record<string, bigint> = {};
    for (const a of ASSETS) {
      const token = getAddress(a.token);
      const balSlot = await findBalSlot(moonbeam, eth, token, a.decimals);
      const supSlot = await findSupplySlot(moonbeam, eth, token, a.decimals);
      const amount = 1000n * 10n ** BigInt(a.decimals);
      const writes: any[] = [];
      if (balSlot != null) writes.push([[token, slotKey(SA, balSlot)], pad(("0x" + amount.toString(16)) as Hex, { size: 32 })]);
      // bump totalSupply huge so the Wormhole burn-on-exit can't underflow (WBTC/WETH wrapped supply < 1000 units)
      if (supSlot != null) writes.push([[token, pad(("0x" + supSlot.toString(16)) as Hex, { size: 32 })], pad(("0x" + (amount + 10n ** 40n).toString(16)) as Hex, { size: 32 })]);
      if (writes.length) await moonbeam.setStorage({ EVM: { AccountStorages: writes } });
      before[a.sym] = await bal(token);
      console.log(`  ${a.sym.padEnd(8)} balSlot=${balSlot} supSlot=${supSlot}  SA bal=${before[a.sym]}`);
    }
    const backed = ASSETS.filter((a) => before[a.sym] > 0n);

    // expected hardcoded dests from the deployed sweeper
    const dest: Record<string, { chain: number; recipient: string }> = {};
    for (const a of ASSETS) {
      const [c, r] = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "destOf", args: [getAddress(a.token)] }) as [number, Hex];
      dest[a.sym] = { chain: Number(c), recipient: r.toLowerCase() };
    }

    // build inner: 11 approve sends (now) + schedule_after(delay, 11 sweep sends + 11 sever) — no batchAll precompile
    const head0 = hydration.chain.head.number;
    const delay = 6;                         // relative: sweeps fire `delay` blocks after the inner dispatches
    const fireAt = head0 + 1 + delay;        // inner dispatches at head0+1, schedule_after adds `delay`
    const inner = buildInitialSweepInner(SWEEPER, delay);
    const bytes = Binary.fromHex(inner); const len = bytes.length;
    const hash = registry.hash(bytes as any).toHex() as Hex;
    console.log(`\n── Root-dispatch inner (${len} bytes, ${ASSETS.length} approve sends + sweeps after +${delay}) ──`);
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
      Scheduler: { Agenda: [[[head0 + 1], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    const hb = await hydration.chain.newBlock(); // dispatch: approves fire + sweeps scheduled
    const disp = (await evAt(hydration, hb.hash)).find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
    rec("inner dispatched Ok as Root", JSON.stringify(disp?.event?.value?.value?.result ?? {}).includes("success"));
    await hydration.newBlock(); // flush HRMP (approve sends)

    // process approves on Moonbeam → verify allowances set (allowance() defined at main top)
    const MAX = (1n << 256n) - 1n;
    for (let i = 0; i < 4; i++) await moonbeam.chain.newBlock();
    await sleep(300);
    console.log(`\n── approves landed on Moonbeam? ──`);
    let approveAll = true;
    for (const a of ASSETS) { const al = await allowance(getAddress(a.token)); const ok = al === MAX; approveAll &&= ok; console.log(`  ${a.sym.padEnd(8)} allowance=${al === MAX ? "MAX" : al} ${ok ? "✅" : "❌"}`); }
    rec("all 11 approves landed (SA→sweeper allowance == MAX)", approveAll);

    // advance Hydration to BLOCK_N → scheduled sweeps fire → collect VAAs on Moonbeam
    console.log(`\n── advance Hydration +${delay} (to ${fireAt}) → sweeps fire ──`);
    while (hydration.chain.head.number < fireAt) await hydration.chain.newBlock();
    await hydration.newBlock(); // flush HRMP (sweep sends)
    const vlogs: { topics: Hex[]; data: Hex }[] = [];
    for (let i = 0; i < 8; i++) {
      const b = await moonbeam.chain.newBlock();
      const ev = await evAt(moonbeam, b.hash);
      vlogs.push(...coreLogsIn(ev));
      const J = (v: any) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x?.asHex ? x.asHex() : x));
      for (const { event } of ev) if (event?.type === "Ethereum" && event?.value?.type === "Executed" && J(event.value.value?.exit_reason).includes("Revert")) console.log(`  [mb blk+${i}] Ethereum.Executed REVERT`);
    }
    await sleep(300);
    const vaas = vlogs.map((l) => decodeTransfer((decodeEventLog({ abi: CORE_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as any).payload as Hex));
    console.log(`\n── sweeps: verify (${backed.length} tokens) ── VAAs seen: ${vaas.length}`);
    let drainAll = true, vaaAll = true;
    for (let i = 0; i < backed.length; i++) {
      const a = backed[i]; const token = getAddress(a.token);
      const after = await bal(token);
      const v = vaas[i];
      const expAmt = norm(before[a.sym], a.decimals);
      const drained = after === 0n;
      const amtOk = !!v && v.amount === expAmt;
      const chainOk = !!v && v.toChain === dest[a.sym].chain;
      const recipOk = !!v && v.recipient.toLowerCase() === dest[a.sym].recipient;
      drainAll &&= drained; vaaAll &&= amtOk && chainOk && recipOk;
      console.log(`  ${a.sym.padEnd(8)} SA→${after} ${drained ? "✅" : "❌"}  VAA amt${amtOk ? "✅" : "❌"} chain=${v?.toChain}(${CHAIN_NAME[dest[a.sym].chain]})${chainOk ? "✅" : "❌"} recip${recipOk ? "✅" : "❌"}`);
    }
    rec("all backed tokens drained to 0", drainAll);
    rec(`${backed.length} VAAs, correct amount + hardcoded chain + recipient`, vaaAll && vaas.length === backed.length);

    // sever verification: every asset's Hydration AssetLocations repointed to WH-origin (X3) at BLOCK_N
    console.log(`\n── XCM sever: AssetLocations → WH-origin (11) ──`);
    const api0 = hydration.client.getUnsafeApi();
    let severAll = true;
    for (const a of ASSETS) {
      const loc: any = await api0.query.AssetRegistry.AssetLocations.getValue(a.id);
      const [chain, addr] = WH_ORIGIN[a.id];
      const iv = loc?.interior;
      const ok = loc?.parents === 0 && iv?.type === "X3"
        && iv.value[0]?.type === "GeneralKey" && hx(iv.value[0]?.value?.data) === ("0x" + WH_GENERALKEY_DATA)
        && iv.value[1]?.type === "GeneralIndex" && String(iv.value[1]?.value) === String(chain)
        && iv.value[2]?.type === "GeneralKey" && hx(iv.value[2]?.value?.data) === addr.toLowerCase();
      severAll &&= ok;
      console.log(`  ${a.sym.padEnd(8)} id=${String(a.id).padEnd(8)} X3 WH-origin ${ok ? "✅" : "❌"}`);
    }
    rec("all 11 tokens severed from XCM (AssetLocations = WH-origin)", severAll);

    // standing approval survives for the EOA backstop
    const allowLeft = await allowance(getAddress(backed[0].token));
    rec("standing approval survives (allowance > 0) for backstop", allowLeft > 0n);
    console.log(`\n  allowance(SA→sweeper) for ${backed[0].sym} after sweep: ${allowLeft > 10n ** 30n ? "~MAX" : allowLeft} ${allowLeft > 0n ? "✅" : "❌"}`);

    console.log(`\n════════ VERDICT ════════`);
    for (const r of results) console.log(`  ${r.pass ? "PASS ✅" : "FAIL ❌"}  ${r.label}`);
    const ok = results.every((r) => r.pass);
    console.log(`\n${ok ? "ALL PASS ✅" : "FAILURES ❌"}`);
    process.exitCode = ok ? 0 : 1;
  } finally { await teardownForks(nets); }
}
main().catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
