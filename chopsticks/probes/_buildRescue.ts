/** Assemble the protocol-POL rescue proposal: utility.batchAll([11 protocol-sized sends]) + whitelist wrapper.
 *  Same structure as _buildProposal.ts (the $110 trial), amounts from rescueAmounts.ts.
 *  Usage: HAIRCUT_BPS=50 pnpm tsx chopsticks/probes/_buildRescue.ts   (haircut optional, default 0) */
import { Binary } from "polkadot-api";
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";
import { ASSETS, resolveRecipient, buildExitPayload } from "./exitAssets";
import { rescueRaw, rawFromHuman, IMMEDIATE_LEG } from "./rescueAmounts";

const compact = (n: number): string => {
  if (n < 64) return (n << 2).toString(16).padStart(2, "0");
  if (n < 2 ** 14) { const v = (n << 2) | 1; return (v & 0xff).toString(16).padStart(2,"0") + ((v>>8)&0xff).toString(16).padStart(2,"0"); }
  throw new Error("compact >2^14 not needed");
};

async function main() {
  const hair = process.env.HAIRCUT_BPS ? Number(process.env.HAIRCUT_BPS) : 0;
  const amt = (a: typeof ASSETS[number]) => rescueRaw(a, hair);
  // per large asset: an immediate leg (<$100k, "has to pass" via the daily budget) + the remainder
  // ("can get stuck" — big legs bypass ~24h, sub-$100k remainders queue on budget). See IMMEDIATE_LEG.
  const rows: { a: typeof ASSETS[number]; amount: bigint; leg: string }[] = [];
  for (const a of ASSETS) {
    const total = amt(a);
    const immHuman = IMMEDIATE_LEG[a.sym];
    if (immHuman !== undefined) {
      const imm = rawFromHuman(a, immHuman);
      rows.push({ a, amount: imm, leg: "immediate" }, { a, amount: total - imm, leg: "remainder" });
    } else {
      rows.push({ a, amount: total, leg: "immediate" });
    }
  }
  // emit ALL immediate legs first: batch order = VAA sequence = Governor processing order, so the
  // "has to pass" legs claim the daily budget before the "can get stuck" remainders overflow it.
  rows.sort((x, y) => (x.leg === "immediate" ? 0 : 1) - (y.leg === "immediate" ? 0 : 1));
  const sends = rows.map((r) => buildExitPayload(r.a, r.amount, resolveRecipient(r.a)).slice(2));
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const batchEmpty = Binary.toHex(await api.tx.Utility.batch_all({ calls: [] }).getEncodedData()).slice(2);
    const batchPrefix = batchEmpty.slice(0, 4);
    const remark = api.tx.System.remark({ remark: Binary.fromText("x") });
    const wlDummy = Binary.toHex(await api.tx.Whitelist.dispatch_whitelisted_call_with_preimage({ call: remark.decodedCall }).getEncodedData()).slice(2);
    const wlPrefix = wlDummy.slice(0, 4);

    const inner = "0x" + batchPrefix + compact(sends.length) + sends.join("");
    const innerBytes = Binary.fromHex(inner as Hex);
    const innerHash = (await nets.hydration.chain.head.registry).hash(innerBytes).toHex();
    const proposal = "0x" + wlPrefix + inner.slice(2);

    console.log(`haircut: ${hair} bps`);
    console.log(`inner utility.batchAll: ${innerBytes.length} bytes`);
    console.log(`inner blake2-256 (whitelist this on the TC): ${innerHash}`);
    console.log(`whitelisted proposal call: ${(proposal.length - 2) / 2} bytes`);
    writeFileSync("probes/rescue-proposal.json", JSON.stringify({
      note: "protocol-POL rescue — protocol-owned MRL, SA→origin via Wormhole TokenBridge. Each large asset split into an immediate (<$100k, budget) leg + remainder (bypass/queue). Amounts re-derived @13,358,797; RE-DERIVE fresh before submit.",
      haircutBps: hair,
      transfers: rows.map((r) => ({ sym: r.a.sym, id: r.a.id, leg: r.leg, token: r.a.token, originChain: r.a.originChain, amountRaw: r.amount.toString(), recipient: resolveRecipient(r.a) })),
      innerBatchAll: inner, innerHash, whitelistedProposal: proposal,
    }, null, 2));
    console.log("\nwrote probes/rescue-proposal.json");
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
