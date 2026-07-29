/** Live-check Hydration governance for the migration. Read-only mainnet RPC. */
import { readFileSync } from "node:fs";
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

const OURS: Record<string, string> = {
  "current($250k)": "0xb4160e45ae3b707aea5ec787a251971b5900a56b1952c530bec5104fa358799f",
  "no-split": "0xae18b45a10a982cd09f386b28ec1183ba0ccd43b38c46a2b4298c52350323ee9",
  "split v1": "0xdfd27bdf9063a64f959f4112ebfd6101031d615e2cdcd529451d1ff2de6c90dc",
  "$100k margin": "0xc399be3e9da5342638ce47d4b98ebf01b33458f99ff7d04f9818da6dff14b085",
  "$10 trial": "0xe6f820003d4fbeee35efbc6907623884046fca2fa53aa16f19fbfd89017ef59c",
};
const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
const OUR_WL_PROPOSAL = (d.whitelistedProposal as string).toLowerCase();
const hx = (x: any) => (typeof x?.asHex === "function" ? x.asHex() : x)?.toLowerCase?.() ?? String(x);

async function main() {
  const client = createClient(getWsProvider("wss://rpc.hydradx.cloud"));
  const api = client.getUnsafeApi();
  try {
    const now = Number((await api.query.System.Number.getValue()));
    console.log(`current block ~${now}\n`);

    console.log("── whitelisted calls on-chain ──");
    try {
      const ents: any[] = await api.query.Whitelist.WhitelistedCall.getEntries();
      if (!ents.length) console.log("  (none whitelisted right now)");
      for (const e of ents) {
        const h = hx(e.keyArgs[0]);
        const mine = Object.entries(OURS).find(([, v]) => v === h)?.[0];
        console.log(`  ${h}  ${mine ? "◀ OURS (" + mine + ")" : ""}`);
      }
    } catch (e: any) { console.log("  getEntries err:", e?.message ?? e); }

    console.log("\n── recent referenda: resolve + decode proposals ──");
    const count = Number(await api.query.Referenda.ReferendumCount.getValue());
    for (let i = count - 1; i >= Math.max(0, count - 16); i--) {
      const info: any = await api.query.Referenda.ReferendumInfoFor.getValue(i);
      if (!info) { console.log(`#${i}: <none>`); continue; }
      const t = info.type;
      if (t !== "Ongoing") { console.log(`#${i}: ${t}${t === "Approved" ? " @" + JSON.stringify(info.value?.[0]) : ""}`); continue; }
      const o = info.value; const p = o.proposal;
      let bytes: string | null = null;
      if (p?.type === "Inline") bytes = hx(p.value);
      else if (p?.type === "Lookup") {
        try { const pi: any = await api.query.Preimage.PreimageFor.getValue([p.value.hash, p.value.len]); bytes = pi ? hx(pi) : null; } catch {}
      }
      let kind = "?";
      if (bytes) {
        try { const dc: any = (await api.txFromCallData(Binary.fromHex(bytes))).decodedCall; kind = `${dc.type}.${dc.value?.type}`; } catch (e: any) { kind = "decode-err"; }
      }
      const exact = bytes && bytes === OUR_WL_PROPOSAL ? "  ◀◀ EXACT MATCH to current proposal" : "";
      console.log(`#${i}: Ongoing track=${o.track} deciding=${!!o.deciding} tally=${JSON.stringify(o.tally)} call=${kind}${exact}`);
    }
  } finally { client.destroy(); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
