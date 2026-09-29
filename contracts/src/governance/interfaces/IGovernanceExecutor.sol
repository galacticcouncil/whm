// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title Destination interface for Hydration cross-chain governance
/// @notice A verified Hydration action is queued locally, remains vetoable until expiry, and may be
///         executed permissionlessly only during its maturity window.
interface IGovernanceExecutor {
    /// @notice User-facing lifecycle state. `Ready` and `Expired` are derived from timestamps;
    ///         terminal veto and execution states are stored.
    enum ActionState {
        Unknown,
        Pending,
        Ready,
        Vetoed,
        Executed,
        Expired
    }

    /// @notice Minimal persistent commitment to a queued action.
    /// @dev Payload bytes are resupplied at execution to avoid unbounded dynamic storage.
    struct ActionRecord {
        /// @notice Hash of the exact canonical Wormhole payload accepted by `queue`.
        bytes32 payloadHash;
        /// @notice Monotonic nonce assigned by the Hydration governance dispatcher.
        uint64 governanceNonce;
        /// @notice Destination timestamp at which the VAA was accepted.
        uint48 queuedAt;
        /// @notice First timestamp at which execution is allowed.
        uint48 executableAt;
        /// @notice Last timestamp at which veto or execution is allowed, inclusive.
        uint48 expiresAt;
        /// @notice Internal terminal marker; callers should normally use `state`.
        uint8 storedStatus;
    }

    error ZeroAddress();
    error AddressHasNoCode(address account);
    error InvalidLocalWormholeChain();
    error InvalidSourceDispatcher();
    error VetoPeriodTooShort(uint48 supplied, uint48 minimum);
    error GracePeriodTooShort(uint48 supplied, uint48 minimum);
    error InvalidVaa();
    error UnauthorizedEmitter(uint16 emitterChain, bytes32 emitterAddress);
    error WrongDestination(uint16 destinationChain, address destinationExecutor);
    error VaaAlreadyConsumed(bytes32 vaaHash);
    error ActionAlreadyQueued(bytes32 actionId);
    error DeadlineOverflow();
    error ReentrantCall();
    error NotVetoer(address caller);
    error OnlySelf(address caller);
    error ActionNotPending(bytes32 actionId);
    error ActionNotReady(bytes32 actionId, uint48 executableAt);
    error ActionExpired(bytes32 actionId, uint48 expiresAt);
    error PayloadHashMismatch(bytes32 expected, bytes32 actual);
    error InsufficientBalance(uint256 required, uint256 available);
    error InvalidUpgradeBatch();
    error CallFailed(uint256 index, bytes returnData);

    event ActionQueued(
        bytes32 indexed actionId,
        bytes32 indexed vaaHash,
        uint64 indexed governanceNonce,
        bytes32 payloadHash,
        uint48 queuedAt,
        uint48 executableAt,
        uint48 expiresAt
    );
    event ActionVetoed(bytes32 indexed actionId, address indexed vetoer, bytes32 indexed reasonHash);
    event ActionExecuted(bytes32 indexed actionId, address indexed caller);
    event VetoerUpdated(address indexed previousVetoer, address indexed newVetoer);
    event SourceDispatcherUpdated(bytes32 previousSourceDispatcher, bytes32 newSourceDispatcher);
    event TimingUpdated(uint48 vetoPeriod, uint48 executionGracePeriod);

    /// @notice Atomically configures a freshly deployed ERC-1967 proxy.
    /// @param wormhole Destination chain's trusted Wormhole core contract.
    /// @param sourceDispatcher Hydration `GovernanceDispatcher` in Wormhole universal-address form.
    /// @param vetoer Destination Technical Committee Safe; must contain deployed code.
    /// @param vetoPeriod Local delay beginning when `queue` accepts the VAA.
    /// @param executionGracePeriod Time after maturity during which veto and execution remain valid.
    function initialize(
        address wormhole,
        bytes32 sourceDispatcher,
        address vetoer,
        uint48 vetoPeriod,
        uint48 executionGracePeriod
    ) external;

    /// @notice Verifies and queues an action. Any account may relay the signed VAA.
    /// @return actionId Source-domain-separated identifier of the accepted payload.
    function queue(bytes calldata vaa) external returns (bytes32 actionId);

    /// @notice Irreversibly cancels a pending action; callable only by the configured vetoer.
    /// @param reasonHash Optional hash of an off-chain incident or rationale; it may be zero.
    function veto(bytes32 actionId, bytes32 reasonHash) external;

    /// @notice Atomically performs a matured action using the exact queued payload.
    /// @dev Permissionless. A downstream revert restores the pending state, permitting retry.
    function execute(bytes32 actionId, bytes calldata payload) external;

    /// @notice Returns the persistent record, or an all-zero record for an unknown ID.
    function action(bytes32 actionId) external view returns (ActionRecord memory);

    /// @notice Returns the stored or timestamp-derived lifecycle state.
    function state(bytes32 actionId) external view returns (ActionState);

    /// @notice Replaces the veto Safe through a matured executor self-call.
    function setVetoer(address newVetoer) external;

    /// @notice Rotates the authorized Hydration dispatcher through a matured executor self-call.
    function setSourceDispatcher(bytes32 newSourceDispatcher) external;

    /// @notice Changes timing for subsequently queued actions, subject to immutable v1 floors.
    function setTiming(uint48 newVetoPeriod, uint48 newExecutionGracePeriod) external;
}
