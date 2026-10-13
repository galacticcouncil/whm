// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {INttManager} from "../ntt/interfaces/INttManager.sol";
import {IWormholeTransceiver} from "../ntt/interfaces/IWormholeTransceiver.sol";
import {NttPayload} from "../ntt/NttPayload.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";

import {IIntentReceiver} from "./interfaces/IIntentReceiver.sol";

/// @title IntentReceiver — Ethereum end of the NTT intent path
/// @notice One call carries an order the last hop it takes on our side:
///
///           1. MATCH   — the settlement and the emitter's instruction must name the same sequence.
///           2. DELIVER — submit the NTT VAA, releasing native ETH here.
///           3. FORWARD — pay the caller its fee, send the rest to the instruction's depositAddress.
///
///         Atomic, so whoever calls it did all of it and is the one paid. NTT's delivery is
///         permissionless unlike the TokenBridge's payload-3 completion, so a settlement may already
///         be here; that skips step 2 rather than failing.
///
/// @dev Nothing is caller-supplied. The destination and the fee ceiling come from a guardian-signed
///      instruction whose emitter is pinned; the amount comes from the settlement itself, so an
///      instruction cannot claim more than its own settlement released.
contract IntentReceiver is Initializable, UUPSUpgradeable, IIntentReceiver {
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

    /// @notice The Hydration IntentEmitter, as a Wormhole universal address.
    bytes32 public emitterAddress;

    mapping(bytes32 => bool) public processed;

    /// @notice Relayers that may process inside EXCLUSIVE_WINDOW. Empty means permissionless always.
    /// @dev Appended after `processed` — UUPS, so the preceding layout is fixed.
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

    /// @inheritdoc IIntentReceiver
    function processOrder(bytes calldata nttVaa, bytes calldata instructionVaa, uint256 feeRequested)
        external
    {
        if (emitterAddress == bytes32(0)) revert NotConfigured();

        (IWormhole.VM memory instruction, bool valid,) = wormhole.parseAndVerifyVM(instructionVaa);
        if (!valid) revert InvalidInstruction();

        (uint64 sequence, address depositAddress, uint256 maxRelayFee) =
            _requireInstruction(instruction);

        IWormhole.VM memory settlement = wormhole.parseVM(nttVaa);
        (bytes memory message, uint64 trimmed) = _requireSettlement(settlement.payload, sequence);

        if (feeRequested > maxRelayFee) revert FeeExceedsCeiling();

        // Skipped when a generic NTT relayer already delivered.
        if (!transceiver.isVAAConsumed(settlement.hash)) {
            transceiver.receiveMessage(nttVaa);
        }

        // Delivered is not released.
        _requireReleased(settlement.emitterChainId, message, sequence);

        // Below the proof, not above it: only now is the settlement's timestamp trustworthy.
        _requireCallerMayProcess(settlement.timestamp);

        uint256 amount = uint256(trimmed) * TRIM_UNIT;
        uint256 forwardAmount = amount - feeRequested;

        _pay(depositAddress, forwardAmount);
        emit OrderProcessed(sequence, depositAddress, forwardAmount);

        if (feeRequested > 0) {
            _pay(msg.sender, feeRequested);
            emit RelayFeePaid(sequence, msg.sender, feeRequested);
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /// @dev Authorize the emitter's instruction, consume it, and read its terms.
    /// @return sequence The settlement this instruction was published with
    /// @return depositAddress Where it forwards
    /// @return maxRelayFee Ceiling on the caller's claim
    function _requireInstruction(IWormhole.VM memory instruction)
        private
        returns (uint64 sequence, address depositAddress, uint256 maxRelayFee)
    {
        if (
            instruction.emitterChainId != HydrationConsts.WORMHOLE_CHAIN_ID ||
            instruction.emitterAddress != emitterAddress
        ) {
            revert UnauthorizedEmitter(instruction.emitterChainId, instruction.emitterAddress);
        }

        if (processed[instruction.hash]) revert AlreadyRedeemed();
        processed[instruction.hash] = true;

        (sequence, depositAddress, maxRelayFee) =
            abi.decode(instruction.payload, (uint64, address, uint256));
        if (depositAddress == address(0)) revert MalformedInstruction();
    }

    /// @dev Read the settlement and reject it before anything is delivered.
    /// @param payload The settlement VAA's payload — parsed, not verified.
    /// @param sequence The manager sequence the instruction named.
    /// @return message The manager message, the preimage NTT digests delivery on
    /// @return trimmed What the transfer releases, still at the rail's precision
    function _requireSettlement(bytes memory payload, uint64 sequence)
        private
        pure
        returns (bytes memory message, uint64 trimmed)
    {
        uint64 settled;
        uint8 decimals;
        (settled, message, decimals, trimmed) = payload.settlementOf();
        if (settled != sequence) revert SequenceMismatch(sequence, settled);
        if (decimals != NTT_DECIMALS) revert UnexpectedTrim(decimals);
    }

    /// @dev The VAAs are public once signed and this pays msg.sender, so anyone can rebuild the call —
    ///      or copy a pending one out of the mempool. The window makes that unprofitable without
    ///      making delivery depend on us: it expires, and an empty allowlist disables it entirely.
    ///
    ///      Both messages leave one transaction, so both VAAs carry that block's timestamp and which
    ///      one this is timed from makes no difference. It does mean the window opens at the block
    ///      rather than at signing, so finality spends its first ~40s before anyone can act.
    /// @param timestamp The settlement's, trustworthy only after the settlement is proven — it is
    ///        parsed unverified.
    function _requireCallerMayProcess(uint32 timestamp) private view {
        if (authorizedRelayerCount == 0 || authorizedRelayer[msg.sender]) return;
        if (block.timestamp < uint256(timestamp) + EXCLUSIVE_WINDOW) revert Unauthorized();
    }

    /// @dev Assert the settlement's funds landed here, rather than inferring it from delivery: the
    ///      manager marks a message executed before the inbound rate limiter runs, and a queued
    ///      transfer releases nothing until someone completes it.
    function _requireReleased(uint16 sourceChain, bytes memory message, uint64 sequence)
        private
        view
    {
        INttManager manager = INttManager(transceiver.nttManager());
        bytes32 digest = keccak256(abi.encodePacked(sourceChain, message));

        if (
            !manager.isMessageExecuted(digest) ||
            manager.getInboundQueuedTransfer(digest).txTimestamp != 0
        ) {
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

    /// @notice Pin the emitter the instructions must come from.
    function setEmitter(bytes32 emitter) external onlyOwner {
        emitterAddress = emitter;
        emit EmitterUpdated(emitter);
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
