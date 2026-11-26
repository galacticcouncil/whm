import assert from "node:assert/strict";
import { test } from "node:test";

import { balanceKey, step, type Pending } from "./once";

const NOW = 1_800_000_000_000;
const pending: Pending = {
  kind: "deliver",
  payloads: [{ signed: { signed_data: {} }, label: "deliver" }],
  expiresAt: NOW + 170_000,
  balances: balanceKey(0n, 156_427n),
};

test("a payout still valid is resent as signed, not signed again", () => {
  assert.equal(step(pending, NOW, balanceKey(0n, 156_427n)), "resend");
  assert.equal(step(pending, NOW + 169_999, balanceKey(0n, 156_427n)), "resend");
});

test("one that expired unexecuted parks its terms", () => {
  assert.equal(step(pending, NOW + 170_000, balanceKey(0n, 156_427n)), "park");
});

test("moved balances mean it landed, whatever its send reported", () => {
  assert.equal(step(pending, NOW, balanceKey(0n, 0n)), "landed");
  assert.equal(step(pending, NOW + 999_999, balanceKey(5n, 156_427n)), "landed");
});
