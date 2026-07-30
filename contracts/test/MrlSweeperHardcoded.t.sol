// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MrlSweeperHardcoded} from "../src/MrlSweeperHardcoded.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

/// records the last transferTokens call so tests can assert the destination is the hardcoded one.
contract MockBridge {
    address public lastToken; uint256 public lastAmount; uint16 public lastChain; bytes32 public lastRecipient; uint64 public seq;
    function transferTokens(address token, uint256 amount, uint16 chain, bytes32 recipient, uint256, uint32)
        external payable returns (uint64)
    {
        lastToken = token; lastAmount = amount; lastChain = chain; lastRecipient = recipient;
        return ++seq;
    }
}

contract MrlSweeperHardcodedTest is Test {
    MockBridge bridge;
    MockERC20 daiTok;   // chain 2
    MockERC20 solTok;   // chain 1
    MrlSweeperHardcoded sw;

    address SA = address(0x5A);
    address OWNER = address(0x0E);
    address STRANGER = address(0xBAD);
    bytes32 ETH_DEST = bytes32(uint256(uint160(0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7)));
    bytes32 SOL_DEST = bytes32(uint256(0xdead));

    function setUp() public {
        bridge = new MockBridge();
        daiTok = new MockERC20();
        solTok = new MockERC20();

        address[] memory tokens = new address[](2);
        uint16[] memory chains = new uint16[](2);
        bytes32[] memory recips = new bytes32[](2);
        tokens[0] = address(daiTok); chains[0] = 2; recips[0] = ETH_DEST;
        tokens[1] = address(solTok); chains[1] = 1; recips[1] = SOL_DEST;

        sw = new MrlSweeperHardcoded(SA, OWNER, address(bridge), tokens, chains, recips);

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

    function test_unknown_token_reverts() public {
        MockERC20 rogue = new MockERC20();
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
        // destOf has no external setter — the only writer is the constructor.
        // Attempting a state-changing dest write is a compile-time impossibility; assert the getter is stable.
        vm.prank(OWNER); sw.sweep(address(daiTok));
        (uint16 c, bytes32 r,) = sw.destOf(address(daiTok));
        assertEq(c, 2); assertEq(r, ETH_DEST); // unchanged after a sweep
    }
}
