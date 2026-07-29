/** Inspect referendum #375 and locate its scheduled enactment. */
import { readFileSync } from "node:fs";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
const OUR_WL = (d.whitelistedProposal as string).toLowerCase().replace(/^0x/, "");
const OUR_INNER = (d.innerBatchAll as string).toLowerCase().replace(/^0x/, "");
const INNER_HASH = "b4160e45ae3b707aea5ec787a251971b5900a56b1952c530bec5104fa358799f";
const hx = (x: any) => ((typeof x?.asHex === "function" ? x.asHex() : x)?.toLowerCase?.() ?? String(x)).replace(/^0x/, "");
const J = (o: any) => JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v));

async function bytesOf(api: any, call: any): Promise<string | null> {
  if (!call) return null;
  if (call.type === "Inline") return hx(call.value);
  if (call.type === "Lookup") { try { const pi = await api.query.Preimage.PreimageFor.getValue([call.value.hash, call.value.len]); return pi ? hx(pi) : null; } catch { return null; } }
  return null;
}
async function kind(api: any, b: string) { try { const dc: any = (await api.txFromCallData(Binary.fromHex("0x" + b))).decodedCall; return `${dc.type}.${dc.value?.type}`; } catch { return "decode-err"; } }
const tag = (b: string | null) => !b ? "" : b === OUR_WL ? " ◀ our whitelisted-proposal (current)" : b.includes(INNER_HASH) ? " ◀ by-hash dispatch of our inner" : b.includes(OUR_INNER) ? " ◀ inlines our batch" : "";

async function main() {
  const client = createClient(getWsProvider("wss://rpc.hydradx.cloud"));
  const api = client.getUnsafeApi();
  try {
    const now = Number(await api.query.System.Number.getValue());
    console.log(`current block ~${now}`);
    const info: any = await api.query.Referenda.ReferendumInfoFor.getValue(375);
    console.log(`\n#375 = ${info?.type}  value=${J(info?.value)}`);

    // is our inner hash still whitelisted?
    const wl: any[] = await api.query.Whitelist.WhitelistedCall.getEntries();
    console.log(`\nour inner hash still whitelisted: ${wl.some((e) => hx(e.keyArgs[0]) === INNER_HASH)}`);

    // dump scheduler: any entry that is a Whitelist call, big, or in the future
    console.log(`\n── scheduler agenda: relevant/future entries ──`);
    const agenda: any[] = await api.query.Scheduler.Agenda.getEntries();
    let any = false;
    for (const e of agenda.sort((a, b) => Number(a.keyArgs[0]) - Number(b.keyArgs[0]))) {
      const blk = Number(e.keyArgs[0]);
      for (const it of (e.value ?? [])) {
        if (!it) continue;
        const b = await bytesOf(api, it.call);
        const k = b ? await kind(api, b) : "?";
        const relevant = tag(b) || k.startsWith("Whitelist") || (b && b.length > 8000) || blk > now;
        if (relevant) {
          any = true;
          const eta = ((blk - now) * 6) / 60;
          console.log(`  blk ${blk} (${blk > now ? `+${blk - now}≈${eta.toFixed(0)}min` : `${now - blk} ago`}) origin=${J(it.origin)} call=${k} ${b ? b.length / 2 + "B" : ""}${tag(b)}`);
        }
      }
    }
    if (!any) console.log("  (nothing relevant/future scheduled)");
  } finally { client.destroy(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
