// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {DerivedAccount} from "../utils/DerivedAccount.sol";
import {XcmV4} from "../utils/XcmV4.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";
import {HydrationRouter} from "../utils/hydration/HydrationRouter.sol";
import {HydrationPolkadotXcm} from "../utils/hydration/HydrationPolkadotXcm.sol";
import {HydrationUtility} from "../utils/hydration/HydrationUtility.sol";

import {MoonbeamConsts} from "../utils/moonbeam/MoonbeamConsts.sol";

import {IIntentEmitter} from "./interfaces/IIntentEmitter.sol";

/// @title IntentEmitter — shared Hydration→Moonbeam entry point for NEAR-Intents bridging
/// @notice One atomic extrinsic, dispatched through Hydration's runtime via the DISPATCH precompile:
///
///           1. FEE  — reserve a fixed `xcmFee` of GLMR for the x-chain hop: bought from A,
///                     or simply held back when A is already GLMR.
///           2. SWAP — sell the remaining A for WETH (skipped when A is already WETH).
///           3. BATCH_ALL of two XCM calls to Moonbeam:
///                a. transfer_assets_using_type_and_then — reserve-transfer [GLMR, WETH] to the MDA.
///                b. send — Transact AS the MDA via Moonbeam's Batch precompile. The exact bridge
///                   call is the ONLY thing that varies between deployments, so it's left to the
///                   `_bridgeViaWormholeCall` hook: a Basejump batch (IntentEmitterBjp) or a direct
///                   TokenBridge `transferTokensWithPayload` batch (IntentEmitterWtt). Either way
///                   native ETH lands at the OneClick quote's intentDepositAddress on Ethereum.
///
///         Concrete variants implement `_bridgeViaWormholeCall` and own their path-specific config;
///         everything else (swap, fee, XCM batch, dispatch, params) is shared.
abstract contract IntentEmitter is Initializable, UUPSUpgradeable, IIntentEmitter {
    using SafeERC20 for IERC20;

    uint16 public constant ETHEREUM_WORMHOLE_ID = 2;

    address public owner;
    mapping(address => bool) public xcmOperators;

    // --- XCM source (derived H160 on Moonbeam) ---
    address public xcmSource;

    // --- XCM defaults (tunable by authorized callers) ---
    uint256 public xcmFee;
    uint256 public xcmExecutionFee;
    uint64 public xcmGasLimit;
    uint64 public xcmTransactRefTime;
    uint64 public xcmTransactProofSize;

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyXcmOperator() {
        _onlyXcmOperator();
        _;
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function _initEmitter() internal onlyInitializing {
        owner = msg.sender;
        xcmSource = DerivedAccount.deriveSiblingEvm(HydrationConsts.PARA_ID, address(this));
        xcmFee = 1_000_000_000_000_000_000; // 1 GLMR: dest arrival fee (<0.1) + remote execution (<0.9)
        xcmExecutionFee = 900_000_000_000_000_000; // 0.9 GLMR: transact-leg BuyExecution
        xcmGasLimit = 5_000_000;
        xcmTransactRefTime = 125_059_217_000;
        xcmTransactProofSize = 625_000;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @inheritdoc IIntentEmitter
    function swapAndBridge(
        uint32 assetIn,
        uint256 amountIn,
        uint256 minEthOut,
        uint256 maxFeeIn,
        bytes32 intentId,
        address intentDepositAddress
    ) external {
        if (amountIn == 0) revert ZeroAmount();
        if (intentDepositAddress == address(0)) revert InvalidDepositAddress();

        IERC20 assetInToken = IERC20(HydrationConsts.toErc20(assetIn));
        IERC20 wethToken = IERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));

        uint256 wethInitial = wethToken.balanceOf(address(this));

        assetInToken.safeTransferFrom(msg.sender, address(this), amountIn);

        _swap(assetInToken, assetIn, amountIn, maxFeeIn);

        uint256 wethOut = wethToken.balanceOf(address(this)) - wethInitial;

        // Slippage check
        if (wethOut < minEthOut) revert InsufficientOutput();

        _bridge(wethOut, intentId, intentDepositAddress);

        emit BridgeInitiated(intentId, msg.sender, assetIn, amountIn, wethOut, intentDepositAddress);
    }

    // ─── Hook (implemented by concrete variants) ─────────────────

    /// @dev Build the Moonbeam ethereumXcm.transact payload
    function _bridgeViaWormholeCall(uint256 ethOut, bytes memory data) internal view virtual returns (bytes memory);

    // ─── Helpers ─────────────────────────────────────────────────

    function _swap(IERC20 assetInToken, uint32 assetIn, uint256 amountIn, uint256 maxFeeIn) internal {
        // A is GLMR: Nothing to buy — keep the fee, sell the rest for WETH.
        if (assetIn == HydrationConsts.GLMR_ID) {
            uint256 aIn = amountIn - xcmFee;
            bytes memory buyWeth = HydrationRouter.encodeSell(assetIn, HydrationConsts.WETH_ID, aIn, 0);
            _dispatch(buyWeth);
            return;
        }

        // Buy the GLMR fee, spending at most `maxFeeIn` of A (caller's slippage).
        uint256 beforeFee = assetInToken.balanceOf(address(this));
        bytes memory buyFeeAsset = HydrationRouter.encodeBuy(assetIn, HydrationConsts.GLMR_ID, xcmFee, maxFeeIn);
        _dispatch(buyFeeAsset);

        // Convert the caller's leftover A (their deposit minus what the fee buy consumed) to WETH —
        // unless A already is WETH. Using the per-call delta rather than balanceOf leaves any stray /
        // donated A in the contract untouched instead of sweeping it into this caller's bridge.
        if (assetIn != HydrationConsts.WETH_ID) {
            uint256 feeSpent = beforeFee - assetInToken.balanceOf(address(this));
            uint256 aIn = amountIn - feeSpent;
            bytes memory buyWeth = HydrationRouter.encodeSell(assetIn, HydrationConsts.WETH_ID, aIn, 0);
            _dispatch(buyWeth);
        }
    }

    /// @dev Builds and dispatches batch_all([transfer_assets_using_type_and_then, send]).
    ///      Split out of swapAndBridge to keep stack depth manageable.
    function _bridge(uint256 ethOut, bytes32 intentId, address intentDepositAddress) internal {
        bytes memory beneficiary = XcmV4.accountKey20(xcmSource);

        bytes memory transferCall = HydrationPolkadotXcm.encodeTransferAssets(
            HydrationPolkadotXcm.TransferParams({
                destParaId: MoonbeamConsts.PARA_ID,
                feeLocation: HydrationConsts.GLMR_LOCATION,
                feeAmount: xcmFee,
                assetLocation: HydrationConsts.WETH_LOCATION,
                assetAmount: ethOut,
                beneficiary: beneficiary
            })
        );

        bytes memory sendCall = HydrationPolkadotXcm.encodeSendTransact(
            HydrationPolkadotXcm.SendTransactParams({
                destParaId: MoonbeamConsts.PARA_ID,
                feeLocation: MoonbeamConsts.GLMR_LOCATION,
                feeAmount: xcmExecutionFee,
                refTime: xcmTransactRefTime,
                proofSize: xcmTransactProofSize,
                transactCall: _bridgeViaWormholeCall(ethOut, abi.encode(intentId, intentDepositAddress)),
                beneficiary: beneficiary
            })
        );

        _dispatch(HydrationUtility.batchAll(transferCall, sendCall));
    }

    function _dispatch(bytes memory call) internal {
        (bool success,) = HydrationConsts.DISPATCH_PRECOMPILE.call(call);
        if (!success) revert DispatchFailed();
    }

    // ─── Internal ───────────────────────────────────────────────

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyXcmOperator() internal view {
        if (!xcmOperators[msg.sender]) revert NotXcmOperator();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setXcmOperator(address operator, bool enabled) external onlyOwner {
        xcmOperators[operator] = enabled;
        emit XcmOperatorUpdated(operator, enabled);
    }

    function setXcmParams(
        uint256 _xcmFee,
        uint256 _xcmExecutionFee,
        uint64 _gasLimit,
        uint64 _refTime,
        uint64 _proofSize
    ) external onlyXcmOperator {
        xcmFee = _xcmFee;
        xcmExecutionFee = _xcmExecutionFee;
        xcmGasLimit = _gasLimit;
        xcmTransactRefTime = _refTime;
        xcmTransactProofSize = _proofSize;
        emit XcmDefaultsUpdated(_xcmFee, _xcmExecutionFee, _gasLimit, _refTime, _proofSize);
    }
}
