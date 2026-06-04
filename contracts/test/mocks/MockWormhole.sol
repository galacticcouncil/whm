// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

/// @dev Mixin for test contracts that set `wormhole = address(this)`.
///      VAA bytes are simply: abi.encode(emitterChainId, emitterAddress, payload[, salt])
///      parseAndVerifyVM always returns valid=true with a deterministic hash.
abstract contract MockWormhole {
    // forge-lint: disable-next-line(mixed-case-function)
    function parseAndVerifyVM(bytes calldata encodedVM) // forge-lint: disable-line(mixed-case-variable)
        external
        pure
        returns (IWormhole.VM memory _vm, bool valid, string memory reason)
    {
        (uint16 emitterChainId, bytes32 emitterAddress, bytes memory payload) =
            abi.decode(encodedVM, (uint16, bytes32, bytes));

        _vm.emitterChainId = emitterChainId;
        _vm.emitterAddress = emitterAddress;
        _vm.payload = payload;
        _vm.hash = keccak256(encodedVM);

        valid = true;
        reason = "";
    }
}
