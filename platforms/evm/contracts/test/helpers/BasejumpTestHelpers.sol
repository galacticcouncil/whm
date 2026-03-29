// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @notice Test helper library for Basejump integration tests
/// @dev Provides utilities for VAA generation and common test operations
library BasejumpTestHelpers {
    /// @notice Build a fast-path VAA for Basejump transfers
    /// @dev VAA format: abi.encode(emitterChainId, emitterAddress, payload)
    /// @param sourceChain Wormhole chain ID of the source chain
    /// @param sourceBasejump Address of the Basejump contract that emitted the message
    /// @param sourceAsset Address of the source asset being transferred
    /// @param netAmount Amount after fees deducted
    /// @param recipient bytes32-encoded recipient address
    /// @return Encoded VAA bytes
    function buildFastPathVAA(
        uint16 sourceChain,
        address sourceBasejump,
        address sourceAsset,
        uint256 netAmount,
        bytes32 recipient
    ) internal pure returns (bytes memory) {
        bytes memory payload = abi.encode(sourceAsset, netAmount, recipient);
        return abi.encode(
            sourceChain,
            bytes32(uint256(uint160(sourceBasejump))),
            payload
        );
    }

    /// @notice Convert an address to bytes32 (for cross-chain addresses)
    /// @param addr Address to convert
    /// @return bytes32 representation (address in lower 20 bytes)
    function addressToBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    /// @notice Convert bytes32 to address (from cross-chain addresses)
    /// @param b bytes32 to convert
    /// @return Address from lower 20 bytes
    function bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }
}
