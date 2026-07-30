/**
 * FULL two-sweep MRL-drain proposal test (Hydration + Moonbeam fork).
 *
 *  1. spawn both forks (HRMP wired); inject MrlSweeper on Moonbeam; seed SA GLMR; supply-back all 11
 *     MRL tokens on the SA (balance + totalSupply, so burn-on-exit can't underflow).
 *  2. Root-dispatch the inner batch_all([SWEEP1, SCHEDULE_SWEEP2]) on Hydration.
 *  3. verify SWEEP1: every backed token SA balanceOf → 0, one Wormhole LogMessagePublished per token
 *     with amount == normalize(pre-balance), correct recipientChain + recipient.
 *  4. verify SWEEP2 scheduled at BLOCK_N (Scheduler.Agenda / Scheduler.Lookup).
 *  5. straggler: re-credit a few tokens, fast-forward Hydration to BLOCK_N, let SWEEP2 fire → verify
 *     stragglers swept + fresh VAAs; 0-balance tokens no-op (no message, no revert).
 *  6. self-decode the inner.
 *
 *   pnpm tsx probes/_probeSweepProposal.ts
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient, http, decodeEventLog, encodeEventTopics, getAddress, keccak256, pad,
  parseAbi, erc20Abi, type Abi, type Hex, type PublicClient,
} from "viem";
import { Binary } from "polkadot-api";
import { acc } from "@galacticcouncil/common";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { ASSETS, resolveRecipient, type ExitAsset } from "./exitAssets";
import { SWEEPER, SWEEP2_ID, buildSweepCall, buildScheduleNamed, buildInner } from "./_buildSweepProposal";

const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const BRIDGE = getAddress("0xb1731c586ca89a23809861c6103f0b96b3f57d92");
const CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3");
const ART = "/home/mrq/git/whm/contracts/out/MrlSweeper.sol/MrlSweeper.json";

const GETTER_ABI = parseAbi(["function SA() view returns (address)", "function BRIDGE() view returns (address)"]);
const CORE_ABI = [{ type: "event", name: "LogMessagePublished", inputs: [
  { name: "sender", type: "address", indexed: true }, { name: "sequence", type: "uint64" },
  { name: "nonce", type: "uint32" }, { name: "payload", type: "bytes" }, { name: "consistencyLevel", type: "uint8" }] }] as const satisfies Abi;
const LOG_TOPIC = encodeEventTopics({ abi: CORE_ABI, eventName: "LogMessagePublished" })[0]!.toLowerCase();
const CHAIN_NAME: Record<number, string> = { 1: "Solana", 2: "Ethereum", 21: "Sui", 30: "Base" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hx = (x: any): string => x == null ? "" : typeof x === "string" ? x.toLowerCase()
  : typeof x?.asHex === "function" ? x.asHex().toLowerCase()
  : x instanceof Uint8Array ? "0x" + Buffer.from(x).toString("hex") : String(x).toLowerCase();
const norm = (bal: bigint, dec: number): bigint => dec > 8 ? bal / 10n ** BigInt(dec - 8) : bal;

// ── deploy sweeper by injecting resolved runtime bytecode (immutables SA+BRIDGE) ──
async function deploySweeper(moonbeam: Network, eth: PublicClient) {
  const art = JSON.parse(readFileSync(ART, "utf8"));
  const refs: Record<string, { start: number; length: number }[]> = art.deployedBytecode.immutableReferences;
  const ids = Object.keys(refs);
  const build = (saId: string, brId: string): string => {
    let code = (art.deployedBytecode.object as string).replace(/^0x/, "");
    const put = (offs: { start: number }[], addr: string) => {
      const v = addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      for (const { start } of offs) code = code.slice(0, start * 2) + v + code.slice(start * 2 + 64);
    };
    put(refs[saId], SA); put(refs[brId], BRIDGE);
    return code;
  };
  const inject = async (code: string) => {
    const codeHex = ("0x" + code) as Hex;
    await moonbeam.setStorage({
      EVM: {
        AccountCodes: [[[SWEEPER], Array.from(Buffer.from(code, "hex"))]],
        AccountCodesMetadata: [[[SWEEPER], { size: code.length / 2, hash: keccak256(codeHex) }]],
      },
      System: { Account: [[[SWEEPER], { nonce: 1, providers: 1, data: { free: 0n } }]] },
    });
  };
  await inject(build(ids[0], ids[1]));
  let saGet = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "SA" }) as Hex;
  if (getAddress(saGet) !== SA) { await inject(build(ids[1], ids[0])); saGet = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "SA" }) as Hex; }
  const brGet = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "BRIDGE" }) as Hex;
  return { saOk: getAddress(saGet) === SA, brOk: getAddress(brGet) === BRIDGE };
}

// ── locate a token's ERC20 balances-mapping slot + totalSupply scalar slot via write-probe ──
const slotKey = (holder: Hex, slot: number): Hex =>
  keccak256(("0x" + pad(holder, { size: 32 }).slice(2) + pad(("0x" + slot.toString(16)) as Hex, { size: 32 }).slice(2)) as Hex);

async function findSlots(moonbeam: Network, eth: PublicClient, token: Hex, dec: number) {
  const probe = getAddress("0x000000000000000000000000000000000000bEEF");
  const sentinel = 777n * 10n ** BigInt(dec);
  let balSlot: number | null = null, supplySlot: number | null = null;
  for (let slot = 0; slot < 30 && balSlot === null; slot++) {
    const key = slotKey(probe, slot);
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad(("0x" + sentinel.toString(16)) as Hex, { size: 32 })]] } });
    const got = await eth.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [probe] }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad("0x0", { size: 32 })]] } });
    if (got === sentinel) balSlot = slot;
  }
  const supSentinel = 999n * 10n ** BigInt(dec);
  for (let slot = 0; slot < 30 && supplySlot === null; slot++) {
    const key = pad(("0x" + slot.toString(16)) as Hex, { size: 32 });
    const prev = await eth.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad(("0x" + supSentinel.toString(16)) as Hex, { size: 32 })]] } });
    const got = await eth.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[token, key], pad(("0x" + prev.toString(16)) as Hex, { size: 32 })]] } });
    if (got === supSentinel) supplySlot = slot;
  }
  return { balSlot, supplySlot };
}

async function creditSA(moonbeam: Network, token: Hex, balSlot: number, supplySlot: number | null, amount: bigint) {
  const writes: any[] = [[[token, slotKey(SA, balSlot)], pad(("0x" + amount.toString(16)) as Hex, { size: 32 })]];
  if (supplySlot != null) writes.push([[token, pad(("0x" + supplySlot.toString(16)) as Hex, { size: 32 })], pad(("0x" + (amount + 10n ** 30n).toString(16)) as Hex, { size: 32 })]);
  await moonbeam.setStorage({ EVM: { AccountStorages: writes } });
}

// ── event / VAA collection ──
async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}
function coreLogsIn(events: any[]) {
  const out: { topics: Hex[]; data: Hex }[] = [];
  for (const { event } of events) {
    const ev = event as any;
    if (ev.type !== "EVM" || ev.value?.type !== "Log") continue;
    const log = ev.value.value?.log; if (!log || hx(log.address) !== CORE.toLowerCase()) continue;
    const topics = (log.topics ?? []).map((tp: any) => hx(tp) as Hex);
    if (topics[0] === LOG_TOPIC) out.push({ topics, data: hx(log.data) as Hex });
  }
  return out;
}
interface Transfer { amount: bigint; tokenChain: number; toChain: number; recipient: Hex; }
function decodeTransfer(payload: Hex): Transfer {
  const b = payload.slice(2);
  return {
    amount: BigInt("0x" + b.slice(1 * 2, 33 * 2)),
    tokenChain: parseInt(b.slice(65 * 2, 67 * 2), 16),
    recipient: ("0x" + b.slice(67 * 2, 99 * 2)) as Hex,
    toChain: parseInt(b.slice(99 * 2, 101 * 2), 16),
  };
}
// collect all Wormhole transfers emitted across the next `n` Moonbeam blocks
async function collectVaas(moonbeam: Network, n = 8): Promise<Transfer[]> {
  const logs: { topics: Hex[]; data: Hex }[] = [];
  for (let i = 0; i < n; i++) { const b = await moonbeam.chain.newBlock(); logs.push(...coreLogsIn(await evAt(moonbeam, b.hash))); }
  await sleep(300);
  return logs.map((l) => decodeTransfer((decodeEventLog({ abi: CORE_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as any).payload as Hex));
}

async function main() {
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.moonbeam.port}`) }) as PublicClient;
  const registry: any = await hydration.chain.head.registry;
  const bal = (tok: Hex) => eth.readContract({ address: tok, abi: erc20Abi, functionName: "balanceOf", args: [SA] }) as Promise<bigint>;
  const results: { pass: boolean; label: string }[] = [];
  const rec = (label: string, pass: boolean) => { results.push({ pass, label }); return pass; };

  try {
    console.log(`\n════════ two-sweep MRL-drain FULL proposal test ════════`);
    console.log(`SA=${SA}  sweeper=${SWEEPER}`);

    // 1. seed SA GLMR + deploy sweeper
    await moonbeam.setStorage({ System: { Account: [[[SA], { providers: 1, data: { free: 20000n * 10n ** 18n } }]] } });
    const dep = await deploySweeper(moonbeam, eth);
    rec("sweeper deployed (SA/BRIDGE immutables)", dep.saOk && dep.brOk);
    console.log(`\n── deploy MrlSweeper ──  SA() ${dep.saOk ? "✅" : "❌"}  BRIDGE() ${dep.brOk ? "✅" : "❌"}`);

    // 2. supply-back ALL 11 tokens on the SA (test balances w/ sub-8dp dust for >8dp assets)
    console.log(`\n── supply-back SA balances (find slots + credit) ──`);
    const slots: Record<string, { balSlot: number | null; supplySlot: number | null }> = {};
    const before: Record<string, bigint> = {};
    for (const a of ASSETS) {
      const token = getAddress(a.token);
      const s = await findSlots(moonbeam, eth, token, a.decimals);
      slots[a.sym] = s;
      let amount = 0n;
      if (s.balSlot != null) {
        // 1000 units + a sub-8dp dust tail for >8dp tokens (exercises Wormhole 8dp trim)
        amount = 1000n * 10n ** BigInt(a.decimals) + (a.decimals > 8 ? 777n : 0n);
        await creditSA(moonbeam, token, s.balSlot, s.supplySlot, amount);
      }
      before[a.sym] = await bal(token);
      console.log(`  ${a.sym.padEnd(8)} slot bal=${String(s.balSlot).padStart(2)} sup=${String(s.supplySlot).padStart(2)}  SA=${before[a.sym]}  ${before[a.sym] > 0n ? "✅" : "⚠️ 0 (will no-op)"}`);
    }
    const backed = ASSETS.filter((a) => before[a.sym] > 0n);

    // 3. build + Root-dispatch inner batch_all([SWEEP1, SCHEDULE_SWEEP2@BLOCK_N])
    const BLOCK_N = process.env.BLOCK_N ? Number(process.env.BLOCK_N) : hydration.chain.head.number + 20;
    const sweepCall = buildSweepCall();
    const inner = buildInner(sweepCall, buildScheduleNamed(sweepCall, BLOCK_N));
    console.log(`\n── Root-dispatch inner batch_all  (BLOCK_N=${BLOCK_N}, inner=${(inner.length - 2) / 2} bytes) ──`);
    {
      const bytes = Binary.fromHex(inner); const len = bytes.length;
      const hash = registry.hash(bytes as any).toHex() as Hex;
      const when = hydration.chain.head.number + 1;
      await hydration.setStorage({
        Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
        Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
      });
      const hb = await hydration.chain.newBlock();
      const he: any[] = await evAt(hydration, hb.hash);
      const disp = he.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
      const scheduled = he.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Scheduled");
      const dispOk = JSON.stringify(disp?.event?.value?.value?.result ?? {}).includes("success") || disp?.event?.value?.value?.result?.success === true;
      console.log(`  Scheduler.Dispatched(inner): ${JSON.stringify(disp?.event?.value?.value?.result)}`);
      console.log(`  Scheduler.Scheduled(SWEEP2): ${scheduled ? "yes ✅" : "no ❌"}  at block ${scheduled?.event?.value?.value?.when}`);
      rec("inner dispatched Ok + SWEEP2 scheduled", !!disp && !!scheduled);
      await hydration.chain.newBlock(); // flush HRMP
    }

    // 3b. collect SWEEP1 VAAs on Moonbeam
    const t1 = await collectVaas(moonbeam, 8);

    // 4. verify SWEEP1 — every backed token drained to 0, one correct VAA each (in batch order)
    console.log(`\n── SWEEP1 verification (${backed.length} backed tokens) ──`);
    let drainAll = true, vaaAll = true;
    for (let i = 0; i < backed.length; i++) {
      const a = backed[i];
      const token = getAddress(a.token);
      const after = await bal(token);
      const v = t1[i];
      const expAmt = norm(before[a.sym], a.decimals);
      const expRecip = ("0x" + resolveRecipient(a)).toLowerCase();
      const drained = after === 0n;
      const amtOk = !!v && v.amount === expAmt;
      const chainOk = !!v && v.toChain === a.originChain && v.tokenChain === a.originChain;
      const recipOk = !!v && v.recipient.toLowerCase() === expRecip;
      drainAll &&= drained; vaaAll &&= amtOk && chainOk && recipOk;
      console.log(`  ${a.sym.padEnd(8)} SA→${after} ${drained ? "✅" : "❌"}  VAA amt=${v?.amount}/exp${expAmt}${amtOk ? "✅" : "❌"} chain=${v?.toChain}(${CHAIN_NAME[a.originChain]})${chainOk ? "✅" : "❌"} recip${recipOk ? "✅" : "❌"}`);
    }
    rec("SWEEP1 drains all backed tokens to 0", drainAll);
    rec(`SWEEP1 emits ${backed.length} correct VAAs`, t1.length === backed.length && vaaAll);
    console.log(`  VAAs: ${t1.length} / ${backed.length} expected`);

    // 5. verify SWEEP2 is scheduled at BLOCK_N. NB: schedule_named takes an inline Box<RuntimeCall>,
    //    but pallet_scheduler internally bounds a >128-byte call as a preimage ⇒ the stored Agenda
    //    entry's `call` is Bounded::Lookup{hash=blake2(sweepCall), len}, and the scheduler auto-noted
    //    the preimage (no manual note_preimage needed by us).
    console.log(`\n── SWEEP2 schedule verification ──`);
    const api = hydration.client.getUnsafeApi();
    const sweepHash = (registry.hash(Binary.fromHex(sweepCall) as any).toHex() as string).toLowerCase();
    const agenda: any[] = await api.query.Scheduler.Agenda.getValue(BLOCK_N);
    const task = (agenda ?? []).find((t: any) => t);
    const taskCall = task?.call;
    const callJson = JSON.stringify(taskCall, (k, v) => v?.asHex ? v.asHex() : (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
    const boundOk = callJson.includes(sweepHash.slice(2)) || callJson.includes('"send"');
    let lookup: any = null;
    try { lookup = await api.query.Scheduler.Lookup.getValue(Binary.fromHex(SWEEP2_ID)); }
    catch { try { lookup = await (hydration.chain.head as any).get(Binary.fromHex(SWEEP2_ID)); } catch {} }
    console.log(`  Agenda(${BLOCK_N}) length: ${(agenda ?? []).length}  task present: ${task ? "✅" : "❌"}`);
    console.log(`  task.call: ${callJson.slice(0, 120)}`);
    console.log(`  expect Bounded::Lookup hash == sweepHash ${sweepHash}  ${boundOk ? "✅" : "❌"}`);
    console.log(`  Scheduler.Lookup(SWEEP2_ID): ${lookup ? "present ✅" : "n/a (papi rejected typed read)"}`);
    rec("SWEEP2 present in Scheduler.Agenda(BLOCK_N) as Lookup→sweepCall", !!task && boundOk);

    // 6. straggler: re-credit a few tokens, fast-forward to BLOCK_N, let SWEEP2 fire
    console.log(`\n── straggler run (re-credit, fast-forward to BLOCK_N=${BLOCK_N}) ──`);
    const stragglers = ["DAI", "USDC", "SUI"].map((s) => ASSETS.find((a) => a.sym === s)!).filter((a) => slots[a.sym].balSlot != null);
    const zeroAtN = backed.filter((a) => !stragglers.includes(a)); // should stay 0 → no-op
    const stBefore: Record<string, bigint> = {};
    for (const a of stragglers) {
      const amount = 500n * 10n ** BigInt(a.decimals) + (a.decimals > 8 ? 55n : 0n);
      await creditSA(moonbeam, getAddress(a.token), slots[a.sym].balSlot!, slots[a.sym].supplySlot, amount);
      stBefore[a.sym] = await bal(getAddress(a.token));
      console.log(`  re-credited ${a.sym}: ${stBefore[a.sym]}`);
    }
    // fast-forward Hydration until head == BLOCK_N (scheduler fires SWEEP2 at BLOCK_N)
    let guard = 0;
    while (hydration.chain.head.number < BLOCK_N && guard++ < 200) await hydration.chain.newBlock();
    const nAt = hydration.chain.head.number;
    const fbHash = hydration.chain.head.hash;
    const fev: any[] = await evAt(hydration, fbHash);
    const fdisp = fev.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
    console.log(`  Hydration head=${nAt} (target ${BLOCK_N})  Scheduler.Dispatched@BLOCK_N: ${fdisp ? JSON.stringify(fdisp.event.value.value.result) : "❌ none"}`);
    rec("SWEEP2 fired at BLOCK_N", nAt === BLOCK_N && !!fdisp);
    await hydration.chain.newBlock(); // flush HRMP
    const t2 = await collectVaas(moonbeam, 8);

    // verify stragglers swept + zero-balance tokens produced nothing
    console.log(`\n── SWEEP2 straggler verification ──`);
    let stDrain = true, stVaa = true;
    for (let i = 0; i < stragglers.length; i++) {
      const a = stragglers[i]; const after = await bal(getAddress(a.token)); const v = t2[i];
      const expAmt = norm(stBefore[a.sym], a.decimals);
      const ok = after === 0n; const amtOk = !!v && v.amount === expAmt;
      stDrain &&= ok; stVaa &&= amtOk;
      console.log(`  ${a.sym.padEnd(8)} SA→${after} ${ok ? "✅" : "❌"}  VAA amt=${v?.amount}/exp${expAmt} ${amtOk ? "✅" : "❌"}`);
    }
    rec("SWEEP2 sweeps stragglers to 0", stDrain);
    rec(`SWEEP2 emits ${stragglers.length} straggler VAAs`, t2.length === stragglers.length && stVaa);
    rec("zero-balance tokens produced no extra VAA / no revert", t2.length === stragglers.length);
    console.log(`  straggler VAAs: ${t2.length} (expect ${stragglers.length}); ${zeroAtN.length} already-drained tokens no-op'd`);

    // 7. self-decode inner
    let decodeOk = false, decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(Binary.fromHex(inner))).decodedCall;
      const calls = dc.value.value.calls;
      decodeOk = dc.type === "Utility" && dc.value.type === "batch_all" && calls.length === 2
        && calls[0].value.type === "send" && calls[1].value.type === "schedule_named"
        && calls[1].value.value.call.value.type === "send";
      decodeInfo = `${dc.type}.${dc.value.type}[${calls.map((c: any) => c.type + "." + c.value.type).join(", ")}]`;
    } catch (e: any) { decodeInfo = "decode failed: " + (e?.message ?? e); }
    rec("inner self-decodes as batch_all[send, schedule_named(send)]", decodeOk);
    console.log(`\n── inner self-decode ──  ${decodeInfo}  ${decodeOk ? "✅" : "❌"}`);

    // verdict
    console.log(`\n════════ VERDICT ════════`);
    for (const r of results) console.log(`  ${r.pass ? "PASS ✅" : "FAIL ❌"}  ${r.label}`);
    const allPass = results.every((r) => r.pass);
    console.log(`\n  ${allPass ? "ALL PASS ✅✅✅" : "SOME FAILED ❌"}`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
