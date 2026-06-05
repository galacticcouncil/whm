// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentEmitter — Hydration entry point for NEAR-Intents bridging
/// @notice User picks asset A (held on Hydration) and a destination asset B (on NEAR).
///         IntentEmitter sells `amountIn` of A for WETH on Hydration, then dispatches a
///         polkadotXcm.send message to Moonbeam that triggers BasejumpProxy.bridgeViaWormhole
///         for the swapped amount. The ETH ultimately lands at the OneClick quote's
///         `intentDepositAddress` on Ethereum and enters the ETH→B quote.
interface IIntentEmitter {
    // ─── Events ──────────────────────────────────────────────────

    /// @param intentId      UI-computed correlation hash (threaded into the Basejump payload)
    /// @param caller        the Hydration account that initiated the bridge
    /// @param assetIn       Hydration asset id of A sold
    /// @param amountIn      amount of A sold
    /// @param ethOut        WETH received from the sell and bridged (the quote's origin amount)
    /// @param intentDepositAddress OneClick quote deposit address on Ethereum
    event BridgeInitiated(
        bytes32 indexed intentId,
        address indexed caller,
        uint32 indexed assetIn,
        uint256 amountIn,
        uint256 ethOut,
        address intentDepositAddress
    );

    event XcmOperatorUpdated(address indexed operator, bool enabled);
    event XcmDefaultsUpdated(
        uint256 xcmFee, uint256 xcmExecutionFee, uint64 gasLimit, uint64 transactRefTime, uint64 transactProofSize
    );

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotXcmOperator();
    error ZeroAmount();
    error InvalidDepositAddress();
    error InsufficientOutput();
    error DispatchFailed();
    error NotConfigured();

    // ─── Core ────────────────────────────────────────────────────

    /// @param assetIn        Hydration asset id of A
    /// @param amountIn       total amount of A pulled from the caller
    /// @param minEthOut      slippage floor on the WETH bridged out (reverts InsufficientOutput below it).
    ///                       Applies to the swap paths (A→WETH, GLMR→WETH); ignored when A is already WETH,
    ///                       since that path has no swap and is bounded by amountIn.
    /// @param intentId       UI-computed correlation hash
    /// @param intentDepositAddress OneClick quote's Ethereum deposit address
    function swapAndBridge(
        uint32 assetIn,
        uint256 amountIn,
        uint256 minEthOut,
        bytes32 intentId,
        address intentDepositAddress
    ) external;

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
