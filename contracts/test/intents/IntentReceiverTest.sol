// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {INttManager} from "../../src/ntt/interfaces/INttManager.sol";
import {NttPayload} from "../../src/ntt/NttPayload.sol";

import {IntentReceiver} from "../../src/intents/IntentReceiver.sol";
import {IIntentReceiver} from "../../src/intents/interfaces/IIntentReceiver.sol";

/// @dev Parses a VAA as `abi.encode(emitterChainId, emitterAddress, timestamp, nonce, payload)` and
///      treats it as valid unless marked otherwise. `nonce` only keeps otherwise-identical VAAs on
///      distinct hashes, the way two real messages would be.
contract MockWormhole {
    mapping(bytes32 => bool) public invalid;

    function markInvalid(bytes memory vaa) external {
        invalid[keccak256(vaa)] = true;
    }

    function parseVM(bytes memory encodedVM) public pure returns (IWormhole.VM memory vm) {
        (uint16 chainId, bytes32 emitter, uint32 timestamp,, bytes memory payload) =
            abi.decode(encodedVM, (uint16, bytes32, uint32, uint64, bytes));

        vm.emitterChainId = chainId;
        vm.emitterAddress = emitter;
        vm.timestamp = timestamp;
        vm.payload = payload;
        vm.hash = keccak256(encodedVM);
    }

    function parseAndVerifyVM(bytes memory encodedVM)
        external
        view
        returns (IWormhole.VM memory vm, bool valid, string memory reason)
    {
        vm = parseVM(encodedVM);
        valid = !invalid[keccak256(encodedVM)];
        reason = valid ? "" : "invalid";
    }
}

/// @dev Stands in for NTT's manager: a message is marked executed before the rate limiter runs, so
///      "executed" alone never means the funds moved — a queued entry says they did not.
contract MockNttManager {
    mapping(bytes32 => bool) public isMessageExecuted;
    mapping(bytes32 => INttManager.InboundQueuedTransfer) internal _queued;

    function markExecuted(bytes32 digest) external {
        isMessageExecuted[digest] = true;
    }

    function enqueue(bytes32 digest, uint64 txTimestamp) external {
        _queued[digest].txTimestamp = txTimestamp;
    }

    function getInboundQueuedTransfer(bytes32 digest)
        external
        view
        returns (INttManager.InboundQueuedTransfer memory)
    {
        return _queued[digest];
    }
}

/// @dev Stands in for NTT's transceiver: delivering a settlement credits the receiver with the ETH
///      the manager would have released. Permissionless, exactly like the real one.
contract MockTransceiver {
    using NttPayload for bytes;

    mapping(bytes32 => bool) public isVAAConsumed;

    address public receiver;
    uint256 public release;
    MockNttManager public manager = new MockNttManager();

    /// @dev Consume the VAA without the manager executing it — what a sub-threshold attestation
    ///      looks like when more than one transceiver is enabled.
    bool public skipExecute;

    function configure(address _receiver, uint256 _release) external {
        receiver = _receiver;
        release = _release;
    }

    function setSkipExecute(bool value) external {
        skipExecute = value;
    }

    function nttManager() external view returns (address) {
        return address(manager);
    }

    /// @dev Hold a delivered settlement in the inbound rate-limit queue.
    function enqueue(bytes memory encodedMessage) external {
        manager.enqueue(_digest(encodedMessage), uint64(block.timestamp));
    }

    receive() external payable {}

    function receiveMessage(bytes memory encodedMessage) external {
        bytes32 hash = keccak256(encodedMessage);
        require(!isVAAConsumed[hash], "consumed");
        isVAAConsumed[hash] = true;

        if (!skipExecute) manager.markExecuted(_digest(encodedMessage));

        (bool ok,) = receiver.call{value: release}("");
        require(ok, "release failed");
    }

    function _digest(bytes memory encodedMessage) internal pure returns (bytes32) {
        (uint16 chainId,,,, bytes memory payload) =
            abi.decode(encodedMessage, (uint16, bytes32, uint32, uint64, bytes));
        (, bytes memory message,,) = payload.settlementOf();
        return keccak256(abi.encodePacked(chainId, message));
    }
}

/// @dev Rejects native ETH, to exercise the failed-forward path.
contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}

/// @title IntentReceiverTest
/// @notice Pins what carries the last hop:
///
///           1. the two VAAs must name the same sequence, so a caller cannot pay for any pending
///              settlement and claim the fee of whichever instruction pays best;
///           2. the destination and the amount come from signed messages, never from the caller;
///           3. an instruction acts once, and a third party having delivered first is ordinary
///              rather than a denial of service.
///
/// @dev Settlements are built with NTT's own encoders, so the fixtures and the contract's parser
///      cannot drift apart.
contract IntentReceiverTest is Test {
    uint16 constant HYDRATION_CHAIN = 73;
    uint16 constant ETHEREUM_CHAIN = 2;
    uint256 constant AMOUNT = 1 ether;
    /// @dev Mirror the contract's own — NTT trims WETH to 8dp, the rail delivers 18dp native ETH.
    uint8 constant NTT_DECIMALS = 8;
    uint256 constant TRIM_UNIT = 1e10;
    uint256 constant MAX_RELAY_FEE = 0.01 ether;
    uint64 constant SEQUENCE = 7;

    IntentReceiver public receiver;
    MockWormhole public wormhole;
    MockTransceiver public transceiver;

    bytes32 public emitterAddress = bytes32(uint256(uint160(makeAddr("emitter"))));
    address public depositAddress = makeAddr("depositAddress");
    address public relayer = makeAddr("relayer");

    function setUp() public {
        wormhole = new MockWormhole();
        transceiver = new MockTransceiver();

        receiver = IntentReceiver(
            payable(
                address(
                    new ERC1967Proxy(
                        address(new IntentReceiver()),
                        abi.encodeCall(
                            IntentReceiver.initialize, (address(wormhole), address(transceiver))
                        )
                    )
                )
            )
        );
        receiver.setEmitter(emitterAddress);

        transceiver.configure(address(receiver), AMOUNT);
        vm.deal(address(transceiver), 100 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function _vaa(uint16 chainId, bytes32 emitter, uint64 nonce, bytes memory payload)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(chainId, emitter, uint32(block.timestamp), nonce, payload);
    }

    /// @dev No amount: the receiver reads that off the settlement.
    function _instruction(uint64 sequence, uint256 maxRelayFee)
        internal
        view
        returns (bytes memory)
    {
        return _vaa(
            HYDRATION_CHAIN, emitterAddress, sequence, abi.encode(sequence, depositAddress, maxRelayFee)
        );
    }

    /// @dev A settlement in the transceiver's wire format:
    ///      prefix ‖ sourceManager ‖ recipientManager ‖ len ‖ (id ‖ sender ‖ len ‖ transfer) ‖ len,
    ///      where transfer is NTT_PREFIX ‖ decimals ‖ amount ‖ sourceToken ‖ to ‖ toChain. The
    ///      amount rides trimmed, so a wei value goes on the wire as `amount / TRIM_UNIT`.
    function _settlementWith(bytes4 prefix, uint64 sequence, uint8 decimals, uint256 amount)
        internal
        view
        returns (bytes memory)
    {
        bytes memory transfer = abi.encodePacked(
            NttPayload.NTT_PREFIX,
            decimals,
            uint64(amount / TRIM_UNIT),
            bytes32(uint256(4)), // sourceToken
            bytes32(uint256(uint160(address(receiver)))), // to
            uint16(2) // toChain
        );
        bytes memory managerMessage = abi.encodePacked(
            bytes32(uint256(sequence)), // id
            bytes32(uint256(3)), // sender
            uint16(transfer.length),
            transfer
        );
        bytes memory payload = abi.encodePacked(
            prefix,
            bytes32(uint256(1)), // sourceNttManagerAddress
            bytes32(uint256(2)), // recipientNttManagerAddress
            uint16(managerMessage.length),
            managerMessage,
            uint16(0) // transceiverPayload length
        );
        return _vaa(HYDRATION_CHAIN, bytes32(uint256(9)), sequence, payload);
    }

    function _settlement(uint64 sequence) internal view returns (bytes memory) {
        return _settlementOf(sequence, AMOUNT);
    }

    function _settlementOf(uint64 sequence, uint256 amount) internal view returns (bytes memory) {
        return _settlementWith(NttPayload.WH_TRANSCEIVER_PAYLOAD_PREFIX, sequence, NTT_DECIMALS, amount);
    }

    function _redeem(uint64 sequence, uint256 feeRequested) internal {
        receiver.processOrder(
            _settlement(sequence), _instruction(sequence, MAX_RELAY_FEE), feeRequested
        );
    }

    // ─── Redeem ─────────────────────────────────────────────────────

    function testDeliversAndForwards() public {
        vm.prank(relayer);
        _redeem(SEQUENCE, 0);

        assertEq(depositAddress.balance, AMOUNT, "whole amount must be forwarded");
        assertEq(address(receiver).balance, 0, "nothing should be left over");
    }

    function testRelayFeeIsPaidToTheCaller() public {
        vm.prank(relayer);
        _redeem(SEQUENCE, MAX_RELAY_FEE);

        assertEq(relayer.balance, MAX_RELAY_FEE, "caller must be reimbursed");
        assertEq(depositAddress.balance, AMOUNT - MAX_RELAY_FEE, "rest must be forwarded");
    }

    /// @notice The ceiling is committed at source, so a caller cannot price its own claim.
    function testFeeAboveTheCeilingReverts() public {
        vm.prank(relayer);
        vm.expectRevert(IIntentReceiver.FeeExceedsCeiling.selector);
        _redeem(SEQUENCE, MAX_RELAY_FEE + 1);
    }

    /// @notice The check the whole two-VAA design rests on: pay for one settlement, claim another's
    ///         instruction, and the fee follows the richest ceiling rather than the work done.
    function testMismatchedSequenceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IIntentReceiver.SequenceMismatch.selector, SEQUENCE + 1, SEQUENCE)
        );
        receiver.processOrder(
            _settlement(SEQUENCE), _instruction(SEQUENCE + 1, MAX_RELAY_FEE), MAX_RELAY_FEE
        );
    }

    /// @notice NTT's delivery is permissionless, so someone else getting there first is ordinary.
    /// @notice A settlement NTT delivered but held in the inbound rate-limit queue has released
    ///         nothing, so its instruction must not be paid out of another order's ETH.
    function testQueuedSettlementIsNotPaidFromAnotherOrder() public {
        // Another order's settlement is already sitting here.
        vm.deal(address(receiver), AMOUNT);

        // A generic relayer delivered ours, but the limiter queued it — nothing was released.
        bytes memory settlement = _settlement(SEQUENCE);
        transceiver.configure(address(receiver), 0);
        transceiver.receiveMessage(settlement);
        transceiver.enqueue(settlement);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentReceiver.SettlementNotReleased.selector, SEQUENCE)
        );
        receiver.processOrder(
            settlement, _instruction(SEQUENCE, MAX_RELAY_FEE), MAX_RELAY_FEE
        );

        assertEq(address(receiver).balance, AMOUNT, "the other order's ETH must be untouched");
    }

    /// @notice A VAA the transceiver consumed but the manager never executed — a sub-threshold
    ///         attestation — is not a delivery either.
    function testUnexecutedSettlementIsNotPaid() public {
        vm.deal(address(receiver), AMOUNT);

        bytes memory settlement = _settlement(SEQUENCE);
        transceiver.configure(address(receiver), 0);
        transceiver.setSkipExecute(true);
        transceiver.receiveMessage(settlement);

        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(IIntentReceiver.SettlementNotReleased.selector, SEQUENCE)
        );
        receiver.processOrder(
            settlement, _instruction(SEQUENCE, MAX_RELAY_FEE), MAX_RELAY_FEE
        );

        assertEq(address(receiver).balance, AMOUNT, "the other order's ETH must be untouched");
    }

    function testStillForwardsWhenAlreadyDelivered() public {
        transceiver.receiveMessage(_settlement(SEQUENCE));

        vm.prank(relayer);
        _redeem(SEQUENCE, MAX_RELAY_FEE);

        assertEq(depositAddress.balance, AMOUNT - MAX_RELAY_FEE, "must still forward");
        assertEq(relayer.balance, MAX_RELAY_FEE, "caller did the op, caller is paid");
    }

    /// @notice The amount is the settlement's own, not the balance — a receiver holding an unrelated
    ///         settlement or stray ETH must not have it swept into this forward.
    function testAmountComesFromTheSettlement() public {
        uint256 odd = 3.14159265 ether;
        transceiver.configure(address(receiver), odd);
        vm.deal(address(receiver), 5 ether);

        receiver.processOrder(_settlementOf(SEQUENCE, odd), _instruction(SEQUENCE, MAX_RELAY_FEE), 0);

        assertEq(depositAddress.balance, odd, "forwarded amount must be what the settlement carried");
        assertEq(address(receiver).balance, 5 ether, "the rest must be untouched");
    }

    /// @notice A settlement trimmed to a precision the rail does not use is rejected rather than
    ///         scaled by a guess.
    function testUnexpectedTrimReverts() public {
        bytes memory settlement =
            _settlementWith(NttPayload.WH_TRANSCEIVER_PAYLOAD_PREFIX, SEQUENCE, 6, AMOUNT);

        vm.expectRevert(abi.encodeWithSelector(IIntentReceiver.UnexpectedTrim.selector, uint8(6)));
        receiver.processOrder(settlement, _instruction(SEQUENCE, MAX_RELAY_FEE), 0);
    }

    function testInstructionCannotBeActedOnTwice() public {
        _redeem(SEQUENCE, 0);

        vm.expectRevert(IIntentReceiver.AlreadyRedeemed.selector);
        _redeem(SEQUENCE, 0);
    }

    /// @notice A delivery that credits less than the settlement carried must not half-pay. The
    ///         forward is what fails, so that is what surfaces.
    function testUnderfundedForwardReverts() public {
        transceiver.configure(address(receiver), AMOUNT / 2);

        vm.expectRevert(IIntentReceiver.NativeTransferFailed.selector);
        _redeem(SEQUENCE, 0);
    }

    /// @notice Both halves of the pin are mandatory — a chain check alone honours any contract on
    ///         Hydration, an address check alone the same address on any chain.
    function testForeignEmitterRejected() public {
        bytes32 attacker = bytes32(uint256(uint160(makeAddr("attacker"))));
        bytes memory payload = abi.encode(SEQUENCE, depositAddress, MAX_RELAY_FEE);

        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentReceiver.UnauthorizedEmitter.selector, HYDRATION_CHAIN, attacker
            )
        );
        receiver.processOrder(_settlement(SEQUENCE), _vaa(HYDRATION_CHAIN, attacker, SEQUENCE, payload), 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                IIntentReceiver.UnauthorizedEmitter.selector, ETHEREUM_CHAIN, emitterAddress
            )
        );
        receiver.processOrder(_settlement(SEQUENCE), _vaa(ETHEREUM_CHAIN, emitterAddress, SEQUENCE, payload), 0);
    }

    function testUnverifiedInstructionRejected() public {
        bytes memory instruction = _instruction(SEQUENCE, MAX_RELAY_FEE);
        wormhole.markInvalid(instruction);

        vm.expectRevert(IIntentReceiver.InvalidInstruction.selector);
        receiver.processOrder(_settlement(SEQUENCE), instruction, 0);
    }

    function testZeroDepositAddressReverts() public {
        bytes memory zeroDeposit = _vaa(
            HYDRATION_CHAIN,
            emitterAddress,
            SEQUENCE,
            abi.encode(SEQUENCE, address(0), MAX_RELAY_FEE)
        );

        vm.expectRevert(IIntentReceiver.MalformedInstruction.selector);
        receiver.processOrder(_settlement(SEQUENCE), zeroDeposit, 0);
    }

    /// @notice A failed forward unwinds the whole call, so both legs stay retryable.
    function testForwardFailureUnwindsTheRedeem() public {
        depositAddress = address(new RejectsEth());

        vm.expectRevert(IIntentReceiver.NativeTransferFailed.selector);
        _redeem(SEQUENCE, 0);

        assertFalse(
            receiver.processed(keccak256(_instruction(SEQUENCE, MAX_RELAY_FEE))),
            "instruction must stay executable"
        );
        assertFalse(
            transceiver.isVAAConsumed(keccak256(_settlement(SEQUENCE))),
            "settlement must stay deliverable"
        );
    }

    function testUnconfiguredEmitterReverts() public {
        vm.prank(receiver.owner());
        receiver.setEmitter(bytes32(0));

        vm.expectRevert(IIntentReceiver.NotConfigured.selector);
        _redeem(SEQUENCE, 0);
    }

    // ─── Reorg ──────────────────────────────────────────────────────

    /// @dev Hydration's block interval. The replacement message differs from the orphan only in its
    ///      timestamp: `emitterNonce` and the core bridge's sequence are both contract storage, so a
    ///      reorg rewinds them identically and they come back the same.
    uint256 constant BLOCK_INTERVAL = 12;

    /// @notice The instruction publishes at consistency 200, so guardians sign it with zero
    ///         confirmations and never retract it. Drop that block and the signed instruction
    ///         outlives the state it named — the NTT manager's counter rewinds, the next transfer
    ///         through it takes the same sequence, and two instructions now match one settlement.
    ///
    ///         Nothing is forged and nothing is paid out of thin air: every check passes on a true
    ///         statement. What no check asserts is that each released settlement backs at most one
    ///         forward, because funding is proven by the contract's whole balance.
    ///
    /// @dev Passes against the receiver as written, and is meant to — the receiver cannot tell an
    ///      orphan from a retry, both being guardian-signed messages from the pinned emitter naming
    ///      one sequence. Publishing the instruction finalized is what stops the orphan existing, so
    ///      the enforcing assertion belongs in `IntentEmitterTest`, not here.
    function testOrphanedInstructionIsPaidTwiceFromOneSettlement() public {
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");

        // Pre-reorg: the attacker's own order, its instruction signed before the block is dropped.
        // The reorg refunds them on Hydration, so holding the orphan costs nothing.
        depositAddress = attacker;
        bytes memory orphan = _instruction(SEQUENCE, MAX_RELAY_FEE);

        // One interval on, the counter has rewound and somebody else's transfer takes SEQUENCE —
        // this one reaching finality, so its settlement is signed too.
        vm.warp(block.timestamp + BLOCK_INTERVAL);
        depositAddress = victim;
        bytes memory settlement = _settlement(SEQUENCE);
        bytes memory replacement = _instruction(SEQUENCE, MAX_RELAY_FEE);

        // These two differ in terms as well as in time. In the narrower case — one order retried on
        // its own terms — the timestamp is the only field left, and it is still enough: `processed`
        // is keyed by VAA hash and the emitting block's time sits inside the body.
        assertTrue(keccak256(orphan) != keccak256(replacement), "the orphan must be its own VAA");

        // A concurrent order's settlement, delivered and waiting on its own instruction.
        vm.deal(address(receiver), AMOUNT);

        vm.prank(relayer);
        receiver.processOrder(settlement, replacement, 0);

        // Not a race. `isMessageExecuted` stays true and the queue slot stays empty, so the orphan
        // keeps until the pool next covers its amount.
        vm.warp(block.timestamp + 1 days);
        vm.prank(attacker);
        receiver.processOrder(settlement, orphan, 0);

        assertEq(victim.balance, AMOUNT, "the real order is paid");
        assertEq(attacker.balance, AMOUNT, "so is the dropped one, out of the pool");
        assertEq(address(receiver).balance, 0, "the concurrent order's ETH is what paid it");
    }

    // ─── Exclusive window ───────────────────────────────────────────

    /// @dev Mirrors EXCLUSIVE_WINDOW, which is internal. Both VAAs carry the current block time, so
    ///      building them before warping is what lets an order age.
    uint256 constant WINDOW = 5 minutes;

    function testPermissionlessWhileNoRelayerIsAuthorized() public {
        vm.prank(makeAddr("stranger"));
        _redeem(SEQUENCE, 0);

        assertEq(depositAddress.balance, AMOUNT, "an empty allowlist must gate nothing");
    }

    function testOutsiderIsHeldOffInsideTheWindow() public {
        receiver.setAuthorizedRelayer(relayer, true);

        vm.prank(makeAddr("frontrunner"));
        vm.expectRevert(IIntentReceiver.Unauthorized.selector);
        _redeem(SEQUENCE, MAX_RELAY_FEE);
    }

    function testAuthorizedRelayerProcessesInsideTheWindow() public {
        receiver.setAuthorizedRelayer(relayer, true);

        vm.prank(relayer);
        _redeem(SEQUENCE, MAX_RELAY_FEE);

        assertEq(relayer.balance, MAX_RELAY_FEE, "the authorized caller keeps its fee");
    }

    function testWindowExpiresIntoAPublicFallback() public {
        receiver.setAuthorizedRelayer(relayer, true);
        bytes memory settlement = _settlement(SEQUENCE);
        bytes memory instruction = _instruction(SEQUENCE, MAX_RELAY_FEE);

        address stranger = makeAddr("stranger");

        // One second short: still exclusive.
        vm.warp(block.timestamp + WINDOW - 1);
        vm.prank(stranger);
        vm.expectRevert(IIntentReceiver.Unauthorized.selector);
        receiver.processOrder(settlement, instruction, MAX_RELAY_FEE);

        // On the boundary it opens, so a stalled relayer costs latency and never delivery.
        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        receiver.processOrder(settlement, instruction, MAX_RELAY_FEE);

        assertEq(stranger.balance, MAX_RELAY_FEE, "after the window anyone may be paid");
    }

    /// @dev The instruction publishes at consistency 200 and the settlement at 202, so the
    ///      instruction can be signed blocks earlier. Timing from it would hand outsiders a window
    ///      that had already expired before the settlement a relayer waits on existed.
    function testWindowIsTimedFromTheSettlementNotTheInstruction() public {
        receiver.setAuthorizedRelayer(relayer, true);

        // Instruction published first, then left to age past the window.
        bytes memory instruction = _instruction(SEQUENCE, MAX_RELAY_FEE);
        vm.warp(block.timestamp + WINDOW + 1);

        // Settlement published only now, so the order is still fresh.
        bytes memory settlement = _settlement(SEQUENCE);

        vm.prank(makeAddr("frontrunner"));
        vm.expectRevert(IIntentReceiver.Unauthorized.selector);
        receiver.processOrder(settlement, instruction, MAX_RELAY_FEE);
    }

    function testRevokingTheLastRelayerRestoresPermissionless() public {
        receiver.setAuthorizedRelayer(relayer, true);
        receiver.setAuthorizedRelayer(relayer, false);
        assertEq(receiver.authorizedRelayerCount(), 0, "count must return to zero");

        vm.prank(makeAddr("stranger"));
        _redeem(SEQUENCE, 0);

        assertEq(depositAddress.balance, AMOUNT, "revoking the last relayer reopens processing");
    }

    function testAuthorizingIsIdempotent() public {
        receiver.setAuthorizedRelayer(relayer, true);
        receiver.setAuthorizedRelayer(relayer, true);

        assertEq(receiver.authorizedRelayerCount(), 1, "a repeated grant must not double-count");
    }

    // ─── Admin ──────────────────────────────────────────────────────

    function testSweepRecoversStrayEth() public {
        vm.deal(address(receiver), 1 ether);
        address to = makeAddr("to");

        receiver.sweep(to, 1 ether);
        assertEq(to.balance, 1 ether, "sweep must move native");
    }

    function testOnlyOwnerAdmin() public {
        address attacker = makeAddr("attacker");

        vm.startPrank(attacker);
        vm.expectRevert(IIntentReceiver.NotOwner.selector);
        receiver.setEmitter(bytes32(uint256(1)));

        vm.expectRevert(IIntentReceiver.NotOwner.selector);
        receiver.sweep(attacker, 0);

        vm.expectRevert(IIntentReceiver.NotOwner.selector);
        receiver.setAuthorizedRelayer(attacker, true);
        vm.stopPrank();
    }
}
