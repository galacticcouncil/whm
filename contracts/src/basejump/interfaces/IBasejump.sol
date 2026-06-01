// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IBasejumpCore} from "./IBasejumpCore.sol";

interface IBasejump is IBasejumpCore {
    // ─── Functions ───────────────────────────────────────────────

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        bytes32 recipient,
        bytes memory data
    ) external payable returns (uint64 transferSequence, uint64 messageSequence);
}
