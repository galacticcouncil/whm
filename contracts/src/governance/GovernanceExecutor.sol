// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {GovernanceCodec} from "./GovernanceCodec.sol";
import {IGovernanceExecutor} from "./interfaces/IGovernanceExecutor.sol";

/// @title GovernanceExecutor — delayed destination executor for Hydration OpenGov
/// @notice Accepts only guardian-verified messages from the configured Hydration dispatcher.
///         Actions wait locally for the veto period, then execute atomically and permissionlessly.
contract GovernanceExecutor is Initializable, UUPSUpgradeable, IERC721Receiver, IGovernanceExecutor {
    /// @notice Wormhole identifier assigned to Hydration; source-chain selection is immutable in v1.
    uint16 public constant HYDRATION_WORMHOLE_CHAIN = 73;
    /// @notice Governance may lengthen but cannot shorten this review period without an upgrade.
    uint48 public constant MIN_VETO_PERIOD = 24 hours;
    /// @notice Governance may lengthen but cannot shorten this execution window without an upgrade.
    uint48 public constant MIN_EXECUTION_GRACE_PERIOD = 7 days;

    // Zero deliberately means "unknown", making an uninitialized mapping entry unambiguous.
    uint8 private constant STATUS_PENDING = 1;
    uint8 private constant STATUS_VETOED = 2;
    uint8 private constant STATUS_EXECUTED = 3;
    /// @dev Caps data copied from an untrusted call target into executor memory and revert data.
    uint256 private constant MAX_RETURN_DATA = 4_096;
    /// @dev Used to forbid continuing a batch after its implementation and semantics have changed.
    bytes4 private constant UPGRADE_TO_AND_CALL_SELECTOR = bytes4(keccak256("upgradeToAndCall(address,bytes)"));

    /// @dev Upgrade-safe application state. New versions must append fields and preserve this
    ///      ERC-7201 namespace; moving or reordering existing fields corrupts proxy state.
    /// @custom:storage-location erc7201:hydration.storage.GovernanceExecutor
    struct ExecutorStorage {
        /// @dev Trusted verifier. Guardian quorum security terminates at this core contract.
        IWormhole wormhole;
        /// @dev Authorized Hydration dispatcher as a Wormhole emitter address. Rotation does not
        ///      alter queued records.
        bytes32 sourceDispatcher;
        /// @dev Veto-only Technical Committee Safe for this destination chain.
        address vetoer;
        uint16 localWormholeChain;
        /// @dev Defaults copied into each newly queued record; existing deadlines never change.
        uint48 vetoPeriod;
        uint48 executionGracePeriod;
        /// @dev One guard shared by queue, veto, and execute. Receiver callbacks remain unguarded.
        uint8 reentrancyStatus;
        /// @dev VAA replay protection is separate from action replay protection: distinct signed
        ///      envelopes could theoretically contain an identical governance payload.
        mapping(bytes32 => bool) consumedVaas;
        mapping(bytes32 => ActionRecord) actions;
    }

    bytes32 private constant EXECUTOR_STORAGE_LOCATION =
        0xea3bb21c2b818517127c61a33de254cb0fa1b2ed79cc52e4737929f0b478bb00;

    /// @dev Prevents a Wormhole core or governed call target from re-entering lifecycle methods.
    modifier nonReentrant() {
        ExecutorStorage storage $ = _getExecutorStorage();
        if ($.reentrancyStatus == 2) revert ReentrantCall();
        $.reentrancyStatus = 2;
        _;
        $.reentrancyStatus = 1;
    }

    /// @dev A proxy calling itself has `msg.sender == address(this)`. Therefore configuration and
    ///      upgrades are reachable only as calls inside a matured, non-vetoed governance action.
    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf(msg.sender);
        _;
    }

    /// @dev Locks the implementation contract. The proxy must initialize atomically in its
    ///      constructor so no third party can claim bootstrap authority.
    constructor() {
        _disableInitializers();
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev Reads the local Wormhole ID from the trusted core instead of accepting caller input.
    function initialize(
        address wormhole_,
        bytes32 sourceDispatcher_,
        address vetoer_,
        uint48 vetoPeriod_,
        uint48 executionGracePeriod_
    ) external initializer {
        if (wormhole_ == address(0)) revert ZeroAddress();
        if (wormhole_.code.length == 0) revert AddressHasNoCode(wormhole_);
        if (sourceDispatcher_ == bytes32(0)) revert InvalidSourceDispatcher();
        _validateVetoerAddress(vetoer_);
        _validateTiming(vetoPeriod_, executionGracePeriod_);

        uint16 localChain = IWormhole(wormhole_).chainId();
        if (localChain == 0 || localChain == HYDRATION_WORMHOLE_CHAIN) {
            revert InvalidLocalWormholeChain();
        }

        ExecutorStorage storage $ = _getExecutorStorage();
        $.wormhole = IWormhole(wormhole_);
        $.sourceDispatcher = sourceDispatcher_;
        $.vetoer = vetoer_;
        $.localWormholeChain = localChain;
        $.vetoPeriod = vetoPeriod_;
        $.executionGracePeriod = executionGracePeriod_;
        $.reentrancyStatus = 1;
    }

    /// @notice Accepts native currency needed by queued value-bearing calls.
    /// @dev There is no privileged sweep path; native outflow requires a delayed action.
    receive() external payable {}

    /// @notice Accepts Uniswap and other ERC-721 positions transferred into governance custody.
    /// @dev Intentionally not reentrancy-guarded: a governed call may safely transfer an NFT back
    ///      to this executor. The callback mutates no governance state.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev The review clock begins here—not at source publication—so delayed relaying never
    ///      shortens the Technical Committee's configured veto window.
    function queue(bytes calldata vaa) external nonReentrant returns (bytes32 actionId_) {
        ExecutorStorage storage $ = _getExecutorStorage();
        (IWormhole.VM memory vm, bool valid,) = $.wormhole.parseAndVerifyVM(vaa);
        if (!valid) revert InvalidVaa();
        if (vm.emitterChainId != HYDRATION_WORMHOLE_CHAIN || vm.emitterAddress != $.sourceDispatcher) {
            revert UnauthorizedEmitter(vm.emitterChainId, vm.emitterAddress);
        }
        if ($.consumedVaas[vm.hash]) revert VaaAlreadyConsumed(vm.hash);

        GovernanceCodec.GovernanceAction memory decoded = GovernanceCodec.decode(vm.payload);
        if (decoded.destinationWormholeChain != $.localWormholeChain || decoded.destinationExecutor != address(this)) {
            revert WrongDestination(decoded.destinationWormholeChain, decoded.destinationExecutor);
        }

        bytes32 payloadHash = keccak256(vm.payload);
        // Wormhole sequence is intentionally absent. The dispatcher-assigned nonce lives inside the
        // payload, while source chain + emitter + payload hash fully identify the authorization.
        actionId_ = GovernanceCodec.actionId(vm.emitterChainId, vm.emitterAddress, payloadHash);
        if ($.actions[actionId_].storedStatus != 0) revert ActionAlreadyQueued(actionId_);

        uint256 executableAt_ = block.timestamp + $.vetoPeriod;
        uint256 expiresAt_ = executableAt_ + $.executionGracePeriod;
        if (expiresAt_ > type(uint48).max) revert DeadlineOverflow();

        uint48 queuedAt_ = uint48(block.timestamp);
        // Consume before emitting. Any later revert rolls this write back with the whole queue call.
        $.consumedVaas[vm.hash] = true;
        $.actions[actionId_] = ActionRecord({
            payloadHash: payloadHash,
            governanceNonce: decoded.governanceNonce,
            queuedAt: queuedAt_,
            executableAt: uint48(executableAt_),
            expiresAt: uint48(expiresAt_),
            storedStatus: STATUS_PENDING
        });

        emit ActionQueued(
            actionId_,
            vm.hash,
            decoded.governanceNonce,
            payloadHash,
            queuedAt_,
            uint48(executableAt_),
            uint48(expiresAt_)
        );
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev Veto remains valid at and after maturity through `expiresAt`, inclusive. Once execution
    ///      is possible, transaction ordering decides a veto/execution race.
    function veto(bytes32 actionId_, bytes32 reasonHash) external nonReentrant {
        ExecutorStorage storage $ = _getExecutorStorage();
        if (msg.sender != $.vetoer) revert NotVetoer(msg.sender);

        ActionRecord storage record = $.actions[actionId_];
        if (record.storedStatus != STATUS_PENDING) revert ActionNotPending(actionId_);
        if (block.timestamp > record.expiresAt) revert ActionExpired(actionId_, record.expiresAt);

        record.storedStatus = STATUS_VETOED;
        emit ActionVetoed(actionId_, msg.sender, reasonHash);
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev Execution is allowed on both boundary timestamps: `executableAt <= now <= expiresAt`.
    ///      The caller supplies payload bytes to avoid storing an unbounded dynamic value; their
    ///      hash and canonical form are both revalidated before any interaction.
    function execute(bytes32 actionId_, bytes calldata payload) external nonReentrant {
        ExecutorStorage storage $ = _getExecutorStorage();
        ActionRecord storage record = $.actions[actionId_];
        if (record.storedStatus != STATUS_PENDING) revert ActionNotPending(actionId_);

        bytes32 suppliedHash = keccak256(payload);
        if (suppliedHash != record.payloadHash) {
            revert PayloadHashMismatch(record.payloadHash, suppliedHash);
        }
        if (block.timestamp < record.executableAt) {
            revert ActionNotReady(actionId_, record.executableAt);
        }
        if (block.timestamp > record.expiresAt) revert ActionExpired(actionId_, record.expiresAt);

        GovernanceCodec.GovernanceAction memory decoded = GovernanceCodec.decode(payload);
        if (decoded.destinationWormholeChain != $.localWormholeChain || decoded.destinationExecutor != address(this)) {
            revert WrongDestination(decoded.destinationWormholeChain, decoded.destinationExecutor);
        }

        // Preflight the complete batch before interaction. Solidity 0.8 checked arithmetic also
        // makes an overflowing sum fail closed.
        uint256 requiredBalance;
        for (uint256 i; i < decoded.calls.length; ++i) {
            requiredBalance += decoded.calls[i].value;
            if (_isUpgradeCall(decoded.calls[i])) {
                if (decoded.calls.length != 1 || decoded.calls[i].value != 0) {
                    revert InvalidUpgradeBatch();
                }
            }
        }
        if (requiredBalance > address(this).balance) {
            revert InsufficientBalance(requiredBalance, address(this).balance);
        }

        // Commit before interaction to block recursive execution. A downstream failure reverts the
        // entire transaction, restoring STATUS_PENDING and every earlier target's state for retry.
        record.storedStatus = STATUS_EXECUTED;
        for (uint256 i; i < decoded.calls.length; ++i) {
            (bool success, bytes memory returnData) = _call(decoded.calls[i]);
            if (!success) revert CallFailed(i, returnData);
        }

        emit ActionExecuted(actionId_, msg.sender);
    }

    /// @inheritdoc IGovernanceExecutor
    function action(bytes32 actionId_) external view returns (ActionRecord memory) {
        return _getExecutorStorage().actions[actionId_];
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev `Ready` and `Expired` are derived rather than stored, so no keeper transaction is needed
    ///      to advance time-based state. Expiry begins strictly after the inclusive deadline.
    function state(bytes32 actionId_) external view returns (ActionState) {
        ActionRecord storage record = _getExecutorStorage().actions[actionId_];
        if (record.storedStatus == 0) return ActionState.Unknown;
        if (record.storedStatus == STATUS_VETOED) return ActionState.Vetoed;
        if (record.storedStatus == STATUS_EXECUTED) return ActionState.Executed;
        if (block.timestamp > record.expiresAt) return ActionState.Expired;
        if (block.timestamp >= record.executableAt) return ActionState.Ready;
        return ActionState.Pending;
    }

    /// @inheritdoc IGovernanceExecutor
    function setVetoer(address newVetoer) external onlySelf {
        _validateVetoerAddress(newVetoer);
        ExecutorStorage storage $ = _getExecutorStorage();
        address previous = $.vetoer;
        $.vetoer = newVetoer;
        emit VetoerUpdated(previous, newVetoer);
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev Already queued actions remain executable because execution authenticates their stored
    ///      payload hash instead of consulting the current dispatcher.
    function setSourceDispatcher(bytes32 newSourceDispatcher) external onlySelf {
        if (newSourceDispatcher == bytes32(0)) revert InvalidSourceDispatcher();
        ExecutorStorage storage $ = _getExecutorStorage();
        bytes32 previous = $.sourceDispatcher;
        $.sourceDispatcher = newSourceDispatcher;
        emit SourceDispatcherUpdated(previous, newSourceDispatcher);
    }

    /// @inheritdoc IGovernanceExecutor
    /// @dev Only future actions use these defaults; queued actions retain their recorded deadlines.
    function setTiming(uint48 newVetoPeriod, uint48 newExecutionGracePeriod) external onlySelf {
        _validateTiming(newVetoPeriod, newExecutionGracePeriod);
        ExecutorStorage storage $ = _getExecutorStorage();
        $.vetoPeriod = newVetoPeriod;
        $.executionGracePeriod = newExecutionGracePeriod;
        emit TimingUpdated(newVetoPeriod, newExecutionGracePeriod);
    }

    /// @notice Returns the trusted destination Wormhole core contract.
    function wormhole() external view returns (address) {
        return address(_getExecutorStorage().wormhole);
    }

    /// @notice Returns the currently authorized Hydration dispatcher in Wormhole address form.
    function sourceDispatcher() external view returns (bytes32) {
        return _getExecutorStorage().sourceDispatcher;
    }

    /// @notice Returns this destination's veto-only Technical Committee Safe.
    function vetoer() external view returns (address) {
        return _getExecutorStorage().vetoer;
    }

    /// @notice Returns the destination Wormhole chain ID read during initialization.
    function localWormholeChain() external view returns (uint16) {
        return _getExecutorStorage().localWormholeChain;
    }

    /// @notice Returns the delay applied to subsequently queued actions.
    function vetoPeriod() external view returns (uint48) {
        return _getExecutorStorage().vetoPeriod;
    }

    /// @notice Returns the execution window applied to subsequently queued actions.
    function executionGracePeriod() external view returns (uint48) {
        return _getExecutorStorage().executionGracePeriod;
    }

    /// @notice Reports whether this executor has already accepted a Wormhole VM hash.
    function isVaaConsumed(bytes32 vaaHash) external view returns (bool) {
        return _getExecutorStorage().consumedVaas[vaaHash];
    }

    /// @dev UUPS calls this from proxy context. `onlySelf` makes an upgrade an ordinary delayed,
    ///      vetoable governance action rather than a deployer or multisig privilege.
    function _authorizeUpgrade(address) internal view override onlySelf {}

    /// @dev An upgrade must be the sole zero-value call. Otherwise later calls in the batch would
    ///      execute under implementation semantics different from those reviewed by the vetoer.
    function _isUpgradeCall(GovernanceCodec.Call memory call_) private view returns (bool) {
        if (call_.target != address(this) || call_.data.length < 4) return false;
        bytes4 selector;
        bytes memory data = call_.data;
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
        }
        return selector == UPGRADE_TO_AND_CALL_SELECTOR;
    }

    /// @dev Performs a normal EVM CALL—never DELEGATECALL—and copies at most 4 KiB of untrusted
    ///      return or revert data. High-level `.call` would copy the target's entire return buffer
    ///      and allow a malicious target to force excessive memory expansion.
    function _call(GovernanceCodec.Call memory call_) private returns (bool success, bytes memory returnData) {
        address target = call_.target;
        uint256 value = call_.value;
        bytes memory data = call_.data;
        uint256 maxReturnData = MAX_RETURN_DATA;
        assembly ("memory-safe") {
            success := call(gas(), target, value, add(data, 0x20), mload(data), 0, 0)
            let size := returndatasize()
            if gt(size, maxReturnData) { size := maxReturnData }
            returnData := mload(0x40)
            mstore(returnData, size)
            returndatacopy(add(returnData, 0x20), 0, size)
            mstore(0x40, and(add(add(returnData, 0x20), add(size, 0x1f)), not(0x1f)))
        }
    }

    /// @dev Requiring code prevents configuration to an EOA typo. Safe proxies satisfy this check.
    function _validateVetoerAddress(address vetoer_) private view {
        if (vetoer_ == address(0)) revert ZeroAddress();
        if (vetoer_.code.length == 0) revert AddressHasNoCode(vetoer_);
    }

    /// @dev Timing floors cannot be weakened through ordinary configuration. Changing the floors
    ///      requires a separately reviewed and vetoable implementation upgrade.
    function _validateTiming(uint48 vetoPeriod_, uint48 executionGracePeriod_) private pure {
        if (vetoPeriod_ < MIN_VETO_PERIOD) {
            revert VetoPeriodTooShort(vetoPeriod_, MIN_VETO_PERIOD);
        }
        if (executionGracePeriod_ < MIN_EXECUTION_GRACE_PERIOD) {
            revert GracePeriodTooShort(executionGracePeriod_, MIN_EXECUTION_GRACE_PERIOD);
        }
    }

    /// @dev Binds the storage struct to its fixed ERC-7201 namespace.
    function _getExecutorStorage() private pure returns (ExecutorStorage storage $) {
        assembly ("memory-safe") {
            $.slot := EXECUTOR_STORAGE_LOCATION
        }
    }
}
