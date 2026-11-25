import type { FastNear } from "./fastnear";
import { nearLogs } from "./fastnear";
import type { Tx } from "./types";

/** Where a connector event was logged on NEAR. */
export interface ConnectorRef {
  chain: "near";
  blockNumber: string;
  /** Unix ms. */
  blockTimestamp: number;
  txHash: string;
  logIndex: number;
}

/**
 * A withdrawal Omni's connector built from an account's balance. The coin's transaction id is fixed
 * here, before Omni signs or broadcasts it.
 */
export interface UtxoWithdrawal {
  ref: ConnectorRef;
  /** The transaction on the coin's own chain. */
  utxoTx: string;
  bridgeFee: string | null;
  minerFee: string | null;
  /** What the recipient is paid, in the coin's smallest unit — the amount less both fees. */
  received: string | null;
}

/**
 * The connector's check that a withdrawal's transaction landed: its light client verified the
 * transaction's inclusion proof, after the chain's confirmations.
 */
export interface UtxoVerification {
  ref: ConnectorRef;
  utxoTx: string;
  success: boolean;
}

/** The connector callback a verification runs, carrying the verified transaction's id. */
const VERIFY_CALL = "internal_verify_withdraw_callback";

/**
 * The connector's withdrawal or verification for an account in one transaction, if it has either.
 *
 * A withdrawal logs `generate_btc_pending_info` for the account, with `withdraw_btc_detail` beside
 * it. A verification is relayed by Omni, not by us, and logs `verify_withdraw_details` for the
 * account; its transaction id is the verify callback's argument.
 *
 * @param tx The transaction, whole.
 * @param account The derived account the coin was withdrawn from.
 * @param connectors Omni's connectors on NEAR.
 */
export function connectorEvents(
  tx: Tx,
  account: string,
  connectors: ReadonlySet<string>,
): { withdrawal?: UtxoWithdrawal; verification?: UtxoVerification } {
  const logs = nearLogs(tx, new Set([VERIFY_CALL])).filter((l) => connectors.has(l.executor));
  const ref = (l: (typeof logs)[number]): ConnectorRef => ({
    chain: "near",
    blockNumber: String(l.blockHeight),
    blockTimestamp: l.blockTimestamp,
    txHash: tx.transaction.hash,
    logIndex: l.index,
  });
  const out: { withdrawal?: UtxoWithdrawal; verification?: UtxoVerification } = {};

  const pending = logs.find(
    (l) =>
      l.event === "generate_btc_pending_info" &&
      (l.data as { account_id?: string }).account_id === account,
  );
  if (pending) {
    const detail = logs.find((l) => l.event === "withdraw_btc_detail")?.data as
      | { withdraw_fee?: string; btc_gas_fee?: string; actual_received_amount?: string }
      | undefined;
    out.withdrawal = {
      ref: ref(pending),
      utxoTx: (pending.data as { btc_pending_id: string }).btc_pending_id,
      bridgeFee: detail?.withdraw_fee ?? null,
      minerFee: detail?.btc_gas_fee ?? null,
      received: detail?.actual_received_amount ?? null,
    };
  }

  const verified = logs.find(
    (l) =>
      l.event === "verify_withdraw_details" &&
      (l.data as { account_id?: string }).account_id === account,
  );
  const txId = (logs.find((l) => l.standard === "call" && l.event === VERIFY_CALL)?.data as
    | { tx_id?: string }
    | undefined)?.tx_id;
  if (verified && txId) {
    out.verification = {
      ref: ref(verified),
      utxoTx: txId,
      success: (verified.data as { success?: boolean }).success === true,
    };
  }
  return out;
}

/**
 * An account's withdrawals and verifications through the connectors, oldest first, from its history
 * in FastNEAR's index — which lists the transactions whose events name the account, so Omni's
 * verifications are found there too.
 *
 * @param api FastNEAR's transaction index.
 * @param account The derived account.
 * @param connectors Omni's connectors on NEAR.
 */
export async function accountWithdrawals(
  api: FastNear,
  account: string,
  connectors: ReadonlySet<string>,
): Promise<{ withdrawals: UtxoWithdrawal[]; verifications: UtxoVerification[] }> {
  const hashes = (await api.history(account)).map((h) => h.transaction_hash);
  const withdrawals: UtxoWithdrawal[] = [];
  const verifications: UtxoVerification[] = [];
  for (const tx of await api.transactions(hashes)) {
    const e = connectorEvents(tx, account, connectors);
    if (e.withdrawal) withdrawals.push(e.withdrawal);
    if (e.verification) verifications.push(e.verification);
  }
  const byTime = (a: { ref: ConnectorRef }, b: { ref: ConnectorRef }) =>
    a.ref.blockTimestamp - b.ref.blockTimestamp;
  return { withdrawals: withdrawals.sort(byTime), verifications: verifications.sort(byTime) };
}
