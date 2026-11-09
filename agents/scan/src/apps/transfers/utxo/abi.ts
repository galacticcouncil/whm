import { parseAbiItem } from "viem";

/**
 * A UTXO coin's Hydration emitter — the withdrawal leaving. Every coin's emitter logs the same
 * event; `destination` is the coin's own address bytes, `nearAccount` the account it withdraws
 * through.
 */
export const WithdrawRequestedEvt = parseAbiItem(
  "event WithdrawRequested(uint64 indexed sequence, bytes32 indexed nearAccount, address indexed sender, uint256 amount, uint256 fee, bytes destination)",
);
