// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {HollarBaseFacilitator} from "../../../src/psm/HollarBaseFacilitator.sol";
import {IHollarBaseFacilitator} from "../../../src/psm/interfaces/IHollarBaseFacilitator.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {HollarPermit, MockGho, MockWormholeCore, VaaBuilder} from "../mocks/PsmMocks.sol";

/// @title redeemWithPermit — `redeem` with the approve folded into a signature
/// @notice One signed permit and one call must do exactly what approve + redeem does, and a permit
///         that does not apply must stop the call before anything moves.
contract RedeemWithPermitTest is Test, IHollarBaseFacilitator {
    HollarBaseFacilitator internal facilitator;
    MockGho internal hollar;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant BASE_EMITTER = bytes32(uint256(0xbaa5e));
    uint256 internal constant SCALE = 1e12;
    uint256 internal constant CAPACITY = 10_000e18;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal bob = makeAddr("bob");
    address internal eve = makeAddr("eve");
    address internal alice;
    uint256 internal aliceKey;
    uint256 internal bobKey;

    uint64 internal deadline;
    bytes32 internal constant REF = keccak256("cash-out 1");

    function setUp() public {
        (alice, aliceKey) = makeAddrAndKey("alice");
        (, bobKey) = makeAddrAndKey("bob");
        deadline = uint64(block.timestamp + 30 minutes);

        wormhole = new MockWormholeCore(HYDRATION_CHAIN, 0);
        hollar = new MockGho();

        facilitator = HollarBaseFacilitator(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseFacilitator()),
                    abi.encodeCall(
                        HollarBaseFacilitator.initializeFacilitator,
                        (address(wormhole), address(hollar), 6, BASE_CHAIN, admin, guardian)
                    )
                )
            )
        );

        hollar.addFacilitator(address(facilitator), CAPACITY);

        vm.startPrank(admin);
        facilitator.setBaseEmitter(BASE_EMITTER);
        facilitator.setLimits(RateLimiter.UNLIMITED, RateLimiter.UNLIMITED, 0);
        vm.stopPrank();

        vm.prank(guardian);
        facilitator.setPaused(false, false);

        _mint(alice, 100e6, 0);
    }

    // ─── Helpers ────────────────────────────────────────────────

    function _mint(address recipient, uint256 usdcAmount, uint256 salt) internal {
        facilitator.receiveMessage(
            VaaBuilder.buildSalted(
                BASE_CHAIN,
                BASE_EMITTER,
                PsmPayload.encode(
                    PsmPayload.KIND_MINT,
                    PsmPayload.fromAddress(recipient),
                    usdcAmount,
                    PsmPayload.fromAddress(recipient)
                ),
                salt
            )
        );
    }

    function _sign(uint256 key, address owner, address spender, uint256 value, uint256 permitDeadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        return vm.sign(key, _digest(owner, spender, value, permitDeadline));
    }

    function _digest(address owner, address spender, uint256 value, uint256 permitDeadline)
        internal
        view
        returns (bytes32)
    {
        uint256 nonce = hollar.nonces(owner);
        return HollarPermit.digest(
            address(hollar), HollarPermit.structHash(owner, spender, value, nonce, permitDeadline)
        );
    }

    /// @dev Alice's permit for exactly the burn of `usdcAmount`, under the shared deadline.
    function _aliceSigns(uint256 usdcAmount) internal view returns (uint8, bytes32, bytes32) {
        return _sign(aliceKey, alice, address(facilitator), usdcAmount * SCALE, deadline);
    }

    function _redeemWithPermit(address caller, uint256 usdcAmount, uint8 v, bytes32 r, bytes32 s)
        internal
        returns (uint64)
    {
        vm.prank(caller);
        return facilitator.redeemWithPermit(usdcAmount, bob, type(uint16).max, deadline, REF, v, r, s);
    }

    function _bucketLevel() internal view returns (uint256 level) {
        (, level) = hollar.getFacilitatorBucket(address(facilitator));
    }

    struct State {
        uint256 aliceBalance;
        uint256 level;
        uint256 published;
        uint256 nonce;
        uint256 allowance;
        uint256 inboundAvailable;
        uint256 outboundAvailable;
    }

    function _state() internal view returns (State memory st) {
        st.aliceBalance = hollar.balanceOf(alice);
        st.level = _bucketLevel();
        st.published = wormhole.publishedCount();
        st.nonce = hollar.nonces(alice);
        st.allowance = hollar.allowance(alice, address(facilitator));
        (st.inboundAvailable, st.outboundAvailable) = _available();
    }

    function _available() internal view returns (uint256 inAvail, uint256 outAvail) {
        (, inAvail,, outAvail) = facilitator.limits();
    }

    /// @dev A refused call moves nothing: no burn, no publish, no nonce, no allowance, no limiter.
    function _assertUntouched(State memory before) internal view {
        State memory now_ = _state();
        assertEq(now_.aliceBalance, before.aliceBalance, "nothing burned");
        assertEq(now_.level, before.level, "bucket untouched");
        assertEq(now_.published, before.published, "nothing published");
        assertEq(now_.nonce, before.nonce, "permit nonce untouched");
        assertEq(now_.allowance, before.allowance, "allowance untouched");
        assertEq(now_.inboundAvailable, before.inboundAvailable, "inbound untouched");
        assertEq(now_.outboundAvailable, before.outboundAvailable, "outbound untouched");
    }

    function _facilitatorLogs(Vm.Log[] memory all) internal view returns (Vm.Log[] memory out) {
        uint256 n;
        for (uint256 i; i < all.length; i++) {
            if (all[i].emitter == address(facilitator)) n++;
        }
        out = new Vm.Log[](n);
        n = 0;
        for (uint256 i; i < all.length; i++) {
            if (all[i].emitter == address(facilitator)) out[n++] = all[i];
        }
    }

    // ─── Same as approve + redeem ───────────────────────────────

    struct Outcome {
        uint64 sequence;
        bytes payload;
        uint8 consistencyLevel;
        uint256 fee;
        bytes32 events;
        State state;
    }

    /// @dev Every facilitator event folded into one hash: topics and data, in order.
    function _eventsHash() internal returns (bytes32 h) {
        Vm.Log[] memory logs = _facilitatorLogs(vm.getRecordedLogs());
        for (uint256 i; i < logs.length; i++) {
            h = keccak256(abi.encode(h, logs[i].topics, logs[i].data));
        }
    }

    function _outcome(uint64 sequence) internal returns (Outcome memory o) {
        MockWormholeCore.Published memory pub = wormhole.lastPublished();
        o.sequence = sequence;
        o.payload = pub.payload;
        o.consistencyLevel = pub.consistencyLevel;
        o.fee = pub.value;
        o.events = _eventsHash();
        o.state = _state();
    }

    function _viaApprove(uint256 usdcAmount, uint16 maxFeeBps) internal returns (Outcome memory) {
        vm.startPrank(alice);
        hollar.approve(address(facilitator), usdcAmount * SCALE);
        vm.recordLogs();
        uint64 sequence = facilitator.redeem(usdcAmount, bob, maxFeeBps, deadline, REF);
        vm.stopPrank();
        return _outcome(sequence);
    }

    function _viaPermit(uint256 usdcAmount, uint16 maxFeeBps) internal returns (Outcome memory) {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(usdcAmount);
        vm.recordLogs();
        vm.prank(alice);
        uint64 sequence = facilitator.redeemWithPermit(usdcAmount, bob, maxFeeBps, deadline, REF, v, r, s);
        return _outcome(sequence);
    }

    /// @dev Run both paths from one state and compare everything they leave behind: the return,
    ///      the facilitator's events, the published message, the burn and the limiters.
    function testFuzz_redeemWithPermit_matchesApproveAndRedeem(uint256 usdcAmount, uint16 maxFeeBps) public {
        usdcAmount = bound(usdcAmount, 1, 100e6);

        uint256 snapshot = vm.snapshotState();
        Outcome memory a = _viaApprove(usdcAmount, maxFeeBps);
        vm.revertToState(snapshot);
        Outcome memory b = _viaPermit(usdcAmount, maxFeeBps);

        assertEq(b.sequence, a.sequence, "same sequence");
        assertEq(b.payload, a.payload, "same payload on the wire");
        assertEq(b.consistencyLevel, a.consistencyLevel, "same finality");
        assertEq(b.fee, a.fee, "same message fee");
        assertEq(b.events, a.events, "same facilitator events, topics and data");
        assertTrue(a.events != bytes32(0), "and there were some");

        assertEq(b.state.aliceBalance, a.state.aliceBalance, "same burn");
        assertEq(b.state.level, a.state.level, "same bucket level");
        assertEq(b.state.inboundAvailable, a.state.inboundAvailable, "same inbound");
        assertEq(b.state.outboundAvailable, a.state.outboundAvailable, "same outbound");
        assertEq(b.state.allowance, 0, "the permit's allowance is spent exactly");
        assertEq(b.state.nonce, 1, "the permit was used");
    }

    function test_redeemWithPermit_burnsAndPublishes() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);

        vm.expectEmit(true, true, true, true, address(facilitator));
        emit RedeemInitiated(alice, bob, 40e6, 0, REF);
        _redeemWithPermit(alice, 40e6, v, r, s);

        assertEq(hollar.balanceOf(alice), 60e18);
        assertEq(_bucketLevel(), 60e18, "the burn credits the bucket back");
        (uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin) =
            PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REDEEM);
        assertEq(PsmPayload.toAddress(recipient), bob);
        assertEq(amount, 40e6);
        assertEq(PsmPayload.toAddress(origin), alice, "the signer rides along as origin");
    }

    // ─── Front-run tolerance ────────────────────────────────────

    /// @dev Anyone can lift the signature from the mempool and hand it to the token first. That
    ///      spends the nonce, so our permit call reverts, but the allowance it set is in place.
    function test_redeemWithPermit_succeedsWhenThePermitWasFrontRun() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        vm.prank(eve);
        hollar.permit(alice, address(facilitator), 40e18, deadline, v, r, s);
        assertEq(hollar.nonces(alice), 1, "eve spent the nonce");

        _redeemWithPermit(alice, 40e6, v, r, s);

        assertEq(hollar.balanceOf(alice), 60e18, "the redeem went ahead");
        assertEq(hollar.allowance(alice, address(facilitator)), 0, "on the allowance eve's submission set");
        assertEq(wormhole.publishedCount(), 1);
    }

    /// @dev Front-run and then spent: the permit cannot apply and nothing stands in for it.
    function test_redeemWithPermit_revertsWhenFrontRunAndTheAllowanceIsSpent() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        vm.prank(eve);
        hollar.permit(alice, address(facilitator), 40e18, deadline, v, r, s);
        vm.prank(alice);
        facilitator.redeem(40e6, bob, type(uint16).max, deadline, REF);

        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
    }

    /// @dev The same signed call twice: the nonce is used and the allowance is spent.
    function test_redeemWithPermit_replayReverts() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        _redeemWithPermit(alice, 40e6, v, r, s);

        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
        assertEq(hollar.balanceOf(alice), 60e18, "burned once");
    }

    /// @dev The fall-through is the caller's own allowance, so an approve made the old way still
    ///      lets the call through on a signature that does not apply. It is theirs to spend.
    function test_redeemWithPermit_usesAnExistingAllowance() public {
        vm.prank(alice);
        hollar.approve(address(facilitator), 40e18);
        (uint8 v, bytes32 r, bytes32 s) = _sign(bobKey, alice, address(facilitator), 40e18, deadline);

        _redeemWithPermit(alice, 40e6, v, r, s);

        assertEq(hollar.balanceOf(alice), 60e18);
        assertEq(hollar.nonces(alice), 0, "the bad permit spent nothing");
    }

    // ─── A permit that does not apply ───────────────────────────

    function test_redeemWithPermit_revertsOnWrongSigner() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(bobKey, alice, address(facilitator), 40e18, deadline);
        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
    }

    /// @dev Signed for one wei more than the burn: the value is fixed by the call, not the signer.
    function test_redeemWithPermit_revertsOnWrongValue() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(aliceKey, alice, address(facilitator), 40e18 + 1, deadline);
        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
    }

    function test_redeemWithPermit_revertsOnWrongSpender() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(aliceKey, alice, bob, 40e18, deadline);
        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
    }

    /// @dev One deadline bounds both: a permit signed under another deadline does not apply.
    function test_redeemWithPermit_revertsOnADifferentPermitDeadline() public {
        (uint8 v, bytes32 r, bytes32 s) = _sign(aliceKey, alice, address(facilitator), 40e18, deadline + 1);
        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
    }

    /// @dev The owner is the caller. A third party holding alice's signature cannot burn her
    ///      HOLLAR: the permit reads as eve's and fails, and eve has no allowance.
    function test_redeemWithPermit_revertsWhenSubmittedBySomeoneElse() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(PermitFailed.selector, 0, 40e18));
        _redeemWithPermit(eve, 40e6, v, r, s);
        _assertUntouched(before);
    }

    /// @dev Checked first, exactly like `redeem`: the token is not even asked.
    function test_redeemWithPermit_revertsPastDeadline() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        vm.warp(uint256(deadline) + 1);

        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(RedeemExpired.selector, deadline));
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);
    }

    function test_redeemWithPermit_acceptsAtDeadline() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        vm.warp(deadline);
        _redeemWithPermit(alice, 40e6, v, r, s);
        assertEq(hollar.balanceOf(alice), 60e18);
    }

    // ─── The rest is redeem's ───────────────────────────────────

    /// @dev Paused: the same refusal, and the permit inside the call is rolled back with it.
    function test_redeemWithPermit_respectsPause() public {
        vm.prank(guardian);
        facilitator.setPaused(false, true);
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);

        State memory before = _state();
        vm.expectRevert(RedeemPaused.selector);
        _redeemWithPermit(alice, 40e6, v, r, s);
        _assertUntouched(before);

        vm.expectRevert(RedeemPaused.selector);
        vm.prank(alice);
        facilitator.redeem(40e6, bob, type(uint16).max, deadline, REF);
    }

    function test_redeemWithPermit_rejectsZeroRecipient() public {
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);
        vm.expectRevert(ZeroAddress.selector);
        vm.prank(alice);
        facilitator.redeemWithPermit(40e6, address(0), type(uint16).max, deadline, REF, v, r, s);
    }

    function test_redeemWithPermit_cannotExceedBucketLevel() public {
        hollar.mintFromElsewhere(alice, 500e18);
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(200e6);

        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(ExceedsBucketLevel.selector, 200e18, 100e18));
        _redeemWithPermit(alice, 200e6, v, r, s);
        _assertUntouched(before);
    }

    /// @dev As `test_redeem_refillsInbound`: the burn charges outbound and gives inbound back.
    function test_redeemWithPermit_movesTheLimitersLikeRedeem() public {
        vm.prank(admin);
        facilitator.setLimits(1_000e6, 1_000e6, 1 days);
        _mint(alice, 500e6, 1);

        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(500e6);
        _redeemWithPermit(alice, 500e6, v, r, s);

        (, uint256 inAvail,, uint256 outAvail) = facilitator.limits();
        assertEq(inAvail, 1_000e6, "the burn gave inbound back, up to capacity");
        assertEq(outAvail, 500e6, "outbound charged");

        (v, r, s) = _aliceSigns(100e6);
        _redeemWithPermit(alice, 100e6, v, r, s);
        (, inAvail,, outAvail) = facilitator.limits();
        assertEq(outAvail, 400e6);
    }

    function test_redeemWithPermit_respectsTheOutboundLimit() public {
        vm.prank(admin);
        facilitator.setLimits(1_000e6, 50e6, 1 days);
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(60e6);

        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(RateLimiter.RateLimitExceeded.selector, 60e6, 50e6));
        _redeemWithPermit(alice, 60e6, v, r, s);
        _assertUntouched(before);
    }

    // ─── Message fee ────────────────────────────────────────────

    function test_redeemWithPermit_paysTheMessageFeeAndRefundsTheRest() public {
        wormhole.setMessageFee(1e15);
        vm.deal(alice, 1 ether);
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);

        vm.prank(alice);
        facilitator.redeemWithPermit{value: 3e15}(40e6, bob, type(uint16).max, deadline, REF, v, r, s);

        assertEq(wormhole.lastPublished().value, 1e15, "the core gets exactly its fee");
        assertEq(alice.balance, 1 ether - 1e15, "the excess comes back");
        assertEq(address(facilitator).balance, 0);
    }

    function test_redeemWithPermit_refusesAShortMessageFee() public {
        wormhole.setMessageFee(1e15);
        vm.deal(alice, 1 ether);
        (uint8 v, bytes32 r, bytes32 s) = _aliceSigns(40e6);

        State memory before = _state();
        vm.expectRevert(abi.encodeWithSelector(InsufficientMessageFee.selector, 1e15 - 1, 1e15));
        vm.prank(alice);
        facilitator.redeemWithPermit{value: 1e15 - 1}(40e6, bob, type(uint16).max, deadline, REF, v, r, s);
        _assertUntouched(before);

        vm.startPrank(alice);
        hollar.approve(address(facilitator), 40e18);
        vm.expectRevert(abi.encodeWithSelector(InsufficientMessageFee.selector, 1e15 - 1, 1e15));
        facilitator.redeem{value: 1e15 - 1}(40e6, bob, type(uint16).max, deadline, REF);
        vm.stopPrank();
    }
}
