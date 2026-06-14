// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MoonbeamConsts} from "../utils/moonbeam/MoonbeamConsts.sol";
import {MoonbeamEthereumXcm} from "../utils/moonbeam/MoonbeamEthereumXcm.sol";
import {IBatch} from "../utils/moonbeam/MoonbeamPrecompiles.sol";

import {IBasejumpProxy} from "../basejump/interfaces/IBasejumpProxy.sol";

import {IntentEmitter} from "./IntentEmitter.sol";

/// @title IntentEmitterBjp — BaseJump-Proxy variant of the Hydration NEAR-Intents entry point
/// @notice Bridges the swapped WETH via Basejump's fast-path: on Moonbeam the MDA approves the
///         BasejumpProxy and calls bridgeViaWormhole; Basejump → IntentRouter then delivers native
///         ETH to the OneClick deposit address. See IntentEmitterWtt for the direct wrapped-token
///         transfer that drops the pre-funded pool (preferred where source finality is fast).
contract IntentEmitterBjp is IntentEmitter {
    address public basejumpProxy;
    bytes32 public intentRouter;

    function initialize() public initializer {
        _initEmitter();
    }

    // ─── Hook ────────────────────────────────────────────────────

    /// @dev Moonbeam ethereumXcm.transact → Batch precompile, atomically running (as the MDA):
    ///        1. WETH.approve(basejumpProxy, ethOut)   — so the proxy can pull the delivered WETH
    ///        2. BasejumpProxy.bridgeViaWormhole(WETH, ethOut, ETHEREUM_WORMHOLE_ID, intentRouter, data)
    function _bridgeViaWormholeCall(uint256 ethOut, bytes memory data)
        internal
        view
        override
        returns (bytes memory)
    {
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

    // ─── Admin ───────────────────────────────────────────────────

    function setRouter(bytes32 _intentRouter) external onlyOwner {
        intentRouter = _intentRouter;
    }

    function setProxy(address _basejumpProxy) external onlyOwner {
        basejumpProxy = _basejumpProxy;
    }
}
