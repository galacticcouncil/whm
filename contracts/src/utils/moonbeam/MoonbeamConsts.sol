// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

library MoonbeamConsts {
    uint32 internal constant PARA_ID = 2004;

    /// @notice Batch precompile (atomic multi-call).
    address internal constant BATCH_PRECOMPILE = 0x0000000000000000000000000000000000000808;

    // --- Erc20 ---
    address internal constant WETH = 0xab3f0245B83feB11d15AAffeFD7AD465a59817eD;

    /// @notice GLMR: { parents:0, X1(PalletInstance(10)) }
    bytes internal constant GLMR_LOCATION = hex"0001040a";
}
