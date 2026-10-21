// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ZecUtxoEmitter} from "../../src/utxo/ZecUtxoEmitter.sol";
import {IZecUtxoEmitter} from "../../src/utxo/interfaces/IZecUtxoEmitter.sol";
import {HydrationConsts} from "../../src/utils/hydration/HydrationConsts.sol";

import {MockERC20} from "../mocks/MockERC20.sol";
import {MockNttManager} from "../mocks/MockNttManager.sol";

/// @dev Stands in for the DISPATCH precompile: any call mints `out` NEAR to the caller, which is what
///      a successful `router.sell` looks like from the emitter's side. Set `out` to 0 and `fail` to
///      make the router reject the sale.
contract MockUtxoDispatch {
    address public near;
    uint256 public out;
    bool public fail;
    bytes public lastCall;

    function configure(address _near, uint256 _out, bool _fail) external {
        near = _near;
        out = _out;
        fail = _fail;
    }

    fallback() external {
        require(!fail, "router");
        lastCall = msg.data;
        MockERC20(near).mint(msg.sender, out);
    }
}

/// @title ZecUtxoEmitterTest
/// @notice Pins what the NEAR side relies on: the NTT transfer names `sha256(hex account)` and carries
///         the amount net of the fee, and the event carries the address the bot re-derives from. And
///         that the fee only leaves through the owner — swapped to NEAR quantized to the rail, or swept.
contract ZecUtxoEmitterTest is Test {
    /// @dev Hydration's live asset ids: ZEC 1,001,357 (8 dp), NEAR 1,001,358 (24 dp).
    uint32 constant ZEC_ID = 1_001_357;
    uint32 constant NEAR_ID = 1_001_358;

    uint256 constant FEE = 5_000;
    uint256 constant MIN = 100_000;

    /// @dev The mainnet canary, 2026-10-16: `t1XVScGCcXkcrUaFtHg1YVzos1FXmbiG5dy` derives this account
    ///      under `withdraw-zec.hydration-whm.near`, and this is the NTT recipient that reached it.
    bytes32 constant CANARY_ACCOUNT = 0x506b38107a862ca03d5ace3583d6bb9f653cc0bea7e0c40793306001add35dab;
    bytes32 constant CANARY_RECIPIENT = 0x27c775e46d7f78b3bbc14f52eae1e257e1aed309f550573625a455bae7a8ad80;

    bytes22 constant T1 = bytes22(hex"1cb8b0b6b5a5f1c7d0d0b1e9c2a3e9c3a4b5c6d7e8f9");
    bytes22 constant T3 = bytes22(hex"1cbd1111111111111111111111111111111111111111");

    ZecUtxoEmitter public emitter;
    MockERC20 public zec;
    MockERC20 public near;
    MockNttManager public zecManager;
    MockNttManager public nearManager;
    MockUtxoDispatch public dispatch;

    address public user = makeAddr("user");
    address public stranger = makeAddr("stranger");

    function setUp() public {
        // Assets live at their ERC20-precompile addresses, so the mocks must too.
        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(ZEC_ID));
        deployCodeTo("MockERC20.sol:MockERC20", HydrationConsts.toErc20(NEAR_ID));
        zec = MockERC20(HydrationConsts.toErc20(ZEC_ID));
        near = MockERC20(HydrationConsts.toErc20(NEAR_ID));

        deployCodeTo("ZecUtxoEmitterTest.sol:MockUtxoDispatch", HydrationConsts.DISPATCH_PRECOMPILE);
        dispatch = MockUtxoDispatch(HydrationConsts.DISPATCH_PRECOMPILE);

        zecManager = new MockNttManager(address(zec));
        nearManager = new MockNttManager(address(near));

        emitter = ZecUtxoEmitter(
            address(new ERC1967Proxy(address(new ZecUtxoEmitter()), abi.encodeCall(ZecUtxoEmitter.initialize, ())))
        );
        emitter.setZecNttManager(address(zecManager));
        emitter.setNearNttManager(address(nearManager));
        emitter.setFee(FEE);
    }

    function _send(uint256 amount, bytes22 to, bytes32 account) internal returns (uint64 sequence) {
        zec.mint(user, amount);
        vm.startPrank(user);
        zec.approve(address(emitter), amount);
        sequence = emitter.send(amount, to, account);
        vm.stopPrank();
    }

    // ─── send ───────────────────────────────────────────────────────

    function test_SendSettlesNetAndKeepsFee() public {
        uint64 sequence = _send(1_000_000, T1, CANARY_ACCOUNT);

        MockNttManager.TransferRecord memory t = zecManager.getTransfer(sequence);
        assertEq(t.amount, 1_000_000 - FEE);
        assertEq(t.recipientChain, 15);
        assertEq(zec.balanceOf(address(emitter)), FEE, "fee stays");
        assertEq(zec.balanceOf(user), 0);
    }

    /// @notice The NEAR NTT contract accepts `complete(vaa, account)` only for
    ///         `sha256(account) == to` — this is the recipient that reached the canary account.
    function test_RecipientIsSha256OfTheHexAccount() public {
        uint64 sequence = _send(1_000_000, T1, CANARY_ACCOUNT);
        assertEq(zecManager.getTransfer(sequence).recipient, CANARY_RECIPIENT);
    }

    function test_EventCarriesTheHint() public {
        zec.mint(user, 1_000_000);
        vm.startPrank(user);
        zec.approve(address(emitter), 1_000_000);
        vm.expectEmit(address(emitter));
        emit IZecUtxoEmitter.WithdrawRequested(0, CANARY_ACCOUNT, user, 1_000_000 - FEE, FEE, abi.encodePacked(T1));
        emitter.send(1_000_000, T1, CANARY_ACCOUNT);
        vm.stopPrank();
    }

    function test_P2shAccepted() public {
        uint64 sequence = _send(1_000_000, T3, CANARY_ACCOUNT);
        assertEq(zecManager.getTransfer(sequence).amount, 1_000_000 - FEE);
    }

    function test_ExactlyTheMinimumAfterTheFee() public {
        uint64 sequence = _send(MIN + FEE, T1, CANARY_ACCOUNT);
        assertEq(zecManager.getTransfer(sequence).amount, MIN);
    }

    function test_RevertWhen_BelowTheMinimumAfterTheFee() public {
        vm.expectRevert(abi.encodeWithSelector(IZecUtxoEmitter.AmountBelowMinimum.selector, MIN + FEE - 1, MIN + FEE));
        emitter.send(MIN + FEE - 1, T1, CANARY_ACCOUNT);
    }

    function test_RevertWhen_NotATransparentMainnetAddress() public {
        bytes22 testnet = bytes22(hex"1d25b0b6b5a5f1c7d0d0b1e9c2a3e9c3a4b5c6d7e8f9"); // tm
        vm.expectRevert(IZecUtxoEmitter.InvalidZcashAddress.selector);
        emitter.send(1_000_000, testnet, CANARY_ACCOUNT);
    }

    function test_RevertWhen_NoAccount() public {
        vm.expectRevert(IZecUtxoEmitter.InvalidNearAccount.selector);
        emitter.send(1_000_000, T1, bytes32(0));
    }

    function test_RevertWhen_NotConfigured() public {
        ZecUtxoEmitter fresh = ZecUtxoEmitter(
            address(new ERC1967Proxy(address(new ZecUtxoEmitter()), abi.encodeCall(ZecUtxoEmitter.initialize, ())))
        );
        vm.expectRevert(IZecUtxoEmitter.NotConfigured.selector);
        fresh.send(1_000_000, T1, CANARY_ACCOUNT);
    }

    /// @notice A non-zero delivery price is paid out of the contract's own balance, as in
    ///         `IntentEmitter` — the caller sends no value.
    function test_DeliveryPricePaidFromTheContract() public {
        zecManager.setDeliveryPrice(3 wei);
        vm.deal(address(emitter), 3 wei);
        _send(1_000_000, T1, CANARY_ACCOUNT);
        assertEq(address(zecManager).balance, 3 wei);
        assertEq(address(emitter).balance, 0);
    }

    function test_RevertWhen_RailIsPaused() public {
        zecManager.setPaused(true);
        zec.mint(user, 1_000_000);
        vm.startPrank(user);
        zec.approve(address(emitter), 1_000_000);
        vm.expectRevert(MockNttManager.TransferPaused.selector);
        emitter.send(1_000_000, T1, CANARY_ACCOUNT);
        vm.stopPrank();
    }

    // ─── refuel ───────────────────────────────────────────────────

    function test_RefuelSendsTrimmedNear() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        _send(2_000_000, T1, CANARY_ACCOUNT);
        uint256 out = 1.23456789e24 + 42; // NEAR, with dust below the rail's 8 dp
        dispatch.configure(address(near), out, false);

        uint64 sequence = emitter.refuel(3 * FEE, 1e24, "bot.hydration-whm.near");

        MockNttManager.TransferRecord memory t = nearManager.getTransfer(sequence);
        assertEq(t.amount, out - (out % 1e16));
        assertEq(t.recipientChain, 15);
        assertEq(t.recipient, sha256(bytes("bot.hydration-whm.near")));
        assertEq(near.balanceOf(address(emitter)), out % 1e16, "dust stays for the next swap");
    }

    /// @notice The router call sells exactly `zecIn`, ZEC → NEAR, with the owner's floor — not the
    ///         whole balance, which grows with every `send` while the call waits for governance.
    function test_RefuelRouterCall() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        _send(1_000_000, T1, CANARY_ACCOUNT);
        dispatch.configure(address(near), 1e24, false);
        emitter.refuel(FEE, 9e23, "bot.near");

        bytes memory call = dispatch.lastCall();
        assertEq(uint8(call[0]), 67, "router pallet");
        assertEq(uint8(call[1]), 0, "sell");
        assertEq(_u32(call, 2), ZEC_ID);
        assertEq(_u32(call, 6), NEAR_ID);
        assertEq(_u128(call, 10), FEE, "amount in = zecIn, not the balance");
        assertEq(_u128(call, 26), 9e23, "floor");
    }

    function test_RevertWhen_StrangerRefuels() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        vm.prank(stranger);
        vm.expectRevert(IZecUtxoEmitter.NotOwner.selector);
        emitter.refuel(FEE, 0, "bot.near");
    }

    function test_RevertWhen_NothingToSell() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        vm.expectRevert(IZecUtxoEmitter.ZeroAmount.selector);
        emitter.refuel(0, 0, "bot.near");
    }

    function test_RevertWhen_NoFeeAccount() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        vm.expectRevert(IZecUtxoEmitter.InvalidNearAccount.selector);
        emitter.refuel(FEE, 0, "");
    }

    function test_RevertWhen_BelowTheTrimUnit() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        dispatch.configure(address(near), 1e16 - 1, false);
        vm.expectRevert(abi.encodeWithSelector(IZecUtxoEmitter.AmountBelowTrimUnit.selector, 0, 1e16));
        emitter.refuel(FEE, 0, "bot.near");
    }

    function test_RevertWhen_RouterFails() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        dispatch.configure(address(near), 0, true);
        vm.expectRevert(IZecUtxoEmitter.DispatchFailed.selector);
        emitter.refuel(FEE, 0, "bot.near");
    }

    // ─── admin ──────────────────────────────────────────────────────

    function test_RevertWhen_StrangerSetsTheFee() public {
        vm.prank(stranger);
        vm.expectRevert(IZecUtxoEmitter.NotOwner.selector);
        emitter.setFee(1);
    }

    function test_SweepIsOwnerOnly() public {
        _send(1_000_000, T1, CANARY_ACCOUNT);
        vm.prank(stranger);
        vm.expectRevert(IZecUtxoEmitter.NotOwner.selector);
        emitter.sweep(address(zec), stranger, FEE);

        emitter.sweep(address(zec), address(this), FEE);
        assertEq(zec.balanceOf(address(this)), FEE);
    }

    function test_RevertWhen_StrangerUpgrades() public {
        address impl = address(new ZecUtxoEmitter());
        vm.prank(stranger);
        vm.expectRevert(IZecUtxoEmitter.NotOwner.selector);
        emitter.upgradeToAndCall(impl, "");
    }

    // ─── helpers ────────────────────────────────────────────────────

    function _u32(bytes memory b, uint256 at) internal pure returns (uint32 v) {
        for (uint256 i = 0; i < 4; i++) {
            v |= uint32(uint8(b[at + i])) << uint32(8 * i);
        }
    }

    function _u128(bytes memory b, uint256 at) internal pure returns (uint256 v) {
        for (uint256 i = 0; i < 16; i++) {
            v |= uint256(uint8(b[at + i])) << (8 * i);
        }
    }
}
