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

    /// @notice Everything this contract publishes waits for finality. Wormhole reads any level but
    ///         200 and 201 as finalized; 1 is the value its SDK names `Finalized`.
    uint8 internal constant CONSISTENCY_FINALIZED = 1;

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

    /// @dev Each refills the other — a mint gives outbound back, a burn gives inbound back — so the
    ///      pair meters net flow. A cancelled pending mint touches neither: it never minted, and a
    ///      re-mint's value already burned under outbound.
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

    /// @notice Messages consumed, by sequence and payload. The inherited guard keys on the VAA
    ///         hash, which also covers the envelope timestamp, so a message re-included after a
    ///         reorg is signed again under a new hash; this is what refuses that copy.
    mapping(bytes32 => bool) public processedMessages;

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

        // Zero USDC decimals would make `scale` 1e18 and every wire unit a whole HOLLAR.
        uint8 hollarDecimals = hollar.decimals();
        if (usdcDecimals == 0 || hollarDecimals < usdcDecimals) revert IncorrectDecimals();
        scale = 10 ** uint256(hollarDecimals - usdcDecimals);

        // The vault lives on another chain than the core this contract listens to. Reading the
        // core here also proves the address is one.
        if (_baseChainId == 0 || _baseChainId == wormhole.chainId()) revert InvalidChainId(_baseChainId);
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
        // mapping default on any unbound chain, this one included until `setBaseEmitter` runs.
        // Refusing everything before the bind and pinning the chain after it closes both without
        // touching the shared base.
        if (!emitterFrozen) revert EmitterNotSet();
        if (vm.emitterChainId != baseChainId) revert UnexpectedEmitterChain(vm.emitterChainId);
        _consume(vm);

        (uint8 kind, bytes32 rawRecipient, uint256 usdcAmount, bytes32 rawOrigin) = PsmPayload.decode(vm.payload);
        if (kind != PsmPayload.KIND_MINT && kind != PsmPayload.KIND_REMINT) revert UnexpectedKind(kind);
        // The vault never publishes a zero amount; refused like any payload it could not have
        // produced, so it cannot leave a dead entry in the queue.
        if (usdcAmount == 0) revert ZeroAmount();

        address recipient = PsmPayload.toAddress(rawRecipient);
        address origin = PsmPayload.toAddress(rawOrigin);
        bool remint = kind == PsmPayload.KIND_REMINT;

        if (mintPaused) return _queue(recipient, origin, usdcAmount, remint, QueueReason.MintPaused);

        uint256 hollarAmount = usdcAmount * scale;
        if (hollarAmount > _bucketHeadroom()) {
            return _queue(recipient, origin, usdcAmount, remint, QueueReason.BucketFull);
        }
        if (!inbound.tryConsume(usdcAmount)) {
            return _queue(recipient, origin, usdcAmount, remint, QueueReason.RateLimited);
        }
        outbound.refill(usdcAmount);

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
        outbound.refill(entry.amount);

        delete pendingMints[id];

        pendingOf[entry.recipient] -= entry.amount;
        totalPendingMint -= entry.amount;

        hollar.mint(entry.recipient, hollarAmount);

        emit Minted(entry.recipient, entry.amount, hollarAmount);
        emit PendingMintFlushed(id, entry.recipient, entry.amount);
    }

    /// @notice Give up on a queued mint and send the USDC back on Base instead. A queued deposit
    ///         refunds fee-free; a queued re-mint goes back as a redemption and pays the fee.
    /// @dev Nothing was minted, so there is nothing to burn and the bucket does not move. This is
    ///      the exit from "queued forever" — without it, a mint queued behind a capacity that
    ///      governance never raises has no path back to the depositor's money. Gated by neither
    ///      pause: the exit stays open exactly when entries queue, and the credit it books on
    ///      Base still waits behind the vault's own claims pause.
    ///
    ///      The USDC goes back to the entry's `origin`. Nobody picks: not `msg.sender`, whose
    ///      Hydration address may not exist on Base, and not an argument, which the far side
    ///      could not return if it named nobody.
    /// @param id The queue slot, from the `MintQueued` event or `pendingEntryOf`.
    /// @param maxFeeBps Read only when the entry is a re-mint: the fee limit its redemption carries.
    function cancelPendingMint(uint256 id, uint16 maxFeeBps) external payable returns (uint64 sequence) {
        PendingMint memory entry = pendingMints[id];
        if (entry.amount == 0) revert NotQueued(id);
        if (entry.recipient != msg.sender) revert NotYourPendingMint(id, entry.recipient);

        return _cancelPending(id, entry, maxFeeBps);
    }

    /// @notice Cancel a queued mint on the recipient's behalf. Admin only, same books as the
    ///         recipient's own cancel, and the USDC goes back to the same place: the account that
    ///         locked it.
    /// @dev The lever for an entry its owner cannot clear — a contract wallet, an unreachable user.
    function cancelPendingMintFor(uint256 id, uint16 maxFeeBps)
        external
        payable
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint64 sequence)
    {
        PendingMint memory entry = pendingMints[id];
        if (entry.amount == 0) revert NotQueued(id);

        return _cancelPending(id, entry, maxFeeBps);
    }

    // ─── Redeem — Hydration to Base ─────────────────────────────

    /// @notice Burn HOLLAR and attest a redemption to Base.
    /// @param usdcAmount Denominated in USDC units, so the burn is an exact multiple of `scale`
    ///        and no fractional remainder can strand here.
    /// @param baseRecipient Who receives the USDC on Base.
    /// @param maxFeeBps The most the redeemer will pay. The fee is assessed on Base when the
    ///        message lands; above this the vault books nothing and the HOLLAR is re-minted to the
    ///        caller. `PsmPayload.NO_FEE_CAP` sets no limit.
    function redeem(uint256 usdcAmount, address baseRecipient, uint16 maxFeeBps)
        external
        payable
        returns (uint64 sequence)
    {
        if (redeemPaused) revert RedeemPaused();
        if (baseRecipient == address(0)) revert ZeroAddress();

        uint256 hollarAmount = usdcAmount * scale;

        // The token would underflow-revert on its own; this is the same refusal with a name.
        (, uint256 level) = hollar.getFacilitatorBucket(address(this));
        if (hollarAmount > level) revert ExceedsBucketLevel(hollarAmount, level);

        outbound.consume(usdcAmount);
        inbound.refill(usdcAmount);

        hollar.safeTransferFrom(msg.sender, address(this), hollarAmount);
        hollar.burn(hollarAmount);

        sequence = _publish(
            PsmPayload.KIND_REDEEM,
            PsmPayload.fromAddress(baseRecipient),
            usdcAmount,
            PsmPayload.fromAddress(msg.sender),
            maxFeeBps
        );

        emit RedeemInitiated(msg.sender, baseRecipient, usdcAmount, sequence);
    }

    // ─── Views ──────────────────────────────────────────────────

    /// @notice The most that can be redeemed right now, in USDC units. The UI must show this
    ///         before anyone burns, so it reports zero while redeem is paused.
    function maxRedeemable() external view returns (uint256) {
        if (redeemPaused) return 0;

        (, uint256 level) = hollar.getFacilitatorBucket(address(this));
        uint256 byBucket = level / scale;
        uint256 byLimit = outbound.available();
        return byBucket < byLimit ? byBucket : byLimit;
    }

    /// @notice Room for new mints in USDC units, net of what is already queued. Zero while mint
    ///         is paused: an arriving attestation queues, whatever the bucket says.
    function mintHeadroom() external view returns (uint256) {
        if (mintPaused) return 0;

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

    /// @notice A recipient's first live entry with an id in `[fromId, fromId + maxIds)`. `id` is
    ///         what `flushPendingMint` and `cancelPendingMint` take; `MintQueued` carries it too.
    /// @dev Caller-bounded because ids are never reclaimed: `pendingTail` only grows, so a walk
    ///      from zero would cost ~2.4k gas per retired id, forever. No position: there is no line.
    function pendingEntryOf(address recipient, uint256 fromId, uint256 maxIds)
        external
        view
        returns (bool found, uint256 id)
    {
        uint256 tail = pendingTail;
        if (fromId >= tail) return (false, 0);

        uint256 end = tail - fromId > maxIds ? fromId + maxIds : tail;
        for (uint256 i = fromId; i < end; i++) {
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

    /// @dev Keyed on the payload as well as the sequence: a reorg that reorders two messages swaps
    ///      their sequences, and a key on the sequence alone would refuse the honest one.
    function _consume(IWormhole.VM memory vm) private {
        bytes32 id = keccak256(abi.encode(vm.sequence, keccak256(vm.payload)));
        if (processedMessages[id]) revert MessageAlreadyProcessed(vm.sequence);
        processedMessages[id] = true;
    }

    function _queue(address recipient, address origin, uint256 usdcAmount, bool remint, QueueReason reason)
        private
    {
        uint256 id = pendingTail++;
        pendingMints[id] = PendingMint({recipient: recipient, origin: origin, remint: remint, amount: usdcAmount});

        pendingOf[recipient] += usdcAmount;
        totalPendingMint += usdcAmount;

        emit MintQueued(id, recipient, usdcAmount, reason);
    }

    /// @dev Nothing was minted, so nothing is burned and the bucket does not move. The message is
    ///      addressed to the entry's origin and names its recipient as origin in turn, so a
    ///      cancellation of the resulting credit on Base re-mints back to them. A cancelled
    ///      re-mint is burned HOLLAR leaving as USDC — a redemption however it got here — so it
    ///      goes back as KIND_REDEEM and pays the fee; only a cancelled deposit refunds fee-free.
    function _cancelPending(uint256 id, PendingMint memory entry, uint16 maxFeeBps)
        private
        returns (uint64 sequence)
    {
        delete pendingMints[id];
        pendingOf[entry.recipient] -= entry.amount;
        totalPendingMint -= entry.amount;

        bytes32 baseRecipient = PsmPayload.fromAddress(entry.origin);
        uint8 kind = entry.remint ? PsmPayload.KIND_REDEEM : PsmPayload.KIND_REFUND;

        sequence = _publish(kind, baseRecipient, entry.amount, PsmPayload.fromAddress(entry.recipient), maxFeeBps);

        emit PendingMintCancelled(id, entry.recipient, entry.amount, baseRecipient, kind, sequence);
    }

    function _bucketHeadroom() private view returns (uint256) {
        (uint256 capacity, uint256 level) = hollar.getFacilitatorBucket(address(this));
        return capacity > level ? capacity - level : 0;
    }

    /// @dev Finalized throughout, at under a minute on Hydration. A redeem signed before its block
    ///      finalized could be reorged out while its credit stood; a cancelled pending mint sends
    ///      value out with nothing new burned, so a reorg after signing would pay twice.
    function _publish(uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin, uint16 maxFeeBps)
        private
        returns (uint64 sequence)
    {
        uint256 fee = wormhole.messageFee();
        if (msg.value < fee) revert InsufficientMessageFee(msg.value, fee);

        sequence = wormhole.publishMessage{value: fee}(
            0, PsmPayload.encode(kind, recipient, amount, origin, maxFeeBps), CONSISTENCY_FINALIZED
        );

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ─── Upgrade ────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
