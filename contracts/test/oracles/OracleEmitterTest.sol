// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OracleEmitter} from "../../src/oracles/OracleEmitter.sol";

contract MockRateSource {
    uint256 public value;

    constructor(uint256 v) {
        value = v;
    }

    function stEthPerToken() external view returns (uint256) {
        return value;
    }

    function setValue(uint256 v) external {
        value = v;
    }

    function revertingCall() external pure returns (uint256) {
        revert("source revert");
    }
}

/// @dev Stand-in for IWormhole's `publishMessage` + `messageFee`. The test contract
///      is `wormhole = address(this)`; it records the last published payload + args
///      and returns a fixed sequence number.
abstract contract WormholeRecorder {
    uint256 public mockFee;
    uint64 public nextSequence = 42;

    bytes public lastPayload;
    uint32 public lastNonce;
    uint8 public lastConsistency;
    uint256 public lastValue;
    uint64 public lastReturnedSequence;

    function messageFee() external view returns (uint256) {
        return mockFee;
    }

    function publishMessage(uint32 nonce, bytes memory payload, uint8 consistencyLevel)
        external
        payable
        returns (uint64)
    {
        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistencyLevel;
        lastValue = msg.value;
        uint64 seq = nextSequence;
        lastReturnedSequence = seq;
        nextSequence = seq + 1;
        return seq;
    }
}

contract OracleEmitterTest is Test, WormholeRecorder {
    OracleEmitter public emitterContract;
    OracleEmitter public emitterImpl;
    MockRateSource public source;

    address public owner = address(this);
    address public alice = address(0xA11CE);

    bytes32 constant WSTETH = keccak256("WSTETH");
    bytes32 constant APYUSD = keccak256("APYUSD");

    uint8 constant ACTION_RATE_UPDATE = 2;
    uint8 constant CONSISTENCY_FINALIZED = 200;

    event FeedRegistered(bytes32 indexed assetId, address source);
    event FeedRemoved(bytes32 indexed assetId);
    event RatePublished(bytes32 indexed assetId, uint256 rate, uint64 sequence);

    function setUp() public {
        emitterImpl = new OracleEmitter();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(emitterImpl),
            abi.encodeCall(OracleEmitter.initialize, (address(this)))
        );
        emitterContract = OracleEmitter(address(proxy));

        source = new MockRateSource(1.2355e18);
    }

    // ─── Init ────────────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(address(emitterContract.wormhole()), address(this));
        assertEq(emitterContract.owner(), address(this));
        assertEq(emitterContract.nonce(), 0);
    }

    function testCannotReinitialize() public {
        vm.expectRevert();
        emitterContract.initialize(address(0xdead));
    }

    function testImplementationInitializersDisabled() public {
        vm.expectRevert();
        emitterImpl.initialize(address(0xdead));
    }

    // ─── Registry ────────────────────────────────────────────────

    function testRegisterFeed() public {
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);

        vm.expectEmit(true, false, false, true, address(emitterContract));
        emit FeedRegistered(WSTETH, address(source));
        emitterContract.registerFeed(WSTETH, address(source), call);

        (address src, bytes memory storedCall) = emitterContract.feeds(WSTETH);
        assertEq(src, address(source));
        assertEq(storedCall, call);
    }

    function testRegisterFeedOverwrites() public {
        bytes memory callA = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        bytes memory callB = abi.encodeWithSignature("other()");

        emitterContract.registerFeed(WSTETH, address(source), callA);
        MockRateSource source2 = new MockRateSource(2e18);
        emitterContract.registerFeed(WSTETH, address(source2), callB);

        (address src, bytes memory storedCall) = emitterContract.feeds(WSTETH);
        assertEq(src, address(source2));
        assertEq(storedCall, callB);
    }

    function testRegisterFeedRejectsZeroSource() public {
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        vm.expectRevert(abi.encodeWithSelector(OracleEmitter.InvalidSource.selector, address(0)));
        emitterContract.registerFeed(WSTETH, address(0), call);
    }

    function testRegisterFeedOnlyOwner() public {
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        vm.prank(alice);
        vm.expectRevert(OracleEmitter.NotOwner.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);
    }

    function testRemoveFeed() public {
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        vm.expectEmit(true, false, false, false, address(emitterContract));
        emit FeedRemoved(WSTETH);
        emitterContract.removeFeed(WSTETH);

        (address src,) = emitterContract.feeds(WSTETH);
        assertEq(src, address(0));
    }

    function testRemoveFeedOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(OracleEmitter.NotOwner.selector);
        emitterContract.removeFeed(WSTETH);
    }

    // ─── Send ────────────────────────────────────────────────────

    function testSendPublishesExpectedPayload() public {
        uint256 rate = 1.2355e18;
        source.setValue(rate);
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        uint64 ts = 1_700_000_000;
        vm.warp(ts);

        vm.expectEmit(true, false, false, true, address(emitterContract));
        emit RatePublished(WSTETH, rate, 42);
        uint64 seq = emitterContract.send(WSTETH);

        assertEq(seq, 42);
        assertEq(lastNonce, 0);
        assertEq(lastConsistency, CONSISTENCY_FINALIZED);
        assertEq(lastValue, 0);

        // Payload must match the Solana helper's abi_encode_price_payload layout exactly.
        bytes memory expected = abi.encode(ACTION_RATE_UPDATE, WSTETH, rate, ts);
        assertEq(lastPayload, expected);
        assertEq(lastPayload.length, 128);

        (uint8 action, bytes32 assetId, uint256 decodedRate, uint64 decodedTs) =
            abi.decode(lastPayload, (uint8, bytes32, uint256, uint64));
        assertEq(action, ACTION_RATE_UPDATE);
        assertEq(assetId, WSTETH);
        assertEq(decodedRate, rate);
        assertEq(decodedTs, ts);

        assertEq(emitterContract.nonce(), 1);
    }

    function testSendIncrementsNonceAndSequence() public {
        source.setValue(1e18);
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        uint64 s1 = emitterContract.send(WSTETH);
        uint64 s2 = emitterContract.send(WSTETH);

        assertEq(s1, 42);
        assertEq(s2, 43);
        assertEq(lastNonce, 1);
        assertEq(emitterContract.nonce(), 2);
    }

    function testSendForwardsExactFee() public {
        mockFee = 0.01 ether;
        source.setValue(1e18);
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        vm.deal(alice, 1 ether);
        vm.prank(alice);
        emitterContract.send{value: mockFee}(WSTETH);

        assertEq(lastValue, mockFee);
    }

    function testSendRevertsOnUnregisteredFeed() public {
        vm.expectRevert(abi.encodeWithSelector(OracleEmitter.FeedNotRegistered.selector, WSTETH));
        emitterContract.send(WSTETH);
    }

    function testSendRevertsOnInsufficientFee() public {
        mockFee = 0.01 ether;
        source.setValue(1e18);
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        vm.expectRevert(abi.encodeWithSelector(OracleEmitter.InsufficientFee.selector, 0, mockFee));
        emitterContract.send(WSTETH);
    }

    function testSendRevertsWhenSourceReverts() public {
        bytes memory call = abi.encodeWithSelector(MockRateSource.revertingCall.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        vm.expectRevert();
        emitterContract.send(WSTETH);
    }

    function testSendRevertsOnEmptyReturn() public {
        // staticcall to an address with no deployed code succeeds with empty returndata.
        address codeless = address(0xBEEF);
        assertEq(codeless.code.length, 0);
        emitterContract.registerFeed(WSTETH, codeless, hex"");

        vm.expectRevert(abi.encodeWithSelector(OracleEmitter.InvalidSourceReturn.selector, WSTETH));
        emitterContract.send(WSTETH);
    }

    function testSendIsPermissionless() public {
        source.setValue(1e18);
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        vm.prank(alice);
        emitterContract.send(WSTETH);

        assertEq(emitterContract.nonce(), 1);
    }

    // ─── Quote ───────────────────────────────────────────────────

    function testQuoteCrossChainCost() public {
        mockFee = 0.005 ether;
        assertEq(emitterContract.quoteCrossChainCost(), mockFee);
    }

    // ─── Owner ───────────────────────────────────────────────────

    function testSetOwner() public {
        emitterContract.setOwner(alice);
        assertEq(emitterContract.owner(), alice);
    }

    function testSetOwnerOnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(OracleEmitter.NotOwner.selector);
        emitterContract.setOwner(alice);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function testUpgradeOnlyOwner() public {
        OracleEmitter newImpl = new OracleEmitter();
        vm.prank(alice);
        vm.expectRevert(OracleEmitter.NotOwner.selector);
        emitterContract.upgradeToAndCall(address(newImpl), "");
    }

    function testUpgradePreservesState() public {
        bytes memory call = abi.encodeWithSelector(MockRateSource.stEthPerToken.selector);
        emitterContract.registerFeed(WSTETH, address(source), call);

        OracleEmitter newImpl = new OracleEmitter();
        emitterContract.upgradeToAndCall(address(newImpl), "");

        (address src,) = emitterContract.feeds(WSTETH);
        assertEq(src, address(source));
        assertEq(emitterContract.owner(), address(this));
    }
}
