// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IBasejumpBase} from "./IBasejumpBase.sol";

interface IBasejumpProxy is IBasejumpBase {
    // ─── Functions ───────────────────────────────────────────────

    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        uint16 destChain,
        bytes32 recipient
    ) external payable returns (uint64 transferSequence, uint64 messageSequence);
}
