// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

/// @title ForkWormhole — a permissive core, for anvil `setCode` runs only
/// @notice Guardian signatures cannot be produced against a fork, so driving the receive leg on
///         one means standing in for verification. This does that and nothing else: every other
///         check on the path — emitter binding, the replay guard, decode, the bucket — still runs
///         for real against the real contracts.
///
/// @dev Deliberately storage-free. It is installed over a live core's address with
///      `anvil_setCode`, which replaces code but keeps that account's existing storage, so any
///      state variable here would read the real core's slots. `messageFee` is therefore a constant
///      rather than a stored value.
///
///      NEVER deploy this. It attests anything handed to it.
contract ForkWormhole {
    /// @dev VAA bytes are `abi.encode(emitterChainId, emitterAddress, payload)`.
    // forge-lint: disable-next-line(mixed-case-function)
    function parseAndVerifyVM(bytes calldata encodedVM) // forge-lint: disable-line(mixed-case-variable)
        external
        view
        returns (IWormhole.VM memory vm_, bool valid, string memory reason)
    {
        (uint16 emitterChainId, bytes32 emitterAddress, bytes memory payload) =
            abi.decode(encodedVM, (uint16, bytes32, bytes));

        vm_.emitterChainId = emitterChainId;
        vm_.emitterAddress = emitterAddress;
        vm_.payload = payload;
        vm_.hash = keccak256(encodedVM);
        vm_.timestamp = uint32(block.timestamp);

        valid = true;
        reason = "";
    }

    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64)
    {
        emit LogMessagePublished(msg.sender, 0, nonce, payload, consistencyLevel);
        return 0;
    }

    event LogMessagePublished(
        address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel
    );
}
