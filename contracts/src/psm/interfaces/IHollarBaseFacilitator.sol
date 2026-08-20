// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHollarBaseFacilitator {
    // ─── Types ──────────────────────────────────────────────────

    /// @notice Why an attested mint did not mint on arrival. Emitted so the queue is diagnosable
    ///         without replaying the VAA.
    enum QueueReason {
        MintPaused,
        BucketFull,
        RateLimited
    }

    /// @notice One attested message that could not mint on arrival. Minted whole or not at all,
    ///         so the amount is the message's own and is never merged with another's.
    struct PendingMint {
        address recipient;
        /// @dev USDC units. Zeroed once the entry is flushed or cancelled.
        uint256 amount;
    }

    // ─── Events ─────────────────────────────────────────────────

    event Minted(address indexed recipient, uint256 usdcAmount, uint256 hollarAmount);
    event MintQueued(uint256 indexed id, address indexed recipient, uint256 usdcAmount, QueueReason reason);
    event PendingMintFlushed(uint256 indexed id, address indexed recipient, uint256 usdcAmount);
    event PendingMintCancelled(
        uint256 indexed id, address indexed recipient, uint256 usdcAmount, bytes32 baseRecipient, uint64 sequence
    );
    event RedeemInitiated(address indexed from, address indexed baseRecipient, uint256 usdcAmount, uint64 sequence);

    event BaseEmitterSet(bytes32 emitter);
    event LimitsSet(uint256 inboundCapacity, uint256 outboundCapacity, uint256 window);
    event PausedSet(bool mintPaused, bool redeemPaused);

    // ─── Errors ─────────────────────────────────────────────────

    error MintPausedError();
    error RedeemPaused();
    error EmitterAlreadySet();
    error ZeroAddress();
    error ExceedsBucketLevel(uint256 requested, uint256 level);
    error NotQueued(uint256 id);
    error NotYourPendingMint(uint256 id, address owner);
    error UnexpectedKind(uint8 kind);
    error UnexpectedEmitterChain(uint16 chainId);
    error IncorrectDecimals();
    error InsufficientMessageFee(uint256 provided, uint256 required);
    error RefundFailed();
    error Disabled();
}
