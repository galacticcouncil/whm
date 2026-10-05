// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {MessageReceiver} from "../MessageReceiver.sol";
import {IAaveOracle, IPool, IPoolAddressesProvider} from "./interfaces/IAave.sol";
import {IHollarBaseVault} from "./interfaces/IHollarBaseVault.sol";
import {PsmPayload} from "./lib/PsmPayload.sol";
import {RateLimiter} from "./lib/RateLimiter.sol";

/// @title HollarBaseVault — Base end of the Base-USDC PSM
/// @notice Holds the reserve. Locks USDC into Aave v3 and attests it to Hydration, then credits
///         and pays redemptions coming back.
///
/// @dev Two properties shape everything here. Crediting a redemption never moves money — it books
///      an IOU into a FIFO queue — so the one irreversible step (the burn on Hydration) can never
///      fail for want of liquidity on this side. And the queue has no size-based fast path: a
///      "small claims pay instantly" rule would let a drip of small claims starve a large head
///      forever, which is exactly what the queue exists to prevent.
contract HollarBaseVault is MessageReceiver, AccessControlUpgradeable, IHollarBaseVault {
    using SafeERC20 for IERC20;
    using RateLimiter for RateLimiter.Limit;

    // ─── Roles ──────────────────────────────────────────────────
    //
    // Plain AccessControl rather than AccessControlDefaultAdminRules: that extension declares an
    // `owner()` colliding with MessageReceiver's `owner` state variable, and the base is the one
    // thing this contract must inherit. DEFAULT_ADMIN_ROLE is held by a multisig, not a timelock,
    // so an upgrade takes effect as soon as it is signed — deliberate, and the reason the handover
    // step is the last thing the migration does.

    /// @notice Stops things. Never moves money out — worst case for a compromised guardian is
    ///         forgone Aave yield.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    /// @notice Sweeps surplus, bounded by the floor.
    bytes32 public constant TREASURER_ROLE = keccak256("TREASURER_ROLE");

    uint256 internal constant BPS = 10_000;
    /// @notice Fee ceiling the admin dial cannot pass. 5% would already be an emergency setting.
    uint256 internal constant MAX_FEE_BPS = 500;

    /// @notice How long a redemption must sit at the head unpaid before its origin may cancel it.
    uint256 public constant ORIGIN_CANCEL_DELAY = 1 days;

    /// @notice Deposits publish immediately — guardians sign on inclusion. See `_publish`.
    uint8 internal constant CONSISTENCY_INSTANT = 200;
    /// @notice Exits wait for finality. Wormhole reads any level but 200 and 201 as finalized; 1
    ///         is the value its SDK names `Finalized`.
    uint8 internal constant CONSISTENCY_FINALIZED = 1;

    // ─── Config ─────────────────────────────────────────────────

    IERC20 public usdc;
    IERC20 public aUsdc;
    IPoolAddressesProvider public addressesProvider;

    uint16 public hydrationChainId;
    bool public emitterFrozen;

    uint256 public redeemFeeBps;
    uint256 public surplusFloorBps;

    /// @notice Mint gate in AaveOracle's 8-dp USD base. Zero is not "off" — it is unconfigured,
    ///         and deposits refuse until it is set.
    uint256 public minUsdcPrice;

    bool public depositsPaused;
    bool public claimsPaused;

    RateLimiter.Limit internal depositLimit;

    // ─── Books ──────────────────────────────────────────────────

    /// @notice Attested to Hydration and not yet redeemed.
    uint256 public principal;

    /// @notice What the reserve must hold against the queue: the GROSS of every live credit,
    ///         fee included. Deliberately not the sum of `owed` below.
    /// @dev The fee is not earned when a credit books — the redeemer can still walk away with
    ///      `cancelQueuedRedemption` and take the gross back. Booking it as surplus on arrival
    ///      would let the treasurer sweep money the vault may have to return, so the gross stays a
    ///      liability until `_settle` actually pays, and the fee becomes surplus only then.
    uint256 public totalOwed;

    /// @notice What each recipient will receive, net of fee.
    mapping(address => uint256) public owed;


    /// @notice Claimed more than was ever attested. Parked rather than left to revert-loop a VAA
    ///         that can never be consumed. A record, not a balance: nothing here pays it out.
    /// @dev The ledgers move in lockstep, so a hit means one of three things: a Base reorg that
    ///      unwound a deposit after its mint VAA was signed (the consistency-200 residual), a
    ///      forged VAA, or an accounting bug. None has a correct automatic payout; each is an
    ///      investigation and an upgrade.
    mapping(address => uint256) public disputed;

    mapping(uint256 => Credit) public queue;
    uint256 public queueHead;
    uint256 public queueTail;

    /// @notice Credits whose recipient the reserve could not pay. Still owed, no longer queued.
    mapping(address => uint256) public unpayable;
    uint256 public totalUnpayable;

    /// @notice Set by `emergencyUnwindAave`: deposits stop re-supplying Aave until a guardian
    ///         clears it. Declared last; keep new state below.
    bool public investPaused;

    /// @notice When the entry now at the head got there. The origin's wait runs from here, not
    ///         from booking: a credit that queued behind a stall is about to be paid once it clears.
    uint64 public headSince;

    // ─── Init ───────────────────────────────────────────────────

    function initializeVault(VaultInit calldata p) external initializer {
        _initMessageReceiver(p.wormhole);
        __AccessControl_init();

        if (
            p.usdc == address(0) || p.aUsdc == address(0) || p.addressesProvider == address(0)
                || p.admin == address(0) || p.guardian == address(0) || p.treasurer == address(0)
        ) revert ZeroAddress();
        // Nothing ships fail-open: the gate is an init argument, not a later setter.
        if (p.minUsdcPrice == 0) revert OracleNotConfigured();
        // The facilitator lives on another chain than the core this contract listens to. Reading
        // the core here also proves the address is one.
        if (p.hydrationChainId == 0 || p.hydrationChainId == wormhole.chainId()) {
            revert InvalidChainId(p.hydrationChainId);
        }

        usdc = IERC20(p.usdc);
        aUsdc = IERC20(p.aUsdc);
        addressesProvider = IPoolAddressesProvider(p.addressesProvider);
        hydrationChainId = p.hydrationChainId;

        minUsdcPrice = p.minUsdcPrice;

        redeemFeeBps = 5;
        surplusFloorBps = 25;

        // Ships with deposits paused and the deposit limit closed, so the route cannot carry
        // value before governance has set its budget.
        depositsPaused = true;

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(GUARDIAN_ROLE, p.guardian);
        _grantRole(TREASURER_ROLE, p.treasurer);

        owner = address(0);
    }

    /// @dev Sealed for the same reason as the facilitator's: a fresh proxy must not be claimable.
    function initialize(address) public pure override {
        revert Disabled();
    }

    // ─── Deposit — Base to Hydration ────────────────────────────

    /// @notice Lock USDC and attest it to Hydration.
    /// @dev Charges the rate limit, books `principal`, and publishes the vault's own observed
    ///      balance delta across the transfer — never the caller's `amount` — so a token that moves
    ///      less than requested (fee-on-transfer, say) cannot mint more HOLLAR than the reserve
    ///      actually received.
    ///
    ///      The delta is trustworthy only because nothing else is supposed to move this balance
    ///      inside the bracket — and there is no reentrancy guard here, so that is an assumption,
    ///      not a guarantee. A token whose `transferFrom` calls back into a second `deposit` can
    ///      land real funds in the vault before this frame's own transfer completes, and this
    ///      frame's read would then absorb them as if they were its own. Capping the delta at
    ///      `amount` bounds that: the worst this frame can ever book is what it itself asked to
    ///      move, exactly the old caller-amount behaviour, so nesting cannot inflate the total. It
    ///      does not stop a single deposit from *under*-crediting when it is genuinely short (that
    ///      case is the fee-on-transfer one this delta exists to handle). A zero delta reverts with
    ///      `ZeroAmount`; a token that leaves the vault's balance *lower* than before the transfer
    ///      underflows the subtraction and reverts on its own (`Panic(0x11)`), uncaught and
    ///      unnamed — there is no scenario in between. `safeTransferFrom` itself still requests
    ///      `amount`.
    /// @param recipient The H160 to credit on Hydration, left-padded. Rejected here if it is not
    ///        one, while the depositor still holds their money — the far side has no way to
    ///        return it.
    function deposit(uint256 amount, bytes32 recipient) external payable returns (uint64 sequence) {
        if (depositsPaused) revert DepositsPaused();

        PsmPayload.toAddress(recipient);
        _checkOracle();

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - balanceBefore;
        // Cap rather than trust the raw delta: a reentrant token could otherwise let this frame's
        // read absorb funds a nested deposit already booked. This bounds the worst case at
        // `amount`, exactly what the pre-delta code always used.
        if (received > amount) received = amount;
        if (received == 0) revert ZeroAmount();

        depositLimit.consume(received);
        principal += received;

        _investBestEffort();

        sequence =
            _publish(PsmPayload.KIND_MINT, recipient, received, PsmPayload.fromAddress(msg.sender), CONSISTENCY_INSTANT);

        emit Deposited(msg.sender, recipient, received, sequence);
    }

    // ─── Credit — Hydration to Base ─────────────────────────────

    /// @dev Books only. No token ever moves in this path, so a credit cannot fail for want of
    ///      liquidity — the HOLLAR is already burned and there is no way to give it back.
    function _processMessage(IWormhole.VM memory vm) internal override {
        // See the facilitator's counterpart: the inherited emitter check treats the mapping default
        // as a valid key, so a zero-emitter VAA passes on any chain nobody bound — this one
        // included until `setHydrationEmitter` runs. Refusing everything before the bind and
        // pinning the chain after it closes both without changing the shared base.
        if (!emitterFrozen) revert EmitterNotSet();
        if (vm.emitterChainId != hydrationChainId) revert UnexpectedEmitterChain(vm.emitterChainId);

        (uint8 kind, bytes32 rawRecipient, uint256 amount, bytes32 rawOrigin) = PsmPayload.decode(vm.payload);
        if (kind != PsmPayload.KIND_REDEEM && kind != PsmPayload.KIND_REFUND) revert UnexpectedKind(kind);
        if (amount == 0) revert ZeroAmount();

        address recipient = PsmPayload.toAddress(rawRecipient);
        address origin = PsmPayload.toAddress(rawOrigin);

        // More claimed than was ever attested: the books disagree with the far side, which is an
        // incident, not a payment. Park it rather than revert, so the VAA is consumed once and
        // cannot be replayed at us.
        if (amount > principal) {
            disputed[recipient] += amount;
            emit Disputed(recipient, amount, principal);
            return;
        }

        // A redemption carries the most its redeemer will pay. The fee is assessed here, not at
        // the burn, so above that limit nothing is booked and the HOLLAR goes back.
        if (kind == PsmPayload.KIND_REDEEM) {
            uint16 cap = PsmPayload.feeCap(vm.payload);
            if (redeemFeeBps > cap) return _returnRedeem(recipient, origin, amount, cap);
        }

        principal -= amount;

        // A refund is a cancelled mint coming home. Nothing was minted and no service was
        // rendered, so it carries no fee.
        bool refund = kind == PsmPayload.KIND_REFUND;
        uint256 fee = refund ? 0 : (amount * redeemFeeBps) / BPS;
        uint256 credited = amount - fee;

        uint256 index = _enqueue(recipient, origin, refund, credited, amount);

        emit RedeemCredited(index, recipient, amount, fee, credited, kind);
    }

    /// @dev `principal` was never reduced, so the books already hold the HOLLAR this re-mints.
    ///      Refused while claims are paused, like every path that mints on Hydration: the delivery
    ///      reverts and the VAA lands once they are not. It publishes from a non-payable delivery,
    ///      so it holds only while the core's message fee is zero — were that to change, the
    ///      delivery reverts the same way and the VAA stays replayable. Published at finality: a
    ///      reorg that unwound this delivery would leave the redemption deliverable again while
    ///      the returned HOLLAR stood.
    function _returnRedeem(address recipient, address origin, uint256 amount, uint16 cap) private {
        if (claimsPaused) revert ClaimsPaused();

        uint64 sequence = _publish(
            PsmPayload.KIND_REMINT,
            PsmPayload.fromAddress(origin),
            amount,
            PsmPayload.fromAddress(recipient),
            CONSISTENCY_FINALIZED
        );

        emit RedeemReturned(recipient, origin, amount, redeemFeeBps, cap, sequence);
    }


    // ─── Pay ────────────────────────────────────────────────────

    /// @notice Take payment for your own credit at the head of the queue.
    /// @dev Only settles the caller at the head. Anything looser is `drain` wearing a disguise,
    ///      and then the ordering below it means nothing.
    ///
    ///      Whole-fill: a credit is paid in full or not at all. Part-paying the head would leave a
    ///      remainder in front of everyone behind it while consuming the liquidity they were
    ///      waiting on, so a steady trickle would keep the line stationary and permanently busy.
    ///      The cost is that a head larger than the reserve can release stalls the queue — which is
    ///      why the redeemer can walk away from it via `cancelQueuedRedemption`.
    function claim() external {
        if (claimsPaused) revert ClaimsPaused();

        uint256 index = queueHead;
        address head = index < queueTail ? queue[index].recipient : address(0);
        if (head != msg.sender) revert NotAtQueueHead(msg.sender, head);

        uint256 entry = queue[index].amount;
        uint256 available = _reserveLiquidity();
        if (entry > available) revert InsufficientLiquidity(entry, available);

        // A recipient the reserve cannot pay is retired by `drain`, never by their own call: a
        // revert here leaves the credit queued and `cancelQueuedRedemption` open to them, where a
        // silent retirement would have closed it.
        if (!_settle(index)) revert RecipientUnpayable(msg.sender);
    }

    /// @notice Pay the queue head-first from whatever the reserve can currently release.
    /// @dev The only path that pays a non-empty queue, and permissionless so no one depends on us
    ///      to run it. Whole-fill and strictly in order: a head the reserve cannot cover stops the
    ///      loop rather than being part-paid, and nothing behind it is reached.
    function drain(uint256 maxEntries) external returns (uint256 paid) {
        if (claimsPaused) revert ClaimsPaused();

        uint256 available = _reserveLiquidity();

        for (uint256 i = 0; i < maxEntries; i++) {
            uint256 index = queueHead;
            if (index >= queueTail) break;

            uint256 entry = queue[index].amount;
            if (entry > available) break;

            // A retired entry moved no money, so it consumes no liquidity and is not `paid`. The
            // loop still advances, which is the whole point of retiring it.
            if (_settle(index)) {
                available -= entry;
                paid += entry;
            }
        }
    }

    /// @notice Give up a queued redemption and take the HOLLAR back instead. Head only.
    /// @dev The exit from a stalled queue. Whole-fill means a head larger than the reserve can
    ///      release holds the line indefinitely, and the burn on Hydration already happened, so
    ///      without this the redeemer has no way back to either asset. Reverses the credit exactly:
    ///      `gross` returns to `principal` and the same figure is re-minted, so the corridor's
    ///      books land where they were before the redemption.
    ///
    ///      Restricted to the head, so this retires the front entry exactly as a payment does. The
    ///      restriction costs nothing: the stall it exists to escape is at the head by definition,
    ///      and everyone behind leaves in turn as the head clears.
    ///
    ///      Gated by `claimsPaused` like the payment paths: this mints HOLLAR on Hydration, and an
    ///      incident that pauses claims to stop a bad payout must also stop that queue entry from
    ///      converting into a fresh mint on the other chain.
    ///
    ///      The value goes back to `origin` whoever asks — nobody picks, not `msg.sender` and not
    ///      an argument. The `recipient` may ask at any time. The `origin` may ask only for a
    ///      redemption, and only once it has sat at the head unpaid for `ORIGIN_CANCEL_DELAY`: a
    ///      recipient that is a payment address will never call this, so the redeemer needs an
    ///      exit from a real stall — but not a way to recall a payment the queue is about to
    ///      make. A refund's origin is the deposit's recipient on Hydration, who put nothing in.
    /// @param index The queue slot, from the `RedeemCredited` event or `queueEntryOf` — cancellable
    ///        only once it is the head, i.e. once `queueEntryOf` reports `position == 0`.
    function cancelQueuedRedemption(uint256 index) external payable returns (uint64 sequence) {
        if (claimsPaused) revert ClaimsPaused();

        Credit memory credit = queue[index];
        if (credit.amount == 0) revert NotQueued(index);
        bool byOrigin = credit.recipient != msg.sender;
        if (byOrigin && (credit.origin != msg.sender || credit.refund)) {
            revert NotYourCredit(index, credit.recipient);
        }
        // Only the head ever moves. Zeroing a slot behind it would leave a hole every later
        // advance has to walk, and nothing bounds how many an attacker can leave.
        if (index != queueHead) revert CancelNotAtHead(index, queueHead);
        if (byOrigin) {
            uint256 opensAt = uint256(headSince) + ORIGIN_CANCEL_DELAY;
            if (block.timestamp < opensAt) revert OriginCancelTooEarly(index, opensAt);
        }

        return _cancel(index, credit);
    }

    /// @notice Cancel the head on the redeemer's behalf. Admin only, head only, same gate and same
    ///         books as the redeemer's own cancel, and the HOLLAR goes back to the same place: the
    ///         account that burned it.
    /// @dev The lever for a head its owner cannot or will not clear — a contract wallet, an
    ///      unreachable user.
    function cancelQueuedRedemptionFor(uint256 index)
        external
        payable
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint64 sequence)
    {
        if (claimsPaused) revert ClaimsPaused();

        Credit memory credit = queue[index];
        if (credit.amount == 0) revert NotQueued(index);
        if (index != queueHead) revert CancelNotAtHead(index, queueHead);

        return _cancel(index, credit);
    }

    /// @notice Pay out a retired credit once its recipient can receive again. Permissionless.
    /// @dev Goes only to `recipient`, so a third party calling this can hand them their money but
    ///      never redirect it. Reverts while they are still unpayable, which costs the caller gas
    ///      and nothing else.
    function claimUnpayable(address recipient) external {
        if (claimsPaused) revert ClaimsPaused();

        uint256 amount = unpayable[recipient];
        if (amount == 0) revert NothingUnpayable(recipient);

        uint256 available = _reserveLiquidity();
        if (amount > available) revert InsufficientLiquidity(amount, available);

        unpayable[recipient] = 0;
        totalUnpayable -= amount;

        _release(recipient, amount);

        emit UnpayableClaimed(recipient, amount);
    }

    // ─── Views ──────────────────────────────────────────────────

    /// @notice Assets over liabilities. Reads live aUSDC, which rebases — never cache this.
    function surplus() public view returns (uint256) {
        uint256 assets = usdc.balanceOf(address(this)) + aUsdc.balanceOf(address(this));
        // `totalUnpayable` is still owed — retiring a credit from the queue does not discharge it,
        // and leaving it out here would turn a blacklisted recipient's money into sweepable profit.
        uint256 liabilities = principal + totalOwed + totalUnpayable;
        return assets > liabilities ? assets - liabilities : 0;
    }

    /// @notice What the treasurer may take right now, after the floor.
    function sweepable() public view returns (uint256) {
        uint256 floorAmount = (principal * surplusFloorBps) / BPS;
        uint256 current = surplus();
        return current > floorAmount ? current - floorAmount : 0;
    }

    /// @notice What a recipient could actually be paid now — bounded by Aave's real liquidity,
    ///         not by our aUSDC balance, by their position in the queue, and by the pause.
    /// @dev Says nothing about whether USDC can reach them, nor whether Aave will release it: a
    ///      blacklisted head or a paused pool reads as payable here and is refused by `claim`.
    function claimable(address recipient) external view returns (uint256) {
        if (claimsPaused) return 0;

        uint256 index = queueHead;
        if (index >= queueTail || queue[index].recipient != recipient) return 0;

        // Whole-fill: below the entry's full size nothing is payable, so reporting a part would
        // promise a payout `claim` refuses.
        uint256 entry = queue[index].amount;
        return entry <= _reserveLiquidity() ? entry : 0;
    }



    function depositAllowance() external view returns (uint256) {
        return depositLimit.available();
    }

    function queueLength() external view returns (uint256) {
        return queueTail - queueHead;
    }

    function queueHeadEntry() external view returns (address recipient, uint256 amount) {
        uint256 index = queueHead;
        if (index >= queueTail) return (address(0), 0);
        return (queue[index].recipient, queue[index].amount);
    }

    /// @notice A recipient's first credit: its queue slot, and how many entries sit ahead of it.
    /// @dev `index` is what `cancelQueuedRedemption` takes, and it is cancellable only once it is
    ///      the head — `position == 0`. `position` is for display only: ordering is guaranteed, but
    ///      no liquidity is earmarked against any individual claim and timing is not promised.
    ///      Every slot between head and tail is live, so the walk is the queue's real length.
    function queueEntryOf(address recipient) external view returns (bool found, uint256 index, uint256 position) {
        for (uint256 i = queueHead; i < queueTail; i++) {
            if (queue[i].recipient == recipient) return (true, i, i - queueHead);
        }
        return (false, 0, 0);
    }


    // ─── Guardian ───────────────────────────────────────────────

    function setDepositsPaused(bool paused) external onlyRole(GUARDIAN_ROLE) {
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    /// @notice Credits still land while paused. This stops payment, not accounting.
    function setClaimsPaused(bool paused) external onlyRole(GUARDIAN_ROLE) {
        claimsPaused = paused;
        emit ClaimsPausedSet(paused);
    }

    /// @notice Pull the reserve out of Aave into this contract. Cannot send it anywhere.
    /// @dev Also stops re-supply: `_investBestEffort` sweeps the whole idle balance, so without
    ///      this the next deposit of any size would put the reserve straight back into the pool
    ///      the guardian just left.
    function emergencyUnwindAave(uint256 amount) external onlyRole(GUARDIAN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        // Aave reads `type(uint256).max` as withdraw-all, so log what moved, not what was asked.
        uint256 withdrawn = IPool(addressesProvider.getPool()).withdraw(address(usdc), amount, address(this));
        emit Unwound(withdrawn);

        if (!investPaused) {
            investPaused = true;
            emit InvestPausedSet(true);
        }
    }

    /// @notice Clear (or set) the re-supply stop. Clearing re-supplies whatever is idle at once
    ///         rather than waiting for the next deposit to do it.
    function setInvestPaused(bool paused) external onlyRole(GUARDIAN_ROLE) {
        investPaused = paused;
        emit InvestPausedSet(paused);

        if (!paused) _investBestEffort();
    }

    // ─── Treasurer ──────────────────────────────────────────────

    function sweepSurplus(uint256 amount, address to) external onlyRole(TREASURER_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        uint256 limit = sweepable();
        if (amount == 0 || amount > limit) revert SurplusBelowFloor(amount, limit);

        _release(to, amount);
        emit SurplusSwept(to, amount);
    }

    // ─── Admin ──────────────────────────────────────────────────

    function setHydrationEmitter(bytes32 emitter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (emitterFrozen) revert EmitterAlreadySet();
        if (emitter == bytes32(0)) revert ZeroAddress();

        authorizedEmitters[hydrationChainId] = emitter;
        emitterFrozen = true;

        emit HydrationEmitterSet(emitter);
    }

    function setDepositLimit(uint256 capacity, uint256 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositLimit.set(capacity, window);
        emit DepositLimitSet(capacity, window);
    }

    function setFees(uint256 _redeemFeeBps, uint256 _surplusFloorBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_redeemFeeBps > MAX_FEE_BPS) revert FeeTooHigh(_redeemFeeBps);
        // Above 100% the floor is just the treasurer locked out; past ~1e67 it overflows `sweepable`.
        if (_surplusFloorBps > BPS) revert FloorTooHigh(_surplusFloorBps);
        redeemFeeBps = _redeemFeeBps;
        surplusFloorBps = _surplusFloorBps;
        emit FeesSet(_redeemFeeBps, _surplusFloorBps);
    }


    function rescueToken(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(usdc) || token == address(aUsdc)) revert ProtectedToken(token);
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);

        emit TokenRescued(token, to, balance);
    }

    // ─── Internal ───────────────────────────────────────────────

    /// @dev Callers guarantee `amount > 0`. Returns the slot, which is what the events carry and
    ///      what `cancelQueuedRedemption` takes.
    function _enqueue(address recipient, address origin, bool refund, uint256 amount, uint256 gross)
        private
        returns (uint256 index)
    {
        index = queueTail;
        // Booked into an empty queue, it is the head from now.
        if (index == queueHead) headSince = uint64(block.timestamp);
        queue[index] = Credit({recipient: recipient, origin: origin, refund: refund, amount: amount, gross: gross});
        queueTail = index + 1;
        owed[recipient] += amount;
        totalOwed += gross;
    }

    /// @dev Reverses a credit exactly: `gross` returns to `principal` and the same figure goes
    ///      back to the credit's origin, so the corridor lands where it stood before. The message
    ///      names this credit's recipient as its own origin, so a cancel on Hydration comes back
    ///      to them — as what the value is. A redemption credit returns as KIND_REMINT, whose
    ///      cancel is a fee-charged KIND_REDEEM; a refund credit, a deposit that never minted,
    ///      returns as the KIND_MINT it was, whose cancel is a fee-free KIND_REFUND.
    function _cancel(uint256 index, Credit memory credit) private returns (uint64 sequence) {
        queue[index].amount = 0;
        queueHead = index + 1;
        headSince = uint64(block.timestamp);
        owed[credit.recipient] -= credit.amount;
        totalOwed -= credit.gross;
        principal += credit.gross;

        bytes32 hydrationRecipient = PsmPayload.fromAddress(credit.origin);

        // At finality: this sends value back with nothing new locked, so a Base reorg that
        // unwound the cancel after its message was signed would leave the credit queued AND the
        // value re-issued.
        uint8 kind = credit.refund ? PsmPayload.KIND_MINT : PsmPayload.KIND_REMINT;
        sequence = _publish(
            kind, hydrationRecipient, credit.gross, PsmPayload.fromAddress(credit.recipient), CONSISTENCY_FINALIZED
        );

        emit RedemptionCancelled(index, credit.recipient, credit.gross, hydrationRecipient, sequence);
    }

    /// @dev A recipient the reserve cannot pay must not hold the line. USDC on Base is
    ///      blacklistable, so `transfer` to a sanctioned address reverts for the sender — and with
    ///      the payment inside the same frame that advances `queueHead`, one such entry at the head
    ///      froze every claim behind it permanently, with no admin lever to clear it. The transfer
    ///      is therefore isolated: if it fails the whole entry retires into `unpayable`, still owed
    ///      and still a liability, and the queue moves on. Effects land before the call, so a
    ///      failure unwinds only the transfer.
    function _settle(uint256 index) private returns (bool) {
        address recipient = queue[index].recipient;
        uint256 amount = queue[index].amount;
        uint256 gross = queue[index].gross;

        queue[index].amount = 0;
        queueHead = index + 1;
        headSince = uint64(block.timestamp);

        owed[recipient] -= amount;
        // Releases the fee to surplus, here and only here. A credit leaves the queue by payment or
        // by retirement, and retirement is terminal — no cancel can reclaim the gross afterwards —
        // so consuming the slot is what earns the fee, delivered or not.
        totalOwed -= gross;

        // Sourcing the money is a reserve concern: if Aave will not release it, that reverts and
        // unwinds everything above, leaving the claim queued exactly where it was. Only the
        // transfer to the recipient is isolated below, because only that one is about *them*.
        _sourceIdle(amount);

        try this.payExternal(recipient, amount) {
            emit Claimed(recipient, amount);
            return true;
        } catch {
            unpayable[recipient] += amount;
            totalUnpayable += amount;

            emit CreditUnpayable(index, recipient, amount);
            return false;
        }
    }

    /// @dev Only callable by this contract, purely so `_settle` has a frame to catch. Deliberately
    ///      the transfer alone — the Aave withdrawal happens before it, outside the catch.
    function payExternal(address to, uint256 amount) external {
        if (msg.sender != address(this)) revert Disabled();
        usdc.safeTransfer(to, amount);
    }

    /// @notice Pay out, taking idle USDC first and only then withdrawing from Aave.
    function _release(address to, uint256 amount) private {
        _sourceIdle(amount);
        usdc.safeTransfer(to, amount);
    }

    /// @notice Make `amount` available as idle USDC, pulling the shortfall out of Aave.
    /// @dev Reverts if Aave cannot fill, and the IOU stands. Not consuming the credit is the
    ///      point: a failed payment must leave the claim intact.
    function _sourceIdle(uint256 amount) private {
        uint256 idle = usdc.balanceOf(address(this));
        if (idle < amount) {
            IPool(addressesProvider.getPool()).withdraw(address(usdc), amount - idle, address(this));
        }
    }

    /// @notice What the reserve could pay right now: idle USDC plus what Aave will actually release.
    /// @dev Aave's side is `getVirtualUnderlyingBalance`, which is the figure `withdraw` decrements
    ///      and underflows against — not `usdc.balanceOf(aUsdc)`. The two differ by every donation
    ///      ever made to the aToken, a gap that only grows and that anyone can widen. Overstating
    ///      here does not merely overpay: `drain` would size a payout Aave refuses and revert the
    ///      whole call, paying nobody in the exact squeeze the queue exists to survive.
    function _reserveLiquidity() private view returns (uint256) {
        uint256 idle = usdc.balanceOf(address(this));
        uint256 supplied = aUsdc.balanceOf(address(this));
        uint256 inAave = IPool(addressesProvider.getPool()).getVirtualUnderlyingBalance(address(usdc));

        uint256 withdrawable = supplied < inAave ? supplied : inAave;
        return idle + withdrawable;
    }

    function _supply(uint256 amount) private {
        address pool = addressesProvider.getPool();
        usdc.forceApprove(pool, amount);
        IPool(pool).supply(address(usdc), amount, address(this), 0);
        emit Invested(amount);
    }

    /// @dev Aave refusing must never block a deposit. The USDC is already locked and attested;
    ///      whether it earns yield is a strictly lesser concern than whether it arrives.
    function _investBestEffort() private {
        if (investPaused) return;

        uint256 idle = usdc.balanceOf(address(this));
        if (idle == 0) return;

        try this.investExternal(idle) {} catch {}
    }

    /// @dev Only callable by this contract, purely so `_investBestEffort` has a frame to catch.
    function investExternal(uint256 amount) external {
        if (msg.sender != address(this)) revert Disabled();
        _supply(amount);
    }

    /// @notice Refuse to mint against a reserve asset that is not holding its peg.
    /// @dev Fails closed on every branch. Redemption deliberately stays open when this gate shuts:
    ///      that direction reduces exposure.
    ///
    ///      The floor is the whole gate. A separate staleness check was considered and dropped: the
    ///      feed behind this price updates on deviation as well as on its 24 h heartbeat, so a real
    ///      depeg moves `getAssetPrice` and the floor catches it. Age would only have caught a feed
    ///      frozen outright, at the cost of a second oracle address in config that nothing could
    ///      validate as describing the same asset.
    function _checkOracle() private view {
        if (minUsdcPrice == 0) revert OracleNotConfigured();

        address oracle = addressesProvider.getPriceOracle();
        uint256 price = IAaveOracle(oracle).getAssetPrice(address(usdc));

        if (price == 0) revert OraclePriceInvalid(0);
        if (price < minUsdcPrice) revert UsdcBelowFloor(price, minUsdcPrice);
    }

    /// @dev The level is chosen per call site, not per kind: KIND_MINT is both a deposit and a
    ///      cancelled refund. Deposits go instant — a Base reorg after the VAA is signed leaves
    ///      that HOLLAR unbacked, bounded by the deposit limit and the bucket, an accepted
    ///      residual. Exits go finalized: they cost nothing, are not rate-limited and can be
    ///      repeated with the same funds, so at instant one holder could keep a whole position
    ///      exposed to any reorg.
    function _publish(uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin, uint8 consistency)
        private
        returns (uint64 sequence)
    {
        uint256 fee = wormhole.messageFee();
        if (msg.value < fee) revert InsufficientMessageFee(msg.value, fee);

        sequence = wormhole.publishMessage{value: fee}(
            0, PsmPayload.encode(kind, recipient, amount, origin), consistency
        );

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ─── Upgrade ────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
