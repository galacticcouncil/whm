// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {INttManager} from "./INttManager.sol";

/// @title INttManagerWithPayload — an NTT manager that carries a payload with a transfer
/// @dev Hand-written, like `INttManager`. Signature matches hydration-ntt
///      evm/src/NttManager/NttManagerWithPayload.sol (working tree after 929ba2f2). The payload lands in
///      `NativeTokenTransfer.additionalPayload`, covered by the manager message digest; the
///      destination manager ignores it — contracts that read the VAA themselves act on it.
interface INttManagerWithPayload is INttManager {
    /// @notice Transfer `amount` to `recipient` on `recipientChain` with `payload` attached.
    /// @dev Mirrors the 3-argument `transfer`: the recipient doubles as the refund address and no
    ///      transceiver instructions are passed. Never queued: a rate-limit breach reverts. Reverts
    ///      for Solana as the recipient chain.
    function transferWithPayload(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes calldata payload
    ) external payable returns (uint64 msgId);
}
