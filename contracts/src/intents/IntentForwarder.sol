// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {INttManager} from "../ntt/interfaces/INttManager.sol";
import {IWormholeTransceiver} from "../ntt/interfaces/IWormholeTransceiver.sol";
import {NttPayload} from "../ntt/NttPayload.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";

import {IntentCodec} from "./IntentCodec.sol";
import {IIntentForwarder} from "./interfaces/IIntentForwarder.sol";

/// @title IntentForwarder — Ethereum end of intents v2
/// @notice One call carries an order the last hop it takes on our side:
///
///           1. READ    — the settlement must be the dispatcher's transfer to this contract, and its
///                        payload the forwarding instruction.
///           2. DELIVER — submit the NTT VAA, releasing native ETH here.
///           3. FORWARD — pay the caller its fee, send the rest to the payload's depositAddress.
///
///         Atomic, so whoever calls it did all of it and is the one paid. NTT's delivery is
///         permissionless, so a settlement may already be here; that skips step 2 rather than failing.
///
/// @dev Nothing is caller-supplied. The destination and the fee ceiling ride in the transfer's
///      payload, which NTT attests with the transfer itself; only a transfer the pinned dispatcher
///      sent is an order, and the amount comes from the settlement. The manager executing the
///      message is what proves it — it only executes its registered Hydration peer's messages.
contract IntentForwarder is Initializable, UUPSUpgradeable, IIntentForwarder {
    using NttPayload for bytes;

    /// @notice Head start for authorized relayers, from the settlement VAA's timestamp.
    uint256 internal constant EXCLUSIVE_WINDOW = 5 minutes;

    /// @notice What NTT trims WETH to — `min(8, srcDp, dstDp)` with 18 decimals on both sides.
    uint8 internal constant NTT_DECIMALS = 8;

    /// @notice Scales a trimmed amount back to the 18-decimal native ETH the rail delivers.
    uint256 internal constant TRIM_UNIT = 1e10;

    address public owner;
    IWormhole public wormhole;
    IWormholeTransceiver public transceiver;

    /// @notice The Hydration IntentDispatcher, as a Wormhole universal address — the only sender
    ///         whose transfers are orders.
    bytes32 public dispatcher;

    /// @notice Settlements already forwarded, by NTT message digest.
    mapping(bytes32 => bool) public processed;

    /// @notice Relayers that may process inside EXCLUSIVE_WINDOW. Empty means permissionless always.
    mapping(address => bool) public authorizedRelayer;
    uint256 public authorizedRelayerCount;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole, address _transceiver) public initializer {
        owner = msg.sender;
        wormhole = IWormhole(_wormhole);
        transceiver = IWormholeTransceiver(_transceiver);
    }

    /// @notice Accept settlements.
    receive() external payable {}

    // ─── Core ────────────────────────────────────────────────────

    /// @inheritdoc IIntentForwarder
    function processOrder(bytes calldata nttVaa, uint256 feeRequested) external {
        if (dispatcher == bytes32(0)) revert NotConfigured();

        IWormhole.VM memory settlement = wormhole.parseVM(nttVaa);
        NttPayload.Transfer memory transfer = _requireOrder(settlement);
        (address depositAddress, uint256 maxRelayFee) = IntentCodec.decodeForward(transfer.additionalPayload);

        if (feeRequested > maxRelayFee) revert FeeExceedsCeiling();

        bytes32 digest = keccak256(abi.encodePacked(settlement.emitterChainId, transfer.message));
        if (processed[digest]) revert AlreadyRedeemed();
        processed[digest] = true;

        // Skipped when a generic NTT relayer already delivered.
        if (!transceiver.isVAAConsumed(settlement.hash)) {
            transceiver.receiveMessage(nttVaa);
        }

        // Delivered is not released.
        _requireReleased(digest, transfer.sequence);

        // Below the proof, not above it: only now is the settlement's timestamp trustworthy.
        _requireCallerMayProcess(settlement.timestamp);

        uint256 forwardAmount = uint256(transfer.amount) * TRIM_UNIT - feeRequested;

        _pay(depositAddress, forwardAmount);
        emit OrderForwarded(transfer.sequence, depositAddress, forwardAmount);

        if (feeRequested > 0) {
            _pay(msg.sender, feeRequested);
            emit RelayFeePaid(transfer.sequence, msg.sender, feeRequested);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /// @dev Read the settlement and reject it before anything is delivered: from Hydration, sent by
    ///      the dispatcher, to this contract, at the rail's precision.
    /// @param settlement The NTT VAA — parsed, not verified; delivery proves it.
    function _requireOrder(IWormhole.VM memory settlement)
        private
        view
        returns (NttPayload.Transfer memory transfer)
    {
        if (settlement.emitterChainId != HydrationConsts.WORMHOLE_CHAIN_ID) {
            revert UnexpectedSourceChain(settlement.emitterChainId);
        }

        transfer = settlement.payload.transferOf();
        if (transfer.sender != dispatcher) revert UnauthorizedSender(transfer.sender);
        if (transfer.to != bytes32(uint256(uint160(address(this))))) revert WrongRecipient(transfer.to);
        if (transfer.decimals != NTT_DECIMALS) revert UnexpectedTrim(transfer.decimals);
    }

    /// @dev The VAA is public once signed and this pays msg.sender, so anyone can rebuild the call —
    ///      or copy a pending one out of the mempool. The window makes that unprofitable without
    ///      making delivery depend on us: it expires, and an empty allowlist disables it entirely.
    /// @param timestamp The settlement's, trustworthy only after the settlement is proven — it is
    ///        parsed unverified.
    function _requireCallerMayProcess(uint32 timestamp) private view {
        if (authorizedRelayerCount == 0 || authorizedRelayer[msg.sender]) return;
        if (block.timestamp < uint256(timestamp) + EXCLUSIVE_WINDOW) revert Unauthorized();
    }

    /// @dev Assert the settlement's funds landed here, rather than inferring it from delivery: the
    ///      manager marks a message executed before the inbound rate limiter runs, and a queued
    ///      transfer releases nothing until someone completes it.
    function _requireReleased(bytes32 digest, uint64 sequence) private view {
        INttManager manager = INttManager(transceiver.nttManager());
        if (!manager.isMessageExecuted(digest) || manager.getInboundQueuedTransfer(digest).txTimestamp != 0) {
            revert SettlementNotReleased(sequence);
        }
    }

    /// @dev Everything this contract moves is native ETH.
    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Pin the dispatcher whose transfers are orders.
    function setDispatcher(bytes32 _dispatcher) external onlyOwner {
        dispatcher = _dispatcher;
        emit DispatcherUpdated(_dispatcher);
    }

    /// @notice Grant or revoke exclusive-window access. The first grant turns the window on for
    ///         everyone else; revoking the last turns it off again.
    function setAuthorizedRelayer(address relayer, bool enabled) external onlyOwner {
        if (authorizedRelayer[relayer] == enabled) return;
        authorizedRelayer[relayer] = enabled;
        enabled ? authorizedRelayerCount++ : authorizedRelayerCount--;
        emit RelayerAuthorized(relayer, enabled);
    }

    /// @notice Emergency withdrawal.
    function sweep(address to, uint256 amount) external onlyOwner {
        _pay(to, amount);
        emit Swept(to, amount);
    }
}
