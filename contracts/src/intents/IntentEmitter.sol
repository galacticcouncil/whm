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
import {MoonbeamEthereumXcm} from "../utils/moonbeam/MoonbeamEthereumXcm.sol";
import {IBatch} from "../utils/moonbeam/MoonbeamPrecompiles.sol";

import {IBasejumpProxy} from "../basejump/interfaces/IBasejumpProxy.sol";
import {IIntentEmitter} from "./interfaces/IIntentEmitter.sol";

/// @title IntentEmitter — Hydration entry point for NEAR-Intents bridging
/// @notice One atomic extrinsic, dispatched through Hydration's runtime via the DISPATCH precompile:
///
///           1. FEE  — reserve a fixed `xcmFee` of GLMR for the x-chain hop: bought from A,
///                     or simply held back when A is already GLMR.
///           2. SWAP — sell the remaining A for WETH (skipped when A is already WETH).
///           3. BATCH_ALL of two XCM calls to Moonbeam:
///                a. transfer_assets_using_type_and_then — reserve-transfer [GLMR, WETH] to the MDA.
///                b. send — Transact AS the MDA via Moonbeam's Batch precompile: WETH.approve(proxy)
///                   then BasejumpProxy.bridgeViaWormhole(...). From there Basejump → IntentRouter
///                   delivers native ETH to the OneClick quote's intentDepositAddress.
contract IntentEmitter is Initializable, UUPSUpgradeable, IIntentEmitter {
    using SafeERC20 for IERC20;

    uint16 public constant ETHEREUM_WORMHOLE_ID = 2;

    address public owner;
    mapping(address => bool) public xcmOperators;

    address public basejumpProxy;
    bytes32 public intentRouter;

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

    function initialize() public initializer {
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
        bytes32 intentId,
        address intentDepositAddress
    ) external {
        if (amountIn == 0) revert ZeroAmount();
        if (intentDepositAddress == address(0)) revert InvalidDepositAddress();
        if (basejumpProxy == address(0) || intentRouter == bytes32(0)) revert NotConfigured();

        IERC20 assetInToken = IERC20(HydrationConsts.toErc20(assetIn));
        IERC20 wethToken = IERC20(HydrationConsts.toErc20(HydrationConsts.WETH_ID));

        assetInToken.safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 wethInitial = wethToken.balanceOf(address(this));

        _swap(assetInToken, assetIn, amountIn);

        uint256 wethOut = wethToken.balanceOf(address(this)) - wethInitial;

        // Slippage check
        if (wethOut < minEthOut) revert InsufficientOutput();

        _bridge(wethOut, intentId, intentDepositAddress);

        emit BridgeInitiated(intentId, msg.sender, assetIn, amountIn, wethOut, intentDepositAddress);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _swap(IERC20 assetInToken, uint32 assetIn, uint256 amountIn) internal {
        // A is GLMR: Nothing to buy — keep the fee, sell the rest for WETH.
        if (assetIn == HydrationConsts.GLMR_ID) {
            uint256 aIn = amountIn - xcmFee;
            bytes memory buyWeth = HydrationRouter.encodeSell(assetIn, HydrationConsts.WETH_ID, aIn, 0);
            _dispatch(buyWeth);
            return;
        }

        // No GLMR slippage guard
        bytes memory buyFeeAsset =
            HydrationRouter.encodeBuy(assetIn, HydrationConsts.GLMR_ID, xcmFee, type(uint128).max);
        _dispatch(buyFeeAsset);

        // Convert the leftover A to WETH — unless A already is WETH.
        if (assetIn != HydrationConsts.WETH_ID) {
            uint256 aIn = assetInToken.balanceOf(address(this));
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

    /// @dev Moonbeam ethereumXcm.transact → Batch precompile, atomically running (as the MDA):
    ///        1. WETH.approve(basejumpProxy, ethOut)   — so the proxy can pull the delivered WETH
    ///        2. BasejumpProxy.bridgeViaWormhole(WETH, ethOut, ETHEREUM_WORMHOLE_ID, intentRouter, data)
    function _bridgeViaWormholeCall(uint256 ethOut, bytes memory data) internal view returns (bytes memory) {
        address[] memory to = new address[](2);
        to[0] = MoonbeamConsts.WETH;
        to[1] = basejumpProxy;

        uint256[] memory values = new uint256[](2); // [0, 0]

        bytes[] memory callData = new bytes[](2);
        callData[0] = abi.encodeWithSelector(IERC20.approve.selector, basejumpProxy, ethOut);
        callData[1] = abi.encodeWithSelector(
            IBasejumpProxy.bridgeViaWormhole.selector,
            MoonbeamConsts.WETH,
            ethOut,
            ETHEREUM_WORMHOLE_ID,
            intentRouter,
            data
        );

        uint64[] memory gasLimit = new uint64[](2); // [0, 0] = forward remaining gas

        bytes memory input = abi.encodeWithSelector(IBatch.batchAll.selector, to, values, callData, gasLimit);
        return MoonbeamEthereumXcm.transact(xcmGasLimit, MoonbeamConsts.BATCH_PRECOMPILE, input);
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

    function setRouter(bytes32 _intentRouter) external onlyOwner {
        intentRouter = _intentRouter;
    }

    function setProxy(address _basejumpProxy) external onlyOwner {
        basejumpProxy = _basejumpProxy;
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
