import { parseAbi } from "viem";

/**
 * The PSM receivers' destination call, and the reverts worth naming in logs.
 *
 * `HollarBaseVault` (Base) and `HollarBaseFacilitator` (Hydration) share this one ABI: both inherit
 * `receiveMessage(bytes)` from `MessageReceiver`, and an error only the vault's delivery can raise
 * (`ClaimsPaused`, `InsufficientMessageFee`) is simply never met on the facilitator's.
 *
 * Only what `receiveMessage` can raise is listed, because that is the call the app classifies.
 * Payout errors (`PayoutFailed` and the rest of `claim` and `drain`'s) are left out: crediting moves
 * no money (`HollarBaseVault._processMessage` books only), so a delivery never meets them. The keeper
 * calls will.
 *
 * Declared against `contracts/src/psm` and `contracts/src/MessageReceiver.sol`. A viem ABI decodes a
 * custom error by its selector, so a signature that drifts here stops matching without a sound: the
 * revert falls back to unnamed, and the queue retries what it should have recognised.
 * `scripts/verify-psm-reverts.ts` checks every entry against the compiled contracts, and that the
 * list is exactly what a delivery can raise.
 */
export const receiverAbi = parseAbi([
  "function receiveMessage(bytes vaa) external",

  // MessageReceiver's, inherited by both
  "error NotAuthorizedEmitter()",

  // Both `_processMessage`s, in the order each meets them
  "error EmitterNotSet()",
  "error UnexpectedEmitterChain(uint16 chainId)",
  // A second signed copy of a message already consumed — see `engine/revert.ts`
  "error MessageAlreadyProcessed(uint64 sequence)",
  "error UnexpectedKind(uint8 kind)",
  "error ZeroAmount()",

  // PsmPayload's, raised while decoding the body
  "error InvalidLength(uint256 got)",
  "error UnsupportedVersion(uint8 got)",
  "error UnknownKind(uint8 got)",
  "error NotAnAddress(bytes32 raw)",
  "error ZeroRecipient()",

  // The vault's. A redemption that lands above its own fee limit is sent back, and that publishes
  // from this non-payable delivery: `ClaimsPaused` refuses it while claims are paused, and
  // `InsufficientMessageFee` would, were the Wormhole message fee ever non-zero. The VAA stays
  // replayable either way.
  "error ClaimsPaused()",
  "error InsufficientMessageFee(uint256 provided, uint256 required)",
]);
