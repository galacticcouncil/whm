// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {ITokenBridge} from "wormhole-solidity-sdk/interfaces/ITokenBridge.sol";

import {IntentReceiver} from "../../src/intents/IntentReceiver.sol";
import {IIntentReceiver} from "../../src/intents/interfaces/IIntentReceiver.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockWETH} from "../mocks/MockWETH.sol";

/// @dev Inbound side of the Wormhole TokenBridge for redeem() tests. The "vaa" passed to redeem is
///      ignored; the test pre-configures the transfer body and the token to release. On
///      completeTransferWithPayload the mock transfers the configured token to the caller (the
///      receiver), mirroring how the real bridge releases the redeemed amount.
contract MockInboundTokenBridge {
    uint16 public immutable homeChainId;
    address public releaseToken; // token transferred to the redeemer on completion
    ITokenBridge.TransferWithPayload body;

    constructor(uint16 _homeChainId) {
        homeChainId = _homeChainId;
    }

    function chainId() external view returns (uint16) {
        return homeChainId;
    }

    /// @dev Home-chain canonical assets only in these tests; wrapped lookups aren't exercised.
    function wrappedAsset(uint16, bytes32) external pure returns (address) {
        return address(0);
    }

    function configure(address token, uint256 amount, uint16 tokenChain, bytes32 tokenAddress, bytes memory payload)
        external
    {
        releaseToken = token;
        body = ITokenBridge.TransferWithPayload({
            payloadID: 3,
            amount: amount,
            tokenAddress: tokenAddress,
            tokenChain: tokenChain,
            to: bytes32(0),
            toChain: homeChainId,
            fromAddress: bytes32(0),
            payload: payload
        });
    }

    function completeTransferWithPayload(bytes memory) external returns (bytes memory) {
        if (body.amount > 0) {
            MockERC20(releaseToken).transfer(msg.sender, body.amount); // MockWETH shares this selector
        }
        return abi.encode(body);
    }

    function parseTransferWithPayload(bytes memory encoded)
        external
        pure
        returns (ITokenBridge.TransferWithPayload memory)
    {
        return abi.decode(encoded, (ITokenBridge.TransferWithPayload));
    }
}

contract IntentReceiverTest is Test {
    IntentReceiver public receiver;
    MockInboundTokenBridge public bridge;
    MockWETH public weth;
    MockERC20 public token;

    uint16 constant HOME_CHAIN = 2; // Ethereum
    address public relayer = makeAddr("relayer");
    address public depositAddress = makeAddr("depositAddress");
    address public stranger = makeAddr("stranger");
    bytes32 public intentId = keccak256("intent-1");

    function setUp() public {
        bridge = new MockInboundTokenBridge(HOME_CHAIN);
        weth = new MockWETH();
        token = new MockERC20();

        IntentReceiver impl = new IntentReceiver();
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl), abi.encodeCall(IntentReceiver.initialize, (address(bridge), address(weth)))
        );
        receiver = IntentReceiver(payable(address(proxy)));
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _payload(bytes32 id, address dest, uint256 maxRelayFee) internal pure returns (bytes memory) {
        return abi.encode(id, dest, maxRelayFee);
    }

    /// @dev Seed a WETH delivery: bridge holds `amount` WETH and is set to release it as the home-chain
    ///      canonical token equal to `weth` (→ unwrap-to-native path in the receiver).
    function _configureWeth(uint256 amount, uint256 maxRelayFee) internal {
        weth.mintTo{value: amount}(address(bridge));
        bridge.configure(
            address(weth),
            amount,
            HOME_CHAIN,
            bytes32(uint256(uint160(address(weth)))),
            _payload(intentId, depositAddress, maxRelayFee)
        );
    }

    // ─── Deployment ──────────────────────────────────────────────

    function testDeployment() public view {
        assertEq(receiver.owner(), address(this));
        assertEq(address(receiver.tokenBridge()), address(bridge));
        assertEq(receiver.wrappedNative(), address(weth));
    }

    // ─── redeem: native path ─────────────────────────────────────

    function testRedeemForwardsNetAndPaysRelayerNative() public {
        uint256 amount = 10 ether;
        uint256 maxRelayFee = 1 ether;
        uint256 fee = 0.3 ether;
        _configureWeth(amount, maxRelayFee);

        vm.expectEmit(true, true, true, true);
        emit IIntentReceiver.IntentForwarded(intentId, receiver.NATIVE(), depositAddress, amount - fee);
        vm.expectEmit(true, true, false, true);
        emit IIntentReceiver.RelayFeePaid(intentId, relayer, fee);

        vm.prank(relayer);
        receiver.redeem("", fee);

        assertEq(depositAddress.balance, amount - fee, "deposit gets net");
        assertEq(relayer.balance, fee, "relayer reimbursed");
        assertEq(address(receiver).balance, 0, "receiver holds nothing");
    }

    function testRedeemZeroFeeForwardsFull() public {
        uint256 amount = 5 ether;
        _configureWeth(amount, 1 ether);

        // No RelayFeePaid expected; assert the forward.
        vm.expectEmit(true, true, true, true);
        emit IIntentReceiver.IntentForwarded(intentId, receiver.NATIVE(), depositAddress, amount);

        vm.prank(relayer);
        receiver.redeem("", 0);

        assertEq(depositAddress.balance, amount);
        assertEq(relayer.balance, 0);
    }

    function testRedeemFeeAtCeilingBoundary() public {
        uint256 amount = 4 ether;
        uint256 maxRelayFee = 1 ether;
        _configureWeth(amount, maxRelayFee);

        vm.prank(relayer);
        receiver.redeem("", maxRelayFee); // fee == ceiling is allowed

        assertEq(relayer.balance, maxRelayFee);
        assertEq(depositAddress.balance, amount - maxRelayFee);
    }

    // ─── redeem: ERC20 (degraded) path ───────────────────────────

    function testRedeemErc20PaysFeeInKind() public {
        uint256 amount = 1_000e6;
        uint256 fee = 50e6;
        token.mint(address(bridge), amount);
        bridge.configure(
            address(token),
            amount,
            HOME_CHAIN,
            bytes32(uint256(uint160(address(token)))), // != wrappedNative → ERC20 forward
            _payload(intentId, depositAddress, 100e6)
        );

        vm.expectEmit(true, true, true, true);
        emit IIntentReceiver.IntentForwarded(intentId, address(token), depositAddress, amount - fee);

        vm.prank(relayer);
        receiver.redeem("", fee);

        assertEq(token.balanceOf(depositAddress), amount - fee);
        assertEq(token.balanceOf(relayer), fee);
        assertEq(token.balanceOf(address(receiver)), 0);
    }

    // ─── redeem: reverts ─────────────────────────────────────────

    function testRedeemRevertsWhenFeeExceedsCeiling() public {
        _configureWeth(10 ether, 1 ether);

        vm.prank(relayer);
        vm.expectRevert(IIntentReceiver.FeeExceedsCeiling.selector);
        receiver.redeem("", 1 ether + 1);
    }

    function testRedeemRevertsOnMalformedPayloadLength() public {
        // 64-byte payload (old format) → rejected.
        weth.mintTo{value: 1 ether}(address(bridge));
        bridge.configure(
            address(weth),
            1 ether,
            HOME_CHAIN,
            bytes32(uint256(uint160(address(weth)))),
            abi.encode(intentId, depositAddress)
        );

        vm.prank(relayer);
        vm.expectRevert(IIntentReceiver.MalformedPayload.selector);
        receiver.redeem("", 0);
    }

    function testRedeemRevertsOnZeroDepositAddress() public {
        _configureWeth(1 ether, 0);
        bridge.configure(
            address(weth),
            1 ether,
            HOME_CHAIN,
            bytes32(uint256(uint160(address(weth)))),
            _payload(intentId, address(0), 0)
        );

        vm.prank(relayer);
        vm.expectRevert(IIntentReceiver.MalformedPayload.selector);
        receiver.redeem("", 0);
    }

    function testRedeemRevertsWhenNothingDelivered() public {
        bridge.configure(
            address(weth), 0, HOME_CHAIN, bytes32(uint256(uint160(address(weth)))), _payload(intentId, depositAddress, 0)
        );

        vm.prank(relayer);
        vm.expectRevert(IIntentReceiver.NothingDelivered.selector);
        receiver.redeem("", 0);
    }

    // ─── Admin ───────────────────────────────────────────────────

    function testSetWrappedNative() public {
        address newWeth = makeAddr("newWeth");
        vm.expectEmit(true, true, false, false);
        emit IIntentReceiver.WrappedNativeUpdated(address(weth), newWeth);
        receiver.setWrappedNative(newWeth);
        assertEq(receiver.wrappedNative(), newWeth);
    }

    function testSetWrappedNativeRevertsUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(IIntentReceiver.NotOwner.selector);
        receiver.setWrappedNative(makeAddr("x"));
    }
}
