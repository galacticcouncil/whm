// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MrlSweeperHardcoded} from "../src/MrlSweeperHardcoded.sol";

contract MockERC20 {
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(uint8 d) { decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

interface IMinTok { function transferFrom(address, address, uint256) external returns (bool); }

/// records the last transferTokens call, enforces an optional messageFee via msg.value, and
/// (like the real Wormhole bridge) PULLS the amount from msg.sender so trapped-dust is observable.
contract MockBridge {
    address public lastToken; uint256 public lastAmount; uint16 public lastChain; bytes32 public lastRecipient;
    uint256 public lastValue; uint256 public requiredFee; uint64 public seq;
    function setFee(uint256 f) external { requiredFee = f; }
    function transferTokens(address token, uint256 amount, uint16 chain, bytes32 recipient, uint256, uint32)
        external payable returns (uint64)
    {
        require(msg.value == requiredFee, "fee");
        require(IMinTok(token).transferFrom(msg.sender, address(this), amount), "pull");
        lastToken = token; lastAmount = amount; lastChain = chain; lastRecipient = recipient; lastValue = msg.value;
        return ++seq;
    }
}

contract MrlSweeperHardcodedTest is Test {
    MockBridge bridge;
    MockERC20 daiTok;   // 18 dp, chain 2
    MockERC20 solTok;   // 9 dp, chain 1
    MrlSweeperHardcoded sw;

    address SA = address(0x5A);
    address OWNER = address(0x0E);
    address STRANGER = address(0xBAD);
    bytes32 ETH_DEST = bytes32(uint256(uint160(0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7)));
    bytes32 SOL_DEST = bytes32(uint256(0xdead));

    function _dests(address a, address b)
        internal
        view
        returns (address[] memory t, uint16[] memory c, bytes32[] memory r)
    {
        t = new address[](2); c = new uint16[](2); r = new bytes32[](2);
        t[0] = a; c[0] = 2; r[0] = ETH_DEST;
        t[1] = b; c[1] = 1; r[1] = SOL_DEST;
    }

    function setUp() public {
        bridge = new MockBridge();
        daiTok = new MockERC20(18);
        solTok = new MockERC20(9);
        (address[] memory t, uint16[] memory c, bytes32[] memory r) = _dests(address(daiTok), address(solTok));
        sw = new MrlSweeperHardcoded(SA, OWNER, address(bridge), t, c, r);

        // standing SA->sweeper approval (what governance sets once)
        vm.prank(SA); daiTok.approve(address(sw), type(uint256).max);
        vm.prank(SA); solTok.approve(address(sw), type(uint256).max);
        daiTok.mint(SA, 1_000e18);
        solTok.mint(SA, 500e9);
    }

    function test_immutables_and_dests() public view {
        assertEq(sw.SA(), SA);
        assertEq(sw.OWNER(), OWNER);
        assertEq(address(sw.BRIDGE()), address(bridge));
        (uint16 c, bytes32 r, bool set) = sw.destOf(address(daiTok));
        assertTrue(set); assertEq(c, 2); assertEq(r, ETH_DEST);
    }

    function test_owner_sweeps_full_balance_to_hardcoded_dest() public {
        vm.prank(OWNER);
        sw.sweep(address(daiTok));
        assertEq(daiTok.balanceOf(SA), 0);
        assertEq(bridge.lastToken(), address(daiTok));
        assertEq(bridge.lastAmount(), 1_000e18);
        assertEq(bridge.lastChain(), 2);
        assertEq(bridge.lastRecipient(), ETH_DEST); // caller cannot influence dest
    }

    function test_SA_can_also_sweep() public {
        vm.prank(SA);
        sw.sweep(address(solTok));
        assertEq(solTok.balanceOf(SA), 0);
        assertEq(bridge.lastChain(), 1);
        assertEq(bridge.lastRecipient(), SOL_DEST);
    }

    function test_stranger_cannot_sweep() public {
        vm.prank(STRANGER);
        vm.expectRevert(MrlSweeperHardcoded.NotAuthorized.selector);
        sw.sweep(address(daiTok));
    }

    function test_sweepAmount_partial_for_governor_pacing() public {
        vm.prank(OWNER);
        sw.sweepAmount(address(daiTok), 400e18);
        assertEq(daiTok.balanceOf(SA), 600e18);
        assertEq(bridge.lastAmount(), 400e18);
        assertEq(bridge.lastRecipient(), ETH_DEST);
    }

    // Medium-1: >8dp dust is floored off and STAYS IN THE SA — never trapped in the sweeper.
    function test_dust_stays_in_SA_not_sweeper() public {
        uint256 dust = 12_345; // < 1e10 (the 18->8 dp unit) ⇒ pure dust
        daiTok.mint(SA, dust);  // SA now holds 1_000e18 + 12_345
        vm.prank(OWNER);
        sw.sweep(address(daiTok));
        assertEq(bridge.lastAmount(), 1_000e18);           // bridged amount is 8dp-aligned
        assertEq(daiTok.balanceOf(address(sw)), 0);        // NOTHING trapped in the sweeper
        assertEq(daiTok.balanceOf(SA), dust);              // remainder retained by the SA
    }

    // Medium-2: a nonzero Wormhole messageFee is forwarded via msg.value.
    function test_forwards_message_fee() public {
        bridge.setFee(0.01 ether);
        vm.deal(OWNER, 1 ether);
        vm.prank(OWNER);
        sw.sweep{value: 0.01 ether}(address(daiTok));
        assertEq(bridge.lastValue(), 0.01 ether);
        assertEq(bridge.lastAmount(), 1_000e18);
        // wrong fee reverts atomically (funds never move)
        bridge.setFee(0.02 ether);
        vm.prank(OWNER);
        vm.expectRevert(); // MockBridge "fee"
        sw.sweep{value: 0.01 ether}(address(solTok));
        assertEq(solTok.balanceOf(SA), 500e9);
    }

    function test_unknown_token_reverts() public {
        MockERC20 rogue = new MockERC20(18);
        rogue.mint(SA, 1e18);
        vm.prank(SA); rogue.approve(address(sw), type(uint256).max);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.UnknownToken.selector, address(rogue)));
        sw.sweep(address(rogue));
    }

    function test_zero_balance_is_noop() public {
        vm.prank(OWNER); sw.sweep(address(daiTok));       // drains
        uint64 before = bridge.seq();
        vm.prank(OWNER); uint64 s = sw.sweep(address(daiTok)); // second call, bal==0
        assertEq(s, 0);
        assertEq(bridge.seq(), before); // no new bridge call
    }

    function test_no_setter_exists() public {
        vm.prank(OWNER); sw.sweep(address(daiTok));
        (uint16 c, bytes32 r,) = sw.destOf(address(daiTok));
        assertEq(c, 2); assertEq(r, ETH_DEST); // unchanged after a sweep
    }

    // Low: constructor rejects duplicate / zero token / zero recipient / zero chain / zero SA / length mismatch.
    function test_constructor_rejects_duplicate_token() public {
        address[] memory t = new address[](2); uint16[] memory c = new uint16[](2); bytes32[] memory r = new bytes32[](2);
        t[0] = address(daiTok); c[0] = 2; r[0] = ETH_DEST;
        t[1] = address(daiTok); c[1] = 1; r[1] = SOL_DEST; // dup
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.DuplicateToken.selector, address(daiTok)));
        new MrlSweeperHardcoded(SA, OWNER, address(bridge), t, c, r);
    }

    function test_constructor_rejects_zero_token_recipient_chain() public {
        (address[] memory t, uint16[] memory c, bytes32[] memory r) = _dests(address(daiTok), address(solTok));
        // zero token
        address[] memory t0 = t; t0[1] = address(0);
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.BadDest.selector, address(0)));
        new MrlSweeperHardcoded(SA, OWNER, address(bridge), t0, c, r);
        // zero recipient
        (t, c, r) = _dests(address(daiTok), address(solTok)); r[1] = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.BadDest.selector, address(solTok)));
        new MrlSweeperHardcoded(SA, OWNER, address(bridge), t, c, r);
        // zero chain
        (t, c, r) = _dests(address(daiTok), address(solTok)); c[0] = 0;
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.BadDest.selector, address(daiTok)));
        new MrlSweeperHardcoded(SA, OWNER, address(bridge), t, c, r);
    }

    function test_constructor_rejects_zero_sa_and_length_mismatch() public {
        (address[] memory t, uint16[] memory c, bytes32[] memory r) = _dests(address(daiTok), address(solTok));
        vm.expectRevert(MrlSweeperHardcoded.ZeroAddress.selector);
        new MrlSweeperHardcoded(address(0), OWNER, address(bridge), t, c, r);

        uint16[] memory c1 = new uint16[](1); c1[0] = 2;
        vm.expectRevert(MrlSweeperHardcoded.LengthMismatch.selector);
        new MrlSweeperHardcoded(SA, OWNER, address(bridge), t, c1, r);
    }
}
