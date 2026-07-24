/** MOXIT probe — all 11 MRL assets at ~$10, one Root PolkadotXcm.send each, assert LogMessagePublished. */
import { decodeEventLog, encodeEventTopics, getAddress, type Abi, type Hex } from "viem";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { checkIfXcmSent, findEvent, logEvents, type EventRecord } from "../lib/events";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { ASSETS, tenDollarRaw, placeholderRecipient, buildExitPayload } from "./exitAssets";
import { acc } from "@galacticcouncil/common";

const HYDRATION_PARA_ID = 2034;
const WORMHOLE_CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3");
const SA = acc.getSovereignAccounts(HYDRATION_PARA_ID).moonbeam as Hex;
const CORE_ABI = [{ type: "event", name: "LogMessagePublished", inputs: [
  { name: "sender", type: "address", indexed: true }, { name: "sequence", type: "uint64" },
  { name: "nonce", type: "uint32" }, { name: "payload", type: "bytes" }, { name: "consistencyLevel", type: "uint8" }]}] as const satisfies Abi;
const LOG_TOPIC = encodeEventTopics({ abi: CORE_ABI, eventName: "LogMessagePublished" })[0]!.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toHexStr = (x: any): string => x == null ? "" : typeof x === "string" ? x.toLowerCase()
  : typeof x?.asHex === "function" ? x.asHex().toLowerCase()
  : x instanceof Uint8Array ? "0x" + Array.from(x, (b: number) => b.toString(16).padStart(2, "0")).join("") : String(x).toLowerCase();

async function eventsAt(net: Network, at: string, tries = 12): Promise<EventRecord[]> {
  let e: unknown; for (let i = 0; i < tries; i++) { try { return (await net.client.getUnsafeApi().query.System.Events.getValue({ at })) as EventRecord[]; } catch (err) { e = err; await sleep(300); } } throw e;
}
async function dispatchAsRoot(net: Network, callHex: Hex) {
  const when = net.chain.head.number + 1;
  const bytes = Binary.fromHex(callHex); const len = bytes.length;
  const hash = (await net.chain.head.registry).hash(bytes).toHex() as Hex;
  await net.setStorage({
    Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
    Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
  });
  const b = await net.chain.newBlock();
  return { events: (await net.client.getUnsafeApi().query.System.Events.getValue({ at: b.hash })) as EventRecord[] };
}
function findCoreLog(events: EventRecord[]) {
  for (const { event } of events) {
    const ev = event as any;
    if (ev.type !== "EVM" || ev.value?.type !== "Log") continue;
    const log = ev.value.value?.log; if (!log || toHexStr(log.address) !== WORMHOLE_CORE.toLowerCase()) continue;
    const topics = (log.topics ?? []).map((t: any) => toHexStr(t) as Hex);
    if (topics[0] === LOG_TOPIC) return { topics, data: toHexStr(log.data) as Hex };
  }
  return null;
}
const decodeToChain = (payload: Hex) => parseInt(payload.slice(2).slice(99 * 2, 101 * 2), 16);

async function main() {
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  const results: string[] = [];
  try {
    await moonbeam.setStorage({ System: { Account: [[[SA], { providers: 1, data: { free: 5000n * 10n ** 18n } }]] } });
    console.log(`SA ${SA} seeded 5000 GLMR\n`);
    for (const a of ASSETS) {
      const amt = tenDollarRaw(a);
      const payload = buildExitPayload(a, amt, placeholderRecipient(a));
      const { events: hydEv } = await dispatchAsRoot(hydration, payload);
      const dispatched = !!findEvent(hydEv, "Scheduler", "Dispatched");
      const sent = checkIfXcmSent(hydEv);
      await hydration.chain.newBlock();
      let hit: ReturnType<typeof findCoreLog> = null;
      for (let i = 0; i < 3 && !hit; i++) { const blk = await moonbeam.chain.newBlock(); hit = findCoreLog(await eventsAt(moonbeam, blk.hash)); }
      let line: string;
      if (hit) {
        const { args } = decodeEventLog({ abi: CORE_ABI, data: hit.data, topics: hit.topics as [Hex, ...Hex[]] });
        const toChain = decodeToChain((args as any).payload);
        const ok = toChain === a.originChain;
        line = `${ok ? "✅" : "⚠️"} ${a.sym.padEnd(8)} disp=${dispatched} sent=${sent} LogMessagePublished seq=${(args as any).sequence} toChain=${toChain}(exp ${a.originChain})`;
      } else {
        line = `❌ ${a.sym.padEnd(8)} disp=${dispatched} sent=${sent} NO LogMessagePublished`;
        if (!dispatched || !sent) logEvents(hydEv);
      }
      console.log(line); results.push(line);
    }
    console.log("\n──────── SUMMARY ────────");
    results.forEach((r) => console.log(r));
    const pass = results.filter((r) => r.startsWith("✅")).length;
    console.log(`\n${pass}/${ASSETS.length} assets emitted a correct-chain Wormhole message`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
