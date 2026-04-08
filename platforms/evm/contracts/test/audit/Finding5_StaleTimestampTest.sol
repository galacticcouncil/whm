// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {MessageDispatcher} from "../../src/MessageDispatcher.sol";
import {XcmTransactor} from "../../src/XcmTransactor.sol";

/// @dev Mock transactor that just records calls
contract MockTransactor {
    address public lastTarget;
    bytes public lastInput;
    uint256 public callCount;

    function transact(address target, bytes calldata input) external {
        lastTarget = target;
        lastInput = input;
        callCount++;
    }
}

/// @dev MockWormhole that allows setting vm.timestamp independently from block.timestamp.
///      This simulates the real-world scenario where guardian observation time differs
///      from the actual price data timestamp embedded in the payload.
contract MockWormholeWithCustomTimestamp {
    uint32 public overrideTimestamp;
    bool public useOverride;

    function setTimestampOverride(uint32 ts) external {
        overrideTimestamp = ts;
        useOverride = true;
    }

    function clearTimestampOverride() external {
        useOverride = false;
    }

    function chainId() external pure returns (uint16) { return 16; }
    function messageFee() external pure returns (uint256) { return 0; }

    function parseAndVerifyVM(bytes calldata encodedVM)
        external
        view
        returns (IWormhole.VM memory _vm, bool valid, string memory reason)
    {
        (uint16 emitterChainId, bytes32 emitterAddress, bytes memory payload) =
            abi.decode(encodedVM, (uint16, bytes32, bytes));

        _vm.emitterChainId = emitterChainId;
        _vm.emitterAddress = emitterAddress;
        _vm.payload = payload;
        _vm.hash = keccak256(encodedVM);
        // KEY: vm.timestamp can be set independently from block.timestamp
        _vm.timestamp = useOverride ? overrideTimestamp : uint32(block.timestamp);

        valid = true;
        reason = "";
    }
}

/// @dev MessageDispatcher variant that uses the fixed handler
contract MessageDispatcherFixed is MessageDispatcher {
    function _processMessage(IWormhole.VM memory vm) internal virtual override {
        uint8 action = uint8(vm.payload[31]);

        if (action == ACTION_PRICE_UPDATE || action == ACTION_RATE_UPDATE) {
            // Call the FIXED handler instead of the vulnerable one
            fix_handleOracleUpdate(action, vm);
        } else {
            super._processMessage(vm);
        }
    }
}

/// @title Finding5_StaleTimestampTest
/// @notice Demonstrates that using vm.timestamp instead of the payload timestamp
///         allows stale prices to pass freshness checks and causes valid same-second
///         price updates to be rejected.
contract Finding5_StaleTimestampTest is Test {

    MockWormholeWithCustomTimestamp public mockWormhole;
    MockTransactor public transactor;

    MessageDispatcher public dispatcher;         // vulnerable
    MessageDispatcherFixed public dispatcherFixed; // fixed

    uint16 constant SOURCE_CHAIN = 14;
    bytes32 constant EMITTER = bytes32(uint256(0xabc123));
    bytes32 public assetId = keccak256("JITOSOL");
    address public oracle = address(0xBEEF);

    function setUp() public {
        // Warp to a reasonable timestamp so subtraction doesn't underflow
        vm.warp(100_000);

        mockWormhole = new MockWormholeWithCustomTimestamp();
        transactor = new MockTransactor();

        // Deploy vulnerable dispatcher
        MessageDispatcher implV = new MessageDispatcher();
        dispatcher = MessageDispatcher(address(new ERC1967Proxy(
            address(implV), abi.encodeCall(MessageDispatcher.initialize, (address(mockWormhole)))
        )));
        _configureDispatcher(dispatcher);

        // Deploy fixed dispatcher
        MessageDispatcherFixed implF = new MessageDispatcherFixed();
        dispatcherFixed = MessageDispatcherFixed(address(new ERC1967Proxy(
            address(implF), abi.encodeCall(MessageDispatcher.initialize, (address(mockWormhole)))
        )));
        _configureDispatcher(MessageDispatcher(address(dispatcherFixed)));
    }

    function _configureDispatcher(MessageDispatcher d) internal {
        d.setAuthorizedEmitter(SOURCE_CHAIN, EMITTER);
        d.setHandler(1, address(transactor));
        d.setOracle(assetId, oracle);
    }

    function _buildVaa(bytes memory payload) internal pure returns (bytes memory) {
        return abi.encode(SOURCE_CHAIN, EMITTER, payload);
    }

    function _buildVaaWithSalt(bytes memory payload, bytes32 salt) internal pure returns (bytes memory) {
        return abi.encode(SOURCE_CHAIN, EMITTER, payload, salt);
    }

    // ═══════════════════════════════════════════════════════════════
    // EXPLOIT 1: Stale price passes freshness check
    // ═══════════════════════════════════════════════════════════════

    /// @notice A price that was generated 4 minutes ago on Solana passes the
    ///         5-minute freshness check because the guardian signed it just now.
    ///         The payload timestamp (actual price time) is discarded.
    function test_exploit_stalePricePassesFreshnessCheck() public {
        // Time setup
        uint64 now_ = uint64(block.timestamp);
        uint64 priceTime = now_ - 240; // price observed 4 minutes ago on Solana

        // Payload: action=1, assetId, price, timestamp=4 minutes ago
        uint256 price = 50_000_000_000_000_000_000; // 50e18
        bytes memory payload = abi.encode(uint8(1), assetId, price, priceTime);

        // Guardian signs NOW → vm.timestamp = block.timestamp (fresh)
        // No override needed — default mock behavior sets vm.timestamp = block.timestamp
        mockWormhole.clearTimestampOverride();

        // Submit to vulnerable dispatcher
        dispatcher.receiveMessage(_buildVaa(payload));

        // ─── Verify: price accepted despite being 4 min old ──────
        (uint256 storedPrice, uint64 storedTimestamp,) = dispatcher.latestPrices(assetId);
        assertEq(storedPrice, price, "Stale price was accepted");

        // The stored timestamp is vm.timestamp (NOW), not the actual price time
        assertEq(storedTimestamp, now_, "Stored timestamp is guardian time, not price time");
        assertTrue(storedTimestamp != priceTime, "Stored timestamp should differ from actual price time");

        console.log("EXPLOIT CONFIRMED: Price from", priceTime, "accepted as if it was from", storedTimestamp);
        console.log("  Actual staleness:", now_ - priceTime, "seconds");
        console.log("  Perceived staleness: 0 seconds (vm.timestamp = block.timestamp)");
    }

    // ═══════════════════════════════════════════════════════════════
    // EXPLOIT 2: Same-second VAAs rejected as stale
    // ═══════════════════════════════════════════════════════════════

    /// @notice Two valid price updates in the same block are rejected because
    ///         vm.timestamp is identical for both, triggering the <= check.
    function test_exploit_sameSecondRejection() public {
        uint64 now_ = uint64(block.timestamp);

        // Price update #1: price = 50e18, payload timestamp = now
        bytes memory payload1 = abi.encode(uint8(1), assetId, uint256(50e18), now_);
        dispatcher.receiveMessage(_buildVaa(payload1));

        // Price update #2: DIFFERENT price (51e18), LATER payload timestamp (now+1)
        // But vm.timestamp is still block.timestamp (same block!)
        bytes memory payload2 = abi.encode(uint8(1), assetId, uint256(51e18), now_ + 1);

        // ─── Rejected! vm.timestamp(now) <= latestTimestamp(now) ──
        vm.expectRevert(
            abi.encodeWithSelector(
                MessageDispatcher.StalePriceUpdate.selector,
                assetId,
                now_,    // incoming vaaTimestamp
                now_     // latest stored timestamp
            )
        );
        dispatcher.receiveMessage(_buildVaaWithSalt(payload2, bytes32("salt2")));

        console.log("EXPLOIT CONFIRMED: Valid price correction rejected as stale");
        console.log("  Price #2 has a newer payload timestamp but same vm.timestamp");
    }

    // ═══════════════════════════════════════════════════════════════
    // FIX: Uses payload timestamp correctly
    // ═══════════════════════════════════════════════════════════════

    /// @notice The fix uses the payload-embedded timestamp, correctly rejecting
    ///         prices whose actual observation time is too old.
    function test_fix_rejectsActuallyStalePrice() public {
        uint64 now_ = uint64(block.timestamp);
        uint64 staleTime = now_ - 600; // 10 minutes ago (exceeds 5-min maxPriceAge)

        bytes memory payload = abi.encode(uint8(1), assetId, uint256(50e18), staleTime);

        // Guardian signs now (vm.timestamp = now), but the price data is 10 min old
        // Vulnerable version would accept this. Fixed version rejects.
        vm.expectRevert("Price too stale");
        dispatcherFixed.receiveMessage(_buildVaa(payload));

        console.log("FIX VERIFIED: Actually stale price (10 min old) correctly rejected");
    }

    /// @notice The fix accepts two valid prices in the same block when their
    ///         payload timestamps differ.
    function test_fix_sameSecondAccepted() public {
        uint64 now_ = uint64(block.timestamp);

        // Price update #1: payload timestamp = now - 2
        bytes memory payload1 = abi.encode(uint8(1), assetId, uint256(50e18), now_ - 2);
        dispatcherFixed.receiveMessage(_buildVaa(payload1));

        (,uint64 storedTs1,) = dispatcherFixed.latestPrices(assetId);
        assertEq(storedTs1, now_ - 2, "First price stored with payload timestamp");

        // Price update #2: payload timestamp = now - 1 (newer, still same block)
        // Same block.timestamp, same vm.timestamp — but payload timestamps differ
        bytes memory payload2 = abi.encode(uint8(1), assetId, uint256(51e18), now_ - 1);
        dispatcherFixed.receiveMessage(_buildVaaWithSalt(payload2, bytes32("salt2")));

        (uint256 storedPrice2, uint64 storedTs2,) = dispatcherFixed.latestPrices(assetId);
        assertEq(storedPrice2, 51e18, "Second price accepted");
        assertEq(storedTs2, now_ - 1, "Stored with the newer payload timestamp");

        console.log("FIX VERIFIED: Two valid prices in same block both accepted");
    }

    /// @notice The fix still rejects out-of-order prices (older payload timestamp).
    function test_fix_rejectsOutOfOrderByPayloadTimestamp() public {
        uint64 now_ = uint64(block.timestamp);

        // Submit a price with payload timestamp = now
        bytes memory newer = abi.encode(uint8(1), assetId, uint256(50e18), now_);
        dispatcherFixed.receiveMessage(_buildVaa(newer));

        // Try to submit an older price (payload timestamp = now - 10)
        bytes memory older = abi.encode(uint8(1), assetId, uint256(48e18), now_ - 10);
        vm.expectRevert(
            abi.encodeWithSelector(
                MessageDispatcher.StalePriceUpdate.selector,
                assetId,
                now_ - 10,  // incoming payload timestamp
                now_        // latest stored timestamp
            )
        );
        dispatcherFixed.receiveMessage(_buildVaaWithSalt(older, bytes32("older")));
    }

    /// @notice The fix stores the payload timestamp, not vm.timestamp,
    ///         so latestPrices reflects when the price was actually observed.
    function test_fix_storesPayloadTimestamp() public {
        uint64 now_ = uint64(block.timestamp);
        uint64 priceTime = now_ - 60; // 1 minute ago

        bytes memory payload = abi.encode(uint8(1), assetId, uint256(50e18), priceTime);
        dispatcherFixed.receiveMessage(_buildVaa(payload));

        (, uint64 storedTs, uint64 receivedAt) = dispatcherFixed.latestPrices(assetId);
        assertEq(storedTs, priceTime, "Timestamp reflects actual price observation time");
        assertEq(receivedAt, uint64(block.timestamp), "receivedAt reflects delivery time");

        console.log("FIX VERIFIED: storedTimestamp =", storedTs);
        console.log("  receivedAt =", receivedAt);
    }
}
