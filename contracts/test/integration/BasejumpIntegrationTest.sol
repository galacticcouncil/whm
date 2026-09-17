// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpEmitter} from "../../src/basejump/BasejumpEmitter.sol";
import {BasejumpReceiver} from "../../src/basejump/BasejumpReceiver.sol";
import {BasejumpLanding} from "../../src/basejump/BasejumpLanding.sol";
import {MessageReceiver} from "../../src/MessageReceiver.sol";

import {IBasejumpEmitter} from "../../src/basejump/interfaces/IBasejumpEmitter.sol";
import {IBasejumpPayload} from "../../src/basejump/interfaces/IBasejumpPayload.sol";
import {IBasejumpLanding} from "../../src/basejump/interfaces/IBasejumpLanding.sol";

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
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        return true;
    }
}

/// @title BasejumpIntegrationTest
/// @notice The direct Base → Hydration corridor, end to end:
///
///   Base      BasejumpEmitter.bridgeViaWormhole → NTT settlement (gross) + fast-path VAA (net)
///   Hydration BasejumpReceiver.completeTransfer → BasejumpLanding.transfer
///
/// Two contracts, one per role: neither carries the other s entrypoints. Direct NTT, no
/// intermediate proxy hop, no XcmTransactor, no TokenBridge.
contract BasejumpIntegrationTest is Test, MockWormhole {
    using BasejumpTestHelpers for *;

    // ─── Message core mock ──────────────────────────────────────────

    uint64 private _nextSequence;

    // Captured so tests can assert what the contract ACTUALLY published, rather than
    // asserting against a payload the test itself constructed.
    bytes[] public publishedPayloads;
    uint8[] public publishedConsistency;

    function chainId() external pure returns (uint16) {
        return HYDRATION_CHAIN_ID;
    }

    function messageFee() external pure returns (uint256) {
        return 0;
    }

    function publishMessage(uint32, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64 sequence)
    {
        sequence = _nextSequence;
        _nextSequence++;
        publishedPayloads.push(payload);
        publishedConsistency.push(consistencyLevel);
    }

    function lastPublishedPayload() public view returns (bytes memory) {
        return publishedPayloads[publishedPayloads.length - 1];
    }

    function lastPublishedConsistency() public view returns (uint8) {
        return publishedConsistency[publishedConsistency.length - 1];
    }

    // ─── Chain ids ──────────────────────────────────────────────────

    uint16 constant BASE_CHAIN_ID = 30;
    uint16 constant HYDRATION_CHAIN_ID = 73;

    // ─── Deployments ────────────────────────────────────────────────

    /// @dev Source — publishes the fast-path VAA, settles via NTT.
    BasejumpEmitter public basejumpBase;
    /// @dev Hydration — verifies the VAA and calls the landing. No outbound path.
    BasejumpReceiver public basejumpHydration;
    BasejumpLanding public landing;

    MockNttManager public nttManager;

    MockERC20 public usdcBase;
    MockERC20 public usdcHydration;

    address public user = makeAddr("user");
    bytes32 public hydrationRecipient;

    uint256 constant LIQUIDITY_POOL_SIZE = 1_000_000e6;
    uint256 constant TRANSFER_AMOUNT = 10_000e6;
    uint256 constant BASEJUMP_FEE = 1e6;

    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;

    function setUp() public {
        usdcBase = new MockERC20();
        usdcHydration = new MockERC20();

        // Source deployment (Base). tokenBridge = 0x0 — the NTT path never reads it.
        BasejumpEmitter sourceImpl = new BasejumpEmitter();
        basejumpBase = BasejumpEmitter(
            address(
                new ERC1967Proxy(
                    address(sourceImpl), abi.encodeCall(BasejumpEmitter.initialize, (address(this)))
                )
            )
        );

        // Receiver deployment (Hydration). No tokenBridge argument — it only receives.
        BasejumpReceiver recvImpl = new BasejumpReceiver();
        basejumpHydration = BasejumpReceiver(
            address(
                new ERC1967Proxy(
                    address(recvImpl), abi.encodeCall(MessageReceiver.initialize, (address(this)))
                )
            )
        );

        BasejumpLanding landingImpl = new BasejumpLanding();
        landing = BasejumpLanding(
            address(new ERC1967Proxy(address(landingImpl), abi.encodeCall(BasejumpLanding.initialize, ())))
        );

        // ── Source config: settle via NTT to the landing on chain 73 ──
        nttManager = new MockNttManager(address(usdcBase));
        basejumpBase.setNttManager(address(usdcBase), address(nttManager));
        basejumpBase.setLanding(BasejumpTestHelpers.addressToBytes32(address(landing)));
        basejumpBase.setAssetFee(address(usdcBase), BASEJUMP_FEE);

        // ── Receiver config: trust the source, deliver into the landing ──
        //    setLandingDest is deliberately NEVER called — outbound stays inert.
        basejumpHydration.setAuthorizedEmitter(
            BASE_CHAIN_ID, BasejumpTestHelpers.addressToBytes32(address(basejumpBase))
        );
        basejumpHydration.setLanding(BasejumpTestHelpers.addressToBytes32(address(landing)));

        // ── Landing config ──
        landing.setAuthorizedBridge(address(basejumpHydration), true);
        landing.setDestAsset(address(usdcBase), address(usdcHydration));

        usdcHydration.mint(address(landing), LIQUIDITY_POOL_SIZE);
        usdcBase.mint(user, 100_000e6);
        hydrationRecipient = BasejumpTestHelpers.addressToBytes32(makeAddr("hydrationRecipient"));

        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));
        vm.deal(address(this), 100 ether);
        vm.deal(user, 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _bridge(uint256 amount) internal returns (uint64 transferSeq) {
        return _bridge(amount, "");
    }

    function _bridge(uint256 amount, bytes memory data) internal returns (uint64 transferSeq) {
        vm.startPrank(user);
        usdcBase.approve(address(basejumpBase), amount);
        (transferSeq,) = basejumpBase.bridgeViaWormhole(address(usdcBase), amount, hydrationRecipient, data);
        vm.stopPrank();
    }

    function _vaa(uint256 netAmount, uint64 transferSeq) internal view returns (bytes memory) {
        return BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID, address(basejumpBase), address(usdcBase), netAmount, hydrationRecipient, transferSeq
        );
    }

    // ─── Configuration ──────────────────────────────────────────────

    function testDeploymentConfiguration() public view {
        assertEq(basejumpBase.DEST_CHAIN_ID(), HYDRATION_CHAIN_ID, "wrong settlement chain");
        assertEq(basejumpBase.nttManagerFor(address(usdcBase)), address(nttManager), "no NTT route");
        assertEq(
            basejumpHydration.authorizedEmitters(BASE_CHAIN_ID),
            BasejumpTestHelpers.addressToBytes32(address(basejumpBase)),
            "source not authorized on receiver"
        );
        assertTrue(landing.authorizedBridges(address(basejumpHydration)), "receiver not a bridge");
        assertEq(
            basejumpHydration.landing(),
            BasejumpTestHelpers.addressToBytes32(address(landing)),
            "receiver not pointed at the landing"
        );
    }

    function testLiquidityPoolFunded() public view {
        assertEq(usdcHydration.balanceOf(address(landing)), LIQUIDITY_POOL_SIZE);
    }

    /// @notice The invariant nothing on-chain enforces: settlement must land in the same contract
    ///         the fast path pays out of. Two slots on two chains, set by two migrations.
    function testPoolBinding() public view {
        assertEq(
            basejumpBase.landing(),
            basejumpHydration.landing(),
            "settlement recipient and payout pool must be the same contract"
        );
    }

    // ─── Happy path ─────────────────────────────────────────────────

    function testCrossChainTransferHappyPath() public {
        uint256 expectedNet = TRANSFER_AMOUNT - BASEJUMP_FEE;
        uint64 transferSeq = _bridge(TRANSFER_AMOUNT);

        // Settlement carries GROSS to the landing on the destination chain.
        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(transferSeq);
        assertEq(settled.amount, TRANSFER_AMOUNT, "NTT must receive gross");
        assertEq(settled.recipientChain, HYDRATION_CHAIN_ID, "wrong settlement chain");

        // The payout leaves via the DISPATCH precompile, which is mocked here — so ERC20 balances
        // do NOT move in Foundry and asserting on them would be meaningless. The event is the
        // observable; the real balance movement is pinned by chopsticks/probes/_probeBasejumpDelivery.
        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.TransferExecuted(
            address(usdcBase), address(usdcHydration), hydrationRecipient, expectedNet
        );
        basejumpHydration.completeTransfer(_vaa(expectedNet, transferSeq));

        assertEq(landing.pendingTail(), 0, "a funded pool must not queue");
    }

    function testFeeDeductedCorrectly() public {
        uint64 transferSeq = _bridge(TRANSFER_AMOUNT);

        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(transferSeq);
        assertEq(settled.amount, TRANSFER_AMOUNT, "settlement gets gross");

        IBasejumpPayload.TransferPayload memory published =
            abi.decode(lastPublishedPayload(), (IBasejumpPayload.TransferPayload));
        assertEq(published.amount, TRANSFER_AMOUNT - BASEJUMP_FEE, "fast path carries net");
        assertEq(settled.amount - published.amount, BASEJUMP_FEE, "fee accrual broken");
    }

    /// @notice Pins the emit side against the payload the CONTRACT published — not one the test built.
    function testPublishedMessageCarriesNetAndRoute() public {
        uint256 expectedNet = TRANSFER_AMOUNT - BASEJUMP_FEE;
        uint64 transferSeq = _bridge(TRANSFER_AMOUNT);

        MockNttManager.TransferRecord memory settled = nttManager.getTransfer(transferSeq);
        assertEq(
            settled.recipient,
            BasejumpTestHelpers.addressToBytes32(address(landing)),
            "settlement recipient must be the payout pool"
        );

        IBasejumpPayload.TransferPayload memory published =
            abi.decode(lastPublishedPayload(), (IBasejumpPayload.TransferPayload));
        assertEq(published.amount, expectedNet, "published message must carry net");
        assertEq(published.sourceAsset, address(usdcBase), "wrong sourceAsset published");
        assertEq(published.recipient, hydrationRecipient, "wrong recipient published");
        assertEq(published.transferSequence, transferSeq, "settlement sequence not correlated");
        assertEq(lastPublishedConsistency(), 200, "must publish at instant finality");
    }

    /// @notice `data` is the inbound-intent channel: a recipient that is a Hydration contract needs
    ///         to know what to do with the funds, not just receive them. Neither end may touch the
    ///         bytes, so this pins them at both ends — the payload the emitter published, and the
    ///         argument the receiver hands the landing. Without the second assertion an end that
    ///         silently dropped `data` would still pass.
    function testDataForwardedEndToEnd() public {
        bytes memory intentData = abi.encode(keccak256("intent-1"), makeAddr("depositAddress"));
        uint64 transferSeq = _bridge(TRANSFER_AMOUNT, intentData);

        IBasejumpPayload.TransferPayload memory published =
            abi.decode(lastPublishedPayload(), (IBasejumpPayload.TransferPayload));
        assertEq(published.data, intentData, "emitter must publish data untouched");

        uint256 expectedNet = TRANSFER_AMOUNT - BASEJUMP_FEE;
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            address(basejumpBase),
            address(usdcBase),
            expectedNet,
            hydrationRecipient,
            transferSeq,
            intentData
        );

        // The deployed landing discards `data`, so the observable is the call it receives.
        vm.expectCall(
            address(landing),
            abi.encodeCall(
                IBasejumpLanding.transfer,
                (address(usdcBase), expectedNet, hydrationRecipient, intentData)
            )
        );
        basejumpHydration.completeTransfer(vaa);
    }

    // ─── Liquidity ──────────────────────────────────────────────────

    /// @notice A shortfall QUEUES and consumes the VAA — it does not revert. Atomicity protects
    ///         against misconfiguration, not an empty pool.
    function testCrossChainTransferInsufficientLiquidity() public {
        uint256 huge = LIQUIDITY_POOL_SIZE + 1e6;

        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.TransferQueued(
            0, address(usdcBase), address(usdcHydration), hydrationRecipient, huge
        );
        basejumpHydration.completeTransfer(_vaa(huge, 1));

        assertEq(landing.pendingTail(), 1, "shortfall must queue");
        assertEq(landing.pendingHead(), 0, "queued transfer must stay unfulfilled");
    }

    function testFulfillPendingAfterLiquidityRestored() public {
        uint256 huge = LIQUIDITY_POOL_SIZE + 1e6;
        basejumpHydration.completeTransfer(_vaa(huge, 1));

        // Top the pool past the queued amount, then drain the queue.
        usdcHydration.mint(address(landing), 10e6);

        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.PendingTransferFulfilled(
            0, address(usdcBase), address(usdcHydration), hydrationRecipient, huge
        );
        landing.fulfillPending();

        assertEq(landing.pendingHead(), landing.pendingTail(), "queue must be drained");
    }

    // ─── Guards ─────────────────────────────────────────────────────

    function testReplayProtection() public {
        bytes memory vaa = _vaa(TRANSFER_AMOUNT - BASEJUMP_FEE, 1);
        basejumpHydration.completeTransfer(vaa);

        vm.expectRevert("VAA already processed");
        basejumpHydration.completeTransfer(vaa);
    }

    function testUnauthorizedEmitterRejected() public {
        // Well-formed payload from an emitter that is NOT authorized, so the emitter check is the
        // only thing that can revert. A malformed payload would revert during decode instead and
        // pass this test even with the check removed.
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID,
            makeAddr("unauthorizedEmitter"),
            address(usdcBase),
            TRANSFER_AMOUNT,
            hydrationRecipient,
            0
        );

        vm.expectRevert(MessageReceiver.NotAuthorizedEmitter.selector);
        basejumpHydration.completeTransfer(vaa);
    }

    /// @notice Atomicity: a landing revert rolls the whole receiveMessage back, leaving the VAA
    ///         unconsumed so the relayer can retry. The old proxy hop could not do this — it marked
    ///         the VAA processed before knowing whether delivery landed.
    function testLandingRevertRollsBackProcessedVaa() public {
        bytes memory vaa = _vaa(TRANSFER_AMOUNT - BASEJUMP_FEE, 1);

        landing.setAuthorizedBridge(address(basejumpHydration), false);
        vm.expectRevert(IBasejumpLanding.NotAuthorizedBridge.selector);
        basejumpHydration.completeTransfer(vaa);

        landing.setAuthorizedBridge(address(basejumpHydration), true);
        basejumpHydration.completeTransfer(vaa); // same VAA — must still be unconsumed
    }

    function testAssetNotConfigured() public {
        MockERC20 unknownAsset = new MockERC20();
        bytes memory vaa = BasejumpTestHelpers.buildFastPathVAA(
            BASE_CHAIN_ID, address(basejumpBase), address(unknownAsset), TRANSFER_AMOUNT, hydrationRecipient, 1
        );

        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpLanding.AssetNotConfigured.selector, address(unknownAsset))
        );
        basejumpHydration.completeTransfer(vaa);
    }

    function testDispatchPrecompileFailure() public {
        vm.mockCallRevert(DISPATCH_PRECOMPILE, bytes(""), bytes(""));

        vm.expectRevert(IBasejumpLanding.DispatchFailed.selector);
        basejumpHydration.completeTransfer(_vaa(TRANSFER_AMOUNT - BASEJUMP_FEE, 1));
    }

    function testZeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(IBasejumpEmitter.ZeroAmount.selector);
        basejumpBase.bridgeViaWormhole(address(usdcBase), 0, hydrationRecipient, "");
    }

    function testLandingNotSet() public {
        BasejumpEmitter impl = new BasejumpEmitter();
        BasejumpEmitter fresh = BasejumpEmitter(
            address(
                new ERC1967Proxy(address(impl), abi.encodeCall(BasejumpEmitter.initialize, (address(this))))
            )
        );

        vm.startPrank(user);
        usdcBase.approve(address(fresh), TRANSFER_AMOUNT);
        vm.expectRevert(
            IBasejumpEmitter.LandingNotSet.selector
        );
        fresh.bridgeViaWormhole{value: 1 ether}(address(usdcBase), TRANSFER_AMOUNT, hydrationRecipient, "");
        vm.stopPrank();
    }

    /// @notice The receiver is inbound-only by CODE, not by configuration — there is no
    ///         outbound entrypoint to leave unarmed. A raw call to the source selector finds
    ///         no function and no fallback, so it cannot be reached at any configuration.
    function testReceiverHasNoOutboundEntrypoint() public {
        vm.prank(user);
        (bool ok,) = address(basejumpHydration).call(
            abi.encodeWithSignature(
                "bridgeViaWormhole(address,uint256,bytes32,bytes)",
                address(usdcBase),
                TRANSFER_AMOUNT,
                hydrationRecipient,
                ""
            )
        );
        assertFalse(ok, "receiver must expose no outbound entrypoint");
    }

    function testUnroutedAssetReverts() public {
        MockERC20 unrouted = new MockERC20();
        unrouted.mint(user, TRANSFER_AMOUNT);

        vm.startPrank(user);
        unrouted.approve(address(basejumpBase), TRANSFER_AMOUNT);
        vm.expectRevert(
            abi.encodeWithSelector(IBasejumpEmitter.SettlementRouteNotSet.selector, address(unrouted))
        );
        basejumpBase.bridgeViaWormhole(address(unrouted), TRANSFER_AMOUNT, hydrationRecipient, "");
        vm.stopPrank();
    }
}
