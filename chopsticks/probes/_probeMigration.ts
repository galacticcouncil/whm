/** MIGRATION probe — dispatch the 17-leg rescue batchAll as Root on a Hydration+Moonbeam fork.
 *  Verifies: (1) 17 Wormhole LogMessagePublished, correct target chain per leg;
 *            (2) SA ERC20 balance drops by exactly Σ amountRaw per token (immediate + remainder). */
import { readFileSync } from "node:fs";
import { decodeEventLog, encodeEventTopics, getAddress, createPublicClient, http, erc20Abi, type Abi, type Hex, type PublicClient } from "viem";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { acc } from "@galacticcouncil/common";

const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const WORMHOLE_CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3");
const CORE_ABI = [{ type: "event", name: "LogMessagePublished", inputs: [
  { name: "sender", type: "address", indexed: true }, { name: "sequence", type: "uint64" },
  { name: "nonce", type: "uint32" }, { name: "payload", type: "bytes" }, { name: "consistencyLevel", type: "uint8" }]}] as const satisfies Abi;
const LOG_TOPIC = encodeEventTopics({ abi: CORE_ABI, eventName: "LogMessagePublished" })[0]!.toLowerCase();
const CHAIN_NAME: Record<number, string> = { 1: "Solana", 2: "Ethereum", 21: "Sui", 30: "Base" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toHexStr = (x: any): string => x == null ? "" : typeof x === "string" ? x.toLowerCase()
  : typeof x?.asHex === "function" ? x.asHex().toLowerCase()
  : x instanceof Uint8Array ? "0x" + Array.from(x, (b: number) => b.toString(16).padStart(2, "0")).join("") : String(x).toLowerCase();
const decodeToChain = (payload: Hex) => parseInt(payload.slice(2).slice(99 * 2, 101 * 2), 16);

async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}
function coreLogsIn(events: any[]) {
  const out: { topics: Hex[]; data: Hex }[] = [];
  for (const { event } of events) {
    const ev = event as any;
    if (ev.type !== "EVM" || ev.value?.type !== "Log") continue;
    const log = ev.value.value?.log; if (!log || toHexStr(log.address) !== WORMHOLE_CORE.toLowerCase()) continue;
    const topics = (log.topics ?? []).map((tp: any) => toHexStr(tp) as Hex);
    if (topics[0] === LOG_TOPIC) out.push({ topics, data: toHexStr(log.data) as Hex });
  }
  return out;
}

async function main() {
  const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
  const legs: { sym: string; token: string; originChain: number; amountRaw: string; leg: string }[] = d.transfers;
  // expected Σ deduction per token, and expected LogMessagePublished chain tally
  const byToken: Record<string, { sym: string; token: string; expected: bigint }> = {};
  const expChain: Record<number, number> = {};
  for (const t of legs) {
    (byToken[t.token] ??= { sym: t.sym, token: t.token, expected: 0n }).expected += BigInt(t.amountRaw);
    expChain[t.originChain] = (expChain[t.originChain] ?? 0) + 1;
  }

  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  try {
    await moonbeam.setStorage({ System: { Account: [[[SA], { providers: 1, data: { free: 5000n * 10n ** 18n } }]] } });
    console.log(`SA ${SA} seeded 5000 GLMR — dispatching ${legs.length}-leg batchAll as Root\n`);
    const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.moonbeam.port}`) }) as PublicClient;
    const bal = (tok: string) => eth.readContract({ address: getAddress(tok), abi: erc20Abi, functionName: "balanceOf", args: [SA] }) as Promise<bigint>;
    const before: Record<string, bigint> = {};
    for (const k of Object.keys(byToken)) before[k] = await bal(byToken[k].token);

    // dispatch inner batchAll as Root via preimage + scheduler-agenda injection
    const bytes = Binary.fromHex(d.innerBatchAll as Hex); const len = bytes.length;
    const hash = (await hydration.chain.head.registry).hash(bytes).toHex() as Hex;
    const when = hydration.chain.head.number + 1;
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
      Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    await hydration.chain.newBlock();
    await hydration.chain.newBlock(); // flush HRMP to Moonbeam

    // collect all Wormhole core logs across several Moonbeam blocks
    const logs: { topics: Hex[]; data: Hex }[] = [];
    for (let i = 0; i < 8; i++) { const b = await moonbeam.chain.newBlock(); logs.push(...coreLogsIn(await evAt(moonbeam, b.hash))); }
    await sleep(500);

    // (1) LogMessagePublished tally
    const gotChain: Record<number, number> = {};
    for (const l of logs) {
      const { args } = decodeEventLog({ abi: CORE_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      const c = decodeToChain((args as any).payload);
      gotChain[c] = (gotChain[c] ?? 0) + 1;
    }
    console.log(`── (1) Wormhole LogMessagePublished: ${logs.length}/${legs.length} ──`);
    let chainsOk = true;
    for (const c of Object.keys(expChain).map(Number).sort()) {
      const ok = (gotChain[c] ?? 0) === expChain[c]; chainsOk &&= ok;
      console.log(`  ${(CHAIN_NAME[c] ?? c).padEnd(9)} got ${gotChain[c] ?? 0} / expect ${expChain[c]}  ${ok ? "✅" : "❌"}`);
    }

    // (2) SA balance deltas per token (summed across legs)
    console.log(`\n── (2) SA deduction per token (expect Δ == -Σ amountRaw) ──`);
    let balOk = true;
    for (const k of Object.keys(byToken)) {
      const after = await bal(byToken[k].token);
      const delta = after - before[k]; const exp = -byToken[k].expected;
      const ok = delta === exp; balOk &&= ok;
      console.log(`  ${byToken[k].sym.padEnd(8)} Δ ${delta}  expect ${exp}  ${ok ? "✅" : "❌"}`);
    }

    console.log(`\n${logs.length === legs.length && chainsOk ? "✅" : "❌"} messages   ${balOk ? "✅" : "❌"} balances`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
