import { parseAbiItem } from "viem";

/**
 * Every coin's emitter logs this beside each settlement. `nearAccount` is the derived account's key,
 * whose lowercase hex is its account id — what pays out. `destination` is the address bytes, decoded
 * per chain; a hint, re-derived and checked against `nearAccount`.
 */
export const WithdrawRequestedEvt = parseAbiItem(
  "event WithdrawRequested(uint64 indexed sequence, bytes32 indexed nearAccount, address indexed sender, uint256 amount, uint256 fee, bytes destination)",
);
