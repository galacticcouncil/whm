// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {GovernanceCodec} from "../../src/governance/GovernanceCodec.sol";
import {GovernanceDispatcher} from "../../src/governance/GovernanceDispatcher.sol";
import {IGovernanceDispatcher} from "../../src/governance/interfaces/IGovernanceDispatcher.sol";

/// @dev Hydration Wormhole core substitute that records the exact publication arguments.
contract MockDispatcherWormhole {
    uint16 public immutable chainId;
    uint256 public messageFee;
    uint64 public nextSequence = 100;

    uint32 public lastNonce;
    bytes public lastPayload;
    uint8 public lastConsistency;
    uint256 public lastValue;

    bool public failPublication;
    bytes public reentryData;
    bytes4 public observedReentryError;

    constructor(uint16 chainId_) {
        chainId = chainId_;
    }

    function setMessageFee(uint256 fee) external {
        messageFee = fee;
    }

    function setFailPublication(bool fail) external {
        failPublication = fail;
    }

    function setReentryData(bytes calldata data) external {
        reentryData = data;
    }

    function publishMessage(uint32 nonce, bytes calldata payload, uint8 consistency)
        external
        payable
        returns (uint64 sequence)
    {
        if (failPublication) revert("mock publication failed");

        lastNonce = nonce;
        lastPayload = payload;
        lastConsistency = consistency;
        lastValue = msg.value;

        if (reentryData.length != 0) {
            (bool success, bytes memory returnData) = msg.sender.call(reentryData);
            require(!success, "reentrant publication succeeded");
            if (returnData.length >= 4) {
                bytes4 selector;
                assembly ("memory-safe") {
                    selector := mload(add(returnData, 0x20))
                }
                observedReentryError = selector;
            }
        }

        sequence = nextSequence++;
    }

    /// @dev Lets this mock also stand in for the synthetic governance caller during reentrancy tests.
    function callPublish(
        IGovernanceDispatcher dispatcher,
        uint16 destinationChain,
        address destinationExecutor,
        GovernanceCodec.Call[] calldata calls
    ) external payable returns (uint64 governanceNonce, uint64 sequence, bytes32 actionId) {
        return dispatcher.publish{value: msg.value}(destinationChain, destinationExecutor, calls);
    }
}

/// @dev Exposes internal codec operations for independent assertions against dispatcher output.
contract DispatcherCodecHarness {
    function decode(bytes calldata payload) external pure returns (GovernanceCodec.GovernanceAction memory) {
        return GovernanceCodec.decode(payload);
    }

    function actionId(uint16 emitterChain, bytes32 emitterAddress, bytes32 payloadHash)
        external
        pure
        returns (bytes32)
    {
        return GovernanceCodec.actionId(emitterChain, emitterAddress, payloadHash);
    }
}

contract GovernanceDispatcherV2 is GovernanceDispatcher {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @title GovernanceDispatcher source-authentication and publication tests
contract GovernanceDispatcherTest is Test {
    uint16 constant HYDRATION_CHAIN = 73;
    uint16 constant DESTINATION_CHAIN = 2;
    uint8 constant FINALIZED = 202;
    uint256 constant MESSAGE_FEE = 0.01 ether;

    address internal governanceAddress = address(0xaa7e0000000000000000000000000000000aA7e2);
    address internal destinationExecutor = address(0x1111111111111111111111111111111111111111);

    MockDispatcherWormhole internal wormhole;
    DispatcherCodecHarness internal codec;
    GovernanceDispatcher internal implementation;
    GovernanceDispatcher internal dispatcher;

    function setUp() public {
        wormhole = new MockDispatcherWormhole(HYDRATION_CHAIN);
        wormhole.setMessageFee(MESSAGE_FEE);
        codec = new DispatcherCodecHarness();
        implementation = new GovernanceDispatcher();
        dispatcher = _deployDispatcher(address(wormhole), governanceAddress);
        vm.deal(governanceAddress, 100 ether);
    }

    // ─── Initialization and authority ───────────────────────────

    function testInitialization() public view {
        assertEq(dispatcher.wormhole(), address(wormhole));
        assertEq(dispatcher.governanceCaller(), governanceAddress);
        assertEq(dispatcher.nextGovernanceNonce(), 1);
        assertEq(dispatcher.HYDRATION_WORMHOLE_CHAIN(), HYDRATION_CHAIN);
        assertEq(dispatcher.CONSISTENCY_FINALIZED(), FINALIZED);
    }

    function testImplementationCannotBeInitialized() public {
        vm.expectRevert();
        implementation.initialize(address(wormhole), governanceAddress);
    }

    function testProxyCannotBeReinitialized() public {
        vm.expectRevert();
        dispatcher.initialize(address(wormhole), governanceAddress);
    }

    function testInitializationRejectsZeroAndNoCodeAddresses() public {
        vm.expectRevert(IGovernanceDispatcher.ZeroAddress.selector);
        _deployDispatcher(address(0), governanceAddress);

        vm.expectRevert(IGovernanceDispatcher.ZeroAddress.selector);
        _deployDispatcher(address(wormhole), address(0));

        address eoa = makeAddr("not wormhole");
        vm.expectRevert(abi.encodeWithSelector(IGovernanceDispatcher.AddressHasNoCode.selector, eoa));
        _deployDispatcher(eoa, governanceAddress);
    }

    function testInitializationRequiresHydrationWormholeChain() public {
        MockDispatcherWormhole wrongCore = new MockDispatcherWormhole(2);
        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceDispatcher.InvalidWormholeChain.selector, uint16(2), HYDRATION_CHAIN)
        );
        _deployDispatcher(address(wrongCore), governanceAddress);
    }

    function testOnlyGovernanceCanPublish() public {
        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IGovernanceDispatcher.NotGovernance.selector, attacker));
        dispatcher.publish(DESTINATION_CHAIN, destinationExecutor, _oneCall());
    }

    // ─── Publication ────────────────────────────────────────────

    function testPublishesCanonicalFinalizedAction() public {
        GovernanceCodec.Call[] memory calls = _oneCall();
        vm.prank(governanceAddress);
        (uint64 governanceNonce, uint64 sequence, bytes32 actionId) =
            dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, calls);

        assertEq(governanceNonce, 1);
        assertEq(sequence, 100);
        assertEq(wormhole.lastNonce(), 1);
        assertEq(wormhole.lastConsistency(), FINALIZED);
        assertEq(wormhole.lastValue(), MESSAGE_FEE);
        assertEq(dispatcher.nextGovernanceNonce(), 2);

        bytes memory payload = wormhole.lastPayload();
        GovernanceCodec.GovernanceAction memory decoded = codec.decode(payload);
        assertEq(decoded.destinationWormholeChain, DESTINATION_CHAIN);
        assertEq(decoded.destinationExecutor, destinationExecutor);
        assertEq(decoded.governanceNonce, 1);
        assertEq(decoded.calls.length, 1);
        assertEq(decoded.calls[0].target, calls[0].target);
        assertEq(decoded.calls[0].value, calls[0].value);
        assertEq(decoded.calls[0].data, calls[0].data);

        bytes32 emitterAddress = bytes32(uint256(uint160(address(dispatcher))));
        assertEq(actionId, codec.actionId(HYDRATION_CHAIN, emitterAddress, keccak256(payload)));
    }

    function testNonceIncrementsAcrossPublications() public {
        vm.startPrank(governanceAddress);
        (uint64 first,,) = dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
        (uint64 second,,) = dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
        vm.stopPrank();

        assertEq(first, 1);
        assertEq(second, 2);
        assertEq(dispatcher.nextGovernanceNonce(), 3);
        assertEq(wormhole.lastNonce(), 2);
    }

    function testRequiresExactMessageFee() public {
        vm.startPrank(governanceAddress);
        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceDispatcher.InvalidMessageFee.selector, MESSAGE_FEE, MESSAGE_FEE - 1)
        );
        dispatcher.publish{value: MESSAGE_FEE - 1}(DESTINATION_CHAIN, destinationExecutor, _oneCall());

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceDispatcher.InvalidMessageFee.selector, MESSAGE_FEE, MESSAGE_FEE + 1)
        );
        dispatcher.publish{value: MESSAGE_FEE + 1}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
        vm.stopPrank();

        assertEq(dispatcher.nextGovernanceNonce(), 1);
    }

    function testRevertingWormholePublicationDoesNotConsumeNonce() public {
        wormhole.setFailPublication(true);
        vm.prank(governanceAddress);
        vm.expectRevert("mock publication failed");
        dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
        assertEq(dispatcher.nextGovernanceNonce(), 1);

        wormhole.setFailPublication(false);
        vm.prank(governanceAddress);
        (uint64 nonce,,) = dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
        assertEq(nonce, 1);
    }

    function testUsesSharedCodecValidation() public {
        vm.prank(governanceAddress);
        vm.expectRevert(GovernanceCodec.InvalidDestinationChain.selector);
        dispatcher.publish{value: MESSAGE_FEE}(0, destinationExecutor, _oneCall());
        assertEq(dispatcher.nextGovernanceNonce(), 1);
    }

    function testForcedBalanceIsNeverSpent() public {
        uint256 forcedBalance = 2 ether;
        // Models native currency forced in independently of the dispatcher's payable publication.
        vm.deal(address(dispatcher), forcedBalance);
        assertEq(address(dispatcher).balance, forcedBalance);

        vm.deal(governanceAddress, MESSAGE_FEE);
        vm.prank(governanceAddress);
        dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());

        assertEq(address(dispatcher).balance, forcedBalance);
        assertEq(address(wormhole).balance, MESSAGE_FEE);
    }

    function testReentrantPublicationCannotReuseNonce() public {
        MockDispatcherWormhole reentrantWormhole = new MockDispatcherWormhole(HYDRATION_CHAIN);
        GovernanceDispatcher reentrantDispatcher =
            _deployDispatcher(address(reentrantWormhole), address(reentrantWormhole));
        GovernanceCodec.Call[] memory calls = _oneCall();
        reentrantWormhole.setReentryData(
            abi.encodeCall(IGovernanceDispatcher.publish, (DESTINATION_CHAIN, destinationExecutor, calls))
        );

        (uint64 nonce,,) = reentrantWormhole.callPublish(
            IGovernanceDispatcher(address(reentrantDispatcher)), DESTINATION_CHAIN, destinationExecutor, calls
        );

        assertEq(nonce, 1);
        assertEq(reentrantDispatcher.nextGovernanceNonce(), 2);
        assertEq(reentrantWormhole.observedReentryError(), IGovernanceDispatcher.ReentrantCall.selector);
    }

    function testGovernanceNonceCannotWrap() public {
        bytes32 namespace = 0x87c9bfd7d4d795f8d6f9338d86a7a19561287ad9cd8d93140b14a14e06551200;
        // Solidity packs governanceCaller (20 bytes), nonce (8 bytes), and guard (1 byte) into
        // namespace + 1. Preserve the caller while placing max uint64 immediately above it.
        uint256 packed = uint256(uint160(governanceAddress)) | (uint256(type(uint64).max) << 160) | (uint256(1) << 224);
        vm.store(address(dispatcher), bytes32(uint256(namespace) + 1), bytes32(packed));

        vm.prank(governanceAddress);
        vm.expectRevert(IGovernanceDispatcher.GovernanceNonceExhausted.selector);
        dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
    }

    // ─── UUPS upgrade authority ─────────────────────────────────

    function testNonGovernanceCannotUpgrade() public {
        GovernanceDispatcherV2 v2 = new GovernanceDispatcherV2();
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IGovernanceDispatcher.NotGovernance.selector, attacker));
        dispatcher.upgradeToAndCall(address(v2), "");
    }

    function testGovernanceCanUpgradeAndStorageSurvives() public {
        vm.prank(governanceAddress);
        dispatcher.publish{value: MESSAGE_FEE}(DESTINATION_CHAIN, destinationExecutor, _oneCall());
        GovernanceDispatcherV2 v2 = new GovernanceDispatcherV2();

        vm.prank(governanceAddress);
        dispatcher.upgradeToAndCall(address(v2), "");

        GovernanceDispatcherV2 upgraded = GovernanceDispatcherV2(address(dispatcher));
        assertEq(upgraded.version(), 2);
        assertEq(upgraded.wormhole(), address(wormhole));
        assertEq(upgraded.governanceCaller(), governanceAddress);
        assertEq(upgraded.nextGovernanceNonce(), 2);
    }

    function _oneCall() internal pure returns (GovernanceCodec.Call[] memory calls) {
        calls = new GovernanceCodec.Call[](1);
        calls[0] = GovernanceCodec.Call({target: address(0xCA11), value: 123, data: hex"12345678"});
    }

    function _deployDispatcher(address wormhole_, address governanceCaller_)
        internal
        returns (GovernanceDispatcher deployed)
    {
        deployed = GovernanceDispatcher(
            address(
                new ERC1967Proxy(
                    address(implementation),
                    abi.encodeCall(GovernanceDispatcher.initialize, (wormhole_, governanceCaller_))
                )
            )
        );
    }
}
