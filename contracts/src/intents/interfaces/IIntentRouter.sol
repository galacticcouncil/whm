// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IBasejumpReceiver} from "../../basejump/interfaces/IBasejumpReceiver.sol";

interface IIntentRouter is IBasejumpReceiver {
    // ─── Events ──────────────────────────────────────────────────

    /// @notice Emitted after the received asset has been forwarded to the OneClick
    ///         quote's depositAddress. `asset` is whatever the authorized BasejumpLanding
    ///         delivered; the router doesn't pin a single asset.
    event IntentForwarded(
        bytes32 indexed intentId, address indexed asset, address indexed depositAddress, uint256 amount
    );
    event Swept(address indexed asset, address indexed to, uint256 amount);
    event BasejumpLandingUpdated(address indexed previous, address indexed current);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotBasejumpLanding(address sender);
    error InvalidDepositAddress();
    error MalformedData();

    // ─── Admin ───────────────────────────────────────────────────

    function sweep(address asset, address to, uint256 amount) external;
    function setBasejumpLanding(address basejumpLanding) external;
    function setOwner(address newOwner) external;

    // ─── Views ───────────────────────────────────────────────────

    function basejumpLanding() external view returns (address);
    function owner() external view returns (address);
}
