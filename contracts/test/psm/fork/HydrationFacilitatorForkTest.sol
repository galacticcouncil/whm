// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {HollarBaseFacilitator} from "../../../src/psm/HollarBaseFacilitator.sol";
import {IGhoToken} from "../../../src/psm/interfaces/IGhoToken.sol";
import {IHollarBaseFacilitator} from "../../../src/psm/interfaces/IHollarBaseFacilitator.sol";
import {PsmPayload} from "../../../src/psm/lib/PsmPayload.sol";
import {RateLimiter} from "../../../src/psm/lib/RateLimiter.sol";
import {HollarPermit} from "../mocks/PsmMocks.sol";

/// @title The facilitator against real HOLLAR on Hydration
/// @notice The unit suite runs against `MockGho`. This one runs against the GHO contract the
///         migration will actually register on, so the thing under test is the real bucket
///         arithmetic rather than our model of it — including the floorless `burn` that the
///         module's entire solvency argument rests on.
///
/// @dev Two accommodations, both narrow and both load-bearing:
///
///      - `prevrandao` is unset in Hydration's EVM headers, so every call after the fork fails
///        header validation until it is stamped.
///      - `transferFrom` resolves its allowance through a Substrate runtime precompile that anvil
///        does not have. The redeem tests mock `transferFrom` whole and place what it would have
///        moved on the facilitator with `deal`, leaving the burn and the bucket real; the
///        `redeemWithPermit` tests mock only the precompile's allowance read.
contract HydrationFacilitatorForkTest is Test {
    /// @dev The GHO ERC20, not the asset-222 precompile — that one answers symbol()/decimals()
    ///      and then reverts on everything a facilitator needs.
    address internal constant HOLLAR = 0x531a654d1696ED52e7275A8cede955E82620f99a;
    address internal constant WORMHOLE_CORE = 0x3792a6d63c31941B2805181771795D9176fA82A1;

    /// @dev Base slot of GhoToken's `facilitators` mapping: capacity at the struct slot, level at
    ///      the next. Located by matching a live facilitator's (capacity, level) against storage.
    uint256 internal constant FACILITATORS_SLOT = 8;

    uint16 internal constant BASE_CHAIN = 30;
    bytes32 internal constant VAULT_EMITTER = bytes32(uint256(0xBA5E));
    uint256 internal constant SCALE = 1e12;
    uint64 internal constant NO_DEADLINE = type(uint64).max;
    uint256 internal constant CAPACITY = 250_000e18;

    HollarBaseFacilitator internal facilitator;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");

    bool internal forked;

    function setUp() public {
        // `rpcUrl` is resolved before the call it feeds, so its revert has to be caught separately
        // or an unset RPC_HYDRATION fails setUp instead of skipping the suite.
        try vm.rpcUrl("hydration") returns (string memory url) {
            try vm.createSelectFork(url) {
                forked = true;
            } catch {
                return;
            }
        } catch {
            return;
        }
        vm.prevrandao(bytes32(uint256(1)));

        facilitator = HollarBaseFacilitator(
            address(
                new ERC1967Proxy(
                    address(new HollarBaseFacilitator()),
                    abi.encodeCall(
                        HollarBaseFacilitator.initializeFacilitator,
                        (WORMHOLE_CORE, HOLLAR, 6, BASE_CHAIN, admin, guardian)
                    )
                )
            )
        );

        vm.startPrank(admin);
        facilitator.setBaseEmitter(VAULT_EMITTER);
        facilitator.setLimits(RateLimiter.UNLIMITED, RateLimiter.UNLIMITED, 0);
        vm.stopPrank();

        vm.prank(guardian);
        facilitator.setPaused(false, false);

        _grantBucket(CAPACITY);
    }

    modifier onFork() {
        if (!forked) vm.skip(true);
        _;
    }

    // ─── Harness ────────────────────────────────────────────────

    /// @dev Governance's call on Substrate, written straight into storage here.
    function _grantBucket(uint256 capacity) internal {
        vm.store(HOLLAR, keccak256(abi.encode(address(facilitator), FACILITATORS_SLOT)), bytes32(capacity));
    }

    function _level() internal view returns (uint256 level) {
        (, level) = IGhoToken(HOLLAR).getFacilitatorBucket(address(facilitator));
    }

    /// @dev Guardian signatures cannot be produced against a fork, so verification is stood in for.
    ///      Everything downstream of it — emitter binding, replay, decode, the bucket — is real.
    function _deliverMint(address recipient, uint256 usdcAmount, uint256 salt) internal {
        IWormhole.VM memory v;
        v.emitterChainId = BASE_CHAIN;
        v.emitterAddress = VAULT_EMITTER;
        v.payload = PsmPayload.encode(PsmPayload.KIND_MINT, PsmPayload.fromAddress(recipient), usdcAmount, PsmPayload.fromAddress(recipient));
        v.hash = keccak256(abi.encode(recipient, usdcAmount, salt));

        vm.mockCall(
            WORMHOLE_CORE, abi.encodeWithSelector(bytes4(keccak256("parseAndVerifyVM(bytes)"))), abi.encode(v, true, "")
        );
        facilitator.receiveMessage(hex"00");
        vm.clearMockedCalls();
    }

    /// @dev `redeem` pulls HOLLAR in with transferFrom before burning it. Only that pull is faked;
    ///      the tokens are really placed on the facilitator so the burn that follows is real.
    function _redeem(address from, uint256 usdcAmount, address baseRecipient) internal {
        deal(HOLLAR, address(facilitator), IGhoToken(HOLLAR).balanceOf(address(facilitator)) + usdcAmount * SCALE);
        vm.mockCall(HOLLAR, abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)"))), abi.encode(true));
        vm.prank(from);
        facilitator.redeem(usdcAmount, baseRecipient, type(uint16).max, NO_DEADLINE, bytes32(0));
        vm.clearMockedCalls();
    }

    // ─── The real token ─────────────────────────────────────────

    function test_realHollarShape() public onFork {
        assertEq(IGhoToken(HOLLAR).decimals(), 18, "HOLLAR is 18dp");
        assertEq(facilitator.scale(), SCALE, "scale derived from the real token");
        assertGt(HOLLAR.code.length, 0, "the GHO contract, not a precompile");

        (uint256 capacity, uint256 level) = IGhoToken(HOLLAR).getFacilitatorBucket(address(facilitator));
        assertEq(capacity, CAPACITY, "bucket granted");
        assertEq(level, 0, "and unused");
    }

    /// @dev A mint moves the real bucket, and the minted HOLLAR is the real token's balance.
    function test_mintMovesTheRealBucket() public onFork {
        _deliverMint(alice, 10_000e6, 1);

        assertEq(IGhoToken(HOLLAR).balanceOf(alice), 10_000e18, "real HOLLAR minted");
        assertEq(_level(), 10_000e18, "real bucket level moved");
        assertEq(facilitator.outstanding(), 10_000e18);
    }

    /// @dev The bucket ceiling is the token's, not ours. Past it the facilitator queues rather than
    ///      letting the real token revert on an attested deposit.
    function test_realBucketCeilingQueuesRatherThanReverting() public onFork {
        _deliverMint(alice, 240_000e6, 1);
        assertEq(_level(), 240_000e18);

        // 20,000 more would exceed a 250,000 bucket.
        _deliverMint(alice, 20_000e6, 2);

        assertEq(_level(), 240_000e18, "nothing minted past the ceiling");
        assertEq(facilitator.pendingOf(alice), 20_000e6, "queued instead");
        assertEq(IGhoToken(HOLLAR).balanceOf(alice), 240_000e18);
    }

    /// @dev THE solvency model, against the real token rather than a mock of it. `GhoToken.burn`
    ///      computes `bucketLevel - amount` with no floor, so this facilitator can never redeem
    ///      more than it minted — even holding HOLLAR that came from somewhere else entirely.
    function test_realBurnCannotExceedWhatThisFacilitatorMinted() public onFork {
        _deliverMint(alice, 10_000e6, 1);
        assertEq(_level(), 10_000e18);

        // Alice acquires HOLLAR this module never issued — borrowed, bought, HSM-minted.
        deal(HOLLAR, alice, IGhoToken(HOLLAR).balanceOf(alice) + 50_000e18);
        assertEq(IGhoToken(HOLLAR).balanceOf(alice), 60_000e18, "she holds far more than we minted");

        // Redeeming within the bucket is fine.
        _redeem(alice, 4_000e6, makeAddr("baseRecipient"));
        assertEq(_level(), 6_000e18, "real bucket decremented");

        // Past it, the real token's arithmetic refuses -- the facilitator's own check names it first.
        vm.expectRevert(
            abi.encodeWithSelector(IHollarBaseFacilitator.ExceedsBucketLevel.selector, 20_000e18, 6_000e18)
        );
        vm.prank(alice);
        facilitator.redeem(20_000e6, makeAddr("baseRecipient"), type(uint16).max, NO_DEADLINE, bytes32(0));

        assertEq(_level(), 6_000e18, "bucket untouched by the refusal");
    }

    /// @dev With the facilitator's own guard removed the real token must still refuse. This is what
    ///      makes the check above a convenience rather than the thing standing between us and
    ///      unbacked redemption.
    function test_realTokenRefusesEvenWithoutOurGuard() public onFork {
        _deliverMint(alice, 1_000e6, 1);

        // Burn straight through the token, bypassing the facilitator entirely.
        deal(HOLLAR, address(facilitator), 5_000e18);
        vm.prank(address(facilitator));
        vm.expectRevert();
        IGhoToken(HOLLAR).burn(5_000e18);

        assertEq(_level(), 1_000e18, "the floorless subtraction is the backstop");
    }

    /// @dev A full round of the corridor's arithmetic against the real token: every mint raises the
    ///      bucket by exactly usdc x scale, every redeem lowers it by the same, and no dust remains.
    function testFuzz_realBucketTracksUsdcExactly(uint96 mintUsdc, uint96 redeemUsdc) public onFork {
        uint256 m = bound(uint256(mintUsdc), 10e6, 200_000e6);
        uint256 r = bound(uint256(redeemUsdc), 10e6, m);

        _deliverMint(alice, m, 1);
        assertEq(_level(), m * SCALE, "bucket is exactly usdc x scale");

        _redeem(alice, r, makeAddr("baseRecipient"));
        assertEq(_level(), (m - r) * SCALE, "and comes back down exactly");
        assertEq(_level() % SCALE, 0, "no dust can strand");
    }

    // ─── redeemWithPermit against the real permit ───────────────

    /// @dev HOLLAR's `transferFrom` asks this delegated token, the HDX precompile, for an allowance
    ///      first and falls back to its own when that does not cover the amount. The precompile
    ///      answers per (owner, spender): unlimited for an approved contract, otherwise what the owner
    ///      approved there (hydration-node a35840f0, multicurrency.rs:257-264); live it read 0 for
    ///      the deployed facilitator (eth_call, 2026-10-30). Here it is a stub anvil cannot call, so
    ///      that one read is pinned. HOLLAR's own `permit`, allowance, `transferFrom` and `burn` run.
    address internal constant DELEGATED_TOKEN = 0x0000000000000000000000000000000100000000;

    function _signPermit(uint256 key, address owner, uint256 value, uint64 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = IGhoToken(HOLLAR).nonces(owner);
        bytes32 permitHash = HollarPermit.structHash(owner, address(facilitator), value, nonce, deadline);
        return vm.sign(key, HollarPermit.digest(HOLLAR, permitHash));
    }

    function _redeemWithPermit(address from, uint256 usdcAmount, uint64 deadline, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        vm.mockCall(DELEGATED_TOKEN, abi.encodeWithSelector(IERC20.allowance.selector), abi.encode(uint256(0)));
        vm.prank(from);
        facilitator.redeemWithPermit(usdcAmount, makeAddr("baseRecipient"), type(uint16).max, deadline, bytes32(0), v, r, s);
        vm.clearMockedCalls();
    }

    /// @dev One signature, one call, against the live token: the permit's domain is the token's,
    ///      its allowance is the one `transferFrom` spends, and the burn moves the real bucket.
    function test_redeemWithPermit_realHollarPermit() public onFork {
        (address holder, uint256 key) = makeAddrAndKey("holder");
        _deliverMint(holder, 1_000e6, 1);
        assertEq(IGhoToken(HOLLAR).DOMAIN_SEPARATOR(), HollarPermit.domain(HOLLAR), "we sign the live domain");

        uint64 deadline = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(key, holder, 400e18, deadline);
        _redeemWithPermit(holder, 400e6, deadline, v, r, s);

        assertEq(IGhoToken(HOLLAR).balanceOf(holder), 600e18, "real HOLLAR pulled and burned");
        assertEq(_level(), 600e18, "real bucket decremented");
        assertEq(IGhoToken(HOLLAR).allowance(holder, address(facilitator)), 0, "the permit's allowance is spent");
        assertEq(IGhoToken(HOLLAR).nonces(holder), 1, "the real nonce moved");

        // The same signed call again: the nonce is used and the allowance is gone.
        vm.mockCall(DELEGATED_TOKEN, abi.encodeWithSelector(IERC20.allowance.selector), abi.encode(uint256(0)));
        vm.expectRevert(abi.encodeWithSelector(IHollarBaseFacilitator.PermitFailed.selector, 0, 400e18));
        vm.prank(holder);
        facilitator.redeemWithPermit(400e6, makeAddr("baseRecipient"), type(uint16).max, deadline, bytes32(0), v, r, s);
        vm.clearMockedCalls();
        assertEq(_level(), 600e18, "nothing burned twice");
    }

    /// @dev The bound on the delegated path. An owner who approved the facilitator on the HDX
    ///      precompile burns on that approval, so the permit's allowance is left unspent. It is the
    ///      owner's, to the facilitator only: nobody else can draw on it, and the facilitator pulls
    ///      only from its caller.
    function test_redeemWithPermit_ownersPrecompileApprovalLeavesThePermitUnspent() public onFork {
        (address holder, uint256 key) = makeAddrAndKey("holder");
        _deliverMint(holder, 1_000e6, 1);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(key, holder, 400e18, deadline);

        vm.mockCall(
            DELEGATED_TOKEN,
            abi.encodeWithSelector(IERC20.allowance.selector, holder, address(facilitator)),
            abi.encode(uint256(type(uint128).max))
        );
        vm.prank(holder);
        facilitator.redeemWithPermit(400e6, makeAddr("baseRecipient"), type(uint16).max, deadline, bytes32(0), v, r, s);
        vm.clearMockedCalls();

        assertEq(_level(), 600e18, "the burn happened");
        assertEq(IGhoToken(HOLLAR).nonces(holder), 1, "the permit applied");
        assertEq(IGhoToken(HOLLAR).allowance(holder, address(facilitator)), 400e18, "and stayed unspent");

        // Another caller cannot reach it: the facilitator pulls from msg.sender, who has nothing.
        address eve = makeAddr("eve");
        vm.mockCall(DELEGATED_TOKEN, abi.encodeWithSelector(IERC20.allowance.selector), abi.encode(uint256(0)));
        vm.expectRevert();
        vm.prank(eve);
        facilitator.redeem(400e6, makeAddr("baseRecipient"), type(uint16).max, NO_DEADLINE, bytes32(0));
        vm.clearMockedCalls();
        assertEq(IGhoToken(HOLLAR).allowance(holder, address(facilitator)), 400e18, "still the holder's");
    }
}
