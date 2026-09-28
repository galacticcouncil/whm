// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IGhoToken — the facilitator surface of the HOLLAR token
/// @dev Only what a facilitator calls. Registration (`addFacilitator`,
///      `setFacilitatorBucketCapacity`) is governance's, on the token, not ours.
interface IGhoToken is IERC20 {
    /// @notice Mint against this facilitator's bucket. Reverts if it would exceed capacity.
    function mint(address account, uint256 amount) external;

    /// @notice Burn from the caller's own balance, crediting the caller's bucket.
    /// @dev The solvency model of this whole module. `bucketLevel - amount` has no floor, so 0.8
    ///      underflow means a facilitator can never burn past what it minted.
    function burn(uint256 amount) external;

    /// @return capacity The bucket ceiling set by governance.
    /// @return level The amount currently minted against it.
    function getFacilitatorBucket(address facilitator) external view returns (uint256 capacity, uint256 level);

    function decimals() external view returns (uint8);
}
