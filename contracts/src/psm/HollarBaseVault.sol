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

    /// @notice Publish immediately — guardians sign on inclusion. The only level this route can
    ///         use, so every message from this contract carries it. See `_publish`.
    uint8 internal constant CONSISTENCY_INSTANT = 200;

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


    /// @notice Claimed more than was ever attested. Parked for governance rather than left to
    ///         revert-loop a VAA that can never be consumed.
    mapping(address => uint256) public disputed;

    mapping(uint256 => Credit) public queue;
    uint256 public queueHead;
    uint256 public queueTail;

    /// @notice Credits whose recipient the reserve could not pay. Still owed, no longer queued.
    mapping(address => uint256) public unpayable;
    uint256 public totalUnpayable;

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
    /// @param recipient The H160 to credit on Hydration, left-padded. Rejected here if it is not
    ///        one, while the depositor still holds their money — the far side has no way to
    ///        return it.
    function deposit(uint256 amount, bytes32 recipient) external payable returns (uint64 sequence) {
        if (depositsPaused) revert DepositsPaused();

        PsmPayload.toAddress(recipient);
        _checkOracle();

        depositLimit.consume(amount);

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        principal += amount;

        _investBestEffort();

        sequence = _publish(PsmPayload.KIND_MINT, recipient, amount);

        emit Deposited(msg.sender, recipient, amount, sequence);
    }

    // ─── Credit — Hydration to Base ─────────────────────────────

    /// @dev Books only. No token ever moves in this path, so a credit cannot fail for want of
    ///      liquidity — the HOLLAR is already burned and there is no way to give it back.
    function _processMessage(IWormhole.VM memory vm) internal override {
        // See the facilitator's counterpart: the inherited emitter check treats the mapping default
        // as a valid key, so a zero-emitter VAA passes on any chain nobody bound. Pinning the chain
        // here closes it without changing the shared base.
        if (vm.emitterChainId != hydrationChainId) revert UnexpectedEmitterChain(vm.emitterChainId);

        (uint8 kind, bytes32 rawRecipient, uint256 amount) = PsmPayload.decode(vm.payload);
        if (kind != PsmPayload.KIND_REDEEM && kind != PsmPayload.KIND_REFUND) revert UnexpectedKind(kind);

        address recipient = PsmPayload.toAddress(rawRecipient);

        // More claimed than was ever attested: the books disagree with the far side, which is an
        // incident, not a payment. Park it rather than revert, so the VAA is consumed once and
        // cannot be replayed at us.
        if (amount > principal) {
            disputed[recipient] += amount;
            emit Disputed(recipient, amount, principal);
            return;
        }

        principal -= amount;

        // A refund is a cancelled mint coming home. Nothing was minted and no service was
        // rendered, so it carries no fee.
        uint256 fee = kind == PsmPayload.KIND_REDEEM ? (amount * redeemFeeBps) / BPS : 0;
        uint256 credited = amount - fee;

        _enqueue(recipient, credited, amount);

        emit RedeemCredited(recipient, amount, fee, credited, kind);
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
        _advanceHead();

        (bool found, uint256 index) = _liveHead();
        address head = found ? queue[index].recipient : address(0);
        if (head != msg.sender) revert NotAtQueueHead(msg.sender, head);

        uint256 entry = queue[index].amount;
        uint256 available = _reserveLiquidity();
        if (entry > available) revert InsufficientLiquidity(entry, available);

        _settle(index);
    }

    /// @notice Pay the queue head-first from whatever the reserve can currently release.
    /// @dev The only path that pays a non-empty queue, and permissionless so no one depends on us
    ///      to run it. Whole-fill and strictly in order: a head the reserve cannot cover stops the
    ///      loop rather than being part-paid, and nothing behind it is reached.
    function drain(uint256 maxEntries) external returns (uint256 paid) {
        if (claimsPaused) revert ClaimsPaused();

        _advanceHead();

        uint256 available = _reserveLiquidity();

        for (uint256 i = 0; i < maxEntries; i++) {
            (bool found, uint256 index) = _liveHead();
            if (!found) break;

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

    /// @notice Give up a queued redemption and take the HOLLAR back instead.
    /// @dev The exit from a stalled queue. Whole-fill means a head larger than the reserve can
    ///      release holds the line indefinitely, and the burn on Hydration already happened, so
    ///      without this the redeemer has no way back to either asset. Reverses the credit exactly:
    ///      `gross` returns to `principal` and the same figure is re-minted, so the corridor's
    ///      books land where they were before the redemption.
    /// @param index The queue slot, from the `RedeemCredited` event or `queueIndexOf`.
    function cancelQueuedRedemption(uint256 index) external payable returns (uint64 sequence) {
        Credit memory credit = queue[index];
        if (credit.amount == 0) revert NotQueued(index);
        if (credit.recipient != msg.sender) revert NotYourCredit(index, credit.recipient);

        queue[index].amount = 0;
        owed[msg.sender] -= credit.amount;
        totalOwed -= credit.gross;
        principal += credit.gross;

        _advanceHead();

        // Publishes instant like everything else here, which is the residual this route carries:
        // this mints HOLLAR without locking anything new, so a Base reorg that unwound the
        // cancellation while the message stood would leave the credit queued AND the HOLLAR
        // reissued. Bounded by the deposit rate limit and the bucket, nothing narrower.
        sequence = _publish(PsmPayload.KIND_MINT, PsmPayload.fromAddress(msg.sender), credit.gross);

        emit RedemptionCancelled(index, msg.sender, credit.gross, sequence);
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
    ///         not by our aUSDC balance, and by their position in the queue.
    function claimable(address recipient) external view returns (uint256) {
        (bool found, uint256 index) = _liveHead();
        if (!found || queue[index].recipient != recipient) return 0;

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
        (bool found, uint256 index) = _liveHead();
        if (!found) return (address(0), 0);
        return (queue[index].recipient, queue[index].amount);
    }

    /// @notice A recipient's first live credit: its queue slot, and how many live entries sit
    ///         ahead of it. One scan, because both callers want the same walk.
    /// @dev `index` is what `cancelQueuedRedemption` takes. `position` is for display only — it is
    ///      not a payment date: ordering is guaranteed, but no liquidity is earmarked against any
    ///      individual claim and timing is not promised.
    function queueEntryOf(address recipient) external view returns (bool found, uint256 index, uint256 position) {
        uint256 seen;
        for (uint256 i = queueHead; i < queueTail; i++) {
            if (queue[i].amount == 0) continue;
            if (queue[i].recipient == recipient) return (true, i, seen);
            seen++;
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
    function emergencyUnwindAave(uint256 amount) external onlyRole(GUARDIAN_ROLE) {
        if (amount == 0) revert ZeroAmount();
        IPool(addressesProvider.getPool()).withdraw(address(usdc), amount, address(this));
        emit Unwound(amount);
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
        redeemFeeBps = _redeemFeeBps;
        surplusFloorBps = _surplusFloorBps;
        emit FeesSet(_redeemFeeBps, _surplusFloorBps);
    }



    /// @notice Settle a parked over-claim, either by paying it or by writing it off.
    function resolveDisputed(address recipient, uint256 amount, bool credited) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 parked = disputed[recipient];
        if (amount == 0 || amount > parked) revert NotDisputed(recipient, amount, parked);

        disputed[recipient] = parked - amount;
        if (credited) _enqueue(recipient, amount, amount);

        emit DisputeResolved(recipient, amount, credited);
    }

    function rescueToken(address token, address to) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(usdc) || token == address(aUsdc)) revert ProtectedToken(token);
        if (to == address(0)) revert ZeroAddress();

        uint256 balance = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransfer(to, balance);

        emit TokenRescued(token, to, balance);
    }

    // ─── Internal ───────────────────────────────────────────────

    function _enqueue(address recipient, uint256 amount, uint256 gross) private {
        if (amount == 0) return;
        queue[queueTail] = Credit({recipient: recipient, amount: amount, gross: gross});
        queueTail++;
        owed[recipient] += amount;
        totalOwed += gross;
    }

    /// @dev Step over entries that are no longer live — paid, retired or cancelled. Each is skipped
    ///      exactly once and the head stays put afterwards, so a queue full of cancellations does
    ///      not make every later `claim` re-walk them.
    function _advanceHead() private {
        uint256 head = queueHead;
        while (head < queueTail && queue[head].amount == 0) head++;
        queueHead = head;
    }

    /// @dev First entry still owed, scanning past those already paid, retired or cancelled.
    ///      Read-only — `_advanceHead` is what moves the head.
    function _liveHead() private view returns (bool found, uint256 index) {
        for (uint256 i = queueHead; i < queueTail; i++) {
            if (queue[i].amount != 0) return (true, i);
        }
        return (false, 0);
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

        owed[recipient] -= amount;
        // Releases the fee to surplus, here and only here: delivery is what earns it.
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

    /// @dev Always consistency 200. The guardians sign on inclusion, and it is the only level this
    ///      route supports — 201/202 are not an option here, so there is no slower path to buy
    ///      certainty with. The consequence is recorded rather than hidden: a Base reorg landing
    ///      after a VAA is signed leaves that HOLLAR unbacked, bounded only by the deposit rate
    ///      limit and the facilitator's bucket.
    function _publish(uint8 kind, bytes32 recipient, uint256 amount) private returns (uint64 sequence) {
        uint256 fee = wormhole.messageFee();
        if (msg.value < fee) revert InsufficientMessageFee(msg.value, fee);

        sequence =
            wormhole.publishMessage{value: fee}(0, PsmPayload.encode(kind, recipient, amount), CONSISTENCY_INSTANT);

        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    // ─── Upgrade ────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
