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

export interface EthBatchResult {
  /** keccak256 of each raw signed tx, in submission order. */
  ethHashes: Hex[];
  /** hash of the block they were sealed into. */
  blockHash: string;
  /** number of the block they were sealed into. */
  blockNumber: number;
}

/**
 * Submit several raw signed Ethereum transactions as `pallet_ethereum::transact` extrinsics in ONE
 * block. Same nonce order as given; each tx's gas limit counts against the block's.
 */
export async function sendRawEthTxs(net: Network, rawTxs: Hex[]): Promise<EthBatchResult> {
  const api = net.client.getTypedApi(hydration);
  const transactions = await Promise.all(
    rawTxs.map(async (rawTx) => {
      const tx = api.tx.Ethereum.transact({ transaction: buildTransactionV3(parseTransaction(rawTx)) });
      return Binary.toHex(await tx.getBareTx()) as `0x${string}`;
    }),
  );
  const block = await net.chain.newBlock({ transactions });
  return { ethHashes: rawTxs.map((raw) => keccak256(raw)), blockHash: block.hash, blockNumber: block.number };
}
