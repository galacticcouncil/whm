// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {MessageReceiver} from "../MessageReceiver.sol";
import {IGhoToken} from "./interfaces/IGhoToken.sol";
import {IHollarBaseFacilitator} from "./interfaces/IHollarBaseFacilitator.sol";
import {PsmPayload} from "./lib/PsmPayload.sol";
import {RateLimiter} from "./lib/RateLimiter.sol";

/// @title HollarBaseFacilitator — Hydration end of the Base-USDC PSM
/// @notice Mints HOLLAR against USDC attested as locked on Base, and burns it to send a
///         redemption back. Registered on the HOLLAR token as an independent GHO facilitator, so
///         everything this contract can do is bounded by its own bucket.
///
/// @dev The solvency model is not in this file. `GhoToken.burn` computes `bucketLevel - amount`
///      with no floor, so redemption through this module is capped by the token's own arithmetic
///      at exactly what it has minted — a contract neither end of this corridor controls.
contract HollarBaseFacilitator is MessageReceiver, AccessControlUpgradeable, IHollarBaseFacilitator {
    using SafeERC20 for IGhoToken;
    using RateLimiter for RateLimiter.Limit;

    // ─── Roles ──────────────────────────────────────────────────
    //
    // Plain AccessControl, not AccessControlDefaultAdminRules. The latter declares an `owner()`
    // that collides irreconcilably with MessageReceiver's `owner` state variable, and the base is
    // the one thing this contract is required to inherit. DEFAULT_ADMIN_ROLE is held by the
    // technical committee directly; there is no staged handover behind it.

    /// @notice Pauses either leg. Cannot move funds and cannot mint.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    // ─── Config ─────────────────────────────────────────────────

    IGhoToken public hollar;

    /// @notice 10 ** (HOLLAR decimals - USDC decimals). Multiply only; nothing here divides.
    uint256 public scale;

    /// @notice Wormhole chain id of the vault's chain.
    uint16 public baseChainId;

    /// @notice Set once, then frozen. The highest-value key in the system is not a live setting.
    bool public emitterFrozen;

    bool public mintPaused;
    bool public redeemPaused;

    RateLimiter.Limit internal inbound;
    RateLimiter.Limit internal outbound;

    // ─── Books ──────────────────────────────────────────────────

    /// @notice One entry per attested message that could not mint on arrival, keyed by id like
    ///         BasejumpLanding's pending transfers. Never merged: a message mints whole or not at
    ///         all, so each entry keeps its own amount and its own decision.
    /// @dev Independent, not a FIFO. Ordering would only mean an entry the bucket cannot cover
    ///      holds up every smaller one behind it, and nothing here is scarce enough to ration:
    ///      no one was promised a place, and headroom returns as HOLLAR is redeemed. So each
    ///      entry stands alone — an unmintable one reverts its own flush and blocks nobody.
    uint256 public pendingTail;
    mapping(uint256 => PendingMint) public pendingMints;

    /// @notice Attested but not yet minted, in USDC units — the per-recipient and corridor-wide
    ///         totals over the live entries above.
    mapping(address => uint256) public pendingOf;
    uint256 public totalPendingMint;

    // ─── Init ───────────────────────────────────────────────────

    function initializeFacilitator(
        address _wormhole,
        address _hollar,
        uint8 usdcDecimals,
        uint16 _baseChainId,
        address admin,
        address guardian
    ) external initializer {
        _initMessageReceiver(_wormhole);
        __AccessControl_init();

        if (_hollar == address(0) || admin == address(0) || guardian == address(0)) revert ZeroAddress();

        hollar = IGhoToken(_hollar);

        uint8 hollarDecimals = hollar.decimals();
        if (hollarDecimals < usdcDecimals) revert IncorrectDecimals();
        scale = 10 ** uint256(hollarDecimals - usdcDecimals);

        baseChainId = _baseChainId;

        // Ships paused. The deployment order unpauses redeem first, then mint, once the bucket
        // is granted and the invariant has been watched.
        mintPaused = true;
        redeemPaused = true;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);

        // The inherited owner is a single key that could upgrade this contract and rebind the
        // emitter. Retiring it here leaves roles as the only authority; `setOwner` and
        // `setAuthorizedEmitter` become permanently uncallable, which is the intent.
        owner = address(0);
    }

    /// @dev The inherited single-argument initializer would take ownership of a fresh proxy, so
    ///      it is sealed and the real one carries a distinct name.
    function initialize(address) public pure override {
        revert Disabled();
    }

    // ─── Mint — Base to Hydration ───────────────────────────────

    /// @dev Once the VAA verifies, this must not revert on anything the far side controls: a
    ///      revert here strands a deposit that has already been locked on Base. Paused, full and
    ///      rate-limited all queue instead. It does still revert on a payload the vault could not
    ///      have produced — a wrong kind or an unusable recipient — because there is no account to
    ///      credit and leaving the VAA unconsumed keeps it replayable if that is ever fixed.
    function _processMessage(IWormhole.VM memory vm) internal override {
        // The inherited emitter check compares against `authorizedEmitters[chain]`, which is
        // bytes32(0) for every chain nobody bound — so a VAA carrying a zero emitter matches the
        // mapping default and passes on any unbound chain. `setBaseEmitter` binds one chain and
        // refuses zero, so pinning the chain here closes it without touching the shared base.
        if (vm.emitterChainId != baseChainId) revert UnexpectedEmitterChain(vm.emitterChainId);

        (uint8 kind, bytes32 rawRecipient, uint256 usdcAmount) = PsmPayload.decode(vm.payload);
        if (kind != PsmPayload.KIND_MINT) revert UnexpectedKind(kind);

        address recipient = PsmPayload.toAddress(rawRecipient);

        if (mintPaused) return _queue(recipient, usdcAmount, QueueReason.MintPaused);

        uint256 hollarAmount = usdcAmount * scale;
        if (hollarAmount > _bucketHeadroom()) return _queue(recipient, usdcAmount, QueueReason.BucketFull);
        if (!inbound.tryConsume(usdcAmount)) return _queue(recipient, usdcAmount, QueueReason.RateLimited);

        hollar.mint(recipient, hollarAmount);
        emit Minted(recipient, usdcAmount, hollarAmount);
    }

    /// @notice Mint one queued entry once the reason it queued has cleared. Permissionless — the
    ///         mint goes to that entry's own recipient, so a third party can only hand them what
    ///         they were already owed.
    /// @dev Whole-fill: the entry mints in full or reverts. Minting part of it would answer one
    ///      attested message with several mints, and the amount left behind would no longer be a
    ///      message waiting — just arithmetic.
    ///
    ///      Entries are independent, so an amount the bucket cannot cover reverts here and stops
    ///      nothing else: smaller entries behind it flush normally. Its recipient waits for
    ///      governance to raise the bucket, or leaves via `cancelPendingMint`.
    /// @param id The queue slot, from the `MintQueued` event or `pendingEntryOf`.
    function flushPendingMint(uint256 id) external {
        if (mintPaused) revert MintPausedError();

        PendingMint memory entry = pendingMints[id];
        if (entry.amount == 0) revert NotQueued(id);

        uint256 hollarAmount = entry.amount * scale;
        uint256 headroom = _bucketHeadroom();
        if (hollarAmount > headroom) revert ExceedsBucketLevel(hollarAmount, headroom);
        inbound.consume(entry.amount);

        delete pendingMints[id];

        pendingOf[entry.recipient] -= entry.amount;
        totalPendingMint -= entry.amount;

        hollar.mint(entry.recipient, hollarAmount);

        emit Minted(entry.recipient, entry.amount, hollarAmount);
        emit PendingMintFlushed(id, entry.recipient, entry.amount);
    }

    /// @notice Give up on a queued mint and take the USDC back on Base instead.
    /// @dev Nothing was minted, so there is nothing to burn and the bucket does not move. This is
    ///      the exit from "queued forever" — without it, a mint queued behind a capacity that
    ///      governance never raises has no path back to the depositor's money.
    /// @param id The queue slot, from the `MintQueued` event or `pendingEntryOf`.
    function cancelPendingMint(uint256 id, bytes32 baseRecipient) external payable returns (uint64 sequence) {
        PendingMint memory entry = pendingMints[id];
        if (entry.amount == 0) revert NotQueued(id);
        if (entry.recipient != msg.sender) revert NotYourPendingMint(id, entry.recipient);

        // Validated here, where the caller can still pick a different one.
        PsmPayload.toAddress(baseRecipient);

        delete pendingMints[id];
        pendingOf[msg.sender] -= entry.amount;
        totalPendingMint -= entry.amount;

        sequence = _publish(PsmPayload.KIND_REFUND, baseRecipient, entry.amount);

        emit PendingMintCancelled(id, msg.sender, entry.amount, baseRecipient, sequence);
    }

    // ─── Redeem — Hydration to Base ─────────────────────────────

    /// @notice Burn HOLLAR and attest a redemption to Base.
    /// @param usdcAmount Denominated in USDC units, so the burn is an exact multiple of `scale`
    ///        and no fractional remainder can strand here.
    /// @param baseRecipient Who receives the USDC on Base.
    function redeem(uint256 usdcAmount, address baseRecipient) external payable returns (uint64 sequence) {
        if (redeemPaused) revert RedeemPaused();
        if (baseRecipient == address(0)) revert ZeroAddress();

        uint256 hollarAmount = usdcAmount * scale;

        // The token would underflow-revert on its own; this is the same refusal with a name.
        (, uint256 level) = hollar.getFacilitatorBucket(address(this));
        if (hollarAmount > level) revert ExceedsBucketLevel(hollarAmount, level);

        outbound.consume(usdcAmount);

        hollar.safeTransferFrom(msg.sender, address(this), hollarAmount);
        hollar.burn(hollarAmount);

        sequence = _publish(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(baseRecipient), usdcAmount);

        emit RedeemInitiated(msg.sender, baseRecipient, usdcAmount, sequence);
    }

    // ─── Views ──────────────────────────────────────────────────

    /// @notice The most that can be redeemed right now, in USDC units. The UI must show this
    ///         before anyone burns.
    function maxRedeemable() external view returns (uint256) {
        (, uint256 level) = hollar.getFacilitatorBucket(address(this));
        uint256 byBucket = level / scale;
        uint256 byLimit = outbound.available();
        return byBucket < byLimit ? byBucket : byLimit;
    }

    /// @notice Room for new mints in USDC units, net of what is already queued.
    function mintHeadroom() external view returns (uint256) {
        uint256 byBucket = _bucketHeadroom() / scale;
        uint256 byLimit = inbound.available();
        uint256 room = byBucket < byLimit ? byBucket : byLimit;
        uint256 pending = totalPendingMint;
        return room > pending ? room - pending : 0;
    }

    /// @notice Bucket level — the right-hand side of the cross-chain invariant.
    function outstanding() external view returns (uint256) {
        (, uint256 level) = hollar.getFacilitatorBucket(address(this));
        return level;
    }

    /// @notice A recipient's first live entry. `id` is what `flushPendingMint` and
    ///         `cancelPendingMint` take; `MintQueued` carries the same figure.
    /// @dev No position is reported because there is no line to hold a place in — a recipient
    ///      with several entries can flush any of them, in any order, as headroom allows.
    function pendingEntryOf(address recipient) external view returns (bool found, uint256 id) {
        for (uint256 i = 0; i < pendingTail; i++) {
            if (pendingMints[i].amount != 0 && pendingMints[i].recipient == recipient) return (true, i);
        }
        return (false, 0);
    }

    function limits()
        external
        view
        returns (uint256 inboundCapacity, uint256 inboundAvailable, uint256 outboundCapacity, uint256 outboundAvailable)
    {
        return (inbound.capacity, inbound.available(), outbound.capacity, outbound.available());
    }


    // ─── Guardian ───────────────────────────────────────────────

    /// @dev Pausing mint strands nothing: attestations still land and queue.
    function setPaused(bool _mintPaused, bool _redeemPaused) external onlyRole(GUARDIAN_ROLE) {
        mintPaused = _mintPaused;
        redeemPaused = _redeemPaused;
        emit PausedSet(_mintPaused, _redeemPaused);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setBaseEmitter(bytes32 emitter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (emitterFrozen) revert EmitterAlreadySet();
        if (emitter == bytes32(0)) revert ZeroAddress();

        authorizedEmitters[baseChainId] = emitter;
        emitterFrozen = true;

        emit BaseEmitterSet(emitter);
    }

    function setLimits(uint256 inboundCapacity, uint256 outboundCapacity, uint256 window)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        inbound.set(inboundCapacity, window);
        outbound.set(outboundCapacity, window);
        emit LimitsSet(inboundCapacity, outboundCapacity, window);
    }


    // ─── Internal ───────────────────────────────────────────────

    function _queue(address recipient, uint256 usdcAmount, QueueReason reason) private {
        uint256 id = pendingTail++;
        pendingMints[id] = PendingMint({recipient: recipient, amount: usdcAmount});

        pendingOf[recipient] += usdcAmount;
        totalPendingMint += usdcAmount;

        emit MintQueued(id, recipient, usdcAmount, reason);
    }

    function _bucketHeadroom() private view returns (uint256) {
        (uint256 capacity, uint256 level) = hollar.getFacilitatorBucket(address(this));
        return capacity > level ? capacity - level : 0;
    }

    /// @dev Consistency 200 — the guardians sign on inclusion and the leg settles in seconds. The
    ///      redeem leg carries no cap: its reorg exposure is one Hydration block wide and falls on
    ///      the protocol, not on holders.
    function _publish(uint8 kind, bytes32 recipient, uint256 amount) private returns (uint64 sequence) {
        uint256 fee = wormhole.messageFee();
        if (msg.value < fee) revert InsufficientMessageFee(msg.value, fee);

        sequence = wormhole.publishMessage{value: fee}(0, PsmPayload.encode(kind, recipient, amount), 200);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ─── Upgrade ────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
