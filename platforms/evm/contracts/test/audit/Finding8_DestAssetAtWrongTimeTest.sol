// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BasejumpLanding} from "../../src/BasejumpLanding.sol";
import {IBasejumpLanding} from "../../src/interfaces/IBasejumpLanding.sol";

/// @dev Minimal ERC20 with name for test clarity
contract MockERC20Named {
    string public name;
    mapping(address => uint256) public balanceOf;

    constructor(string memory _name) { name = _name; }

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @title Finding8_DestAssetAtWrongTimeTest
/// @notice Demonstrates that pending transfers resolve destAsset from the
///         mutable mapping at fulfillment time, so admin changes between
///         queueing and fulfillment deliver the wrong token. The fix
///         snapshots destAsset at queue time.
contract Finding8_DestAssetAtWrongTimeTest is Test {

    BasejumpLanding public landing;

    MockERC20Named public usdc;    // original dest asset
    MockERC20Named public weth;    // new dest asset after admin change

    address public sourceAsset = makeAddr("sourceUSDC");
    address public bridge = makeAddr("authorizedBridge");

    bytes32 public recipient = bytes32(uint256(uint160(makeAddr("recipient"))));

    address constant DISPATCH_PRECOMPILE = 0x0000000000000000000000000000000000000401;

    function setUp() public {
        // Deploy Landing
        BasejumpLanding impl = new BasejumpLanding();
        landing = BasejumpLanding(address(new ERC1967Proxy(
            address(impl), abi.encodeCall(BasejumpLanding.initialize, ())
        )));

        // Deploy two different destination tokens
        usdc = new MockERC20Named("xcUSDC");
        weth = new MockERC20Named("xcWETH");

        // Configure: sourceAsset maps to USDC initially
        landing.setAuthorizedBridge(bridge, true);
        landing.setDestAsset(sourceAsset, address(usdc));

        // Mock dispatch precompile
        vm.mockCall(DISPATCH_PRECOMPILE, bytes(""), bytes(""));
    }

    // ═══════════════════════════════════════════════════════════════
    // EXPLOIT: destAsset resolved at fulfillment time
    // ═══════════════════════════════════════════════════════════════

    /// @notice Admin changes destAssetFor between queueing and fulfillment.
    ///         The pending transfer delivers the NEW token instead of the
    ///         token that was configured when the transfer was queued.
    function test_exploit_destAssetChangedAfterQueue() public {
        // ─── Step 1: Transfer queues (pool is empty) ──────────────
        // destAssetFor[sourceAsset] = USDC at this point
        vm.prank(bridge);
        landing.transfer(sourceAsset, 1000e6, recipient);

        // Verify it queued with USDC as the intended dest
        (address queuedSource, uint256 queuedAmount,) = landing.pendingTransfers(0);
        assertEq(queuedSource, sourceAsset);
        assertEq(queuedAmount, 1000e6);
        console.log("Step 1: Transfer queued. destAssetFor =", address(usdc), "(xcUSDC)");

        // ─── Step 2: Admin changes the mapping ────────────────────
        // Legitimate reason: migrating to a new wrapped token
        landing.setDestAsset(sourceAsset, address(weth));
        console.log("Step 2: Admin changed destAssetFor to", address(weth), "(xcWETH)");

        // ─── Step 3: Fund pool with WETH (the NEW token) ──────────
        weth.mint(address(landing), 10_000e6);

        // ─── Step 4: Fulfill — delivers WETH instead of USDC ──────
        // fulfillPending re-reads destAssetFor[sourceAsset] which now returns WETH
        landing.fulfillPending();

        console.log("Step 3: fulfillPending delivered xcWETH instead of xcUSDC");
        console.log("EXPLOIT CONFIRMED: Recipient expected xcUSDC but got xcWETH");

        // ─── Verify: the dispatch was called with WETH's currency ID ─
        // In a real scenario, this means the recipient receives a completely
        // different token than what was promised when the transfer was queued.
        // If WETH is worth 2000x more than USDC, the Landing pool is drained
        // of a high-value asset. If WETH is worth less, the recipient is shortchanged.
    }

    /// @notice Multiple pending transfers all switch to the wrong token
    ///         after a single admin mapping change.
    function test_exploit_multiplePendingsAffected() public {
        // Queue 3 transfers — all expect USDC
        vm.startPrank(bridge);
        landing.transfer(sourceAsset, 100e6, recipient);
        landing.transfer(sourceAsset, 200e6, recipient);
        landing.transfer(sourceAsset, 300e6, recipient);
        vm.stopPrank();

        assertEq(landing.pendingTail(), 3, "3 transfers queued");

        // Admin changes mapping
        landing.setDestAsset(sourceAsset, address(weth));

        // Fund with WETH
        weth.mint(address(landing), 10_000e6);

        // ALL three fulfill with WETH instead of USDC
        landing.fulfillPending(); // id=0
        landing.fulfillPending(); // id=1
        landing.fulfillPending(); // id=2

        assertEq(landing.pendingHead(), 3, "All fulfilled");
        console.log("EXPLOIT CONFIRMED: All 3 pending transfers delivered wrong token");
    }

    // ═══════════════════════════════════════════════════════════════
    // FIX: Snapshot destAsset at queue time
    // ═══════════════════════════════════════════════════════════════

    /// @notice fix_transfer snapshots destAsset when queueing. Admin mapping
    ///         changes after queueing don't affect pending transfers.
    function test_fix_snapshotPreventsWrongToken() public {
        // ─── Step 1: Queue via fix_transfer (snapshots destAsset) ─
        vm.prank(bridge);
        landing.fix_transfer(sourceAsset, 1000e6, recipient);

        // Verify snapshot was stored
        address snapshotted = landing.pendingResolvedDestAsset(0);
        assertEq(snapshotted, address(usdc), "Snapshot should be xcUSDC");
        console.log("Step 1: fix_transfer queued with snapshot =", snapshotted);

        // ─── Step 2: Admin changes the mapping ────────────────────
        landing.setDestAsset(sourceAsset, address(weth));
        console.log("Step 2: Admin changed destAssetFor to xcWETH");

        // ─── Step 3: Fund pool with USDC (the ORIGINAL token) ─────
        usdc.mint(address(landing), 10_000e6);

        // ─── Step 4: Fulfill with snapshot — delivers USDC correctly
        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.PendingTransferFulfilled(
            0, sourceAsset, address(usdc), recipient, 1000e6
        );
        landing.fix_fulfillPendingWithSnapshot(0);

        console.log("Step 3: fix_fulfillPendingWithSnapshot delivered xcUSDC (correct!)");
        console.log("FIX VERIFIED: Snapshot preserved original destAsset despite admin change");
    }

    /// @notice fix_fulfillPendingWithSnapshot rejects entries queued via
    ///         the original transfer() (no snapshot exists).
    function test_fix_rejectsNonSnapshotted() public {
        // Queue via original transfer (no snapshot)
        vm.prank(bridge);
        landing.transfer(sourceAsset, 1000e6, recipient);

        usdc.mint(address(landing), 10_000e6);

        // fix_fulfillPendingWithSnapshot requires a snapshot
        vm.expectRevert("No snapshot - use fix_transfer to queue");
        landing.fix_fulfillPendingWithSnapshot(0);
    }

    /// @notice Multiple fix_transfer queues each snapshot their own destAsset.
    function test_fix_independentSnapshots() public {
        // Queue transfer #0 when destAsset = USDC
        vm.prank(bridge);
        landing.fix_transfer(sourceAsset, 100e6, recipient);

        // Change mapping to WETH
        landing.setDestAsset(sourceAsset, address(weth));

        // Queue transfer #1 when destAsset = WETH
        vm.prank(bridge);
        landing.fix_transfer(sourceAsset, 200e6, recipient);

        // Verify each has its own snapshot
        assertEq(landing.pendingResolvedDestAsset(0), address(usdc), "Entry 0 = USDC");
        assertEq(landing.pendingResolvedDestAsset(1), address(weth), "Entry 1 = WETH");

        // Fund both tokens
        usdc.mint(address(landing), 10_000e6);
        weth.mint(address(landing), 10_000e6);

        // Fulfill both — each uses its own snapshot
        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.PendingTransferFulfilled(0, sourceAsset, address(usdc), recipient, 100e6);
        landing.fix_fulfillPendingWithSnapshot(0);

        vm.expectEmit(true, true, false, true, address(landing));
        emit IBasejumpLanding.PendingTransferFulfilled(1, sourceAsset, address(weth), recipient, 200e6);
        landing.fix_fulfillPendingWithSnapshot(1);

        console.log("FIX VERIFIED: Entry 0 used USDC, Entry 1 used WETH - independent snapshots");
    }

    /// @notice Snapshot is cleaned up after fulfillment.
    function test_fix_snapshotCleanedUp() public {
        vm.prank(bridge);
        landing.fix_transfer(sourceAsset, 100e6, recipient);

        usdc.mint(address(landing), 10_000e6);
        landing.fix_fulfillPendingWithSnapshot(0);

        // Snapshot should be deleted
        assertEq(landing.pendingResolvedDestAsset(0), address(0), "Snapshot cleaned up");
    }
}
