// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

library HydrationConsts {
    uint32 internal constant PARA_ID = 2034;

    /// @notice Dispatch precompile (0x0401) — executes a SCALE-encoded runtime call as the caller.
    address internal constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;

    // --- Native asset ids ---
    uint32 internal constant WETH_ID = 20;
    uint32 internal constant GLMR_ID = 16;

    /// @notice WETH: { parents:1, X3(Parachain(2004), PalletInstance(110), AccountKey20(0xab3f…)) }
    bytes internal constant WETH_LOCATION = hex"010300511f046e0300ab3f0245b83feb11d15aaffefd7ad465a59817ed";
    /// @notice GLMR: { parents:1, X2(Parachain(2004), PalletInstance(10)) }
    bytes internal constant GLMR_LOCATION = hex"010200511f040a";

    /// @notice Asset id → ERC20-precompile address: 0x0100000000 | assetId.
    function toErc20(uint32 assetId) internal pure returns (address) {
        return address((uint160(1) << 32) | uint160(assetId));
    }

    /// @notice ERC20-precompile address → Asset id: low 4 bytes.
    /// @dev Assumes a valid asset-precompile address; the 0x0100000000 prefix is not checked.
    function toAssetId(address erc20) internal pure returns (uint32) {
        return uint32(uint160(erc20));
    }
}

