// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentReceiver — Ethereum end of the NTT intent path
/// @notice A relayer calls `processOrder(nttVaa, instructionVaa, feeRequested)`: the NTT VAA is
///         delivered, releasing native ETH here, and the emitter's instruction says how much of it
///         goes where. The relayer takes `feeRequested`, bounded by the ceiling the instruction
///         carries, and the rest goes to `depositAddress`.
///
///         Forwarded, not completed — NEAR still swaps into `destinationAsset` and delivers to the
///         order's `recipient`. This contract's job ends at the handoff.
///
///         Atomic, so whoever calls it did all of it and is the one paid. The two VAAs must name the
///         same sequence, which is what stops a caller pairing any pending settlement with whichever
///         instruction carries the highest ceiling.
interface IIntentReceiver {
    // ─── Events ──────────────────────────────────────────────────

    /// @param transferSequence NTT manager's sequence — the key both legs share
    /// @param depositAddress   where the settlement was forwarded
    /// @param amount           forwarded, net of the relay fee
    event OrderProcessed(
        uint64 indexed transferSequence, address indexed depositAddress, uint256 amount
    );

    /// @param transferSequence NTT manager's sequence
    /// @param relayer          the caller (msg.sender) reimbursed for the relay
    /// @param fee              relay fee paid, in native ETH
    event RelayFeePaid(uint64 indexed transferSequence, address indexed relayer, uint256 fee);

    event Swept(address indexed to, uint256 amount);
    event EmitterUpdated(bytes32 indexed emitter);
    event RelayerAuthorized(address indexed relayer, bool enabled);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotConfigured();
    error NativeTransferFailed();
    error MalformedInstruction();
    error InvalidInstruction();
    error UnauthorizedEmitter(uint16 chainId, bytes32 emitter);
    /// @dev The instruction names a different settlement — pairing them would let a caller pay for
    ///      any pending delivery and claim whichever instruction carries the highest ceiling.
    error SequenceMismatch(uint64 instructed, uint64 settled);
    /// @dev The settlement was delivered but its funds have not been released — NTT's inbound rate
    ///      limiter holds it queued. Reverting leaves the instruction executable for retry.
    error SettlementNotReleased(uint64 sequence);
    /// @dev The settlement's amount is not trimmed to the precision the rail has always used, so
    ///      scaling it to wei would be a guess. Reverting beats forwarding a mis-scaled amount.
    error UnexpectedTrim(uint8 decimals);
    error FeeExceedsCeiling();
    error AlreadyRedeemed();
    /// @dev Caller is not authorized and the order is still inside its exclusive window. Expires, so
    ///      liveness never depends on any one relayer.
    error Unauthorized();

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Deliver a settlement and forward it where its instruction says.
    /// @dev The destination comes from a guardian-signed instruction whose emitter is pinned, never
    ///      from the caller. Any caller may process, except inside the exclusive window while an
    ///      allowlist is set. Reverts if the forward fails, leaving the instruction executable.
    /// @param nttVaa         the NTT transfer VAA. Delivered here unless someone already did.
    /// @param instructionVaa the emitter's instruction for the same sequence
    /// @param feeRequested   relay fee the caller claims, ≤ the instruction's `maxRelayFee`
    function processOrder(bytes calldata nttVaa, bytes calldata instructionVaa, uint256 feeRequested)
        external;

    // ─── Views / Admin ───────────────────────────────────────────

    function owner() external view returns (address);
    function emitterAddress() external view returns (bytes32);
    function processed(bytes32 vaaHash) external view returns (bool);
    function authorizedRelayer(address relayer) external view returns (bool);
    function authorizedRelayerCount() external view returns (uint256);
    function setOwner(address newOwner) external;
    function setEmitter(bytes32 emitter) external;
    function setAuthorizedRelayer(address relayer, bool enabled) external;
    function sweep(address to, uint256 amount) external;
}
