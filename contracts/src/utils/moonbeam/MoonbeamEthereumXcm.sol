// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "../ScaleCodec.sol";

/// @title MoonbeamEthereumXcm — encoders for "ethereumXcm" pallet.
/// @notice Wraps an EVM call for execution via an XCM Transact on Moonbeam.
library MoonbeamEthereumXcm {
    uint8 internal constant PALLET = 109;

    uint8 internal constant TRANSACT = 0; // ethereumXcm.transact

    /// @dev ethereumXcm.transact(EthereumXcmTransaction::V1 { gas_limit, fee_payment: Auto,
    ///      Call(target), value: 0, input, access_list: None }).
    function transact(uint64 gasLimit, address target, bytes memory input) internal pure returns (bytes memory) {
        return abi.encodePacked(
            PALLET,
            TRANSACT,
            uint8(0x00), // EthereumXcmTransaction::V1
            ScaleCodec.u256Le(gasLimit), // gas_limit: U256
            uint8(0x01), // fee_payment: EthereumXcmFee::Auto
            uint8(0x00), // TransactionAction::Call
            bytes20(target),
            ScaleCodec.u256Le(0), // value: 0
            ScaleCodec.encodeVecU8(input), // input: BoundedVec<u8>
            uint8(0x00) // access_list: Option::None
        );
    }
}
