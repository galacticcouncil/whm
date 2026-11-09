import { hexToBigInt, type Address, type Hash, type PublicClient } from "viem";

import { NEAR_ACCOUNT_TOPIC, SEQUENCE_TOPIC } from "./abi";

/**
 * Find the NEAR account the emitter logged beside a settlement.
 *
 * Both ride the same Hydration transaction, so the account is in the settlement's own receipt.
 * Matching on the manager sequence rather than taking the first log keeps a transaction that ever
 * carries more than one send honest.
 *
 * @param client Hydration public client.
 * @param emitter The coin's UTXO emitter, whose logs we are looking for.
 * @param txHash Hydration transaction that produced the settlement.
 * @param sequence Manager sequence read from the settlement.
 * @returns The account id, or null when this transaction logged none — i.e. the settlement is a
 *          raw transfer rather than a withdrawal, and its sender completes it.
 */
export async function findAccount(
  client: PublicClient,
  emitter: Address,
  txHash: Hash,
  sequence: bigint,
): Promise<string | null> {
  const receipt = await client.getTransactionReceipt({ hash: txHash });

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== emitter.toLowerCase()) continue;

    const seq = log.topics[SEQUENCE_TOPIC];
    const account = log.topics[NEAR_ACCOUNT_TOPIC];
    if (!seq || !account || hexToBigInt(seq) !== sequence) continue;

    return account.slice(2).toLowerCase();
  }

  return null;
}
