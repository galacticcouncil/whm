// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock payload-capable NTT manager: records each transfer with its payload, as
///         `NttManagerWithPayload.transferWithPayload` attaches it to the NativeTokenTransfer.
contract MockNttManagerWithPayload {
    uint64 public nextSequence;
    address public immutable settlementToken;
    uint256 public deliveryPrice;
    bool public paused;

    struct TransferRecord {
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
        bytes payload;
        uint256 value;
        address sender;
    }

    mapping(uint64 => TransferRecord) internal _transfers;

    error TransferPaused();

    constructor(address _token) {
        settlementToken = _token;
    }

    function setDeliveryPrice(uint256 price) external {
        deliveryPrice = price;
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function transferWithPayload(uint256 amount, uint16 recipientChain, bytes32 recipient, bytes calldata payload)
        external
        payable
        returns (uint64 sequence)
    {
        if (paused) revert TransferPaused();
        sequence = nextSequence++;
        _transfers[sequence] = TransferRecord(amount, recipientChain, recipient, payload, msg.value, msg.sender);
        IERC20(settlementToken).transferFrom(msg.sender, address(this), amount);
    }

    function transfers(uint64 sequence) external view returns (TransferRecord memory) {
        return _transfers[sequence];
    }

    function quoteDeliveryPrice(uint16, bytes memory) external view returns (uint256[] memory perTransceiver, uint256 total) {
        perTransceiver = new uint256[](1);
        perTransceiver[0] = deliveryPrice;
        total = deliveryPrice;
    }

    function token() external view returns (address) {
        return settlementToken;
    }
}
