/** Locate the migration by our INNER hash across Scheduler.Agenda and Referenda (any whitelist variant). */
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

const INNER = "b4160e45ae3b707aea5ec787a251971b5900a56b1952c530bec5104fa358799f"; // no 0x
const hx = (x: any) => ((typeof x?.asHex === "function" ? x.asHex() : x)?.toLowerCase?.() ?? String(x)).replace(/^0x/, "");

async function bytesOf(api: any, call: any): Promise<string | null> {
  if (!call) return null;
  if (call.type === "Inline") return hx(call.value);
  if (call.type === "Lookup") { try { const pi = await api.query.Preimage.PreimageFor.getValue([call.value.hash, call.value.len]); return pi ? hx(pi) : null; } catch { return null; } }
  return null;
}
async function kindOf(api: any, bytes: string) { try { const dc: any = (await api.txFromCallData(Binary.fromHex("0x" + bytes))).decodedCall; return `${dc.type}.${dc.value?.type}`; } catch { return "?"; } }

async function main() {
  const client = createClient(getWsProvider("wss://rpc.hydradx.cloud"));
  const api = client.getUnsafeApi();
  try {
    const now = Number(await api.query.System.Number.getValue());
    console.log(`current block ~${now}\n`);

    console.log("── Scheduler.Agenda scan for inner hash ──");
    const agenda: any[] = await api.query.Scheduler.Agenda.getEntries();
    let hit = false;
    for (const e of agenda) {
      const blk = Number(e.keyArgs[0]);
      for (const it of (e.value ?? [])) {
        if (!it) continue;
        const b = await bytesOf(api, it.call);
        if (b && b.includes(INNER)) {
          hit = true;
          const eta = ((blk - now) * 6) / 60;
          console.log(`◀ block ${blk} — ${blk > now ? `in ${blk - now} blk ≈ ${eta.toFixed(0)} min` : `${now - blk} blk ago`}  call=${await kindOf(api, b)}  origin=${JSON.stringify(it.origin)}`);
        }
      }
    }
    if (!hit) console.log("  not in scheduler agenda");

    console.log("\n── Referenda scan for inner hash (last 20) ──");
    const count = Number(await api.query.Referenda.ReferendumCount.getValue());
    for (let i = count - 1; i >= Math.max(0, count - 20); i--) {
      const info: any = await api.query.Referenda.ReferendumInfoFor.getValue(i);
      if (!info) continue;
      if (info.type === "Ongoing") {
        const b = await bytesOf(api, info.value.proposal);
        if (b && b.includes(INNER)) console.log(`#${i}: ONGOING (still voting) track=${info.value.track} call=${await kindOf(api, b)}`);
      } else if (info.type === "Approved") {
        // approved: proposal often cleared; note it
        // (can't always resolve; flagged separately by scheduler scan)
      }
    }
    console.log("\n(current whitelisted hash confirmed present earlier: 0x" + INNER + ")");
  } finally { client.destroy(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
