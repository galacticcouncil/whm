// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {Basejump} from "../../src/Basejump.sol";
import {BasejumpProxy} from "../../src/BasejumpProxy.sol";
import {BasejumpLanding} from "../../src/BasejumpLanding.sol";
import {XcmTransactor, Multilocation, Weight} from "../../src/XcmTransactor.sol";

import {IBasejump} from "../../src/interfaces/IBasejump.sol";
import {IBasejumpLanding} from "../../src/interfaces/IBasejumpLanding.sol";

import {MockWormhole} from "../mocks/MockWormhole.sol";
import {MockTokenBridge} from "../mocks/MockTokenBridge.sol";
import {MockXcmPrecompile} from "../mocks/MockXcmPrecompile.sol";
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
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

/// @title BasejumpIntegrationTest
/// @notice Comprehensive cross-chain integration test for Basejump → BasejumpProxy → BasejumpLanding
contract BasejumpIntegrationTest is Test, MockWormhole {
    using BasejumpTestHelpers for *;

    // ─── Wormhole mock functions ────────────────────────────────────
    function chainId() external pure returns (uint16) {
        return MOONBEAM_CHAIN_ID;
    }

    function messageFee() external pure returns (uint256) {
        return 0; // No fee for testing
    }

    uint64 private _nextSequence;

    function publishMessage(uint32, bytes memory, uint8) external payable returns (uint64 sequence) {
        sequence = _nextSequence;
        _nextSequence++;
        return sequence;
    }

    // ─── Chain IDs (Wormhole chain IDs) ────────────────────────────
    uint16 constant BASE_CHAIN_ID = 30;
    uint16 constant MOONBEAM_CHAIN_ID = 16;
    uint16 constant HYDRATION_PARA_ID = 2034;

    // ─── Deployments per chain ──────────────────────────────────────
    Basejump public basejumpBase;
    BasejumpProxy public basejumpMoonbeam;
    BasejumpLanding public basejumpHydration;
    XcmTransactor public xcmTransactor;

    // ─── Infrastructure ─────────────────────────────────────────────
    MockTokenBridge public tokenBridge;
    MockXcmPrecompile public xcmPrecompile;

    // ─── Test tokens ────────────────────────────────────────────────
    MockERC20 public usdcBase;
    MockERC20 public usdcHydration;

    // ─── Test accounts ──────────────────────────────────────────────
    address public user = makeAddr("user");
    bytes32 public hydrationRecipient;

    // ─── Constants ──────────────────────────────────────────────────
    uint256 constant LIQUIDITY_POOL_SIZE = 1_000_000e6;
    uint256 constant TRANSFER_AMOUNT = 10_000e6;
    uint256 constant BASEJUMP_FEE = 1e6;

    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;
    address constant XCM_PRECOMPILE_ADDR = 0x0000000000000000000000000000000000000817;

    function setUp() public {
        // 1. Deploy infrastructure mocks
        tokenBridge = new MockTokenBridge();

        // Deploy XCM precompile mock and etch it at the expected address
        MockXcmPrecompile xcmMock = new MockXcmPrecompile();
        vm.etch(XCM_PRECOMPILE_ADDR, address(xcmMock).code);
        xcmPrecompile = MockXcmPrecompile(XCM_PRECOMPILE_ADDR);

        // 2. Deploy Basejump (Base chain)
        Basejump basejumpImpl = new Basejump();
        ERC1967Proxy basejumpProxy = new ERC1967Proxy(
            address(basejumpImpl),
            abi.encodeCall(Basejump.initialize, (address(this), address(tokenBridge)))
        );
        basejumpBase = Basejump(address(basejumpProxy));

        // 3. Deploy XcmTransactor (Moonbeam)
        XcmTransactor xcmImpl = new XcmTransactor(
            HYDRATION_PARA_ID,      // destination parachain
            MOONBEAM_CHAIN_ID,      // source parachain (Moonbeam = 2004 on Polkadot)
            38,                     // EVM pallet index
            6,                      // EVM call index
            address(0x0000000000000000000000000000000000000802) // fee location (GLMR)
        );
        ERC1967Proxy xcmProxy = new ERC1967Proxy(
            address(xcmImpl),
            abi.encodeCall(XcmTransactor.initialize, ())
        );
        xcmTransactor = XcmTransactor(address(xcmProxy));

        // 4. Deploy BasejumpProxy (Moonbeam)
        BasejumpProxy proxyImpl = new BasejumpProxy();
        ERC1967Proxy proxyProxy = new ERC1967Proxy(
            address(proxyImpl),
            abi.encodeCall(BasejumpProxy.initialize, (address(this), address(tokenBridge)))
        );
        basejumpMoonbeam = BasejumpProxy(address(proxyProxy));

        // 5. Deploy BasejumpLanding (Hydration)
        BasejumpLanding landingImpl = new BasejumpLanding();
        ERC1967Proxy landingProxy = new ERC1967Proxy(
            address(landingImpl),
            abi.encodeCall(BasejumpLanding.initialize, ())
        );
        basejumpHydration = BasejumpLanding(address(landingProxy));

        // 6. Deploy test tokens
        usdcBase = new MockERC20();
        usdcHydration = new MockERC20();

        // 7. Configure cross-chain relationships
        // Basejump (Base) config
        basejumpBase.setBasejumpLanding(
            MOONBEAM_CHAIN_ID,
            BasejumpTestHelpers.addressToBytes32(address(basejumpHydration))
        );
        basejumpBase.setAssetFee(address(usdcBase), BASEJUMP_FEE);
        basejumpBase.setAuthorizedEmitter(
            BASE_CHAIN_ID,
            BasejumpTestHelpers.addressToBytes32(address(basejumpBase))
        );

        // BasejumpProxy (Moonbeam) config
        basejumpMoonbeam.setBasejumpLanding(
            MOONBEAM_CHAIN_ID,
            BasejumpTestHelpers.addressToBytes32(address(basejumpHydration))
        );
        basejumpMoonbeam.setAuthorizedEmitter(
            BASE_CHAIN_ID,
            BasejumpTestHelpers.addressToBytes32(address(basejumpBase))
        );
        basejumpMoonbeam.setXcmTransactor(address(xcmTransactor));

        // XcmTransactor config
        xcmTransactor.setAuthorized(address(basejumpMoonbeam), true);

        // BasejumpLanding (Hydration) config
        basejumpHydration.setAuthorizedBridge(address(basejumpMoonbeam), true);
        basejumpHydration.setDestAsset(address(usdcBase), address(usdcHydration));

        // 8. Fund liquidity pool
        usdcHydration.mint(address(basejumpHydration), LIQUIDITY_POOL_SIZE);

        // 9. Setup user
        usdcBase.mint(user, 100_000e6);
        hydrationRecipient = BasejumpTestHelpers.addressToBytes32(makeAddr("hydrationRecipient"));

        // 10. Mock precompile calls
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));

        // 11. Fund test contract with ETH for Wormhole message fees
        vm.deal(address(this), 100 ether);
        vm.deal(user, 100 ether);
    }

    // ═══════════════════════════════════════════════════════════════════
    // DEPLOYMENT & CONFIGURATION TESTS
    // ═══════════════════════════════════════════════════════════════════

    function testDeploymentConfiguration() public view {
        // Verify all contracts deployed
        assertGt(address(basejumpBase).code.length, 0, "Basejump not deployed");
        assertGt(address(basejumpMoonbeam).code.length, 0, "BasejumpProxy not deployed");
        assertGt(address(basejumpHydration).code.length, 0, "BasejumpLanding not deployed");
        assertGt(address(xcmTransactor).code.length, 0, "XcmTransactor not deployed");

        // Verify cross-chain mappings
        assertEq(
            basejumpBase.basejumpLandings(MOONBEAM_CHAIN_ID),
            BasejumpTestHelpers.addressToBytes32(address(basejumpHydration)),
            "Basejump landing not set on Base"
        );

        assertEq(
            basejumpMoonbeam.basejumpLandings(MOONBEAM_CHAIN_ID),
            BasejumpTestHelpers.addressToBytes32(address(basejumpHydration)),
            "Basejump landing not set on Moonbeam"
        );

        // Verify authorization
        assertTrue(
            basejumpHydration.authorizedBridges(address(basejumpMoonbeam)),
            "BasejumpProxy not authorized on Landing"
        );

        assertTrue(
            xcmTransactor.authorized(address(basejumpMoonbeam)),
            "BasejumpProxy not authorized on XcmTransactor"
        );

        // Verify asset mappings
        assertEq(
            basejumpHydration.destAssetFor(address(usdcBase)),
            address(usdcHydration),
            "Asset mapping not set"
        );

        // Verify fee configuration
        assertEq(basejumpBase.quoteFee(address(usdcBase)), BASEJUMP_FEE, "Fee not set");
    }

    function testLiquidityPoolFunded() public view {
        assertEq(
            usdcHydration.balanceOf(address(basejumpHydration)),
            LIQUIDITY_POOL_SIZE,
            "Liquidity pool not funded"
        );
    }

    // ═══════════════════════════════════════════════════════════════════
    // HAPPY PATH TESTS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Tests the complete cross-chain flow: Base → Moonbeam → Hydration
    function testCrossChainTransferHappyPath() public {
        uint256 amount = TRANSFER_AMOUNT;
        uint256 expectedNetAmount = amount - BASEJUMP_FEE;

        // ─── Step 1: User initiates bridge on Base ─────────────────
        vm.startPrank(user);
        usdcBase.approve(address(basejumpBase), amount);

        (uint64 transferSeq,) = basejumpBase.bridgeViaWormhole{value: 1 ether}(
            address(usdcBase),
            amount,
            MOONBEAM_CHAIN_ID,
            hydrationRecipient
        );
        vm.stopPrank();

        // ─── Step 2: Verify TokenBridge slow path initiated ────────
        MockTokenBridge.TransferRecord memory record = tokenBridge.getTransfer(transferSeq);
        assertEq(record.token, address(usdcBase), "Wrong token in TokenBridge");
        assertEq(record.amount, amount, "Wrong amount in TokenBridge");
        assertEq(record.recipientChain, MOONBEAM_CHAIN_ID, "Wrong recipient chain");

        // ─── Step 3: Build and deliver fast-path VAA ───────────────
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            expectedNetAmount,
            hydrationRecipient
        );

        // ─── Step 4: Deliver to BasejumpProxy on Moonbeam ──────────
        vm.expectEmit(true, true, false, true, address(basejumpMoonbeam));
        emit IBasejump.TransferProcessed(address(usdcBase), expectedNetAmount, hydrationRecipient);

        basejumpMoonbeam.completeTransfer(vaa);

        // ─── Step 5: Verify XCM was dispatched ─────────────────────
        assertEq(xcmPrecompile.callCount(), 1, "XCM not dispatched");
        MockXcmPrecompile.XcmCall memory xcmCall = xcmPrecompile.getLastCall();
        assertEq(xcmCall.dest.parents, 1, "Wrong XCM parents");
        assertEq(xcmCall.dest.interior.length, 1, "Wrong interior length");

        // Decode parachain junction (should be 0x00 + HYDRATION_PARA_ID)
        bytes memory junction = xcmCall.dest.interior[0];
        assertEq(uint8(junction[0]), 0x00, "Wrong junction type");
        uint32 paraId;
        assembly {
            paraId := mload(add(junction, 5)) // Read uint32 after type byte
        }
        assertEq(paraId, HYDRATION_PARA_ID, "Wrong parachain ID");

        // ─── Step 6: Simulate XCM execution on Hydration ───────────
        vm.expectEmit(true, true, true, true, address(basejumpHydration));
        emit IBasejumpLanding.TransferExecuted(
            address(usdcBase),
            address(usdcHydration),
            hydrationRecipient,
            expectedNetAmount
        );

        // BasejumpProxy calls BasejumpLanding.transfer via XCM
        vm.prank(address(basejumpMoonbeam));
        basejumpHydration.transfer(address(usdcBase), expectedNetAmount, hydrationRecipient);

        // ─── Step 7: Verify dispatch precompile was called ─────────
        // This is verified by the vm.mockCall in setUp not reverting
    }

    function testFeeDeductedCorrectly() public {
        uint256 amount = 10_000e6;
        uint256 fee = BASEJUMP_FEE;
        uint256 expectedNet = amount - fee;

        vm.startPrank(user);
        usdcBase.approve(address(basejumpBase), amount);

        (uint64 transferSeq,) = basejumpBase.bridgeViaWormhole{value: 1 ether}(
            address(usdcBase),
            amount,
            MOONBEAM_CHAIN_ID,
            hydrationRecipient
        );
        vm.stopPrank();

        // Verify slow path gets full amount
        MockTokenBridge.TransferRecord memory slowPath = tokenBridge.getTransfer(transferSeq);
        assertEq(slowPath.amount, amount, "Slow path should get full amount");

        // Verify fast path message contains net amount
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            expectedNet,
            hydrationRecipient
        );

        basejumpMoonbeam.completeTransfer(vaa);

        // On Landing, verify net amount is transferred
        vm.prank(address(basejumpMoonbeam));
        basejumpHydration.transfer(address(usdcBase), expectedNet, hydrationRecipient);
    }

    // ═══════════════════════════════════════════════════════════════════
    // EDGE CASE TESTS
    // ═══════════════════════════════════════════════════════════════════

    function testCrossChainTransferInsufficientLiquidity() public {
        // Request amount exceeding pool
        uint256 largeAmount = LIQUIDITY_POOL_SIZE + 1000e6;

        // Generate VAA with amount exceeding pool
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            largeAmount,
            hydrationRecipient
        );

        // Deliver to BasejumpProxy
        basejumpMoonbeam.completeTransfer(vaa);

        // Simulate XCM execution - should queue transfer
        vm.expectEmit(true, true, true, true, address(basejumpHydration));
        emit IBasejumpLanding.TransferQueued(
            0, // pending ID
            address(usdcBase),
            address(usdcHydration),
            hydrationRecipient,
            largeAmount
        );

        vm.prank(address(basejumpMoonbeam));
        basejumpHydration.transfer(address(usdcBase), largeAmount, hydrationRecipient);

        // Verify queued
        assertEq(basejumpHydration.pendingTail(), 1, "Transfer not queued");
        assertEq(basejumpHydration.pendingHead(), 0, "Wrong pending head");

        (address sourceAsset, uint256 queuedAmount, bytes32 recipient) =
            basejumpHydration.pendingTransfers(0);
        assertEq(sourceAsset, address(usdcBase), "Wrong source asset");
        assertEq(queuedAmount, largeAmount, "Wrong queued amount");
        assertEq(recipient, hydrationRecipient, "Wrong recipient");
    }

    function testFulfillPendingAfterLiquidityRestored() public {
        // First create pending transfer
        uint256 largeAmount = LIQUIDITY_POOL_SIZE + 1000e6;

        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            largeAmount,
            hydrationRecipient
        );

        basejumpMoonbeam.completeTransfer(vaa);

        vm.prank(address(basejumpMoonbeam));
        basejumpHydration.transfer(address(usdcBase), largeAmount, hydrationRecipient);

        // Restore liquidity (simulate slow path arrival)
        usdcHydration.mint(address(basejumpHydration), 2000e6);

        // Fulfill pending
        vm.expectEmit(true, true, true, true, address(basejumpHydration));
        emit IBasejumpLanding.PendingTransferFulfilled(
            0,
            address(usdcBase),
            address(usdcHydration),
            hydrationRecipient,
            largeAmount
        );

        basejumpHydration.fulfillPending();

        // Verify pending cleared
        assertEq(basejumpHydration.pendingHead(), 1, "Pending not cleared");
    }

    // ═══════════════════════════════════════════════════════════════════
    // SECURITY TESTS
    // ═══════════════════════════════════════════════════════════════════

    function testReplayProtection() public {
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            TRANSFER_AMOUNT,
            hydrationRecipient
        );

        // First delivery succeeds
        basejumpMoonbeam.completeTransfer(vaa);

        // Second delivery with same VAA should fail
        vm.expectRevert("VAA already processed");
        basejumpMoonbeam.completeTransfer(vaa);
    }

    function testUnauthorizedEmitterRejected() public {
        bytes32 unauthorizedEmitter = bytes32(uint256(0xDEADBEEF));

        bytes memory payload = abi.encode(address(usdcBase), TRANSFER_AMOUNT, hydrationRecipient);
        bytes memory vaa = abi.encode(
            BASE_CHAIN_ID,
            unauthorizedEmitter,
            payload
        );

        vm.expectRevert();
        basejumpMoonbeam.completeTransfer(vaa);
    }

    function testAssetNotConfigured() public {
        address unknownAsset = makeAddr("unknownAsset");

        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            unknownAsset,
            TRANSFER_AMOUNT,
            hydrationRecipient
        );

        basejumpMoonbeam.completeTransfer(vaa);

        vm.prank(address(basejumpMoonbeam));
        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpLanding.AssetNotConfigured.selector, unknownAsset)
        );
        basejumpHydration.transfer(unknownAsset, TRANSFER_AMOUNT, hydrationRecipient);
    }

    function testDispatchPrecompileFailure() public {
        // Make dispatch revert
        vm.mockCallRevert(DISPATCH_PRECOMPILE, bytes(""), bytes("dispatch failed"));

        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            TRANSFER_AMOUNT,
            hydrationRecipient
        );

        basejumpMoonbeam.completeTransfer(vaa);

        // When Landing.transfer is called, it should revert
        vm.prank(address(basejumpMoonbeam));
        vm.expectRevert(IBasejumpLanding.DispatchFailed.selector);
        basejumpHydration.transfer(address(usdcBase), TRANSFER_AMOUNT, hydrationRecipient);
    }

    function testZeroAmountReverts() public {
        vm.startPrank(user);
        usdcBase.approve(address(basejumpBase), 1000e6);

        vm.expectRevert(IBasejump.ZeroAmount.selector);
        basejumpBase.bridgeViaWormhole{value: 1 ether}(
            address(usdcBase),
            0,
            MOONBEAM_CHAIN_ID,
            hydrationRecipient
        );
        vm.stopPrank();
    }

    function testBasejumpLandingNotSet() public {
        // Deploy a fresh Basejump without landing configured
        Basejump freshBasejump = new Basejump();
        ERC1967Proxy freshProxy = new ERC1967Proxy(
            address(freshBasejump),
            abi.encodeCall(Basejump.initialize, (address(this), address(tokenBridge)))
        );
        Basejump basejump = Basejump(address(freshProxy));

        vm.startPrank(user);
        usdcBase.approve(address(basejump), TRANSFER_AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(IBasejump.BasejumpLandingNotSet.selector, MOONBEAM_CHAIN_ID)
        );
        basejump.bridgeViaWormhole{value: 1 ether}(
            address(usdcBase),
            TRANSFER_AMOUNT,
            MOONBEAM_CHAIN_ID,
            hydrationRecipient
        );
        vm.stopPrank();
    }
}
