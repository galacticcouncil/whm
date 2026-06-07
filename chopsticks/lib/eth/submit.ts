import { keccak256, parseTransaction, type Hex } from "viem";
import { Binary } from "polkadot-api";

import { hydration } from "@galacticcouncil/descriptors";

import type { Network } from "../network";
import { buildTransactionV3 } from "./transaction";

export interface EthTxResult {
  /** keccak256 of the raw signed tx — the hash an eth client expects. */
  ethHash: Hex;
  /** hash of the block this tx was sealed into. */
  blockHash: string;
  /** number of the block this tx was sealed into. */
  blockNumber: number;
}

/**
 * Submit a raw signed Ethereum transaction to a chopsticks fork as `pallet_ethereum::transact`,
 * building exactly one block containing it. Returns the eth tx hash + the sealed block.
 */
export async function sendRawEthTx(net: Network, rawTx: Hex): Promise<EthTxResult> {
  const api = net.client.getTypedApi(hydration);
  const tx = api.tx.Ethereum.transact({ transaction: buildTransactionV3(parseTransaction(rawTx)) });
  const bareTx = await tx.getBareTx(); // SCALE-encoded bare (unsigned, v4) extrinsic
  const block = await net.chain.newBlock({ transactions: [Binary.toHex(bareTx) as `0x${string}`] });
  return { ethHash: keccak256(rawTx), blockHash: block.hash, blockNumber: block.number };
}
