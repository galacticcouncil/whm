// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ITokenBridge} from "wormhole-solidity-sdk/interfaces/ITokenBridge.sol";

import {MoonbeamConsts} from "../utils/moonbeam/MoonbeamConsts.sol";
import {MoonbeamEthereumXcm} from "../utils/moonbeam/MoonbeamEthereumXcm.sol";
import {IBatch} from "../utils/moonbeam/MoonbeamPrecompiles.sol";

import {IntentEmitter} from "./IntentEmitter.sol";

/// @title IntentEmitterWtt — Wrapped-Token-Transfer variant of the NEAR-Intents entry point
/// @notice Bridges the swapped WETH straight through the Wormhole TokenBridge with a payload
///         (`transferTokensWithPayload`): on Moonbeam the MDA approves the TokenBridge and calls it
///         with `data = (intentId, depositAddress)` as the payload; on Ethereum, IntentReceiver
///         redeems the payload-3 VAA, unwraps WETH → native ETH, and forwards it to the deposit
///         address. No Basejump pool / fast-path — Moonbeam finalizes in ~seconds, so fronting
///         liquidity to beat source finality buys nothing for this direction.
contract IntentEmitterWtt is IntentEmitter {
    address public tokenBridge; // Moonbeam Wormhole TokenBridge
    bytes32 public intentReceiver; // Ethereum IntentReceiver (payload-3 recipient)

    function initialize() public initializer {
        _initEmitter();
    }

    // ─── Hook ────────────────────────────────────────────────────

    /// @dev Moonbeam ethereumXcm.transact → Batch precompile, atomically running (as the MDA):
    ///        1. WETH.approve(tokenBridge, ethOut)
    ///        2. tokenBridge.transferTokensWithPayload(WETH, ethOut, ETHEREUM_WORMHOLE_ID,
    ///             intentReceiver, nonce=0, data)   — `data` = (intentId, depositAddress) payload
    function _bridgeViaWormholeCall(uint256 ethOut, bytes memory data)
        internal
        view
        override
        returns (bytes memory)
    {
        address[] memory to = new address[](2);
        to[0] = MoonbeamConsts.WETH;
        to[1] = tokenBridge;

        uint256[] memory values = new uint256[](2); // [0, 0]

        bytes[] memory callData = new bytes[](2);
        callData[0] = abi.encodeWithSelector(IERC20.approve.selector, tokenBridge, ethOut);
        callData[1] = abi.encodeWithSelector(
            ITokenBridge.transferTokensWithPayload.selector,
            MoonbeamConsts.WETH,
            ethOut,
            ETHEREUM_WORMHOLE_ID,
            intentReceiver,
            uint32(0), // nonce — informational grouping only
            data
        );

        uint64[] memory gasLimit = new uint64[](2); // [0, 0] = forward remaining gas

        bytes memory input = abi.encodeWithSelector(IBatch.batchAll.selector, to, values, callData, gasLimit);
        return MoonbeamEthereumXcm.transact(xcmGasLimit, MoonbeamConsts.BATCH_PRECOMPILE, input);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setTokenBridge(address _tokenBridge) external onlyOwner {
        tokenBridge = _tokenBridge;
    }

    function setIntentReceiver(bytes32 _intentReceiver) external onlyOwner {
        intentReceiver = _intentReceiver;
    }
}
