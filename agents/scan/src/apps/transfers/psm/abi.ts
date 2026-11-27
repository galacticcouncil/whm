import { parseAbiItem } from "viem";

// ─── HollarBaseVault, on the corridor's EVM chain ────────────────

/** USDC locked for a mint on Hydration. `recipient` is a left-padded Hydration EVM address. */
export const DepositedEvt = parseAbiItem(
  "event Deposited(address indexed from, bytes32 indexed recipient, uint256 amount, uint64 sequence)",
);

/**
 * A delivery booked into the payout queue: a redemption (`kind` 2) or a cancelled mint's refund
 * (`kind` 3). Names its queue slot, never the message it came by.
 */
export const RedeemCreditedEvt = parseAbiItem(
  "event RedeemCredited(uint256 indexed index, address indexed recipient, uint256 gross, uint256 fee, uint256 credited, uint8 kind)",
);

/** The queue's head paid. Names no slot: the queue pays strictly in order, so it is the head. */
export const ClaimedEvt = parseAbiItem("event Claimed(address indexed recipient, uint256 amount)");

/** The head retired unpaid: its recipient cannot receive USDC. Still owed. */
export const CreditUnpayableEvt = parseAbiItem(
  "event CreditUnpayable(uint256 indexed index, address indexed recipient, uint256 amount)",
);

/** The head given up for its HOLLAR back, re-minted on Hydration. */
export const RedemptionCancelledEvt = parseAbiItem(
  "event RedemptionCancelled(uint256 indexed index, address indexed recipient, uint256 gross, bytes32 hydrationRecipient, uint64 sequence)",
);

/** A redemption landing above its own fee limit: nothing booked, the HOLLAR sent back. */
export const RedeemReturnedEvt = parseAbiItem(
  "event RedeemReturned(address indexed recipient, address indexed origin, uint256 amount, uint256 feeBps, uint256 maxFeeBps, uint64 sequence)",
);

/** A delivery claiming more than was ever deposited: parked, not paid. */
export const DisputedEvt = parseAbiItem(
  "event Disputed(address indexed recipient, uint256 amount, uint256 principal)",
);

// ─── HollarBaseFacilitator, on Hydration ─────────────────────────

/** HOLLAR burned for USDC on the corridor's chain. */
export const RedeemInitiatedEvt = parseAbiItem(
  "event RedeemInitiated(address indexed from, address indexed baseRecipient, uint256 usdcAmount, uint64 sequence, bytes32 indexed ref)",
);

/** HOLLAR minted: a deposit's, a flushed queue entry's, or a sent-back redemption's. */
export const MintedEvt = parseAbiItem(
  "event Minted(address indexed recipient, uint256 usdcAmount, uint256 hollarAmount)",
);

/** A delivery that could not mint yet — paused, or over a limit — waiting under `id`. */
export const MintQueuedEvt = parseAbiItem(
  "event MintQueued(uint256 indexed id, address indexed recipient, uint256 usdcAmount, uint8 reason)",
);

/** A queued mint let through. `Minted` precedes it in the same transaction. */
export const PendingMintFlushedEvt = parseAbiItem(
  "event PendingMintFlushed(uint256 indexed id, address indexed recipient, uint256 usdcAmount)",
);

/** A queued mint given up, its USDC sent back to `baseRecipient`. */
export const PendingMintCancelledEvt = parseAbiItem(
  "event PendingMintCancelled(uint256 indexed id, address indexed recipient, uint256 usdcAmount, bytes32 baseRecipient, uint8 kind, uint64 sequence)",
);
