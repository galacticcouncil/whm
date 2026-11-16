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

/**
 * What the vault keeper and watcher read and send on Base. Kept apart from `receiverAbi`, which
 * lists exactly what a delivery can raise. The errors are what `claim` and `drain` can raise, so the
 * keeper can name why a head is not payable.
 */
export const vaultKeeperAbi = parseAbi([
  "function drain(uint256 maxEntries) returns (uint256 paid)",
  "function claim()",
  "function queueHead() view returns (uint256)",
  "function queueHeadEntry() view returns (address recipient, uint256 amount)",
  "function headSince() view returns (uint64)",
  "function claimsPaused() view returns (bool)",
  "function depositsPaused() view returns (bool)",
  "function investPaused() view returns (bool)",
  "function limits() view returns (uint256 depositCapacity, uint256 depositWindow, uint256 depositAvailable, uint256 payoutCapacity, uint256 payoutWindow, uint256 payoutAvailable)",
  "function principal() view returns (uint256)",
  "function totalOwed() view returns (uint256)",
  "function totalUnpayable() view returns (uint256)",
  "function usdc() view returns (address)",
  "function aUsdc() view returns (address)",
  "function wormhole() view returns (address)",

  "event Claimed(address indexed recipient, uint256 amount)",
  "event CreditUnpayable(uint256 indexed index, address indexed recipient, uint256 amount)",
  "event Disputed(address indexed recipient, uint256 amount, uint256 principal)",

  "error ClaimsPaused()",
  "error NotAtQueueHead(address caller, address head)",
  "error InsufficientLiquidity(uint256 requested, uint256 available)",
  "error InsufficientPayoutAllowance(uint256 requested, uint256 available)",
  "error RecipientUnpayable(address recipient)",
  "error PayoutFailed(address recipient)",
  "error Disabled()",
]);

/** What the facilitator keeper and watcher read and send on Hydration. */
export const facilitatorKeeperAbi = parseAbi([
  "function flushPendingMint(uint256 id)",
  "function pendingTail() view returns (uint256)",
  "function pendingMints(uint256 id) view returns (address recipient, address origin, bool remint, uint256 amount)",
  "function mintPaused() view returns (bool)",
  "function redeemPaused() view returns (bool)",
  "function outstanding() view returns (uint256)",
  "function scale() view returns (uint256)",
  "function totalPendingMint() view returns (uint256)",
  "function limits() view returns (uint256 inboundCapacity, uint256 inboundAvailable, uint256 outboundCapacity, uint256 outboundAvailable)",
  "function hollar() view returns (address)",

  "error MintPausedError()",
  "error NotQueued(uint256 id)",
  "error ExceedsBucketLevel(uint256 requested, uint256 level)",
  "error RateLimitExceeded(uint256 requested, uint256 available)",
]);

/** HOLLAR's facilitator bucket: capacity and level, in HOLLAR units. */
export const ghoAbi = parseAbi(["function getFacilitatorBucket(address facilitator) view returns (uint256, uint256)"]);

export const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

export const wormholeCoreAbi = parseAbi(["function messageFee() view returns (uint256)"]);
