// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {GovernanceCodec} from "./GovernanceCodec.sol";
import {IGovernanceDispatcher} from "./interfaces/IGovernanceDispatcher.sol";

/// @title GovernanceDispatcher — Hydration source for cross-chain OpenGov actions
/// @notice The Root-only runtime path calls this proxy from a fixed synthetic EVM address. The
///         dispatcher validates and publishes the canonical action; destination executors impose
///         the
///         local veto delay before any governed call can run.
contract GovernanceDispatcher is Initializable, UUPSUpgradeable, IGovernanceDispatcher {
    /// @notice Wormhole's assigned source-chain identifier for Hydration.
    uint16 public constant HYDRATION_WORMHOLE_CHAIN = 73;
    /// @notice Hydration watcher level that waits for finalized source blocks.
    uint8 public constant CONSISTENCY_FINALIZED = 202;

    /// @custom:storage-location erc7201:hydration.storage.GovernanceDispatcher
    struct DispatcherStorage {
        IWormhole wormhole;
        address governanceCaller;
        /// @dev Starts at one. It is part of the signed payload and survives implementation upgrades.
        uint64 nextGovernanceNonce;
        uint8 reentrancyStatus;
    }

    bytes32 private constant DISPATCHER_STORAGE_LOCATION =
        0x87c9bfd7d4d795f8d6f9338d86a7a19561287ad9cd8d93140b14a14e06551200;

    modifier onlyGovernance() {
        if (msg.sender != _getDispatcherStorage().governanceCaller) revert NotGovernance(msg.sender);
        _;
    }

    modifier nonReentrant() {
        DispatcherStorage storage $ = _getDispatcherStorage();
        if ($.reentrancyStatus == 2) revert ReentrantCall();
        $.reentrancyStatus = 2;
        _;
        $.reentrancyStatus = 1;
    }

    /// @dev Locks the implementation; the proxy must initialize atomically at deployment.
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IGovernanceDispatcher
    function initialize(address wormhole_, address governanceCaller_) external initializer {
        if (wormhole_ == address(0) || governanceCaller_ == address(0)) revert ZeroAddress();
        if (wormhole_.code.length == 0) revert AddressHasNoCode(wormhole_);

        uint16 wormholeChain = IWormhole(wormhole_).chainId();
        if (wormholeChain != HYDRATION_WORMHOLE_CHAIN) {
            revert InvalidWormholeChain(wormholeChain, HYDRATION_WORMHOLE_CHAIN);
        }

        DispatcherStorage storage $ = _getDispatcherStorage();
        $.wormhole = IWormhole(wormhole_);
        $.governanceCaller = governanceCaller_;
        $.nextGovernanceNonce = 1;
        $.reentrancyStatus = 1;
    }

    /// @inheritdoc IGovernanceDispatcher
    function publish(
        uint16 destinationWormholeChain,
        address destinationExecutor,
        GovernanceCodec.Call[] calldata calls
    )
        external
        payable
        onlyGovernance
        nonReentrant
        returns (uint64 governanceNonce_, uint64 wormholeSequence, bytes32 actionId_)
    {
        DispatcherStorage storage $ = _getDispatcherStorage();
        governanceNonce_ = $.nextGovernanceNonce;
        if (governanceNonce_ == type(uint64).max) revert GovernanceNonceExhausted();

        bytes memory payload =
            GovernanceCodec.encode(destinationWormholeChain, destinationExecutor, governanceNonce_, calls);
        uint256 fee = $.wormhole.messageFee();
        if (msg.value != fee) revert InvalidMessageFee(fee, msg.value);

        bytes32 payloadHash = keccak256(payload);
        actionId_ =
            GovernanceCodec.actionId(HYDRATION_WORMHOLE_CHAIN, bytes32(uint256(uint160(address(this)))), payloadHash);

        // Reserve before interaction so a callback cannot reuse a nonce. Any downstream revert
        // rolls this update back. Wormhole's uint32 nonce is metadata only; the uint64 governance
        // nonce inside the signed payload is the protocol replay and audit identifier.
        $.nextGovernanceNonce = governanceNonce_ + 1;
        wormholeSequence =
            $.wormhole.publishMessage{value: msg.value}(uint32(governanceNonce_), payload, CONSISTENCY_FINALIZED);

        emit ActionPublished(
            actionId_, destinationWormholeChain, destinationExecutor, governanceNonce_, wormholeSequence, payloadHash
        );
    }

    /// @notice Returns Hydration's trusted Wormhole core contract.
    function wormhole() external view returns (address) {
        return address(_getDispatcherStorage().wormhole);
    }

    /// @notice Returns the fixed synthetic EVM address allowed to publish and upgrade.
    function governanceCaller() external view returns (address) {
        return _getDispatcherStorage().governanceCaller;
    }

    /// @notice Returns the nonce that the next successful publication will sign into its payload.
    function nextGovernanceNonce() external view returns (uint64) {
        return _getDispatcherStorage().nextGovernanceNonce;
    }

    /// @dev Dispatcher upgrades originate from the same Root-only synthetic account as publication.
    ///      There is no deployer owner, ProxyAdmin, or governance-caller setter.
    function _authorizeUpgrade(address) internal view override onlyGovernance {}

    function _getDispatcherStorage() private pure returns (DispatcherStorage storage $) {
        assembly ("memory-safe") {
            $.slot := DISPATCHER_STORAGE_LOCATION
        }
    }
}
