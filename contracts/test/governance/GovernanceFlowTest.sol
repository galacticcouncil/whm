// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {GovernanceCodec} from "../../src/governance/GovernanceCodec.sol";
import {GovernanceDispatcher} from "../../src/governance/GovernanceDispatcher.sol";
import {GovernanceExecutor} from "../../src/governance/GovernanceExecutor.sol";
import {IGovernanceExecutor} from "../../src/governance/interfaces/IGovernanceExecutor.sol";

/// @dev Source Wormhole core that captures exactly what the dispatcher publishes.
contract MockSourceWormholeCore {
    uint16 public constant chainId = 73;
    uint256 public messageFee;
    uint64 public nextSequence = 1;

    uint32 public publishedNonce;
    bytes public publishedPayload;
    uint8 public publishedConsistency;

    function publishMessage(uint32 nonce, bytes calldata payload, uint8 consistency)
        external
        payable
        returns (uint64 sequence)
    {
        require(msg.value == messageFee, "wrong fee");
        publishedNonce = nonce;
        publishedPayload = payload;
        publishedConsistency = consistency;
        sequence = nextSequence++;
    }
}

/// @dev Destination core that treats the integration test's envelope as a guardian-verified VM.
contract MockDestinationWormholeCore {
    uint16 public constant chainId = 2;

    function parseAndVerifyVM(bytes calldata vaa)
        external
        pure
        returns (IWormhole.VM memory vm_, bool valid, string memory reason)
    {
        (vm_.emitterChainId, vm_.emitterAddress, vm_.sequence, vm_.payload) =
            abi.decode(vaa, (uint16, bytes32, uint64, bytes));
        vm_.hash = keccak256(vaa);
        valid = true;
        reason = "";
    }
}

contract MockFlowVetoSafe {}

/// @dev Represents a destination protocol contract controlled by the executor.
contract MockGovernedProtocol {
    uint256 public parameter;
    address public lastCaller;

    function setParameter(uint256 newParameter) external {
        parameter = newParameter;
        lastCaller = msg.sender;
    }
}

/// @title Hydration governance message flow integration tests
/// @notice Connects the real dispatcher codec output directly to the real executor queue and
///         execution paths. Only guardian cryptography is mocked.
contract GovernanceFlowTest is Test {
    uint16 constant HYDRATION_CHAIN = 73;
    uint16 constant DESTINATION_CHAIN = 2;
    uint48 constant VETO_PERIOD = 24 hours;
    uint48 constant GRACE_PERIOD = 7 days;
    address constant GOVERNANCE_ADDRESS = 0xaa7e0000000000000000000000000000000aA7e2;

    MockSourceWormholeCore internal sourceCore;
    MockDestinationWormholeCore internal destinationCore;
    MockFlowVetoSafe internal vetoSafe;
    MockGovernedProtocol internal governedProtocol;
    GovernanceDispatcher internal dispatcher;
    GovernanceExecutor internal executor;

    function setUp() public {
        sourceCore = new MockSourceWormholeCore();
        destinationCore = new MockDestinationWormholeCore();
        vetoSafe = new MockFlowVetoSafe();
        governedProtocol = new MockGovernedProtocol();

        GovernanceDispatcher dispatcherImplementation = new GovernanceDispatcher();
        dispatcher = GovernanceDispatcher(
            address(
                new ERC1967Proxy(
                    address(dispatcherImplementation),
                    abi.encodeCall(GovernanceDispatcher.initialize, (address(sourceCore), GOVERNANCE_ADDRESS))
                )
            )
        );

        bytes32 sourceDispatcher = bytes32(uint256(uint160(address(dispatcher))));
        GovernanceExecutor executorImplementation = new GovernanceExecutor();
        executor = GovernanceExecutor(
            payable(
                address(
                    new ERC1967Proxy(
                        address(executorImplementation),
                        abi.encodeCall(
                            GovernanceExecutor.initialize,
                            (address(destinationCore), sourceDispatcher, address(vetoSafe), VETO_PERIOD, GRACE_PERIOD)
                        )
                    )
                )
            )
        );
    }

    /// @notice Dispatcher bytes queue unchanged, derive the same ID, mature, and call as executor.
    function testPublishedActionQueuesAndExecutesEndToEnd() public {
        GovernanceCodec.Call[] memory calls = _setParameterCalls(42);

        vm.prank(GOVERNANCE_ADDRESS);
        (uint64 governanceNonce, uint64 sequence, bytes32 sourceActionId) =
            dispatcher.publish(DESTINATION_CHAIN, address(executor), calls);

        bytes memory payload = sourceCore.publishedPayload();
        bytes memory vaa = _verifiedEnvelope(sequence, payload);
        bytes32 destinationActionId = executor.queue(vaa);

        assertEq(destinationActionId, sourceActionId);
        assertEq(sourceCore.publishedNonce(), 1);
        assertEq(sourceCore.publishedConsistency(), 202);
        assertEq(governanceNonce, 1);
        assertEq(executor.action(destinationActionId).payloadHash, keccak256(payload));

        vm.warp(executor.action(destinationActionId).executableAt);
        executor.execute(destinationActionId, payload);

        assertEq(governedProtocol.parameter(), 42);
        assertEq(governedProtocol.lastCaller(), address(executor));
        assertEq(uint256(executor.state(destinationActionId)), uint256(IGovernanceExecutor.ActionState.Executed));
    }

    /// @notice The destination Safe can irreversibly stop the exact action published on Hydration.
    function testPublishedActionCanBeVetoedEndToEnd() public {
        GovernanceCodec.Call[] memory calls = _setParameterCalls(99);

        vm.prank(GOVERNANCE_ADDRESS);
        (, uint64 sequence, bytes32 sourceActionId) = dispatcher.publish(DESTINATION_CHAIN, address(executor), calls);

        bytes memory payload = sourceCore.publishedPayload();
        bytes32 destinationActionId = executor.queue(_verifiedEnvelope(sequence, payload));
        assertEq(destinationActionId, sourceActionId);

        vm.prank(address(vetoSafe));
        executor.veto(destinationActionId, keccak256("integration veto"));
        vm.warp(executor.action(destinationActionId).executableAt);

        vm.expectRevert(abi.encodeWithSelector(IGovernanceExecutor.ActionNotPending.selector, destinationActionId));
        executor.execute(destinationActionId, payload);
        assertEq(governedProtocol.parameter(), 0);
    }

    function _setParameterCalls(uint256 value) internal view returns (GovernanceCodec.Call[] memory calls) {
        calls = new GovernanceCodec.Call[](1);
        calls[0] = GovernanceCodec.Call({
            target: address(governedProtocol),
            value: 0,
            data: abi.encodeCall(MockGovernedProtocol.setParameter, (value))
        });
    }

    function _verifiedEnvelope(uint64 sequence, bytes memory payload) internal view returns (bytes memory) {
        return abi.encode(HYDRATION_CHAIN, bytes32(uint256(uint160(address(dispatcher)))), sequence, payload);
    }
}
