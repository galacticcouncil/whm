// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock NTT manager for testing Basejump settlement
/// @dev Models the 3-arg transfer overload: fails closed on a capacity breach.
contract MockNttManager {
    uint64 public nextSequence;

    address public immutable settlementToken;
    uint256 public deliveryPrice;
    uint256 public outboundCapacity = type(uint256).max;
    bool public paused;

    struct TransferRecord {
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
    }

    mapping(uint64 => TransferRecord) public transfers;

    error TransferPaused();
    error NotEnoughCapacity(uint256 currentCapacity, uint256 amount);

    event TransferSent(uint64 indexed sequence, uint256 amount, uint16 recipientChain, bytes32 recipient);

    constructor(address _token) {
        settlementToken = _token;
    }

    function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient)
        external
        payable
        returns (uint64 sequence)
    {
        if (paused) revert TransferPaused();
        // 3-arg overload hardcodes shouldQueue=false — a breach reverts, never queues
        if (amount > outboundCapacity) revert NotEnoughCapacity(outboundCapacity, amount);

        sequence = nextSequence;
        nextSequence++;

        transfers[sequence] =
            TransferRecord({amount: amount, recipientChain: recipientChain, recipient: recipient});

        // Lock the tokens (locking-hub behaviour)
        IERC20(settlementToken).transferFrom(msg.sender, address(this), amount);

        emit TransferSent(sequence, amount, recipientChain, recipient);
    }

    function quoteDeliveryPrice(uint16, bytes memory)
        external
        view
        returns (uint256[] memory perTransceiver, uint256 total)
    {
        perTransceiver = new uint256[](1);
        perTransceiver[0] = deliveryPrice;
        total = deliveryPrice;
    }

    function token() external view returns (address) {
        return settlementToken;
    }

    function tokenDecimals() external pure returns (uint8) {
        return 6;
    }

    function isPaused() external view returns (bool) {
        return paused;
    }

    function getCurrentOutboundCapacity() external view returns (uint256) {
        return outboundCapacity;
    }

    function getTransfer(uint64 sequence) external view returns (TransferRecord memory) {
        return transfers[sequence];
    }

    // ─── Test controls ───────────────────────────────────────────

    function setDeliveryPrice(uint256 price) external {
        deliveryPrice = price;
    }

    function setOutboundCapacity(uint256 capacity) external {
        outboundCapacity = capacity;
    }

    function setPaused(bool value) external {
        paused = value;
    }
}
