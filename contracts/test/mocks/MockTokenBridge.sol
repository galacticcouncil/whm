// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock TokenBridge for testing Basejump cross-chain transfers
/// @dev Simulates Wormhole TokenBridge transferTokensWithPayload functionality
contract MockTokenBridge {
    uint64 public nextSequence;

    struct TransferRecord {
        address token;
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
        uint32 nonce;
        bytes payload;
    }

    mapping(uint64 => TransferRecord) public transfers;

    event TokensTransferredWithPayload(
        uint64 indexed sequence,
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes payload
    );

    /// @notice Mock implementation of transferTokensWithPayload
    /// @dev Stores transfer details for test verification and returns sequence number
    function transferTokensWithPayload(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint32 nonce,
        bytes memory payload
    ) external payable returns (uint64 sequence) {
        sequence = nextSequence;
        nextSequence++;

        // Store transfer record for test assertions
        transfers[sequence] = TransferRecord({
            token: token,
            amount: amount,
            recipientChain: recipientChain,
            recipient: recipient,
            nonce: nonce,
            payload: payload
        });

        // Transfer tokens to this contract (simulating bridge lock)
        IERC20(token).transferFrom(msg.sender, address(this), amount);

        emit TokensTransferredWithPayload(sequence, token, amount, recipientChain, recipient, payload);

        return sequence;
    }

    /// @notice Get transfer details by sequence number
    function getTransfer(uint64 sequence) external view returns (TransferRecord memory) {
        return transfers[sequence];
    }
}
