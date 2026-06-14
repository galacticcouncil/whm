// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentReceiver — Ethereum redeemer for the direct TokenBridge (payload-3) intent path
/// @notice A relayer calls `redeem(vaa)` with a `transferTokensWithPayload` VAA addressed to the
///         receiver; it pulls the bridged WETH, unwraps to native ETH, and forwards the exact
///         redeemed amount to the OneClick `depositAddress` carried in the payload.
interface IIntentReceiver {
    // ─── Events ──────────────────────────────────────────────────

    /// @param intentId       UI-computed correlation hash (from the bridged payload)
    /// @param asset          asset forwarded — the `NATIVE` sentinel when unwrapped, else the ERC20
    /// @param depositAddress OneClick quote deposit address that received the funds
    /// @param amount         amount forwarded (native ETH when unwrapped, else the ERC20 amount)
    event IntentForwarded(
        bytes32 indexed intentId, address indexed asset, address indexed depositAddress, uint256 amount
    );
    event Swept(address indexed asset, address indexed to, uint256 amount);
    event WrappedNativeUpdated(address indexed previous, address indexed current);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NativeTransferFailed();
    error NothingDelivered();
    error MalformedPayload();

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Redeem a payload-3 TokenBridge VAA addressed to this contract: pull the WETH, unwrap
    ///         it to native ETH, and forward it to the payload's depositAddress. Permissionless —
    ///         the payload (not the caller) dictates the destination, the TokenBridge restricts
    ///         completion to this contract and marks the VAA consumed (replay-safe). Reverts if the
    ///         forward fails, leaving the VAA redeemable for retry.
    function redeem(bytes calldata vaa) external;

    // ─── Views / Admin ───────────────────────────────────────────

    function owner() external view returns (address);
    function wrappedNative() external view returns (address);
    function setOwner(address newOwner) external;
    function setWrappedNative(address wrappedNative) external;
    function sweep(address asset, address to, uint256 amount) external;
}
