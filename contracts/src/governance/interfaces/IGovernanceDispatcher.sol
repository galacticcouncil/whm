// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GovernanceCodec} from "../GovernanceCodec.sol";

/// @title Hydration source interface for cross-chain governance
/// @notice Publishes one canonical, destination-bound action through Wormhole.
interface IGovernanceDispatcher {
    error ZeroAddress();
    error AddressHasNoCode(address account);
    error InvalidWormholeChain(uint16 actual, uint16 expected);
    error NotGovernance(address caller);
    error InvalidMessageFee(uint256 expected, uint256 received);
    error GovernanceNonceExhausted();
    error ReentrantCall();

    event ActionPublished(
        bytes32 indexed actionId,
        uint16 indexed destinationWormholeChain,
        address indexed destinationExecutor,
        uint64 governanceNonce,
        uint64 wormholeSequence,
        bytes32 payloadHash
    );

    /// @notice Atomically configures a freshly deployed ERC-1967 proxy.
    /// @param wormhole Hydration's trusted Wormhole core contract; it must report chain ID 73.
    /// @param governanceCaller Fixed EVM address mapped from the Root-only runtime account.
    function initialize(address wormhole, address governanceCaller) external;

    /// @notice Publishes one action to exactly one destination executor.
    /// @dev Only the configured governance caller may invoke this function. `msg.value` must equal
    ///      the Wormhole core's current message fee exactly.
    function publish(
        uint16 destinationWormholeChain,
        address destinationExecutor,
        GovernanceCodec.Call[] calldata calls
    ) external payable returns (uint64 governanceNonce, uint64 wormholeSequence, bytes32 actionId);
}
