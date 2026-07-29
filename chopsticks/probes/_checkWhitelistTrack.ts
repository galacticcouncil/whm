/** Identify the whitelisted-caller track and decode/match referenda proposals against our migration. */
import { readFileSync } from "node:fs";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
const OUR_WL = (d.whitelistedProposal as string).toLowerCase().replace(/^0x/, "");
const OUR_INNER = (d.innerBatchAll as string).toLowerCase().replace(/^0x/, "");
const INNER_HASH = "b4160e45ae3b707aea5ec787a251971b5900a56b1952c530bec5104fa358799f";
const hx = (x: any) => ((typeof x?.asHex === "function" ? x.asHex() : x)?.toLowerCase?.() ?? String(x)).replace(/^0x/, "");
const txt = (x: any) => { try { return typeof x?.asText === "function" ? x.asText() : Buffer.from(hx(x), "hex").toString("utf8"); } catch { return String(x); } };

async function bytesOf(api: any, call: any): Promise<string | null> {
  if (!call) return null;
  if (call.type === "Inline") return hx(call.value);
  if (call.type === "Lookup") { try { const pi = await api.query.Preimage.PreimageFor.getValue([call.value.hash, call.value.len]); return pi ? hx(pi) : null; } catch { return null; } }
  return null;
}

async function main() {
  const client = createClient(getWsProvider("wss://rpc.hydradx.cloud"));
  const api = client.getUnsafeApi();
  try {
    // tracks
    let wlTrack: number | null = null;
    try {
      const tracks: any = await api.constants.Referenda.Tracks();
      console.log("── tracks ──");
      for (const [id, info] of tracks) {
        const name = txt(info.name);
        if (/white/i.test(name)) wlTrack = Number(id);
        console.log(`  ${id}: ${name}`);
      }
      console.log(`whitelisted-caller track = ${wlTrack}\n`);
    } catch (e: any) { console.log("tracks err:", e?.message ?? e); }

    const count = Number(await api.query.Referenda.ReferendumCount.getValue());
    console.log(`── ongoing referenda (count=${count}), decoding proposals ──`);
    for (let i = count - 1; i >= Math.max(0, count - 40); i--) {
      const info: any = await api.query.Referenda.ReferendumInfoFor.getValue(i);
      if (!info || info.type !== "Ongoing") continue;
      const o = info.value;
      const b = await bytesOf(api, o.proposal);
      let kind = "?"; if (b) { try { const dc: any = (await api.txFromCallData(Binary.fromHex("0x" + b))).decodedCall; kind = `${dc.type}.${dc.value?.type}`; } catch { kind = "decode-err"; } }
      const match = b === OUR_WL ? "◀◀ EXACT (with_preimage, our version)"
        : b && b.includes(INNER_HASH) ? "◀◀ by-hash dispatch of our call"
        : b && b.includes(OUR_INNER) ? "◀◀ contains our batch"
        : "";
      const onWl = wlTrack !== null && Number(o.track) === wlTrack ? " [WHITELISTED TRACK]" : "";
      console.log(`#${i}: track=${o.track}${onWl} call=${kind} bytes=${b ? b.length / 2 + "B" : "unresolved"} ${match}`);
    }
  } finally { client.destroy(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
