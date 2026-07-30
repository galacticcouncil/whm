/**
 * Static coherence check: the pure builder functions must reproduce the committed
 * sweep-proposal.json artifact byte-for-byte (⇒ identical blake2-256 innerHash, no fork).
 *   pnpm tsx probes/_verifySweepRebuild.ts
 */
import { readFileSync } from "node:fs";
import { ASSETS } from "./exitAssets";
import {
  buildSweepCall, buildScheduleNamed, buildLocationUpdate, buildWithdrawLimit, buildInner, wrapWhitelist,
} from "./_buildSweepProposal";

const j = JSON.parse(readFileSync(new URL("./sweep-proposal.json", import.meta.url), "utf8"));
const eq = (name: string, got: string, want: string) => {
  const ok = got.toLowerCase() === String(want).toLowerCase();
  console.log(`  ${ok ? "✅" : "❌"} ${name}${ok ? "" : `\n     got : ${got}\n     want: ${want}`}`);
  return ok;
};

let all = true;
console.log("── per-call ──");
all = eq("sweepCall", buildSweepCall(), j.sweepCall) && all;
all = eq("scheduleNamed", buildScheduleNamed(buildSweepCall(), j.blockN), j.scheduleNamed) && all;
for (const lu of j.locationUpdates) all = eq(`update ${lu.sym} (id ${lu.id})`, buildLocationUpdate(lu.id), lu.updateCall) && all;
all = eq("withdrawLimit", buildWithdrawLimit(), j.withdrawLimit.call) && all;

console.log("── assembled ──");
const sweepCall = buildSweepCall();
const inner = buildInner(sweepCall, buildScheduleNamed(sweepCall, j.blockN), ASSETS.map((a) => buildLocationUpdate(a.id)), buildWithdrawLimit());
all = eq("innerBatchAll", inner, j.innerBatchAll) && all;
all = eq("whitelistedProposal", wrapWhitelist(inner), j.whitelistedProposal) && all;

console.log(`\n${all ? "PASS ✅  builder reproduces artifact (innerHash " + j.innerHash + ")" : "FAIL ❌  builder DRIFTED from artifact"}`);
process.exit(all ? 0 : 1);
