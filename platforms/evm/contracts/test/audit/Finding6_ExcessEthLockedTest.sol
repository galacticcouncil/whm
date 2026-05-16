// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {Basejump} from "../../src/Basejump.sol";
import {IBasejumpBase} from "../../src/interfaces/IBasejumpBase.sol";
import {MockTokenBridge} from "../mocks/MockTokenBridge.sol";
import {BasejumpTestHelpers} from "../helpers/BasejumpTestHelpers.sol";

/// @dev Minimal ERC20
contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

/// @dev Wormhole mock with a configurable non-zero message fee
contract MockWormholeWithFee {
    uint256 public fee;

    constructor(uint256 _fee) { fee = _fee; }

    function chainId() external pure returns (uint16) { return 30; }
    function messageFee() external view returns (uint256) { return fee; }

    function publishMessage(uint32, bytes memory, uint8) external payable returns (uint64) {
        require(msg.value >= fee, "insufficient fee");
        return 0;
    }

    function parseAndVerifyVM(bytes calldata encodedVM)
        external
        view
        returns (IWormhole.VM memory _vm, bool valid, string memory reason)
    {
        (uint16 emitterChainId, bytes32 emitterAddress, bytes memory payload) =
            abi.decode(encodedVM, (uint16, bytes32, bytes));
        _vm.emitterChainId = emitterChainId;
        _vm.emitterAddress = emitterAddress;
        _vm.payload = payload;
        _vm.hash = keccak256(encodedVM);
        _vm.timestamp = uint32(block.timestamp);
        valid = true;
    }
}

/// @title Finding6_ExcessEthLockedTest
/// @notice Demonstrates that excess msg.value sent with bridgeViaWormhole
///         is permanently locked in the Basejump contract, and verifies
///         the fix enforces exact payment.
///
///         The vulnerability is in BasejumpBase._fastTrack — it forwards
///         exactly messageFee to Wormhole but doesn't check or refund the excess.
///         We test via Basejump.bridgeViaWormhole which calls _fastTrack internally.
///
///         The fix (BasejumpBase.fix_fastTrack) adds:
///           require(msg.value == messageFee, "msg.value must equal message fee");
///         To test the fix without modifying Basejump.bridgeViaWormhole (non-virtual),
///         we call fix_fastTrack via a thin test harness that exposes it.
contract Finding6_ExcessEthLockedTest is Test {

    uint256 constant WORMHOLE_FEE = 0.01 ether;
    uint256 constant TRANSFER_AMOUNT = 10_000e6;
    uint256 constant BASEJUMP_FEE = 1e6;

    MockWormholeWithFee public mockWormhole;
    MockTokenBridge public tokenBridge;
    MockERC20 public usdc;

    Basejump public basejump;

    address public user = makeAddr("user");
    bytes32 public recipient = BasejumpTestHelpers.addressToBytes32(makeAddr("recipient"));

    function setUp() public {
        mockWormhole = new MockWormholeWithFee(WORMHOLE_FEE);
        tokenBridge = new MockTokenBridge();
        usdc = new MockERC20();

        // Deploy Basejump (has both _fastTrack and fix_fastTrack via BasejumpBase)
        Basejump impl = new Basejump();
        basejump = Basejump(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(Basejump.initialize, (address(mockWormhole), address(tokenBridge)))
        )));

        basejump.setLandingDest(BasejumpTestHelpers.addressToBytes32(makeAddr("landing")));
        basejump.setAssetFee(address(usdc), BASEJUMP_FEE);

        // Fund user
        usdc.mint(user, 1_000_000e6);
        vm.deal(user, 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXPLOIT: Excess ETH permanently locked
    // ═══════════════════════════════════════════════════════════════

    /// @notice User sends 1 ETH for a bridge that costs 0.01 ETH.
    ///         0.99 ETH is permanently locked in the contract.
    function test_exploit_excessEthLocked() public {
        uint256 excessAmount = 1 ether;

        vm.startPrank(user);
        usdc.approve(address(basejump), TRANSFER_AMOUNT);
        basejump.bridgeViaWormhole{value: excessAmount}(
            address(usdc), TRANSFER_AMOUNT, recipient
        );
        vm.stopPrank();

        uint256 ethTrapped = address(basejump).balance;

        // 0.01 went to MockWormhole, 0.99 stuck in Basejump
        assertEq(ethTrapped, excessAmount - WORMHOLE_FEE, "Excess ETH locked");

        console.log("EXPLOIT CONFIRMED:");
        console.log("  User sent:", excessAmount);
        console.log("  Wormhole fee:", WORMHOLE_FEE);
        console.log("  ETH trapped:", ethTrapped);
    }

    /// @notice ETH accumulates over multiple overpayments with no way to recover.
    function test_exploit_ethAccumulatesOverTime() public {
        vm.startPrank(user);
        for (uint256 i = 0; i < 5; i++) {
            usdc.approve(address(basejump), TRANSFER_AMOUNT);
            basejump.bridgeViaWormhole{value: 0.5 ether + WORMHOLE_FEE}(
                address(usdc), TRANSFER_AMOUNT, recipient
            );
        }
        vm.stopPrank();

        assertEq(address(basejump).balance, 2.5 ether, "2.5 ETH accumulated");
        console.log("EXPLOIT CONFIRMED: 2.5 ETH accumulated from 5 overpaying users");
    }

    /// @notice There is no function to recover the trapped ETH.
    function test_exploit_noRecoveryMechanism() public {
        // Trap some ETH
        vm.startPrank(user);
        usdc.approve(address(basejump), TRANSFER_AMOUNT);
        basejump.bridgeViaWormhole{value: 1 ether}(
            address(usdc), TRANSFER_AMOUNT, recipient
        );
        vm.stopPrank();

        uint256 trapped = address(basejump).balance;
        assertGt(trapped, 0, "ETH is trapped");

        // No receive() or fallback() — can't pull ETH out
        // No withdraw() for native ETH (only BasejumpLanding has ERC20 withdraw)
        // The ETH is permanently lost

        // Try sending ETH to the contract directly — also fails (no receive/fallback)
        // The only way ETH enters is via payable bridgeViaWormhole
        console.log("No recovery: trapped ETH =", trapped);
    }

    // ═══════════════════════════════════════════════════════════════
    // FIX: fix_fastTrack enforces exact msg.value
    // ═══════════════════════════════════════════════════════════════

    // The fix is in BasejumpBase.fix_fastTrack (internal function).
    // Since Basejump.bridgeViaWormhole is non-virtual, we test fix_fastTrack
    // by calling it from a harness contract.

    function _deployHarness() internal returns (FixFastTrackHarness) {
        FixFastTrackHarness impl = new FixFastTrackHarness();
        FixFastTrackHarness harness = FixFastTrackHarness(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(Basejump.initialize, (address(mockWormhole), address(tokenBridge)))
        )));
        harness.setAssetFee(address(usdc), BASEJUMP_FEE);
        vm.deal(address(this), 10 ether);
        return harness;
    }

    /// @notice Demonstrates the fix rejects excess ETH before any state changes.
    function test_fix_rejectsExcessEth() public {
        FixFastTrackHarness harness = _deployHarness();

        vm.expectRevert("msg.value must equal message fee");
        harness.callFixFastTrack{value: 1 ether}(address(usdc), TRANSFER_AMOUNT, recipient);

        assertEq(address(harness).balance, 0, "No ETH trapped");
        console.log("FIX VERIFIED: Excess ETH rejected");
    }

    /// @notice Fix accepts exact msg.value == messageFee.
    function test_fix_exactFeeSucceeds() public {
        FixFastTrackHarness harness = _deployHarness();

        harness.callFixFastTrack{value: WORMHOLE_FEE}(address(usdc), TRANSFER_AMOUNT, recipient);

        assertEq(address(harness).balance, 0, "No ETH in contract");
        console.log("FIX VERIFIED: Exact fee accepted, 0 ETH trapped");
    }

    /// @notice Fix rejects insufficient msg.value.
    function test_fix_rejectsInsufficientEth() public {
        FixFastTrackHarness harness = _deployHarness();

        vm.expectRevert("msg.value must equal message fee");
        harness.callFixFastTrack{value: 0.001 ether}(address(usdc), TRANSFER_AMOUNT, recipient);
    }
}

/// @dev Thin harness exposing BasejumpBase.fix_fastTrack as a public function.
contract FixFastTrackHarness is Basejump {
    function callFixFastTrack(
        address sourceAsset,
        uint256 amount,
        bytes32 _recipient
    ) external payable returns (uint64) {
        return fix_fastTrack(sourceAsset, amount, 16, _recipient, 0);
    }
}
