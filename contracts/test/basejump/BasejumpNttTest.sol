// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {Basejump} from "../../src/basejump/Basejump.sol";
import {IBasejump} from "../../src/basejump/interfaces/IBasejump.sol";
import {IBasejumpCore} from "../../src/basejump/interfaces/IBasejumpCore.sol";

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

/// @title BasejumpNttTest
/// @notice Pins the NTT settlement leg of Basejump.bridgeViaWormhole — specifically the
///         fail-closed property the whole design rests on: settlement is attempted BEFORE
///         the fast-path message is published, so a settlement failure can never leave a
///         payout instruction in flight against an unreplenished pool.
contract BasejumpNttTest is Test, MockWormhole {
    // ─── Message core mock ──────────────────────────────────────────

    uint64 private _nextSequence;

    /// @dev Sentinel. Asserting `publishCount == 0` after a revert proves nothing — the
    ///      counter reverts with everything else. Making publishMessage itself revert with a
    ///      distinct error is what actually discriminates "reverted BEFORE publish" from
    ///      "reverted at or after publish".
    bool public failOnPublish;

    error PublishReached();

    function chainId() external pure returns (uint16) {
        return BASE_CHAIN_ID;
    }

    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function publishMessage(uint32, bytes memory, uint8) external payable returns (uint64 sequence) {
        if (failOnPublish) revert PublishReached();
        sequence = _nextSequence;
        _nextSequence++;
    }

    // ─── Constants ──────────────────────────────────────────────────

    uint16 constant BASE_CHAIN_ID = 30;
    uint16 constant HYDRATION_CHAIN_ID = 73;

    uint256 constant TRANSFER_AMOUNT = 1_000e6;
    uint256 constant BASEJUMP_FEE = 1e5;

    // ─── Fixtures ───────────────────────────────────────────────────

    Basejump public basejump;
    MockNttManager public nttManager;
    MockERC20 public eurc;
    MockERC20 public unroutedToken;

    address public user = makeAddr("user");
    address public landingDestAddr = makeAddr("hydrationLanding");
    bytes32 public landingDest;
    bytes32 public recipient = bytes32(uint256(0xB0B));

    function setUp() public {
        eurc = new MockERC20();
        unroutedToken = new MockERC20();
        landingDest = BasejumpTestHelpers.addressToBytes32(landingDestAddr);

        Basejump impl = new Basejump();
        // tokenBridge = 0x0 — the NTT path must never touch it. Any read would revert here.
        ERC1967Proxy proxy =
            new ERC1967Proxy(address(impl), abi.encodeCall(Basejump.initialize, (address(this), address(0))));
        basejump = Basejump(address(proxy));

        nttManager = new MockNttManager(address(eurc));

        basejump.setLandingDest(landingDest);
        basejump.setNttManager(address(eurc), address(nttManager));
        basejump.setAssetFee(address(eurc), BASEJUMP_FEE);

        eurc.mint(user, TRANSFER_AMOUNT);
        unroutedToken.mint(user, TRANSFER_AMOUNT);
    }

    function _bridge(MockERC20 token, uint256 amount, uint256 value) internal {
        vm.startPrank(user);
        token.approve(address(basejump), amount);
        basejump.bridgeViaWormhole{value: value}(address(token), amount, recipient, "");
        vm.stopPrank();
    }

    // ─── Fail-closed ────────────────────────────────────────────────

    /// @notice A paused settlement rail must abort the call before anything is published.
    function testPausedManagerRevertsBeforePublishing() public {
        nttManager.setPaused(true);
        failOnPublish = true;

        vm.startPrank(user);
        eurc.approve(address(basejump), TRANSFER_AMOUNT);
        // TransferPaused, not PublishReached — settlement is attempted first.
        vm.expectRevert(MockNttManager.TransferPaused.selector);
        basejump.bridgeViaWormhole(address(eurc), TRANSFER_AMOUNT, recipient, "");
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
        eurc.approve(address(basejump), TRANSFER_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(
                MockNttManager.NotEnoughCapacity.selector, TRANSFER_AMOUNT - 1, TRANSFER_AMOUNT
            )
        );
        basejump.bridgeViaWormhole(address(eurc), TRANSFER_AMOUNT, recipient, "");
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
        unroutedToken.approve(address(basejump), TRANSFER_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IBasejump.SettlementRouteNotSet.selector, address(unroutedToken))
        );
        basejump.bridgeViaWormhole(address(unroutedToken), TRANSFER_AMOUNT, recipient, "");
        vm.stopPrank();

        assertEq(unroutedToken.balanceOf(user), TRANSFER_AMOUNT, "user must keep their tokens");
    }

    /// @notice setLandingDest(0) is how a deployment is disarmed. It must revert before the
    ///         transferFrom, so a disarmed contract cannot strand a caller's funds.
    function testUnsetLandingDestRevertsBeforePullingTokens() public {
        basejump.setLandingDest(bytes32(0));
        failOnPublish = true;

        vm.startPrank(user);
        eurc.approve(address(basejump), TRANSFER_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpCore.BasejumpLandingNotSet.selector, HYDRATION_CHAIN_ID)
        );
        basejump.bridgeViaWormhole(address(eurc), TRANSFER_AMOUNT, recipient, "");
        vm.stopPrank();

        assertEq(eurc.balanceOf(user), TRANSFER_AMOUNT, "no token may be pulled");
        assertEq(eurc.balanceOf(address(basejump)), 0, "no token may be pulled");
    }

    // ─── Happy path ─────────────────────────────────────────────────

    /// @notice The quoted delivery price must reach the manager as msg.value, and settlement
    ///         must be addressed to landingDest on destChain.
    function testDeliveryPriceForwardedAndRouteApplied() public {
        uint256 price = 0.01 ether;
        nttManager.setDeliveryPrice(price);
        vm.deal(user, price);

        _bridge(eurc, TRANSFER_AMOUNT, price);

        assertEq(address(nttManager).balance, price, "delivery price not forwarded");

        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(0);
        assertEq(settled.amount, TRANSFER_AMOUNT, "settlement must carry gross");
        assertEq(settled.recipientChain, HYDRATION_CHAIN_ID, "wrong settlement chain");
        assertEq(settled.recipient, landingDest, "settlement must be addressed to landingDest");
    }

    /// @notice No allowance may survive a settled transfer — a lingering approval to an
    ///         external manager is standing authority over whatever the contract later holds.
    function testNoLingeringApprovalAfterSettlement() public {
        _bridge(eurc, TRANSFER_AMOUNT, 0);

        assertEq(eurc.allowance(address(basejump), address(nttManager)), 0, "stale approval left");
    }
}
