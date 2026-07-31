// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {MrlSweeperHardcoded} from "../src/MrlSweeperHardcoded.sol";

contract MockERC20 {
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function setDecimals(uint8 d) external { decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

interface IMinTok { function transferFrom(address, address, uint256) external returns (bool); }

/// records the last transferTokens call, enforces an optional messageFee, and PULLS from msg.sender.
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
    // real hardcoded token addresses (must match MrlSweeperHardcoded._destFor)
    address constant DAI = 0x06e605775296e851FF43b4dAa541Bb0984E9D6fD; // 18dp, chain 2
    address constant SOL = 0x99Fec54a5Ad36D50A4Bba3a41CAB983a5BB86A7d; // 9dp,  chain 1
    bytes32 constant ETH_SAFE = 0x000000000000000000000000d557aeaf1e0cb3d226bff3b7a10c2cda9da081e7;
    bytes32 constant SOL_DEST = 0x4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65;

    MockBridge bridge;
    MrlSweeperHardcoded sw;
    address SA = address(0x5A);
    address OWNER = address(0x0E);
    address STRANGER = address(0xBAD);

    function _mockAt(address at, uint8 dec) internal returns (MockERC20 m) {
        MockERC20 tmpl = new MockERC20();
        vm.etch(at, address(tmpl).code);
        m = MockERC20(at);
        m.setDecimals(dec);
    }

    function setUp() public {
        bridge = new MockBridge();
        sw = new MrlSweeperHardcoded(SA, OWNER, address(bridge));
        MockERC20 dai = _mockAt(DAI, 18);
        MockERC20 sol = _mockAt(SOL, 9);
        vm.prank(SA); dai.approve(address(sw), type(uint256).max);
        vm.prank(SA); sol.approve(address(sw), type(uint256).max);
        dai.mint(SA, 1_000e18);
        sol.mint(SA, 500e9);
    }

    // the full hardcoded table (mirror of _destFor) — a wrong constant in the contract fails here.
    function test_hardcoded_dests_all_11() public view {
        address[11] memory tok = [
            0x06e605775296e851FF43b4dAa541Bb0984E9D6fD, // DAI
            0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D, // WBTC
            0xab3f0245B83feB11d15AAffeFD7AD465a59817eD, // WETH
            0x931715FEE2d06333043d11F658C8CE934aC61D0c, // USDC
            0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f, // USDT
            0xDa430218862d3dB25DE9F61458645Dde49a9e9C1, // sUSDS
            0x3f9610A50630Bc7D4530736942ee2bC9e00E8De8, // EURC
            0xE9F9a2e3dEaE4093c00FBC57b22bb51a4c05ad88, // jitoSOL
            0x52b2f622F5676E92dBeA3092004EB9fFb85A8D07, // PRIME
            0x99Fec54a5Ad36D50A4Bba3a41CAB983a5BB86A7d, // SOL
            0x484eCCE6775143D3335Ed2C7bCB22151C53B9F49  // SUI
        ];
        uint16[11] memory chain = [uint16(2), 2, 2, 2, 2, 2, 30, 1, 1, 1, 21];
        bytes32[11] memory recip = [
            ETH_SAFE, ETH_SAFE, ETH_SAFE, ETH_SAFE, ETH_SAFE, ETH_SAFE, ETH_SAFE,
            bytes32(0x7e87fb82d2851e1630b6c0ea3fc59b02b8be023a501c017b79cc9002316cb89b),
            bytes32(0xce2911d2bf99077bc8ac59dc15097bc76f25f67f8178298bf3412550064ba593),
            bytes32(0x4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65),
            bytes32(0x9fed34580e448224db25a7ea654460d105d9c6f961d3f6861af1362cfe23c86b)
        ];
        for (uint256 i = 0; i < 11; i++) {
            (uint16 c, bytes32 r) = sw.destOf(tok[i]);
            assertEq(c, chain[i]);
            assertEq(r, recip[i]);
        }
    }

    function test_immutables() public view {
        assertEq(sw.SA(), SA);
        assertEq(sw.OWNER(), OWNER);
        assertEq(address(sw.BRIDGE()), address(bridge));
    }

    function test_owner_sweeps_full_balance_to_hardcoded_dest() public {
        vm.prank(OWNER);
        sw.sweep(DAI);
        assertEq(MockERC20(DAI).balanceOf(SA), 0);
        assertEq(bridge.lastToken(), DAI);
        assertEq(bridge.lastAmount(), 1_000e18);
        assertEq(bridge.lastChain(), 2);
        assertEq(bridge.lastRecipient(), ETH_SAFE); // caller cannot influence dest
    }

    function test_SA_can_also_sweep() public {
        vm.prank(SA);
        sw.sweep(SOL);
        assertEq(MockERC20(SOL).balanceOf(SA), 0);
        assertEq(bridge.lastChain(), 1);
        assertEq(bridge.lastRecipient(), SOL_DEST);
    }

    function test_stranger_cannot_sweep() public {
        vm.prank(STRANGER);
        vm.expectRevert(MrlSweeperHardcoded.NotAuthorized.selector);
        sw.sweep(DAI);
    }

    function test_sweepAmount_partial_for_governor_pacing() public {
        vm.prank(OWNER);
        sw.sweepAmount(DAI, 400e18);
        assertEq(MockERC20(DAI).balanceOf(SA), 600e18);
        assertEq(bridge.lastAmount(), 400e18);
        assertEq(bridge.lastRecipient(), ETH_SAFE);
    }

    // >8dp dust is floored off and STAYS IN THE SA — never trapped in the sweeper.
    function test_dust_stays_in_SA_not_sweeper() public {
        uint256 dust = 12_345; // < 1e10 (the 18->8 dp unit) ⇒ pure dust
        MockERC20(DAI).mint(SA, dust); // SA now holds 1_000e18 + 12_345
        vm.prank(OWNER);
        sw.sweep(DAI);
        assertEq(bridge.lastAmount(), 1_000e18);
        assertEq(MockERC20(DAI).balanceOf(address(sw)), 0); // nothing trapped
        assertEq(MockERC20(DAI).balanceOf(SA), dust);       // remainder retained by SA
    }

    // nonzero Wormhole messageFee forwarded via msg.value; wrong fee reverts atomically.
    function test_forwards_message_fee() public {
        bridge.setFee(0.01 ether);
        vm.deal(OWNER, 1 ether);
        vm.prank(OWNER);
        sw.sweep{value: 0.01 ether}(DAI);
        assertEq(bridge.lastValue(), 0.01 ether);
        bridge.setFee(0.02 ether);
        vm.prank(OWNER);
        vm.expectRevert(); // MockBridge "fee"
        sw.sweep{value: 0.01 ether}(SOL);
        assertEq(MockERC20(SOL).balanceOf(SA), 500e9);
    }

    function test_unknown_token_reverts() public {
        address rogue = makeAddr("rogue");
        _mockAt(rogue, 18);
        MockERC20(rogue).mint(SA, 1e18);
        vm.prank(SA); MockERC20(rogue).approve(address(sw), type(uint256).max);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.UnknownToken.selector, rogue));
        sw.sweep(rogue);
        // destOf also reverts for unknown
        vm.expectRevert(abi.encodeWithSelector(MrlSweeperHardcoded.UnknownToken.selector, rogue));
        sw.destOf(rogue);
    }

    function test_zero_balance_is_noop() public {
        vm.prank(OWNER); sw.sweep(DAI);      // drains
        uint64 before = bridge.seq();
        vm.prank(OWNER); uint64 s = sw.sweep(DAI); // bal==0
        assertEq(s, 0);
        assertEq(bridge.seq(), before);
    }

    function test_constructor_rejects_zero_sa_and_bridge() public {
        vm.expectRevert(MrlSweeperHardcoded.ZeroAddress.selector);
        new MrlSweeperHardcoded(address(0), OWNER, address(bridge));
        vm.expectRevert(MrlSweeperHardcoded.ZeroAddress.selector);
        new MrlSweeperHardcoded(SA, OWNER, address(0));
    }
}
