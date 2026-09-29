// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {GovernanceCodec} from "../../src/governance/GovernanceCodec.sol";
import {GovernanceExecutor} from "../../src/governance/GovernanceExecutor.sol";
import {IGovernanceExecutor} from "../../src/governance/interfaces/IGovernanceExecutor.sol";

/// @dev Exposes the library's internal encoder without maintaining a second test-only encoding.
contract ExecutorCodecHarness {
    function encode(
        uint16 destinationChain,
        address destinationExecutor,
        uint64 governanceNonce,
        GovernanceCodec.Call[] calldata calls
    ) external pure returns (bytes memory) {
        return GovernanceCodec.encode(destinationChain, destinationExecutor, governanceNonce, calls);
    }
}

/// @dev Deterministic substitute for guardian verification. The envelope is deliberately simple;
///      executor tests concern how a verified VM is authorized and consumed, not guardian crypto.
contract MockGovernanceWormhole {
    uint16 public immutable chainId;
    mapping(bytes32 => bool) public invalid;

    constructor(uint16 chainId_) {
        chainId = chainId_;
    }

    function markInvalid(bytes calldata vaa) external {
        invalid[keccak256(vaa)] = true;
    }

    function parseAndVerifyVM(bytes calldata vaa)
        external
        view
        returns (IWormhole.VM memory vm_, bool valid, string memory reason)
    {
        (vm_.emitterChainId, vm_.emitterAddress, vm_.sequence, vm_.payload) =
            abi.decode(vaa, (uint16, bytes32, uint64, bytes));
        vm_.hash = keccak256(vaa);
        valid = !invalid[vm_.hash];
        reason = valid ? "" : "invalid";
    }
}

/// @dev Has deployed code, matching the executor's requirement for a Safe-style veto authority.
contract TestSafe {}

/// @dev Governed target used to prove successful calls, rollback, and retry semantics.
contract CallTarget {
    uint256 public number;
    bool public shouldRevert;

    function setNumber(uint256 newNumber) external payable {
        if (shouldRevert) revert("target failed");
        number = newNumber;
    }

    function setShouldRevert(bool value) external {
        shouldRevert = value;
    }

    function fail() external pure {
        revert("always fails");
    }
}

/// @title GovernanceExecutor lifecycle and authority tests
/// @notice Pins the security boundary from verified Hydration VAA through delayed destination call.
contract GovernanceExecutorTest is Test {
    uint16 constant HYDRATION_CHAIN = 73;
    uint16 constant DESTINATION_CHAIN = 2;
    uint48 constant VETO_PERIOD = 24 hours;
    uint48 constant GRACE_PERIOD = 7 days;
    bytes32 constant SOURCE_EMITTER = bytes32(uint256(0xE1117));

    MockGovernanceWormhole internal wormhole;
    ExecutorCodecHarness internal codec;
    GovernanceExecutor internal executor;
    TestSafe internal safe;
    CallTarget internal target;

    /// @dev Deploys the implementation and initializes its proxy atomically, as production must.
    function setUp() public {
        wormhole = new MockGovernanceWormhole(DESTINATION_CHAIN);
        codec = new ExecutorCodecHarness();
        safe = new TestSafe();
        target = new CallTarget();

        GovernanceExecutor implementation = new GovernanceExecutor();
        executor = GovernanceExecutor(
            payable(
                address(
                    new ERC1967Proxy(
                        address(implementation),
                        abi.encodeCall(
                            GovernanceExecutor.initialize,
                            (address(wormhole), SOURCE_EMITTER, address(safe), VETO_PERIOD, GRACE_PERIOD)
                        )
                    )
                )
            )
        );
    }

    // ─── Initialization ─────────────────────────────────────────

    /// @notice Initialization records only the explicitly trusted source, vetoer, and timing.
    function testInitialization() public view {
        assertEq(executor.wormhole(), address(wormhole));
        assertEq(executor.sourceEmitter(), SOURCE_EMITTER);
        assertEq(executor.vetoer(), address(safe));
        assertEq(executor.localWormholeChain(), DESTINATION_CHAIN);
        assertEq(executor.vetoPeriod(), VETO_PERIOD);
        assertEq(executor.executionGracePeriod(), GRACE_PERIOD);
    }

    // ─── Queue authentication and replay ────────────────────────

    /// @notice A valid VAA stores only its commitment and deadlines and starts pending.
    function testQueuesVerifiedAction() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"1234");
        bytes memory vaa = _vaa(HYDRATION_CHAIN, SOURCE_EMITTER, 10, payload);
        bytes32 actionId = executor.queue(vaa);

        IGovernanceExecutor.ActionRecord memory record = executor.action(actionId);
        assertEq(record.payloadHash, keccak256(payload));
        assertEq(record.governanceNonce, 1);
        assertEq(record.queuedAt, block.timestamp);
        assertEq(record.executableAt, block.timestamp + VETO_PERIOD);
        assertEq(record.expiresAt, block.timestamp + VETO_PERIOD + GRACE_PERIOD);
        assertEq(record.storedStatus, 1);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Pending));
        assertTrue(executor.isVaaConsumed(keccak256(vaa)));
    }

    /// @notice Guardian verification failure cannot create or consume an action.
    function testRejectsInvalidVaa() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes memory vaa = _vaa(HYDRATION_CHAIN, SOURCE_EMITTER, 10, payload);
        wormhole.markInvalid(vaa);

        vm.expectRevert(IGovernanceExecutor.InvalidVaa.selector);
        executor.queue(vaa);
    }

    /// @notice A validly signed message from any emitter other than governance is unauthorized.
    function testRejectsWrongSource() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes32 attacker = bytes32(uint256(0xBAD));

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.UnauthorizedEmitter.selector, HYDRATION_CHAIN, attacker)
        );
        executor.queue(_vaa(HYDRATION_CHAIN, attacker, 10, payload));
    }

    /// @notice A VAA cannot be replayed against a chain other than the one signed into its payload.
    function testRejectsWrongDestination() public {
        GovernanceCodec.Call[] memory calls = _calls(address(target), 0, hex"");
        bytes memory payload = codec.encode(30, address(executor), 1, calls);

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.WrongDestination.selector, uint16(30), address(executor))
        );
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_EMITTER, 10, payload));
    }

    /// @notice The exact signed Wormhole envelope can be accepted at most once.
    function testRejectsVaaReplay() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes memory vaa = _vaa(HYDRATION_CHAIN, SOURCE_EMITTER, 10, payload);
        executor.queue(vaa);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.VaaAlreadyConsumed.selector, keccak256(vaa)));
        executor.queue(vaa);
    }

    /// @notice Distinct envelopes carrying the same source-domain payload cannot duplicate an action.
    function testRejectsDuplicateActionFromDifferentVaa() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes32 actionId = executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_EMITTER, 10, payload));

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionAlreadyQueued.selector, actionId));
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_EMITTER, 11, payload));
    }

    // ─── Veto authority ─────────────────────────────────────────

    /// @notice The Safe may veto throughout both pending and ready states.
    function testVetoerCanVetoBeforeOrAfterMaturity() public {
        bytes memory firstPayload = _oneCallPayload(1, address(target), 0, hex"");
        bytes32 first = _queue(firstPayload, 10);
        vm.prank(address(safe));
        executor.veto(first, keccak256("reason"));
        assertEq(uint256(executor.state(first)), uint256(IGovernanceExecutor.ActionState.Vetoed));

        bytes memory secondPayload = _oneCallPayload(2, address(target), 0, hex"");
        bytes32 second = _queue(secondPayload, 11);
        vm.warp(block.timestamp + VETO_PERIOD);
        vm.prank(address(safe));
        executor.veto(second, bytes32(0));
        assertEq(uint256(executor.state(second)), uint256(IGovernanceExecutor.ActionState.Vetoed));
    }

    /// @notice Relaying and execution are permissionless, but veto is not.
    function testNonVetoerCannotVeto() public {
        bytes32 actionId = _queue(_oneCallPayload(1, address(target), 0, hex""), 10);
        address attacker = makeAddr("attacker");

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.NotVetoer.selector, attacker));
        executor.veto(actionId, bytes32(0));
    }

    // ─── Execution timing and atomicity ─────────────────────────

    /// @notice No caller can bypass the complete destination-local review period.
    function testCannotExecuteBeforeMaturity() public {
        bytes memory payload = _setNumberPayload(1, 42);
        bytes32 actionId = _queue(payload, 10);
        IGovernanceExecutor.ActionRecord memory record = executor.action(actionId);

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.ActionNotReady.selector, actionId, record.executableAt)
        );
        executor.execute(actionId, payload);
    }

    /// @notice The maturity timestamp is inclusive and execution needs no privileged keeper.
    function testExecutesAtMaturityPermissionlessly() public {
        bytes memory payload = _setNumberPayload(1, 42);
        bytes32 actionId = _queue(payload, 10);
        IGovernanceExecutor.ActionRecord memory record = executor.action(actionId);
        vm.warp(record.executableAt);

        address caller = makeAddr("caller");
        vm.prank(caller);
        executor.execute(actionId, payload);

        assertEq(target.number(), 42);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Executed));
    }

    /// @notice The action is permanently expired strictly after its inclusive deadline.
    function testCannotExecuteAfterExpiry() public {
        bytes memory payload = _setNumberPayload(1, 42);
        bytes32 actionId = _queue(payload, 10);
        IGovernanceExecutor.ActionRecord memory record = executor.action(actionId);
        vm.warp(uint256(record.expiresAt) + 1);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionExpired.selector, actionId, record.expiresAt));
        executor.execute(actionId, payload);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Expired));
    }

    /// @notice A later failure reverts earlier calls and restores the action's ready state.
    function testRevertingBatchRollsBackAndRemainsRetryable() public {
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](2);
        calls[0] =
            GovernanceCodec.Call({target: address(target), value: 0, data: abi.encodeCall(CallTarget.setNumber, (42))});
        calls[1] = GovernanceCodec.Call({target: address(target), value: 0, data: abi.encodeCall(CallTarget.fail, ())});
        bytes memory payload = codec.encode(DESTINATION_CHAIN, address(executor), 1, calls);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        vm.expectRevert();
        executor.execute(actionId, payload);

        assertEq(target.number(), 0);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Ready));
    }

    /// @notice A transient downstream failure does not consume the signed authorization.
    function testRevertingCallCanBeRetried() public {
        bytes memory payload = _setNumberPayload(1, 42);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);
        target.setShouldRevert(true);

        vm.expectRevert();
        executor.execute(actionId, payload);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Ready));

        target.setShouldRevert(false);
        executor.execute(actionId, payload);
        assertEq(target.number(), 42);
    }

    // ─── Self-administration ────────────────────────────────────

    /// @notice Neither deployer nor veto Safe receives a direct configuration privilege.
    function testAdminFunctionsAreOnlySelf() public {
        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.OnlySelf.selector, address(this)));
        executor.setSourceEmitter(bytes32(uint256(2)));
    }

    function _setNumberPayload(uint64 nonce, uint256 number) internal view returns (bytes memory) {
        return _oneCallPayload(nonce, address(target), 0, abi.encodeCall(CallTarget.setNumber, (number)));
    }

    function _oneCallPayload(uint64 nonce, address callTarget, uint256 value, bytes memory data)
        internal
        view
        returns (bytes memory)
    {
        return codec.encode(DESTINATION_CHAIN, address(executor), nonce, _calls(callTarget, value, data));
    }

    function _calls(address callTarget, uint256 value, bytes memory data)
        internal
        pure
        returns (GovernanceCodec.Call[] memory calls)
    {
        calls = new GovernanceCodec.Call[](1);
        calls[0] = GovernanceCodec.Call({target: callTarget, value: value, data: data});
    }

    function _vaa(uint16 sourceChain, bytes32 emitter, uint64 sequence, bytes memory payload)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(sourceChain, emitter, sequence, payload);
    }

    function _queue(bytes memory payload, uint64 sequence) internal returns (bytes32) {
        return executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_EMITTER, sequence, payload));
    }
}
