// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpEmitter} from "../../src/basejump/BasejumpEmitter.sol";
import {IBasejumpEmitter} from "../../src/basejump/interfaces/IBasejumpEmitter.sol";

import {MockWormhole} from "../mocks/MockWormhole.sol";
import {MockNttManager} from "../mocks/MockNttManager.sol";
import {BasejumpTestHelpers} from "../helpers/BasejumpTestHelpers.sol";

/// @dev Minimal ERC20 with mint
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient allowance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

/// @title BasejumpEmitterTest
/// @notice Pins the NTT settlement leg of BasejumpEmitter.bridgeViaWormhole — specifically the
///         fail-closed property the whole design rests on: settlement is attempted BEFORE
///         the fast-path message is published, so a settlement failure can never leave a
///         payout instruction in flight against an unreplenished pool.
contract BasejumpEmitterTest is Test, MockWormhole {
    // ─── Message core mock ──────────────────────────────────────────

    uint64 private _nextSequence;

    /// @dev Sentinel. Asserting `publishCount == 0` after a revert proves nothing — the
    ///      counter reverts with everything else. Making publishMessage itself revert with a
    ///      distinct error is what actually discriminates "reverted BEFORE publish" from
    ///      "reverted at or after publish".
    bool public failOnPublish;

    error PublishReached();

    /// @dev The consistency argument of the most recent publishMessage call, and how many calls.
    uint8 public lastConsistency;
    uint256 public publishCount;

    function chainId() external pure returns (uint16) {
        return BASE_CHAIN_ID;
    }

    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function publishMessage(uint32, bytes memory, uint8 consistency) external payable returns (uint64 sequence) {
        if (failOnPublish) revert PublishReached();
        lastConsistency = consistency;
        publishCount++;
        sequence = _nextSequence;
        _nextSequence++;
    }

    // ─── Constants ──────────────────────────────────────────────────

    uint16 constant BASE_CHAIN_ID = 30;
    uint16 constant HYDRATION_CHAIN_ID = 73;

    uint256 constant TRANSFER_AMOUNT = 1_000e6;
    uint256 constant BASEJUMP_FEE = 1e5;

    /// @dev The levels the migrations pass: basejump-base 001 (from FAST_PATH_CONSISTENCY_BASE)
    ///      and basejump-ethereum 001 (hardcoded). Literals, not the contract's constants, so a
    ///      changed constant cannot move the expectation with it.
    uint8 constant BASE_CONSISTENCY = 201;
    uint8 constant ETHEREUM_CONSISTENCY = 200;

    // ─── Fixtures ───────────────────────────────────────────────────

    BasejumpEmitter public emitter;
    MockNttManager public nttManager;
    MockERC20 public eurc;
    MockERC20 public unroutedToken;

    address public user = makeAddr("user");
    address public landingAddr = makeAddr("hydrationLanding");
    bytes32 public landing;
    bytes32 public recipient = bytes32(uint256(0xB0B));

    function setUp() public {
        eurc = new MockERC20();
        unroutedToken = new MockERC20();
        landing = BasejumpTestHelpers.addressToBytes32(landingAddr);

        nttManager = new MockNttManager(address(eurc));
        // The Base EURC corridor's deployment: safe (201).
        emitter = _deployArmed(BASE_CONSISTENCY);

        eurc.mint(user, TRANSFER_AMOUNT);
        unroutedToken.mint(user, TRANSFER_AMOUNT);
    }

    /// @dev Implementation built with `level`, behind a proxy, wired as the migrations wire it.
    function _deployArmed(uint8 level) internal returns (BasejumpEmitter e) {
        BasejumpEmitter impl = new BasejumpEmitter(level);
        // tokenBridge = 0x0 — the NTT path must never touch it. Any read would revert here.
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(BasejumpEmitter.initialize, (address(this))));
        e = BasejumpEmitter(address(proxy));

        e.setLanding(landing);
        e.setNttManager(address(eurc), address(nttManager));
        e.setAssetFee(address(eurc), BASEJUMP_FEE);
    }

    function _bridge(MockERC20 token, uint256 amount, uint256 value) internal {
        vm.startPrank(user);
        token.approve(address(emitter), amount);
        emitter.bridgeViaWormhole{value: value}(address(token), amount, recipient, "");
        vm.stopPrank();
    }

    // ─── Fail-closed ────────────────────────────────────────────────

    /// @notice A paused settlement rail must abort the call before anything is published.
    function testPausedManagerRevertsBeforePublishing() public {
        nttManager.setPaused(true);
        failOnPublish = true;

        vm.startPrank(user);
        eurc.approve(address(emitter), TRANSFER_AMOUNT);
        // TransferPaused, not PublishReached — settlement is attempted first.
        vm.expectRevert(MockNttManager.TransferPaused.selector);
        emitter.bridgeViaWormhole(address(eurc), TRANSFER_AMOUNT, recipient, "");
        vm.stopPrank();

        assertEq(eurc.balanceOf(user), TRANSFER_AMOUNT, "user must keep their tokens");
    }

    /// @notice An outbound rate-limit breach must revert the whole call, never publish a
    ///         payout the settlement leg cannot back. The 3-arg NTT transfer overload
    ///         hardcodes shouldQueue=false precisely so this fails rather than queues.
    function testCapacityBreachRevertsBeforePublishing() public {
        nttManager.setOutboundCapacity(TRANSFER_AMOUNT - 1);
        failOnPublish = true;

        vm.startPrank(user);
        eurc.approve(address(emitter), TRANSFER_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockNttManager.NotEnoughCapacity.selector, TRANSFER_AMOUNT - 1, TRANSFER_AMOUNT
            )
        );
        emitter.bridgeViaWormhole(address(eurc), TRANSFER_AMOUNT, recipient, "");
        vm.stopPrank();

        assertEq(eurc.balanceOf(user), TRANSFER_AMOUNT, "user must keep their tokens");
        assertEq(eurc.balanceOf(address(nttManager)), 0, "nothing may be locked");
    }

    // ─── Guards ─────────────────────────────────────────────────────

    /// @notice An asset with no registered manager has no settlement rail — reject it
    ///         rather than pay out against one that will never be replenished.
    function testUnroutedAssetReverts() public {
        failOnPublish = true;

        vm.startPrank(user);
        unroutedToken.approve(address(emitter), TRANSFER_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpEmitter.SettlementRouteNotSet.selector, address(unroutedToken))
        );
        emitter.bridgeViaWormhole(address(unroutedToken), TRANSFER_AMOUNT, recipient, "");
        vm.stopPrank();

        assertEq(unroutedToken.balanceOf(user), TRANSFER_AMOUNT, "user must keep their tokens");
    }

    /// @notice setLanding(0) is how a deployment is disarmed. It must revert before the
    ///         transferFrom, so a disarmed contract cannot strand a caller's funds.
    function testUnsetLandingDestRevertsBeforePullingTokens() public {
        emitter.setLanding(bytes32(0));
        failOnPublish = true;

        vm.startPrank(user);
        eurc.approve(address(emitter), TRANSFER_AMOUNT);
        vm.expectRevert(
            IBasejumpEmitter.LandingNotSet.selector
        );
        emitter.bridgeViaWormhole(address(eurc), TRANSFER_AMOUNT, recipient, "");
        vm.stopPrank();

        assertEq(eurc.balanceOf(user), TRANSFER_AMOUNT, "no token may be pulled");
        assertEq(eurc.balanceOf(address(emitter)), 0, "no token may be pulled");
    }

    // ─── Happy path ─────────────────────────────────────────────────

    /// @notice The quoted delivery price must reach the manager as msg.value, and settlement
    ///         must be addressed to landing on destChain.
    function testDeliveryPriceForwardedAndRouteApplied() public {
        uint256 price = 0.01 ether;
        nttManager.setDeliveryPrice(price);
        vm.deal(user, price);

        _bridge(eurc, TRANSFER_AMOUNT, price);

        assertEq(address(nttManager).balance, price, "delivery price not forwarded");

        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(0);
        assertEq(settled.amount, TRANSFER_AMOUNT, "settlement must carry gross");
        assertEq(settled.recipientChain, HYDRATION_CHAIN_ID, "wrong settlement chain");
        assertEq(settled.recipient, landing, "settlement must be addressed to the landing");
    }

    /// @notice No allowance may survive a settled transfer — a lingering approval to an
    ///         external manager is standing authority over whatever the contract later holds.
    function testNoLingeringApprovalAfterSettlement() public {
        _bridge(eurc, TRANSFER_AMOUNT, 0);

        assertEq(eurc.allowance(address(emitter), address(nttManager)), 0, "stale approval left");
    }

    // ─── Consistency level (per deployment) ─────────────────────────

    /// @notice The Base deployment publishes its fast-path message at safe (201): the level
    ///         reaches publishMessage, read from the mock core's received argument.
    function testBaseDeploymentPublishesAtSafe() public {
        assertEq(emitter.CONSISTENCY_LEVEL(), BASE_CONSISTENCY, "getter must report the level");

        _bridge(eurc, TRANSFER_AMOUNT, 0);

        assertEq(publishCount, 1, "exactly one fast-path message");
        assertEq(lastConsistency, BASE_CONSISTENCY, "Base fast path must publish at safe (201)");
    }

    /// @notice An implementation built with the Ethereum migration's argument publishes at
    ///         instant (200), so an Ethereum upgrade built from this source keeps 200.
    function testEthereumConfigDeploymentPublishesAtInstant() public {
        emitter = _deployArmed(ETHEREUM_CONSISTENCY);
        assertEq(emitter.CONSISTENCY_LEVEL(), ETHEREUM_CONSISTENCY, "getter must report the level");

        _bridge(eurc, TRANSFER_AMOUNT, 0);

        assertEq(publishCount, 1, "exactly one fast-path message");
        assertEq(lastConsistency, ETHEREUM_CONSISTENCY, "Ethereum fast path must publish at instant (200)");
    }

    /// @notice The level is the implementation's: a proxy upgraded to an implementation built
    ///         with another level publishes at the new one, with storage untouched.
    function testUpgradeTakesTheNewImplementationsLevel() public {
        emitter.upgradeToAndCall(address(new BasejumpEmitter(ETHEREUM_CONSISTENCY)), "");
        assertEq(emitter.landing(), landing, "storage must survive the upgrade");

        _bridge(eurc, TRANSFER_AMOUNT, 0);
        assertEq(lastConsistency, ETHEREUM_CONSISTENCY, "upgrade must carry the new level");
    }

    /// @notice Only 200 and 201 are accepted. The guardian watcher reads any other value as
    ///         finalized (and 202 is the explicit finalized level), so each would silently turn
    ///         the fast path into a ~20 min one.
    function testConstructorRejectsOtherLevels() public {
        uint8[4] memory bad = [uint8(0), 1, 202, 255];
        for (uint256 i = 0; i < bad.length; i++) {
            try new BasejumpEmitter(bad[i]) returns (BasejumpEmitter built) {
                fail(string.concat("constructor accepted level ", vm.toString(built.CONSISTENCY_LEVEL())));
            } catch (bytes memory err) {
                assertEq(
                    err,
                    abi.encodeWithSelector(BasejumpEmitter.UnsupportedConsistencyLevel.selector, bad[i]),
                    "wrong revert"
                );
            }
        }
    }
}
