// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test} from "forge-std/Test.sol";

import {WethHubFunder} from "../../src/snowbridge/WethHubFunder.sol";

contract MockWeth {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

contract MockHub {
    address public token;

    constructor(address token_) {
        token = token_;
    }
}

contract WethHubFunderTest is Test {
    MockWeth public weth;
    MockHub public hub;
    WethHubFunder public funder;

    address public agent = makeAddr("snowbridgeAgent");
    address public anyone = makeAddr("anyone");

    function setUp() public {
        weth = new MockWeth();
        hub = new MockHub(address(weth));
        funder = new WethHubFunder(address(weth), address(hub));
        vm.deal(agent, 2_000 ether);
    }

    function _snowbridgeUnlock(uint256 amount) internal {
        address target = address(funder);
        bool success;
        vm.prank(agent);
        assembly {
            success := call(gas(), target, amount, 0, 0, 0, 0)
        }
        assertTrue(success);
    }

    function testConstructorRejectsZero() public {
        vm.expectRevert(WethHubFunder.ZeroAddress.selector);
        new WethHubFunder(address(0), address(hub));
        vm.expectRevert(WethHubFunder.ZeroAddress.selector);
        new WethHubFunder(address(weth), address(0));
    }

    function testConstructorRejectsHubWithOtherToken() public {
        MockHub other = new MockHub(makeAddr("usdc"));
        vm.expectRevert(abi.encodeWithSelector(WethHubFunder.HubTokenMismatch.selector, other.token()));
        new WethHubFunder(address(weth), address(other));
    }

    function testReceivesSnowbridgeStyleCall() public {
        _snowbridgeUnlock(1_037 ether);
        assertEq(address(funder).balance, 1_037 ether);
    }

    function testReceivesWithStipend() public {
        vm.prank(agent);
        payable(address(funder)).transfer(1 ether);
        assertEq(address(funder).balance, 1 ether);
    }

    function testFundWrapsAndDonates() public {
        _snowbridgeUnlock(1_037 ether);

        vm.expectEmit(address(funder));
        emit WethHubFunder.Funded(1_037 ether);
        vm.prank(anyone);
        funder.fund();

        assertEq(weth.balanceOf(address(hub)), 1_037 ether);
        assertEq(address(funder).balance, 0);
        assertEq(weth.balanceOf(address(funder)), 0);
    }

    function testFundForwardsStrayWeth() public {
        weth.mint(address(funder), 3 ether);
        _snowbridgeUnlock(2 ether);
        funder.fund();
        assertEq(weth.balanceOf(address(hub)), 5 ether);
    }

    function testFundEmptyReverts() public {
        vm.expectRevert(WethHubFunder.NothingToFund.selector);
        funder.fund();
    }

    function testFuzzFund(uint96 amount) public {
        vm.assume(amount > 0);
        vm.deal(agent, amount);
        _snowbridgeUnlock(amount);
        funder.fund();
        assertEq(weth.balanceOf(address(hub)), amount);
    }
}

contract WethHubFunderForkTest is Test {
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant ASSET_HUB_AGENT = 0xd803472c47a87D7B63E888DE53f03B4191B846a8;
    address constant WETH_HUB = 0x283B14B5Dd352e32154Df014EA96834F395E04b6;

    function setUp() public {
        vm.createSelectFork("mainnet");
    }

    function testAgentUnlockThenFund() public {
        WethHubFunder funder = new WethHubFunder(WETH, WETH_HUB);
        uint256 amount = 1_037 ether;
        uint256 escrowBefore = IERC20Balance(WETH).balanceOf(WETH_HUB);
        uint256 stray = IERC20Balance(WETH).balanceOf(address(funder)) + address(funder).balance;
        vm.deal(ASSET_HUB_AGENT, ASSET_HUB_AGENT.balance + amount);

        address target = address(funder);
        bool success;
        vm.prank(ASSET_HUB_AGENT);
        assembly {
            success := call(gas(), target, amount, 0, 0, 0, 0)
        }
        assertTrue(success);

        funder.fund();
        assertEq(IERC20Balance(WETH).balanceOf(WETH_HUB) - escrowBefore, amount + stray);
        assertEq(IERC20Balance(WETH).balanceOf(address(funder)), 0);
        assertEq(address(funder).balance, 0);
    }
}

interface IERC20Balance {
    function balanceOf(address) external view returns (uint256);
}
