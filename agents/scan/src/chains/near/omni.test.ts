import assert from "node:assert/strict";
import { test } from "node:test";

import { connectorEvents } from "./omni";
import type { Receipt, Tx } from "./types";

const A_UTXO = "edc3187c7fa4a383a9eabd82aa81ee676743cee484a9b1233ee1a74c8906b04c";
const CONNECTOR = "btc-connector.bridge.near";
const CONNECTORS = new Set([CONNECTOR]);
const UTXO_TX = "acc3be2e1f4f372025c8001dfdf096dec4049767d70b05c2a8436659e0f61302";

const event = (event: string, data: unknown) =>
  `EVENT_JSON:${JSON.stringify({ standard: "bridge", version: "1.0.0", event, data: [data] })}`;

/**
 * One receipt, executed by `executor`.
 *
 * @param n Its position, which orders it.
 * @param executor The account it ran on.
 * @param logs What it logged.
 * @param call A function call it carries, with JSON arguments.
 * @param failed Whether it failed.
 */
function receipt(
  n: number,
  executor: string,
  logs: string[],
  call?: { method: string; args: unknown },
  failed = false,
): Receipt {
  return {
    receipt: {
      receipt_id: `r${n}`,
      predecessor_id: "omni-relayer.bridge.near",
      receipt: {
        Action: {
          actions: call
            ? [{ FunctionCall: { method_name: call.method, args: Buffer.from(JSON.stringify(call.args)).toString("base64") } }]
            : [],
        },
      },
    },
    execution_outcome: {
      block_height: 226034245,
      block_timestamp: 1795540916516388127 + n,
      index: n,
      outcome: {
        executor_id: executor,
        logs,
        receipt_ids: [],
        status: failed ? { Failure: {} } : { SuccessValue: "" },
      },
    },
  };
}

const tx = (hash: string, receipts: Receipt[]): Tx => ({ transaction: { hash }, receipts });

/** The relayer's withdrawal, as `FCYu7gym…` logged it. */
const withdrawal = tx("FCYu7gym", [
  receipt(0, CONNECTOR, [
    event("withdraw_btc_detail", { cost_nbtc: "8554", withdraw_fee: "400", btc_gas_fee: "825", actual_received_amount: "7329" }),
    event("generate_btc_pending_info", { account_id: A_UTXO, btc_pending_id: UTXO_TX }),
  ]),
]);

/** Omni's verification, as `3rrXehJX…` logged it. */
const verification = (txId: string, success = true, failed = false) =>
  tx("3rrXehJX", [
    receipt(0, CONNECTOR, [], { method: "verify_withdraw_v2", args: { tx_id: txId, proof: {} } }),
    receipt(1, CONNECTOR, [], { method: "internal_verify_withdraw_callback", args: { tx_id: txId } }),
    receipt(
      2,
      CONNECTOR,
      [event("verify_withdraw_details", { account_id: A_UTXO, burn_amount: "8154", refund: "0", success })],
      undefined,
      failed,
    ),
  ]);

test("a withdrawal names the coin's transaction and what it pays", () => {
  const e = connectorEvents(withdrawal, A_UTXO, CONNECTORS);
  assert.equal(e.withdrawal?.utxoTx, UTXO_TX);
  assert.equal(e.withdrawal?.received, "7329");
  assert.equal(e.withdrawal?.bridgeFee, "400");
  assert.equal(e.withdrawal?.minerFee, "825");
  assert.equal(e.withdrawal?.ref.txHash, "FCYu7gym");
  assert.equal(e.verification, undefined);
});

test("a verification names the transaction the connector verified", () => {
  const e = connectorEvents(verification(UTXO_TX), A_UTXO, CONNECTORS);
  assert.equal(e.withdrawal, undefined);
  assert.deepEqual([e.verification?.utxoTx, e.verification?.success], [UTXO_TX, true]);
});

test("a failed verification is not success", () => {
  assert.equal(connectorEvents(verification(UTXO_TX, false), A_UTXO, CONNECTORS).verification?.success, false);
});

test("a rolled-back receipt's events never happened", () => {
  assert.equal(connectorEvents(verification(UTXO_TX, true, true), A_UTXO, CONNECTORS).verification, undefined);
});

test("another account's events, or another contract's, are not this account's", () => {
  assert.deepEqual(connectorEvents(withdrawal, "someone-else.near", CONNECTORS), {});
  assert.deepEqual(connectorEvents(withdrawal, A_UTXO, new Set(["zcash-connector.bridge.near"])), {});
});
