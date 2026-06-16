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
    ///                       Applies on every path — including A==WETH, where the bridged amount is
    ///                       amountIn minus the WETH spent buying the GLMR fee.
    /// @param maxFeeIn       max amount of A to spend buying the GLMR cross-chain fee (slippage bound on
    ///                       the fee leg). Ignored when A is GLMR — there the fee is withheld, not bought.
    /// @param intentId       UI-computed correlation hash
    /// @param intentDepositAddress OneClick quote's Ethereum deposit address
    /// @param maxRelayFee    ceiling on the destination relay fee, carried in the bridged payload.
    ///                       Only the direct-TokenBridge variant (IntentEmitterWtt) embeds it; the
    ///                       Basejump variant ignores it.
    function swapAndBridge(
        uint32 assetIn,
        uint256 amountIn,
        uint256 minEthOut,
        uint256 maxFeeIn,
        bytes32 intentId,
        address intentDepositAddress,
        uint256 maxRelayFee
    ) external;

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
