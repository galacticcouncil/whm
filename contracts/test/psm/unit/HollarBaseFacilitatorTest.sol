// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {MessageReceiver} from "../../../src/MessageReceiver.sol";
import {HollarBaseFacilitator} from "../../../src/psm/HollarBaseFacilitator.sol";
import {IHollarBaseFacilitator} from "../../../src/psm/interfaces/IHollarBaseFacilitator.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {MockGho, MockWormholeCore, VaaBuilder} from "../mocks/PsmMocks.sol";

/// @title HollarBaseFacilitator — Hydration leg
/// @notice The side that mints. Two things are load-bearing throughout: a verified attestation
///         must never be lost to a local condition, and nothing may mint outside the bucket.
contract HollarBaseFacilitatorTest is Test, IHollarBaseFacilitator {
    HollarBaseFacilitator internal facilitator;
    MockGho internal hollar;
    MockWormholeCore internal wormhole;

    uint16 internal constant BASE_CHAIN = 30;
    uint16 internal constant HYDRATION_CHAIN = 73;
    bytes32 internal constant BASE_EMITTER = bytes32(uint256(0xbaa5e));
    uint256 internal constant SCALE = 1e12;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // Bucket sized like the launch parameter: 10,000 HOLLAR.
    uint256 internal constant CAPACITY = 10_000e18;

    function setUp() public {
        wormhole = new MockWormholeCore(HYDRATION_CHAIN, 0);
        hollar = new MockGho();

        HollarBaseFacilitator implementation = new HollarBaseFacilitator();
        facilitator = HollarBaseFacilitator(
            address(
                new ERC1967Proxy(
                    address(implementation),
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
    }

    // ─── Helpers ────────────────────────────────────────────────

    function _mintVaa(address recipient, uint256 usdcAmount) internal pure returns (bytes memory) {
        return VaaBuilder.build(
            BASE_CHAIN,
            BASE_EMITTER,
            PsmPayload.encode(PsmPayload.KIND_MINT, PsmPayload.fromAddress(recipient), usdcAmount, PsmPayload.fromAddress(recipient))
        );
    }

    /// @dev A VAA from an arbitrary chain and emitter, for the binding tests.
    function _mintVaaFrom(uint16 chainId, bytes32 emitter, address recipient, uint256 usdcAmount, uint256 salt)
        internal
        pure
        returns (bytes memory)
    {
        return VaaBuilder.buildSalted(
            chainId,
            emitter,
            PsmPayload.encode(PsmPayload.KIND_MINT, PsmPayload.fromAddress(recipient), usdcAmount, PsmPayload.fromAddress(recipient)),
            salt
        );
    }

    /// @dev Any kind, any origin — for the re-mint and cancel paths, where the origin is not the
    ///      recipient.
    function _vaaOf(uint8 kind, address recipient, address origin, uint256 usdcAmount, uint256 salt)
        internal
        pure
        returns (bytes memory)
    {
        return VaaBuilder.buildSalted(
            BASE_CHAIN,
            BASE_EMITTER,
            PsmPayload.encode(kind, PsmPayload.fromAddress(recipient), usdcAmount, PsmPayload.fromAddress(origin)),
            salt
        );
    }

    function _bucketLevel() internal view returns (uint256 level) {
        (, level) = hollar.getFacilitatorBucket(address(facilitator));
    }

    // ─── Mint ───────────────────────────────────────────────────

    function test_receiveMint_mintsScaledAmount() public {
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        assertEq(hollar.balanceOf(alice), 100e18, "100 USDC must mint 100 HOLLAR");
        assertEq(_bucketLevel(), 100e18, "bucket tracks the mint");
        assertEq(facilitator.pendingOf(alice), 0);
    }

    /// @dev The wire carries the coarser unit precisely so this direction is the only conversion.
    function testFuzz_receiveMint_scalesWithoutDust(uint96 usdcAmount) public {
        vm.assume(usdcAmount > 0 && uint256(usdcAmount) * SCALE <= CAPACITY);

        facilitator.receiveMessage(_mintVaa(alice, usdcAmount));

        assertEq(hollar.balanceOf(alice), uint256(usdcAmount) * SCALE);
        assertEq(_bucketLevel() % SCALE, 0, "a minted amount is always a whole number of USDC units");
    }

    /// @dev The replay guard lives in MessageReceiver and is written before dispatch. Pinned here
    ///      because a second mint against one deposit is unbacked HOLLAR.
    function test_receiveMint_rejectsReplay() public {
        bytes memory vaa = _mintVaa(alice, 100e6);
        facilitator.receiveMessage(vaa);

        vm.expectRevert("VAA already processed");
        facilitator.receiveMessage(vaa);

        assertEq(hollar.balanceOf(alice), 100e18, "one deposit, one mint");
    }

    function test_receiveMint_rejectsUnauthorizedEmitter() public {
        bytes memory vaa = VaaBuilder.build(
            BASE_CHAIN,
            bytes32(uint256(0xdead)),
            PsmPayload.encode(PsmPayload.KIND_MINT, PsmPayload.fromAddress(alice), 100e6, PsmPayload.fromAddress(alice))
        );

        vm.expectRevert(MessageReceiver.NotAuthorizedEmitter.selector);
        facilitator.receiveMessage(vaa);
    }

    /// @dev Kinds 2 and 3 travel the other way. One arriving here means the vault is not what we
    ///      think it is, so it is refused rather than interpreted.
    function test_receiveMint_rejectsWrongKind() public {
        bytes memory vaa = VaaBuilder.build(
            BASE_CHAIN, BASE_EMITTER, PsmPayload.encode(PsmPayload.KIND_REDEEM, PsmPayload.fromAddress(alice), 100e6, PsmPayload.fromAddress(alice))
        );

        vm.expectRevert(abi.encodeWithSelector(UnexpectedKind.selector, PsmPayload.KIND_REDEEM));
        facilitator.receiveMessage(vaa);
    }

    // ─── Queue, not revert ──────────────────────────────────────

    /// @dev The deposit is already locked on Base. Pausing must not destroy the claim to it.
    function test_receiveMint_queuesWhenPaused() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);

        vm.expectEmit(true, true, false, true);
        emit MintQueued(0, alice, 100e6, QueueReason.MintPaused);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        assertEq(hollar.balanceOf(alice), 0);
        assertEq(facilitator.pendingOf(alice), 100e6, "the claim survives the pause");
        assertEq(facilitator.totalPendingMint(), 100e6);
    }

    function test_receiveMint_queuesWhenBucketFull() public {
        hollar.setFacilitatorBucketCapacity(address(facilitator), 50e18);

        vm.expectEmit(true, true, false, true);
        emit MintQueued(0, alice, 100e6, QueueReason.BucketFull);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        assertEq(facilitator.pendingOf(alice), 100e6);
    }

    function test_receiveMint_queuesWhenRateLimited() public {
        vm.prank(admin);
        facilitator.setLimits(50e6, RateLimiter.UNLIMITED, 1 days);

        vm.expectEmit(true, true, false, true);
        emit MintQueued(0, alice, 100e6, QueueReason.RateLimited);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        assertEq(facilitator.pendingOf(alice), 100e6);
        assertEq(_bucketLevel(), 0, "a rate limit must not mint a partial amount");
    }

    /// @dev A queued mint is not a lost one: the VAA is consumed, and the claim is now local.
    function test_flushPendingMint_mintsTheWholeEntry() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.prank(guardian);
        facilitator.setPaused(false, false);

        facilitator.flushPendingMint(0);
        assertEq(hollar.balanceOf(alice), 100e18, "all of it, in one go");
        assertEq(facilitator.pendingOf(alice), 0);
        assertEq(facilitator.totalPendingMint(), 0);
    }

    /// @dev The whole point of the entry: headroom short of the full amount mints nothing, rather
    ///      than drawing the entry down and leaving a remainder in front of everyone behind it.
    function test_flushPendingMint_refusesHeadroomShortOfTheWholeEntry() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.prank(guardian);
        facilitator.setPaused(false, false);
        hollar.setFacilitatorBucketCapacity(address(facilitator), 60e18);

        vm.expectRevert(abi.encodeWithSelector(ExceedsBucketLevel.selector, 100e18, 60e18));
        facilitator.flushPendingMint(0);

        assertEq(hollar.balanceOf(alice), 0);
        assertEq(facilitator.pendingOf(alice), 100e6, "still queued, still whole");
    }

    /// @dev The reason there is no queue order: an entry the bucket cannot cover blocks only
    ///      itself. Smaller ones behind it flush while it waits.
    function test_flushPendingMint_oversizedEntryBlocksOnlyItself() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 500e6));
        facilitator.receiveMessage(_mintVaa(bob, 10e6));

        vm.prank(guardian);
        facilitator.setPaused(false, false);
        hollar.setFacilitatorBucketCapacity(address(facilitator), 100e18);

        vm.expectRevert(abi.encodeWithSelector(ExceedsBucketLevel.selector, 500e18, 100e18));
        facilitator.flushPendingMint(0);

        facilitator.flushPendingMint(1);
        assertEq(hollar.balanceOf(bob), 10e18, "bob does not wait on alice");
        assertEq(facilitator.pendingOf(alice), 500e6, "alice's entry is untouched");
    }

    /// @dev A recipient with several entries flushes them in whatever order headroom allows.
    function test_flushPendingMint_entriesAreIndependent() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));
        facilitator.receiveMessage(_mintVaa(alice, 250e6));

        vm.prank(guardian);
        facilitator.setPaused(false, false);
        assertEq(facilitator.pendingOf(alice), 350e6);

        facilitator.flushPendingMint(1);
        assertEq(hollar.balanceOf(alice), 250e18, "the second one, on its own");
        assertEq(facilitator.pendingOf(alice), 100e6);

        facilitator.flushPendingMint(0);
        assertEq(hollar.balanceOf(alice), 350e18);
        assertEq(facilitator.pendingOf(alice), 0);
    }

    function test_flushPendingMint_rejectsUnknownEntry() public {
        vm.expectRevert(abi.encodeWithSelector(NotQueued.selector, 0));
        facilitator.flushPendingMint(0);
    }

    function test_flushPendingMint_rejectsFlushingTwice() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.prank(guardian);
        facilitator.setPaused(false, false);
        facilitator.flushPendingMint(0);

        vm.expectRevert(abi.encodeWithSelector(NotQueued.selector, 0));
        facilitator.flushPendingMint(0);
    }

    // ─── Cancel ─────────────────────────────────────────────────

    /// @dev The exit from "queued forever". Nothing minted, so nothing burns and the bucket does
    ///      not move — only a refund message goes back, to the entry's origin: the Base account
    ///      that locked the USDC, never the Hydration recipient mirrored onto Base and never a
    ///      caller's pick. It names the Hydration recipient as its own origin in turn.
    function test_cancelPendingMint_refundsToOrigin() public {
        address baseDepositor = makeAddr("baseDepositor");
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, alice, baseDepositor, 100e6, 1));

        vm.expectEmit(true, true, false, true);
        emit PendingMintCancelled(0, alice, 100e6, PsmPayload.fromAddress(baseDepositor), PsmPayload.KIND_REFUND, 0);
        vm.prank(alice);
        facilitator.cancelPendingMint(0, type(uint16).max);

        assertEq(facilitator.pendingOf(alice), 0);
        assertEq(facilitator.totalPendingMint(), 0);
        assertEq(_bucketLevel(), 0, "a cancelled mint never touched the bucket");

        (uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin) =
            PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REFUND);
        assertEq(PsmPayload.toAddress(recipient), baseDepositor, "back to who locked it");
        assertNotEq(PsmPayload.toAddress(recipient), alice, "must not mirror the Hydration recipient onto Base");
        assertEq(PsmPayload.toAddress(origin), alice, "naming the Hydration recipient as origin in turn");
        assertEq(amount, 100e6);
    }

    function test_cancelPendingMint_onlyRecipient() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(NotYourPendingMint.selector, 0, alice));
        facilitator.cancelPendingMint(0, type(uint16).max);
    }

    /// @dev The admin's version picks nothing either: same origin, same books.
    function test_cancelPendingMintFor_refundsToOrigin() public {
        address baseDepositor = makeAddr("baseDepositor");
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, alice, baseDepositor, 100e6, 1));

        vm.prank(bob);
        vm.expectRevert();
        facilitator.cancelPendingMintFor(0, type(uint16).max);

        vm.prank(admin);
        facilitator.cancelPendingMintFor(0, type(uint16).max);

        assertEq(facilitator.pendingOf(alice), 0);
        assertEq(facilitator.totalPendingMint(), 0);
        assertEq(_bucketLevel(), 0, "nothing was minted, nothing burns");

        (uint8 kind, bytes32 recipient, uint256 amount,) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REFUND);
        assertEq(PsmPayload.toAddress(recipient), baseDepositor, "to who locked it, not the admin's choice");
        assertEq(amount, 100e6);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(NotQueued.selector, 0));
        facilitator.cancelPendingMintFor(0, type(uint16).max);
    }

    // ─── Re-mint ────────────────────────────────────────────────

    /// @dev A re-mint is a mint on the books: same bucket check, same inbound charge. The kind is
    ///      distinguishable on the wire and on the queued entry, where it decides what a cancel
    ///      sends back — and nowhere else.
    function test_receiveRemint_chargesInboundLikeAMint() public {
        vm.prank(admin);
        facilitator.setLimits(150e6, RateLimiter.UNLIMITED, 1 days);
        (, uint256 inboundBefore,,) = facilitator.limits();

        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 1));

        assertEq(hollar.balanceOf(alice), 100e18);
        (, uint256 inboundAfter,,) = facilitator.limits();
        assertEq(inboundAfter, inboundBefore - 100e6, "charged to the inbound window like any mint");

        vm.expectEmit(true, true, false, true);
        emit MintQueued(0, alice, 100e6, QueueReason.RateLimited);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 2));
        assertEq(hollar.balanceOf(alice), 100e18, "the second one queued on the limiter");
    }

    /// @dev A queued re-mint flushed later is charged exactly as arrival would have charged it.
    function test_flushPendingMint_remintChargesInbound() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 1));

        vm.prank(admin);
        facilitator.setLimits(150e6, RateLimiter.UNLIMITED, 1 days);
        vm.prank(guardian);
        facilitator.setPaused(false, false);
        (, uint256 inboundBefore,,) = facilitator.limits();

        facilitator.flushPendingMint(0);

        assertEq(hollar.balanceOf(alice), 100e18);
        (, uint256 inboundAfter,,) = facilitator.limits();
        assertEq(inboundAfter, inboundBefore - 100e6, "a flushed re-mint is charged like any mint");
    }

    // ─── Redeem ─────────────────────────────────────────────────

    function test_redeem_burnsAndPublishes() public {
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.startPrank(alice);
        hollar.approve(address(facilitator), 100e18);
        facilitator.redeem(40e6, bob, type(uint16).max);
        vm.stopPrank();

        assertEq(hollar.balanceOf(alice), 60e18);
        assertEq(_bucketLevel(), 60e18, "the burn credits the bucket back");

        (uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin) =
            PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REDEEM);
        assertEq(PsmPayload.toAddress(recipient), bob);
        assertEq(amount, 40e6, "the wire carries USDC units, not HOLLAR");
        assertEq(PsmPayload.toAddress(origin), alice, "the redeemer rides along as origin");
    }

    /// @dev #40: the redeem leg is instant and uncapped — its reorg exposure is one block wide and
    ///      falls on the protocol, not on holders.
    function test_redeem_publishesInstant() public {
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.startPrank(alice);
        hollar.approve(address(facilitator), 100e18);
        facilitator.redeem(100e6, bob, type(uint16).max);
        vm.stopPrank();

        assertEq(wormhole.lastPublished().consistencyLevel, 200);
    }

    /// @dev The whole solvency model in one test. The bucket, not our bookkeeping, is what stops
    ///      redemption exceeding what was locked on Base.
    function test_redeem_cannotExceedBucketLevel() public {
        facilitator.receiveMessage(_mintVaa(alice, 100e6));
        // Give alice HOLLAR this facilitator never minted, as an HSM mint or a market buy would.
        hollar.mintFromElsewhere(alice, 500e18);

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ExceedsBucketLevel.selector, 200e18, 100e18));
        facilitator.redeem(200e6, bob, type(uint16).max);
        vm.stopPrank();
    }

    function testFuzz_redeem_neverBurnsPastWhatItMinted(uint96 minted, uint96 redeemed) public {
        vm.assume(minted >= 10e6 && uint256(minted) * SCALE <= CAPACITY);
        vm.assume(redeemed > minted);

        facilitator.receiveMessage(_mintVaa(alice, minted));
        hollar.mintFromElsewhere(alice, uint256(redeemed) * SCALE);

        vm.startPrank(alice);
        hollar.approve(address(facilitator), type(uint256).max);
        vm.expectRevert();
        facilitator.redeem(redeemed, bob, type(uint16).max);
        vm.stopPrank();
    }


    function test_redeem_rejectsZeroRecipient() public {
        vm.expectRevert(ZeroAddress.selector);
        vm.prank(alice);
        facilitator.redeem(100e6, address(0), type(uint16).max);
    }

    function test_redeem_respectsPause() public {
        vm.prank(guardian);
        facilitator.setPaused(false, true);

        vm.expectRevert(RedeemPaused.selector);
        vm.prank(alice);
        facilitator.redeem(100e6, bob, type(uint16).max);
    }

    // ─── Authority ──────────────────────────────────────────────

    /// @dev The emitter binding is the highest-value key here. One shot, then it is not a setting.
    function test_setBaseEmitter_isOneShot() public {
        vm.prank(admin);
        vm.expectRevert(EmitterAlreadySet.selector);
        facilitator.setBaseEmitter(bytes32(uint256(0xdead)));
    }

    /// @dev The base class ships an always-callable emitter setter and a single owner key. Both
    ///      are retired at init, or the freeze above would be decorative.
    function test_inheritedOwnerIsRetired() public {
        assertEq(facilitator.owner(), address(0));

        vm.prank(admin);
        vm.expectRevert(MessageReceiver.NotOwner.selector);
        facilitator.setAuthorizedEmitter(BASE_CHAIN, bytes32(uint256(0xdead)));

        vm.prank(admin);
        vm.expectRevert(MessageReceiver.NotOwner.selector);
        facilitator.setOwner(admin);
    }

    function test_setLimits_onlyAdmin() public {
        vm.prank(guardian);
        vm.expectRevert();
        facilitator.setLimits(1, 1, 1 days);
    }

    function test_setPaused_onlyGuardian() public {
        vm.prank(alice);
        vm.expectRevert();
        facilitator.setPaused(true, true);
    }

    // ─── Views ──────────────────────────────────────────────────

    function test_mintHeadroom_netsOffPending() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        assertEq(facilitator.mintHeadroom(), 0, "nothing mints while paused, whatever the bucket says");

        vm.prank(guardian);
        facilitator.setPaused(false, false);
        assertEq(facilitator.mintHeadroom(), 10_000e6 - 100e6, "queued mints already claim headroom");
    }

    function test_maxRedeemable_tracksBucketLevel() public {
        facilitator.receiveMessage(_mintVaa(alice, 250e6));
        assertEq(facilitator.maxRedeemable(), 250e6);
        assertEq(facilitator.outstanding(), 250e18);
    }

    /// The inherited emitter check compares against `authorizedEmitters[chain]`, which is
    /// bytes32(0) for any chain nobody bound -- so a zero-emitter VAA matches the mapping default.
    /// Only one chain is ever bound, so anything else must be refused outright.
    function test_receiveMint_refusesZeroEmitterOnAnUnboundChain() public {
        uint256 levelBefore = _bucketLevel();

        // A chain nobody bound, with the emitter the mapping already returns for it.
        vm.expectRevert(abi.encodeWithSelector(UnexpectedEmitterChain.selector, uint16(99)));
        facilitator.receiveMessage(_mintVaaFrom(99, bytes32(0), alice, 1_000e6, 1));

        // And chain zero, whose entry is equally unset.
        vm.expectRevert(abi.encodeWithSelector(UnexpectedEmitterChain.selector, uint16(0)));
        facilitator.receiveMessage(_mintVaaFrom(0, bytes32(0), alice, 1_000e6, 2));

        assertEq(_bucketLevel(), levelBefore, "nothing minted");
        assertEq(hollar.balanceOf(alice), 0);
    }

    /// A zero emitter on the bound chain is refused too -- the binder rejects zero, so the mapping
    /// entry is never zero, and a VAA claiming otherwise is forged.
    function test_receiveMint_refusesZeroEmitterOnTheBoundChain() public {
        vm.expectRevert();
        facilitator.receiveMessage(_mintVaaFrom(BASE_CHAIN, bytes32(0), alice, 1_000e6, 3));
        assertEq(hollar.balanceOf(alice), 0);
    }

    // ─── Init ───────────────────────────────────────────────────

    function _initData(uint8 usdcDecimals, uint16 baseChain) internal view returns (bytes memory) {
        return abi.encodeCall(
            HollarBaseFacilitator.initializeFacilitator,
            (address(wormhole), address(hollar), usdcDecimals, baseChain, admin, guardian)
        );
    }

    /// @dev Zero USDC decimals would make `scale` 1e18 — every wire unit a whole HOLLAR, bounded
    ///      by nothing but the bucket. Refused with the other decimals mismatch.
    function test_initialize_rejectsZeroUsdcDecimals() public {
        address impl = address(new HollarBaseFacilitator());

        vm.expectRevert(IncorrectDecimals.selector);
        new ERC1967Proxy(impl, _initData(0, BASE_CHAIN));
    }

    /// @dev The vault's chain is checked against the core's own id, which also proves the core.
    function test_initialize_rejectsOwnChainAsBase() public {
        address impl = address(new HollarBaseFacilitator());

        vm.expectRevert(abi.encodeWithSelector(InvalidChainId.selector, HYDRATION_CHAIN));
        new ERC1967Proxy(impl, _initData(6, HYDRATION_CHAIN));

        vm.expectRevert(abi.encodeWithSelector(InvalidChainId.selector, uint16(0)));
        new ERC1967Proxy(impl, _initData(6, 0));
    }

    // ─── Unbound window ─────────────────────────────────────────

    /// @dev Between deployment and the one-shot bind the mapping holds zero for the pinned chain,
    ///      which is what a zero-emitter VAA would match in the shared base. Nothing is accepted
    ///      until the bind.
    function test_receiveMint_refusesEverythingBeforeTheBind() public {
        HollarBaseFacilitator fresh = HollarBaseFacilitator(
            address(new ERC1967Proxy(address(new HollarBaseFacilitator()), _initData(6, BASE_CHAIN)))
        );

        vm.expectRevert(EmitterNotSet.selector);
        fresh.receiveMessage(_mintVaaFrom(BASE_CHAIN, bytes32(0), alice, 1_000e6, 1));
    }

    /// @dev The vault never publishes zero. A payload it could not have produced is refused, not
    ///      queued, so no dead entry can ever sit in the queue.
    function test_receiveMint_rejectsZeroAmount() public {
        vm.expectRevert(ZeroAmount.selector);
        facilitator.receiveMessage(_mintVaa(alice, 0));

        // Paused too: the check sits before the queue branch, or a dead entry would sit there.
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        vm.expectRevert(ZeroAmount.selector);
        facilitator.receiveMessage(_mintVaaFrom(BASE_CHAIN, BASE_EMITTER, alice, 0, 1));
        assertEq(facilitator.pendingTail(), 0, "nothing queued");
    }

    // ─── Cancelling a re-mint ───────────────────────────────────

    /// @dev A queued re-mint is burned HOLLAR waiting to come back. Cancelling it sends the USDC
    ///      out as a redemption — KIND_REDEEM, so the vault charges the fee the cancelled credit
    ///      would have paid — never as the fee-free refund a cancelled deposit gets. Pinned
    ///      because the alternative was a free round trip: redeem, cancel at the head, let the
    ///      re-mint queue, cancel it here.
    function test_cancelPendingMint_remintEntryLeavesAsRedeem() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 1));

        vm.expectEmit(true, true, false, true);
        emit PendingMintCancelled(0, alice, 100e6, PsmPayload.fromAddress(bob), PsmPayload.KIND_REDEEM, 0);
        vm.prank(alice);
        facilitator.cancelPendingMint(0, type(uint16).max);

        (uint8 kind, bytes32 recipient, uint256 amount, bytes32 origin) =
            PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REDEEM, "a cancelled re-mint is a redemption");
        assertEq(PsmPayload.toAddress(recipient), bob, "back to the Base recipient the credit named");
        assertEq(PsmPayload.toAddress(origin), alice, "naming the redeemer as origin in turn");
        assertEq(amount, 100e6);
        assertEq(_bucketLevel(), 0, "nothing minted, nothing burns");
    }

    /// @dev The admin path shares the rule.
    function test_cancelPendingMintFor_remintEntryLeavesAsRedeem() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 1));

        vm.prank(admin);
        facilitator.cancelPendingMintFor(0, type(uint16).max);

        (uint8 kind, bytes32 recipient,,) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REDEEM);
        assertEq(PsmPayload.toAddress(recipient), bob);
    }

    /// @dev The third way a re-mint queues. Pinned on its own because at launch the bucket equals
    ///      the inbound cap, so a competing mint landing between the burn and the re-mint's
    ///      arrival queues it here rather than on the limiter.
    function test_cancelPendingMint_remintQueuedOnFullBucketLeavesAsRedeem() public {
        hollar.setFacilitatorBucketCapacity(address(facilitator), 50e18);

        vm.expectEmit(true, true, false, true);
        emit MintQueued(0, alice, 100e6, QueueReason.BucketFull);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 1));

        vm.prank(alice);
        facilitator.cancelPendingMint(0, type(uint16).max);

        (uint8 kind,,,) = PsmPayload.decode(wormhole.lastPublished().payload);
        assertEq(kind, PsmPayload.KIND_REDEEM);
    }

    // ─── Cancel under pause ─────────────────────────────────────

    /// @dev The way out of the queue stays open under both pauses — a pause is exactly when
    ///      entries queue. What it books on Base still waits behind the vault's own claims pause.
    function test_cancelPendingMint_worksUnderBothPauses() public {
        vm.prank(guardian);
        facilitator.setPaused(true, true);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, alice, alice, 100e6, 1));
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, bob, bob, 100e6, 2));

        vm.prank(alice);
        facilitator.cancelPendingMint(0, type(uint16).max);
        assertEq(facilitator.pendingOf(alice), 0, "the recipient can leave");

        vm.prank(admin);
        facilitator.cancelPendingMintFor(1, type(uint16).max);
        assertEq(facilitator.pendingOf(bob), 0, "and the admin can clear an entry");
        assertEq(facilitator.totalPendingMint(), 0);
    }

    // ─── Views under pause ──────────────────────────────────────

    /// @dev What the UI shows before anyone burns must be what `redeem` will accept.
    function test_maxRedeemable_isZeroWhileRedeemPaused() public {
        facilitator.receiveMessage(_mintVaa(alice, 250e6));
        assertEq(facilitator.maxRedeemable(), 250e6);

        vm.prank(guardian);
        facilitator.setPaused(false, true);
        assertEq(facilitator.maxRedeemable(), 0, "paused reads as nothing redeemable");
    }

    // ─── Bounded walk ───────────────────────────────────────────

    /// @dev Ids are never reclaimed, so the walk is bounded by the caller: it starts at `fromId`,
    ///      stops after `maxIds`, and a window past the tail is clamped.
    function test_pendingEntryOf_scansOnlyTheGivenWindow() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, alice, alice, 10e6, 1)); // id 0
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, bob, bob, 10e6, 2)); // id 1
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_MINT, alice, alice, 10e6, 3)); // id 2

        (bool found, uint256 id) = facilitator.pendingEntryOf(alice, 0, 1);
        assertTrue(found);
        assertEq(id, 0, "the first live entry in the window");

        (found, id) = facilitator.pendingEntryOf(alice, 1, 10);
        assertTrue(found);
        assertEq(id, 2, "the walk starts at fromId, not at zero");

        (found,) = facilitator.pendingEntryOf(bob, 2, 10);
        assertFalse(found, "bob's entry is behind the window");

        (found, id) = facilitator.pendingEntryOf(alice, 2, type(uint256).max);
        assertTrue(found, "a window past the tail is clamped, not overflowed");
        assertEq(id, 2);

        (found,) = facilitator.pendingEntryOf(alice, 3, 10);
        assertFalse(found, "nothing beyond the tail");
    }

    // ─── Fee limit ──────────────────────────────────────────────

    /// @dev The redeemer's limit rides on the burn; the vault reads it when the fee is assessed.
    function test_redeem_carriesItsFeeLimit() public {
        facilitator.receiveMessage(_mintVaa(alice, 100e6));

        vm.startPrank(alice);
        hollar.approve(address(facilitator), 100e18);
        facilitator.redeem(40e6, bob, 7);
        vm.stopPrank();

        assertEq(PsmPayload.feeCap(wormhole.lastPublished().payload), 7);
    }

    /// @dev A cancelled re-mint is a redemption, so it carries a limit too — the canceller's.
    function test_cancelPendingMint_remintCarriesTheCancellersFeeLimit() public {
        vm.prank(guardian);
        facilitator.setPaused(true, false);
        facilitator.receiveMessage(_vaaOf(PsmPayload.KIND_REMINT, alice, bob, 100e6, 1));

        vm.prank(alice);
        facilitator.cancelPendingMint(0, 9);

        bytes memory payload = wormhole.lastPublished().payload;
        (uint8 kind,,,) = PsmPayload.decode(payload);
        assertEq(kind, PsmPayload.KIND_REDEEM);
        assertEq(PsmPayload.feeCap(payload), 9);
    }
}
