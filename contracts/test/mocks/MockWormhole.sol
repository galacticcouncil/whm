// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

/// @dev Mixin for test contracts that set `wormhole = address(this)`.
///      VAA bytes are simply: abi.encode(emitterChainId, emitterAddress, payload[, salt])
///      parseAndVerifyVM always returns valid=true with a deterministic hash.
abstract contract MockWormhole {
    /// @dev When non-zero, the envelope timestamp to stamp instead of the test clock. Lets a test
    ///      put a VAA ahead of `block.timestamp`, which is what a foreign chain's clock does.
    uint32 internal vaaTimestampOverride;

    // forge-lint: disable-next-line(mixed-case-function)
    function parseAndVerifyVM(bytes calldata encodedVM) // forge-lint: disable-line(mixed-case-variable)
        external
        view
        returns (IWormhole.VM memory _vm, bool valid, string memory reason)
    {
        (uint16 emitterChainId, bytes32 emitterAddress, bytes memory payload) =
            abi.decode(encodedVM, (uint16, bytes32, bytes));

        _vm.emitterChainId = emitterChainId;
        _vm.emitterAddress = emitterAddress;
        _vm.payload = payload;
        _vm.hash = keccak256(encodedVM);
        // A salted VAA (a fourth word, so `payload` sits at 0x80) carries its sequence in the
        // salt's low 64 bits; bits above stand in for envelope fields a re-observation changes.
        if (uint256(bytes32(encodedVM[64:96])) == 0x80) {
            (,,, uint256 salt) = abi.decode(encodedVM, (uint16, bytes32, bytes, uint256));
            _vm.sequence = uint64(salt);
        }
        // Real guardians stamp the envelope observation time here; mirror it from the test clock
        // unless a test pins one, which is how a source chain leading the local clock is expressed.
        _vm.timestamp = vaaTimestampOverride == 0 ? uint32(block.timestamp) : vaaTimestampOverride;

        valid = true;
        reason = "";
    }
}
