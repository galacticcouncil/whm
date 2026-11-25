import type { UtxoVerification, UtxoWithdrawal } from "../../chains/near/omni";

/** A delivery on a UTXO route, not yet confirmed where it lands. */
export interface Pending {
  id: string;
  /** Unix ms. */
  signed_at: string;
  dest_tx: string | null;
}

/**
 * What a delivery's withdrawal adds to its row, if anything new.
 *
 * The relayer withdraws `A_utxo`'s whole balance, so one withdrawal can carry several deliveries:
 * each takes the first withdrawal at or after it was signed. It is confirmed by the connector's
 * verification of that same transaction; a transaction the connector replaced is not followed.
 *
 * @param row The delivery.
 * @param withdrawals Its `A_utxo`'s withdrawals, oldest first.
 * @param verifications Its `A_utxo`'s verifications.
 * @returns The columns to merge, or null when nothing changed.
 */
export function landing(
  row: Pending,
  withdrawals: UtxoWithdrawal[],
  verifications: UtxoVerification[],
): { dest_tx: string; dest_amount: string | null; dest_at?: number } | null {
  const w = withdrawals.find((x) => x.ref.blockTimestamp >= Number(row.signed_at));
  if (!w) return null;
  const v = verifications.find((x) => x.success && x.utxoTx === w.utxoTx);
  if (!v && row.dest_tx === w.utxoTx) return null;
  return { dest_tx: w.utxoTx, dest_amount: w.received, ...(v && { dest_at: v.ref.blockTimestamp }) };
}
