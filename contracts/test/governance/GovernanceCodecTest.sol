// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {GovernanceCodec} from "../../src/governance/GovernanceCodec.sol";

contract GovernanceCodecHarness {
    function encode(
        uint16 destinationWormholeChain,
        address destinationExecutor,
        uint64 governanceNonce,
        GovernanceCodec.Call[] calldata calls
    ) external pure returns (bytes memory) {
        return GovernanceCodec.encode(destinationWormholeChain, destinationExecutor, governanceNonce, calls);
    }

    function decode(bytes memory payload) external pure returns (GovernanceCodec.GovernanceAction memory) {
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

contract GovernanceCodecTest is Test {
    bytes6 constant MAGIC = 0x484458474f56;
    uint8 constant VERSION = 1;
    uint16 constant DESTINATION_CHAIN = 2;
    address constant DESTINATION_EXECUTOR = 0x1111111111111111111111111111111111111111;
    uint64 constant GOVERNANCE_NONCE = 7;

    GovernanceCodecHarness internal harness;

    function setUp() public {
        harness = new GovernanceCodecHarness();
    }

    function testEncodeMatchesFrozenTuple() public view {
        GovernanceCodec.Call[] memory calls = _oneCall();
        bytes memory actual = harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
        bytes memory expected =
            abi.encode(MAGIC, VERSION, DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
        assertEq(actual, expected);
    }

    function testRoundTrip() public view {
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](2);
        calls[0] = GovernanceCodec.Call({target: address(0xA11CE), value: 1 ether, data: hex"12345678aabbccdd"});
        calls[1] = GovernanceCodec.Call({target: address(0xB0B), value: 0, data: hex""});

        bytes memory payload = harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
        GovernanceCodec.GovernanceAction memory decoded = harness.decode(payload);

        assertEq(decoded.destinationWormholeChain, DESTINATION_CHAIN);
        assertEq(decoded.destinationExecutor, DESTINATION_EXECUTOR);
        assertEq(decoded.governanceNonce, GOVERNANCE_NONCE);
        assertEq(decoded.calls.length, 2);
        assertEq(decoded.calls[0].target, address(0xA11CE));
        assertEq(decoded.calls[0].value, 1 ether);
        assertEq(decoded.calls[0].data, hex"12345678aabbccdd");
        assertEq(decoded.calls[1].target, address(0xB0B));
        assertEq(decoded.calls[1].data, hex"");
    }

    function testActionIdMatchesFrozenFormula() public view {
        bytes32 emitter = bytes32(uint256(uint160(address(0xE1117))));
        bytes32 payloadHash = keccak256("payload");
        bytes32 domain = keccak256("hydration.cross-chain-governance.action.v1");

        assertEq(
            harness.actionId(73, emitter, payloadHash), keccak256(abi.encode(domain, uint16(73), emitter, payloadHash))
        );
    }

    function testRejectsWrongMagic() public {
        bytes memory payload = _rawPayload(bytes6(0xDEADBEEFCAFE), VERSION, _oneCall());
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.InvalidMagic.selector, bytes6(0xDEADBEEFCAFE)));
        harness.decode(payload);
    }

    function testRejectsWrongVersion() public {
        bytes memory payload = _rawPayload(MAGIC, 2, _oneCall());
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.InvalidVersion.selector, uint8(2)));
        harness.decode(payload);
    }

    function testRejectsInvalidHeaderFields() public {
        GovernanceCodec.Call[] memory calls = _oneCall();

        vm.expectRevert(GovernanceCodec.InvalidDestinationChain.selector);
        harness.encode(0, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);

        vm.expectRevert(GovernanceCodec.InvalidDestinationExecutor.selector);
        harness.encode(DESTINATION_CHAIN, address(0), GOVERNANCE_NONCE, calls);

        vm.expectRevert(GovernanceCodec.InvalidGovernanceNonce.selector);
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, 0, calls);
    }

    function testRejectsEmptyAndOversizedBatch() public {
        GovernanceCodec.Call[] memory empty = new GovernanceCodec.Call[](0);
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.InvalidCallCount.selector, uint256(0)));
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, empty);

        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](17);
        for (uint256 i; i < calls.length; ++i) {
            calls[i].target = address(uint160(i + 1));
        }
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.InvalidCallCount.selector, uint256(17)));
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
    }

    function testAcceptsSixteenCalls() public view {
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](16);
        for (uint256 i; i < calls.length; ++i) {
            calls[i].target = address(uint160(i + 1));
        }
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
    }

    function testRejectsZeroTarget() public {
        GovernanceCodec.Call[] memory calls = _oneCall();
        calls[0].target = address(0);
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.InvalidCallTarget.selector, uint256(0)));
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
    }

    function testCallDataBoundary() public {
        GovernanceCodec.Call[] memory calls = _oneCall();
        calls[0].data = new bytes(32_768);
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);

        calls[0].data = new bytes(32_769);
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.CallDataTooLarge.selector, uint256(0), uint256(32_769)));
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
    }

    function testRejectsPayloadOverLimitBeforeDecode() public {
        bytes memory payload = new bytes(65_537);
        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.PayloadTooLarge.selector, uint256(65_537)));
        harness.decode(payload);
    }

    function testRejectsPayloadOverLimitAfterEncode() public {
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](2);
        calls[0] = GovernanceCodec.Call({target: address(1), value: 0, data: new bytes(32_768)});
        calls[1] = GovernanceCodec.Call({target: address(2), value: 0, data: new bytes(32_768)});

        vm.expectRevert(abi.encodeWithSelector(GovernanceCodec.PayloadTooLarge.selector, uint256(66_080)));
        harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
    }

    function testRejectsTrailingBytes() public {
        bytes memory canonical = harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, _oneCall());
        bytes memory payload = bytes.concat(canonical, hex"00");

        vm.expectRevert(GovernanceCodec.NonCanonicalPayload.selector);
        harness.decode(payload);
    }

    function testRejectsDirtyStaticPadding() public {
        bytes memory payload = harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, _oneCall());
        payload[31] = 0x01; // padding in the bytes6 ABI word

        // Solidity's ABI decoder itself rejects dirty padding on statically sized values. It
        // currently returns no revert data, so only pin the security property: decoding fails.
        vm.expectRevert();
        harness.decode(payload);
    }

    function testRejectsDirtyDynamicPadding() public {
        GovernanceCodec.Call[] memory calls = _oneCall();
        calls[0].data = hex"aa";
        bytes memory payload = harness.encode(DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
        payload[payload.length - 1] = 0x01;

        vm.expectRevert(GovernanceCodec.NonCanonicalPayload.selector);
        harness.decode(payload);
    }

    function testFuzzRoundTrip(
        uint16 destinationChain,
        address destinationExecutor,
        uint64 governanceNonce,
        address target,
        uint256 value,
        bytes memory data
    ) public view {
        vm.assume(destinationChain != 0);
        vm.assume(destinationExecutor != address(0));
        vm.assume(governanceNonce != 0);
        vm.assume(target != address(0));
        vm.assume(data.length <= 32_768);

        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](1);
        calls[0] = GovernanceCodec.Call({target: target, value: value, data: data});

        bytes memory payload = harness.encode(destinationChain, destinationExecutor, governanceNonce, calls);
        GovernanceCodec.GovernanceAction memory decoded = harness.decode(payload);

        assertEq(decoded.destinationWormholeChain, destinationChain);
        assertEq(decoded.destinationExecutor, destinationExecutor);
        assertEq(decoded.governanceNonce, governanceNonce);
        assertEq(decoded.calls[0].target, target);
        assertEq(decoded.calls[0].value, value);
        assertEq(decoded.calls[0].data, data);
    }

    function _oneCall() internal pure returns (GovernanceCodec.Call[] memory calls) {
        calls = new GovernanceCodec.Call[](1);
        calls[0] = GovernanceCodec.Call({target: address(0xA11CE), value: 123, data: hex"12345678"});
    }

    function _rawPayload(bytes6 magic, uint8 version, GovernanceCodec.Call[] memory calls)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(magic, version, DESTINATION_CHAIN, DESTINATION_EXECUTOR, GOVERNANCE_NONCE, calls);
    }
}
