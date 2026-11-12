// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentForwarder — Ethereum end of intents v2
/// @notice A relayer calls `processOrder(nttVaa, feeRequested)`: the NTT VAA is delivered, releasing
///         native ETH here, and the forwarding instruction the dispatcher put in the transfer's
///         payload says where it goes. The relayer takes `feeRequested`, bounded by the ceiling the
///         payload carries, and the rest goes to `depositAddress` — POA's deposit address for the
///         NEAR account the order funds.
///
///         One VAA: the instruction travels inside the transfer, so there is nothing to pair.
interface IIntentForwarder {
    // ─── Events ──────────────────────────────────────────────────

    /// @param transferSequence NTT manager's sequence — the order's id
    /// @param depositAddress   where the settlement was forwarded
    /// @param amount           forwarded, net of the relay fee
    event OrderForwarded(uint64 indexed transferSequence, address indexed depositAddress, uint256 amount);

    /// @param transferSequence NTT manager's sequence
    /// @param relayer          the caller (msg.sender) reimbursed for the relay
    /// @param fee              relay fee paid, in native ETH
    event RelayFeePaid(uint64 indexed transferSequence, address indexed relayer, uint256 fee);

    event Swept(address indexed to, uint256 amount);
    event DispatcherUpdated(bytes32 indexed dispatcher);
    event RelayerAuthorized(address indexed relayer, bool enabled);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotConfigured();
    error NativeTransferFailed();
    /// @dev Not a settlement from Hydration — the only chain the dispatcher bridges from.
    error UnexpectedSourceChain(uint16 chainId);
    /// @dev The transfer was not sent by the dispatcher, so its payload is not an order.
    error UnauthorizedSender(bytes32 sender);
    /// @dev The transfer released its funds to another address — forwarding would spend this
    ///      contract's balance on someone else's settlement.
    error WrongRecipient(bytes32 to);
    /// @dev The settlement was delivered but its funds have not been released — NTT's inbound rate
    ///      limiter holds it queued. Reverting leaves the order executable for retry.
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

    /// @notice Deliver a settlement and forward it where its payload says.
    /// @dev The destination and the fee ceiling come from the transfer's payload, attested with the
    ///      transfer and accepted only from the pinned dispatcher; the amount from the settlement
    ///      itself. Any caller may process, except inside the exclusive window while an allowlist is
    ///      set. Reverts if the forward fails, leaving the order executable.
    /// @param nttVaa       the NTT transfer VAA. Delivered here unless someone already did.
    /// @param feeRequested relay fee the caller claims, ≤ the payload's `maxRelayFee`
    function processOrder(bytes calldata nttVaa, uint256 feeRequested) external;

    // ─── Views / Admin ───────────────────────────────────────────

    function owner() external view returns (address);
    function dispatcher() external view returns (bytes32);
    function processed(bytes32 digest) external view returns (bool);
    function authorizedRelayer(address relayer) external view returns (bool);
    function authorizedRelayerCount() external view returns (uint256);
    function setOwner(address newOwner) external;
    function setDispatcher(bytes32 dispatcher) external;
    function setAuthorizedRelayer(address relayer, bool enabled) external;
    function sweep(address to, uint256 amount) external;
}
