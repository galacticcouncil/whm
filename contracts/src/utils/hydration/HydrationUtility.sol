// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "../ScaleCodec.sol";

/// @title HydrationUtility — encoders for "utility" pallet.
library HydrationUtility {
    uint8 internal constant PALLET = 13;

    uint8 internal constant BATCH_ALL = 2; // utility.batchAll

    /// @dev utility.batch_all([call1, call2]) — each call is a fully-encoded runtime call.
    function batchAll(bytes memory call1, bytes memory call2) internal pure returns (bytes memory) {
        return abi.encodePacked(PALLET, BATCH_ALL, ScaleCodec.compactU32(2), call1, call2);
    }
}
