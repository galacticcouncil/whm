import { createHash } from "node:crypto";

import { pad } from "viem";

import {
  encodeAddress,
  inclusions,
  parseTx,
  type Inclusion,
  type ZcashTx,
} from "../../../chains/zcash";
import { UTXO } from "../../../deployments";

/** A UTXO coin bridged through Omni's connector on NEAR and our NTT corridor to Hydration. */
export interface UtxoRoute {
  /** The coin's chain — the key rows carry. */
  chain: string;
  symbol: string;
  decimals: number;
  /** Its Hydration emitter: the withdrawal's source, and the NTT sender on the way out. */
  emitter: string;
  /** Our `UtxoWithdraw` on NEAR: signs each withdrawal for the account its destination derives. */
  withdraw: string;
  /** Omni's connector on NEAR: the deposit's prover, and the NTT sender on the way in. */
  connector: string;
  /** Destination bytes, as the emitter logs them, to the coin's address. */
  address(bytes: string): string | null;
  /** A raw transaction, as the connector is handed it. */
  parseTx(raw: Buffer): ZcashTx | null;
  /** Where each transaction landed, for those that have. */
  inclusions(txids: string[]): Promise<Map<string, Inclusion>>;
}

export const ROUTES: UtxoRoute[] = [
  {
    chain: "zcash",
    symbol: "ZEC",
    decimals: 8,
    emitter: UTXO.zec.emitter.toLowerCase(),
    withdraw: UTXO.zec.withdraw,
    connector: UTXO.zec.connector,
    address: encodeAddress,
    parseTx,
    inclusions,
  },
];

/** The NTT sender a route's withdrawal carries: its emitter, left-padded. */
export const withdrawSender = (r: UtxoRoute) => pad(r.emitter as `0x${string}`, { size: 32 });

/** The NTT sender a route's deposit carries: the connector's account, hashed as NEAR names it. */
export const depositSender = (r: UtxoRoute) =>
  `0x${createHash("sha256").update(r.connector).digest("hex")}`;

export const byChain = (chain: string) => ROUTES.find((r) => r.chain === chain);
export const byEmitter = (address: string) =>
  ROUTES.find((r) => r.emitter === address.toLowerCase());
export const byWithdraw = (account: string) => ROUTES.find((r) => r.withdraw === account);
export const byConnector = (account: string) => ROUTES.find((r) => r.connector === account);
