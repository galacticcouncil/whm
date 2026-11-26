import assert from "node:assert/strict";
import { test } from "node:test";

import type { UtxoVerification, UtxoWithdrawal } from "../../chains/near/omni";

import { landing, type Pending } from "./landing";

const ref = (at: number) => ({ chain: "near" as const, blockNumber: "1", blockTimestamp: at, txHash: `n${at}`, logIndex: 0 });
const withdrawal = (at: number, utxoTx: string, received = "7329"): UtxoWithdrawal => ({
  ref: ref(at),
  utxoTx,
  bridgeFee: "400",
  minerFee: "825",
  received,
});
const verification = (at: number, utxoTx: string, success = true): UtxoVerification => ({ ref: ref(at), utxoTx, success });
const row = (signedAt: number, destTx: string | null = null): Pending => ({ id: "p", signed_at: String(signedAt), dest_tx: destTx });

test("nothing before the relayer withdraws", () => {
  assert.equal(landing(row(100), [], []), null);
  assert.equal(landing(row(100), [withdrawal(50, "old")], []), null);
});

test("the transaction and amount as soon as the withdrawal is submitted", () => {
  assert.deepEqual(landing(row(100), [withdrawal(50, "old"), withdrawal(120, "tx")], []), {
    dest_tx: "tx",
    dest_amount: "7329",
  });
});

test("no rewrite while it confirms", () => {
  assert.equal(landing(row(100, "tx"), [withdrawal(120, "tx")], []), null);
});

test("confirmed once the connector verifies that transaction", () => {
  assert.deepEqual(landing(row(100, "tx"), [withdrawal(120, "tx")], [verification(300, "tx")]), {
    dest_tx: "tx",
    dest_amount: "7329",
    dest_at: 300,
  });
});

test("another transaction's verification, or a failed one, does not confirm it", () => {
  assert.equal(landing(row(100, "tx"), [withdrawal(120, "tx")], [verification(300, "other"), verification(310, "tx", false)]), null);
});

test("deliveries batched into one withdrawal share it", () => {
  const ws = [withdrawal(120, "tx", "20000")];
  assert.equal(landing(row(100), ws, [])?.dest_tx, "tx");
  assert.equal(landing(row(110), ws, [])?.dest_tx, "tx");
});
