// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentReceiver — Ethereum redeemer for the direct TokenBridge (payload-3) intent path
/// @notice A relayer calls `redeem(vaa, feeRequested)` with a `transferTokensWithPayload` VAA
///         addressed to the receiver; it pulls the bridged WETH, unwraps to native ETH, pays the
///         relayer `feeRequested` (bounded by the `maxRelayFee` ceiling in the payload), and forwards
///         the remainder to the OneClick `depositAddress` carried in the payload.
interface IIntentReceiver {
    // ─── Events ──────────────────────────────────────────────────

    /// @param intentId       UI-computed correlation hash (from the bridged payload)
    /// @param asset          asset forwarded — the `NATIVE` sentinel when unwrapped, else the ERC20
    /// @param depositAddress OneClick quote deposit address that received the funds
    /// @param amount         amount forwarded to depositAddress (net of the relay fee)
    event IntentForwarded(
        bytes32 indexed intentId, address indexed asset, address indexed depositAddress, uint256 amount
    );

    /// @param intentId correlation hash from the bridged payload
    /// @param relayer  the redeemer (msg.sender) reimbursed for the relay
    /// @param fee      relay fee paid, in the delivered asset (native ETH when unwrapped, else the ERC20)
    event RelayFeePaid(bytes32 indexed intentId, address indexed relayer, uint256 fee);

    event Swept(address indexed asset, address indexed to, uint256 amount);
    event WrappedNativeUpdated(address indexed previous, address indexed current);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NativeTransferFailed();
    error NothingDelivered();
    error MalformedPayload();
    error FeeExceedsCeiling();

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Redeem a payload-3 TokenBridge VAA addressed to this contract: pull the WETH, unwrap
    ///         it to native ETH, pay `msg.sender` the relay fee, and forward the rest to the payload's
    ///         depositAddress. Permissionless — the payload (not the caller) dictates the destination,
    ///         the TokenBridge restricts completion to this contract and marks the VAA consumed
    ///         (replay-safe). Reverts if the forward fails, leaving the VAA redeemable for retry.
    /// @param vaa          the payload-3 TokenBridge VAA
    /// @param feeRequested relay fee the caller claims, in the delivered asset; must be ≤ the
    ///                     `maxRelayFee` ceiling carried in the payload
    function redeem(bytes calldata vaa, uint256 feeRequested) external;

    // ─── Views / Admin ───────────────────────────────────────────

    function owner() external view returns (address);
    function wrappedNative() external view returns (address);
    function setOwner(address newOwner) external;
    function setWrappedNative(address wrappedNative) external;
    function sweep(address asset, address to, uint256 amount) external;
}
