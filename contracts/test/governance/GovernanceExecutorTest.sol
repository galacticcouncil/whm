// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
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
contract MockSafe {}

/// @dev Governed target used to prove successful calls, rollback, and retry semantics.
contract MockCallTarget {
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

/// @dev Attempts to execute the same action recursively, catches the failure, and records its error.
contract MockReentrantCallTarget {
    IGovernanceExecutor public executor;
    bytes32 public actionId;
    bytes public payload;
    bytes4 public observedError;

    function configure(IGovernanceExecutor executor_, bytes32 actionId_, bytes calldata payload_) external {
        executor = executor_;
        actionId = actionId_;
        payload = payload_;
    }

    function attack() external {
        (bool success, bytes memory returnData) =
            address(executor).call(abi.encodeCall(IGovernanceExecutor.execute, (actionId, payload)));
        require(!success, "reentrant execution succeeded");
        if (returnData.length >= 4) {
            bytes4 selector;
            assembly ("memory-safe") {
                selector := mload(add(returnData, 0x20))
            }
            observedError = selector;
        }
    }
}

/// @dev Produces more revert data than the executor is willing to copy from an untrusted target.
contract MockLargeReverter {
    function failWithBytes(uint256 size) external pure {
        assembly {
            revert(0, size)
        }
    }
}

/// @dev Real ERC-721 transfer machinery around a public test mint.
contract MockPositionNFT is ERC721 {
    constructor() ERC721("Mock position", "MPOS") {}

    function mint(address owner, uint256 tokenId) external {
        _mint(owner, tokenId);
    }
}

/// @dev Upgrade target with a second namespaced storage region and self-authorized reinitializer.
contract GovernanceExecutorV2 is GovernanceExecutor {
    /// @custom:storage-location erc7201:hydration.test.GovernanceExecutorV2
    struct V2Storage {
        uint256 initializedValue;
    }

    bytes32 private constant V2_STORAGE_LOCATION = 0xa90e0cc98d2f14eb3cc7d25a6100727ccb92bb24c387c161ff6bd1fed9cb7400;

    function initializeV2(uint256 value) external reinitializer(2) {
        if (msg.sender != address(this)) revert OnlySelf(msg.sender);
        _getV2Storage().initializedValue = value;
    }

    function version() external pure returns (uint256) {
        return 2;
    }

    function initializedValue() external view returns (uint256) {
        return _getV2Storage().initializedValue;
    }

    function _getV2Storage() private pure returns (V2Storage storage $) {
        assembly ("memory-safe") {
            $.slot := V2_STORAGE_LOCATION
        }
    }
}

/// @title GovernanceExecutor lifecycle and authority tests
/// @notice Pins the security boundary from verified Hydration VAA through delayed destination call.
contract GovernanceExecutorTest is Test {
    uint16 constant HYDRATION_CHAIN = 73;
    uint16 constant DESTINATION_CHAIN = 2;
    uint48 constant VETO_PERIOD = 24 hours;
    uint48 constant GRACE_PERIOD = 7 days;
    bytes32 constant SOURCE_DISPATCHER = bytes32(uint256(0xE1117));

    MockGovernanceWormhole internal wormhole;
    ExecutorCodecHarness internal codec;
    GovernanceExecutor internal executor;
    GovernanceExecutor internal implementation;
    MockSafe internal safe;
    MockCallTarget internal target;

    /// @dev Deploys the implementation and initializes its proxy atomically, as production must.
    function setUp() public {
        wormhole = new MockGovernanceWormhole(DESTINATION_CHAIN);
        codec = new ExecutorCodecHarness();
        safe = new MockSafe();
        target = new MockCallTarget();

        implementation = new GovernanceExecutor();
        executor = GovernanceExecutor(
            payable(
                address(
                    new ERC1967Proxy(
                        address(implementation),
                        abi.encodeCall(
                            GovernanceExecutor.initialize,
                            (address(wormhole), SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD)
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
        assertEq(executor.sourceDispatcher(), SOURCE_DISPATCHER);
        assertEq(executor.vetoer(), address(safe));
        assertEq(executor.localWormholeChain(), DESTINATION_CHAIN);
        assertEq(executor.vetoPeriod(), VETO_PERIOD);
        assertEq(executor.executionGracePeriod(), GRACE_PERIOD);
    }

    /// @notice The implementation contract is permanently locked against initialization.
    function testImplementationCannotBeInitialized() public {
        vm.expectRevert();
        implementation.initialize(address(wormhole), SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD);
    }

    /// @notice Proxy bootstrap configuration can be written exactly once.
    function testProxyCannotBeReinitialized() public {
        vm.expectRevert();
        executor.initialize(address(wormhole), SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD);
    }

    /// @notice Initialization rejects dependencies that cannot implement the expected contracts.
    function testInitializationRejectsAddressesWithoutCode() public {
        address eoa = makeAddr("eoa");

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.AddressHasNoCode.selector, eoa));
        _deployExecutor(eoa, SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.AddressHasNoCode.selector, eoa));
        _deployExecutor(address(wormhole), SOURCE_DISPATCHER, eoa, VETO_PERIOD, GRACE_PERIOD);
    }

    /// @notice The initial configuration cannot weaken the immutable v1 timing floors.
    function testInitializationEnforcesTimingFloors() public {
        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.VetoPeriodTooShort.selector, VETO_PERIOD - 1, VETO_PERIOD)
        );
        _deployExecutor(address(wormhole), SOURCE_DISPATCHER, address(safe), VETO_PERIOD - 1, GRACE_PERIOD);

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.GracePeriodTooShort.selector, GRACE_PERIOD - 1, GRACE_PERIOD)
        );
        _deployExecutor(address(wormhole), SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD - 1);
    }

    /// @notice Zero bootstrap authorities and a core reporting chain zero fail closed.
    function testInitializationRejectsZeroConfiguration() public {
        vm.expectRevert(IGovernanceExecutor.ZeroAddress.selector);
        _deployExecutor(address(0), SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD);

        vm.expectRevert(IGovernanceExecutor.InvalidSourceDispatcher.selector);
        _deployExecutor(address(wormhole), bytes32(0), address(safe), VETO_PERIOD, GRACE_PERIOD);

        vm.expectRevert(IGovernanceExecutor.ZeroAddress.selector);
        _deployExecutor(address(wormhole), SOURCE_DISPATCHER, address(0), VETO_PERIOD, GRACE_PERIOD);

        MockGovernanceWormhole zeroChainCore = new MockGovernanceWormhole(0);
        vm.expectRevert(IGovernanceExecutor.InvalidLocalWormholeChain.selector);
        _deployExecutor(address(zeroChainCore), SOURCE_DISPATCHER, address(safe), VETO_PERIOD, GRACE_PERIOD);
    }

    /// @notice A key absent from storage has the explicit Unknown state.
    function testUnknownActionState() public view {
        assertEq(uint256(executor.state(keccak256("unknown"))), uint256(IGovernanceExecutor.ActionState.Unknown));
    }

    // ─── Queue authentication and replay ────────────────────────

    /// @notice A valid VAA stores only its commitment and deadlines and starts pending.
    function testQueuesVerifiedAction() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"1234");
        bytes memory vaa = _vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload);
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
        bytes memory vaa = _vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload);
        wormhole.markInvalid(vaa);

        vm.expectRevert(IGovernanceExecutor.InvalidVaa.selector);
        executor.queue(vaa);
    }

    /// @notice A validly signed message from any dispatcher other than governance is unauthorized.
    function testRejectsWrongSource() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes32 attacker = bytes32(uint256(0xBAD));

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.UnauthorizedEmitter.selector, HYDRATION_CHAIN, attacker)
        );
        executor.queue(_vaa(HYDRATION_CHAIN, attacker, 10, payload));
    }

    /// @notice Even the configured dispatcher is unauthorized when the verified source chain differs.
    function testRejectsWrongSourceChain() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.UnauthorizedEmitter.selector, uint16(2), SOURCE_DISPATCHER)
        );
        executor.queue(_vaa(2, SOURCE_DISPATCHER, 10, payload));
    }

    /// @notice A VAA cannot be replayed against a chain other than the one signed into its payload.
    function testRejectsWrongDestination() public {
        GovernanceCodec.Call[] memory calls = _calls(address(target), 0, hex"");
        bytes memory payload = codec.encode(30, address(executor), 1, calls);

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.WrongDestination.selector, uint16(30), address(executor))
        );
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload));
    }

    /// @notice Destination binding includes the executor address, not only its chain.
    function testRejectsWrongDestinationExecutor() public {
        GovernanceCodec.Call[] memory calls = _calls(address(target), 0, hex"");
        address otherExecutor = makeAddr("other executor");
        bytes memory payload = codec.encode(DESTINATION_CHAIN, otherExecutor, 1, calls);

        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.WrongDestination.selector, DESTINATION_CHAIN, otherExecutor)
        );
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload));
    }

    /// @notice Deadline arithmetic cannot truncate into the uint48 fields stored in an action.
    function testRejectsDeadlineOverflow() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        vm.warp(uint256(type(uint48).max) - VETO_PERIOD - GRACE_PERIOD + 1);

        vm.expectRevert(IGovernanceExecutor.DeadlineOverflow.selector);
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload));
    }

    /// @notice The exact signed Wormhole envelope can be accepted at most once.
    function testRejectsVaaReplay() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes memory vaa = _vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload);
        executor.queue(vaa);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.VaaAlreadyConsumed.selector, keccak256(vaa)));
        executor.queue(vaa);
    }

    /// @notice Distinct envelopes carrying the same source-domain payload cannot duplicate an action.
    function testRejectsDuplicateActionFromDifferentVaa() public {
        bytes memory payload = _oneCallPayload(1, address(target), 0, hex"");
        bytes32 actionId = executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 10, payload));

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionAlreadyQueued.selector, actionId));
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 11, payload));
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

    /// @notice The expiry timestamp itself remains inside the veto window.
    function testVetoSucceedsExactlyAtExpiry() public {
        bytes32 actionId = _queue(_oneCallPayload(1, address(target), 0, hex""), 10);
        IGovernanceExecutor.ActionRecord memory record = executor.action(actionId);
        vm.warp(record.expiresAt);

        vm.prank(address(safe));
        executor.veto(actionId, bytes32(0));

        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Vetoed));
    }

    /// @notice A veto arriving after the inclusive deadline cannot revive or alter an expired action.
    function testVetoFailsAfterExpiry() public {
        bytes32 actionId = _queue(_oneCallPayload(1, address(target), 0, hex""), 10);
        IGovernanceExecutor.ActionRecord memory record = executor.action(actionId);
        vm.warp(uint256(record.expiresAt) + 1);

        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionExpired.selector, actionId, record.expiresAt));
        executor.veto(actionId, bytes32(0));
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

    /// @notice The expiry timestamp itself remains inside the execution window.
    function testExecutesExactlyAtExpiry() public {
        bytes memory payload = _setNumberPayload(1, 42);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).expiresAt);

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

    /// @notice A caller cannot substitute different calls for the payload committed during queueing.
    function testRejectsPayloadSubstitution() public {
        bytes memory payload = _setNumberPayload(1, 42);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);
        bytes memory substitute = _setNumberPayload(1, 99);

        vm.expectRevert(
            abi.encodeWithSelector(
                IGovernanceExecutor.PayloadHashMismatch.selector, keccak256(payload), keccak256(substitute)
            )
        );
        executor.execute(actionId, substitute);
        assertEq(target.number(), 0);
    }

    /// @notice Vetoed and executed records are terminal and cannot execute again.
    function testTerminalActionsCannotExecute() public {
        bytes memory vetoedPayload = _setNumberPayload(1, 1);
        bytes32 vetoed = _queue(vetoedPayload, 10);
        vm.prank(address(safe));
        executor.veto(vetoed, bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionNotPending.selector, vetoed));
        executor.execute(vetoed, vetoedPayload);

        bytes memory executedPayload = _setNumberPayload(2, 2);
        bytes32 executed = _queue(executedPayload, 11);
        vm.warp(executor.action(executed).executableAt);
        executor.execute(executed, executedPayload);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionNotPending.selector, executed));
        executor.execute(executed, executedPayload);
    }

    /// @notice A later failure reverts earlier calls and restores the action's ready state.
    function testRevertingBatchRollsBackAndRemainsRetryable() public {
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](2);
        calls[0] = GovernanceCodec.Call({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockCallTarget.setNumber, (42))
        });
        calls[1] =
            GovernanceCodec.Call({target: address(target), value: 0, data: abi.encodeCall(MockCallTarget.fail, ())});
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

    /// @notice Value-bearing calls spend only balance already held by the executor.
    function testForwardsNativeValue() public {
        uint256 value = 0.4 ether;
        bytes memory payload =
            _oneCallPayload(1, address(target), value, abi.encodeCall(MockCallTarget.setNumber, (42)));
        bytes32 actionId = _queue(payload, 10);
        vm.deal(address(executor), value);
        vm.warp(executor.action(actionId).executableAt);

        executor.execute(actionId, payload);

        assertEq(address(target).balance, value);
        assertEq(address(executor).balance, 0);
        assertEq(target.number(), 42);
    }

    /// @notice The whole batch fails before interaction when its native-value sum is unavailable.
    function testRejectsInsufficientNativeBalance() public {
        uint256 value = 1 ether;
        bytes memory payload =
            _oneCallPayload(1, address(target), value, abi.encodeCall(MockCallTarget.setNumber, (42)));
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.InsufficientBalance.selector, value, uint256(0)));
        executor.execute(actionId, payload);
        assertEq(target.number(), 0);
    }

    /// @notice Summing maliciously large values uses checked arithmetic and fails closed.
    function testRejectsNativeValueSumOverflow() public {
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](2);
        calls[0] = GovernanceCodec.Call({target: address(target), value: type(uint256).max, data: hex""});
        calls[1] = GovernanceCodec.Call({target: address(target), value: 1, data: hex""});
        bytes memory payload = codec.encode(DESTINATION_CHAIN, address(executor), 1, calls);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        vm.expectRevert();
        executor.execute(actionId, payload);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Ready));
    }

    /// @notice A target cannot recursively consume the currently executing action.
    function testRejectsReentrantExecution() public {
        MockReentrantCallTarget reentrantTarget = new MockReentrantCallTarget();
        bytes memory payload =
            _oneCallPayload(1, address(reentrantTarget), 0, abi.encodeCall(MockReentrantCallTarget.attack, ()));
        bytes32 actionId = _queue(payload, 10);
        reentrantTarget.configure(IGovernanceExecutor(address(executor)), actionId, payload);
        vm.warp(executor.action(actionId).executableAt);

        executor.execute(actionId, payload);

        assertEq(reentrantTarget.observedError(), IGovernanceExecutor.ReentrantCall.selector);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Executed));
    }

    /// @notice Revert data copied from an untrusted target is capped at exactly 4 KiB.
    function testCapsRevertData() public {
        MockLargeReverter reverter = new MockLargeReverter();
        bytes memory payload =
            _oneCallPayload(1, address(reverter), 0, abi.encodeCall(MockLargeReverter.failWithBytes, (8_192)));
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        (bool success, bytes memory returnData) =
            address(executor).call(abi.encodeCall(IGovernanceExecutor.execute, (actionId, payload)));

        assertFalse(success);
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(returnData, 0x20))
        }
        assertEq(selector, IGovernanceExecutor.CallFailed.selector);
        // selector + two static head words + dynamic length word + capped dynamic bytes
        assertEq(returnData.length, 4 + 64 + 32 + 4_096);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Ready));
    }

    /// @notice An ERC-721 callback may complete while the executor's lifecycle guard is active.
    function testReceivesPositionNftDuringExecution() public {
        MockPositionNFT nft = new MockPositionNFT();
        uint256 tokenId = 7;
        nft.mint(address(this), tokenId);
        nft.approve(address(executor), tokenId);

        bytes memory transfer = abi.encodeWithSignature(
            "safeTransferFrom(address,address,uint256)", address(this), address(executor), tokenId
        );
        bytes memory payload = _oneCallPayload(1, address(nft), 0, transfer);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        executor.execute(actionId, payload);

        assertEq(nft.ownerOf(tokenId), address(executor));
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Executed));
    }

    // ─── Self-administration ────────────────────────────────────

    /// @notice Neither deployer nor veto Safe receives a direct configuration privilege.
    function testAdminFunctionsAreOnlySelf() public {
        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.OnlySelf.selector, address(this)));
        executor.setSourceDispatcher(bytes32(uint256(2)));

        MockSafe newSafe = new MockSafe();
        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.OnlySelf.selector, address(this)));
        executor.setVetoer(address(newSafe));

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.OnlySelf.selector, address(this)));
        executor.setTiming(48 hours, 8 days);
    }

    /// @notice A matured action can rotate the veto Safe; neither old Safe nor deployer can bypass it.
    function testQueuedActionRotatesVetoer() public {
        MockSafe newSafe = new MockSafe();
        bytes memory rotationPayload =
            _oneCallPayload(1, address(executor), 0, abi.encodeCall(IGovernanceExecutor.setVetoer, (address(newSafe))));
        bytes32 rotation = _queue(rotationPayload, 10);
        vm.warp(executor.action(rotation).executableAt);
        executor.execute(rotation, rotationPayload);
        assertEq(executor.vetoer(), address(newSafe));

        bytes32 nextAction = _queue(_oneCallPayload(2, address(target), 0, hex""), 11);
        vm.prank(address(safe));
        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.NotVetoer.selector, address(safe)));
        executor.veto(nextAction, bytes32(0));

        vm.prank(address(newSafe));
        executor.veto(nextAction, bytes32(0));
        assertEq(uint256(executor.state(nextAction)), uint256(IGovernanceExecutor.ActionState.Vetoed));
    }

    /// @notice Timing changes are delayed themselves and never rewrite existing action deadlines.
    function testTimingUpdateAffectsOnlyNewActions() public {
        bytes32 existing = _queue(_oneCallPayload(1, address(target), 0, hex""), 10);
        IGovernanceExecutor.ActionRecord memory existingBefore = executor.action(existing);

        uint48 newVetoPeriod = 48 hours;
        uint48 newGracePeriod = 8 days;
        bytes memory timingPayload = _oneCallPayload(
            2, address(executor), 0, abi.encodeCall(IGovernanceExecutor.setTiming, (newVetoPeriod, newGracePeriod))
        );
        bytes32 timingAction = _queue(timingPayload, 11);
        vm.warp(executor.action(timingAction).executableAt);
        executor.execute(timingAction, timingPayload);

        assertEq(executor.vetoPeriod(), newVetoPeriod);
        assertEq(executor.executionGracePeriod(), newGracePeriod);
        IGovernanceExecutor.ActionRecord memory existingAfter = executor.action(existing);
        assertEq(existingAfter.executableAt, existingBefore.executableAt);
        assertEq(existingAfter.expiresAt, existingBefore.expiresAt);

        bytes32 fresh = _queue(_oneCallPayload(3, address(target), 0, hex""), 12);
        IGovernanceExecutor.ActionRecord memory freshRecord = executor.action(fresh);
        assertEq(freshRecord.executableAt, block.timestamp + newVetoPeriod);
        assertEq(freshRecord.expiresAt, block.timestamp + newVetoPeriod + newGracePeriod);
    }

    /// @notice Even a properly delayed self-call cannot configure timing below the v1 floors.
    function testQueuedActionCannotReduceTimingBelowFloors() public {
        bytes memory payload = _oneCallPayload(
            1, address(executor), 0, abi.encodeCall(IGovernanceExecutor.setTiming, (VETO_PERIOD - 1, GRACE_PERIOD))
        );
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        vm.expectRevert();
        executor.execute(actionId, payload);

        assertEq(executor.vetoPeriod(), VETO_PERIOD);
        assertEq(uint256(executor.state(actionId)), uint256(IGovernanceExecutor.ActionState.Ready));
    }

    /// @notice Rotation rejects newly submitted old-dispatcher VAAs without stranding queued actions.
    function testDispatcherRotationPreservesQueuedActions() public {
        bytes32 queuedOld = _queue(_setNumberPayload(1, 42), 10);
        bytes32 newDispatcher = bytes32(uint256(0xBEEF));
        bytes memory rotationPayload = _oneCallPayload(
            2, address(executor), 0, abi.encodeCall(IGovernanceExecutor.setSourceDispatcher, (newDispatcher))
        );
        bytes32 rotation = _queue(rotationPayload, 11);
        vm.warp(executor.action(rotation).executableAt);
        executor.execute(rotation, rotationPayload);
        assertEq(executor.sourceDispatcher(), newDispatcher);

        bytes memory laterPayload = _oneCallPayload(3, address(target), 0, hex"");
        vm.expectRevert(
            abi.encodeWithSelector(IGovernanceExecutor.UnauthorizedEmitter.selector, HYDRATION_CHAIN, SOURCE_DISPATCHER)
        );
        executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, 12, laterPayload));

        bytes32 queuedNew = executor.queue(_vaa(HYDRATION_CHAIN, newDispatcher, 12, laterPayload));
        assertEq(uint256(executor.state(queuedNew)), uint256(IGovernanceExecutor.ActionState.Pending));

        bytes memory oldPayload = _setNumberPayload(1, 42);
        executor.execute(queuedOld, oldPayload);
        assertEq(target.number(), 42);
    }

    // ─── UUPS upgrades ──────────────────────────────────────────

    /// @notice Calling the UUPS surface directly cannot bypass the delayed self-call requirement.
    function testDirectUpgradeIsRejected() public {
        GovernanceExecutorV2 v2 = new GovernanceExecutorV2();

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.OnlySelf.selector, address(this)));
        executor.upgradeToAndCall(address(v2), "");
    }

    /// @notice A sole zero-value upgrade action succeeds, runs initialization, and preserves v1 state.
    function testQueuedUpgradeSucceedsAndPreservesStorage() public {
        bytes32 pending = _queue(_oneCallPayload(1, address(target), 0, hex""), 10);
        IGovernanceExecutor.ActionRecord memory pendingBefore = executor.action(pending);
        GovernanceExecutorV2 v2 = new GovernanceExecutorV2();
        bytes memory initializeV2 = abi.encodeCall(GovernanceExecutorV2.initializeV2, (99));
        bytes memory upgradeCall = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(v2), initializeV2);
        bytes memory payload = _oneCallPayload(2, address(executor), 0, upgradeCall);
        bytes32 upgradeAction = _queue(payload, 11);
        vm.warp(executor.action(upgradeAction).executableAt);

        executor.execute(upgradeAction, payload);

        GovernanceExecutorV2 upgraded = GovernanceExecutorV2(payable(address(executor)));
        assertEq(upgraded.version(), 2);
        assertEq(upgraded.initializedValue(), 99);
        assertEq(upgraded.sourceDispatcher(), SOURCE_DISPATCHER);
        assertEq(upgraded.vetoer(), address(safe));
        IGovernanceExecutor.ActionRecord memory pendingAfter = upgraded.action(pending);
        assertEq(pendingAfter.payloadHash, pendingBefore.payloadHash);
        assertEq(pendingAfter.executableAt, pendingBefore.executableAt);
        assertEq(uint256(upgraded.state(upgradeAction)), uint256(IGovernanceExecutor.ActionState.Executed));
    }

    /// @notice A batch cannot continue under implementation code different from what was reviewed.
    function testRejectsUpgradeMixedWithAnotherCall() public {
        GovernanceExecutorV2 v2 = new GovernanceExecutorV2();
        GovernanceCodec.Call[] memory calls = new GovernanceCodec.Call[](2);
        calls[0] = GovernanceCodec.Call({
            target: address(executor),
            value: 0,
            data: abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(v2), bytes(""))
        });
        calls[1] = GovernanceCodec.Call({
            target: address(target),
            value: 0,
            data: abi.encodeCall(MockCallTarget.setNumber, (42))
        });
        bytes memory payload = codec.encode(DESTINATION_CHAIN, address(executor), 1, calls);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        vm.expectRevert(IGovernanceExecutor.InvalidUpgradeBatch.selector);
        executor.execute(actionId, payload);
        assertEq(target.number(), 0);
    }

    /// @notice Upgrade calls cannot transfer native currency to the proxy itself.
    function testRejectsValueBearingUpgrade() public {
        GovernanceExecutorV2 v2 = new GovernanceExecutorV2();
        bytes memory upgradeCall = abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(v2), bytes(""));
        bytes memory payload = _oneCallPayload(1, address(executor), 1, upgradeCall);
        bytes32 actionId = _queue(payload, 10);
        vm.warp(executor.action(actionId).executableAt);

        vm.expectRevert(IGovernanceExecutor.InvalidUpgradeBatch.selector);
        executor.execute(actionId, payload);
    }

    function _setNumberPayload(uint64 nonce, uint256 number) internal view returns (bytes memory) {
        return _oneCallPayload(nonce, address(target), 0, abi.encodeCall(MockCallTarget.setNumber, (number)));
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
        return executor.queue(_vaa(HYDRATION_CHAIN, SOURCE_DISPATCHER, sequence, payload));
    }

    function _deployExecutor(
        address wormhole_,
        bytes32 sourceDispatcher_,
        address vetoer_,
        uint48 vetoPeriod_,
        uint48 gracePeriod_
    ) internal returns (GovernanceExecutor deployed) {
        deployed = GovernanceExecutor(
            payable(
                address(
                    new ERC1967Proxy(
                        address(implementation),
                        abi.encodeCall(
                            GovernanceExecutor.initialize,
                            (wormhole_, sourceDispatcher_, vetoer_, vetoPeriod_, gracePeriod_)
                        )
                    )
                )
            )
        );
    }
}
