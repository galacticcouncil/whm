// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function decimals() external view returns (uint8);
    function transferFrom(address, address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface ITokenBridge {
    function transferTokens(
        address token,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint256 arbiterFee,
        uint32 nonce
    ) external payable returns (uint64);
}

/// drains the hydration moonbeam sovereign account (SA) to a per-token treasury over the wormhole
/// bridge. destinations are hardcoded in the bytecode (_destFor) — no constructor arg, no setter, so
/// a caller can only push funds to the fixed treasury, never redirect them.
/// governance sets a one-time SA->this approval; then the SA or the owner EOA sweeps per token
/// (bal==0-safe) to drain + catch stragglers. amounts are floored to 8dp so no dust is trapped here;
/// msg.value is forwarded as the wormhole messageFee.
contract MrlSweeperHardcoded {
    address public immutable SA;
    address public immutable OWNER;
    ITokenBridge public immutable BRIDGE;

    event Swept(address indexed token, uint256 amount, uint16 chain, bytes32 recipient, uint64 seq);

    error NotAuthorized();
    error UnknownToken(address token);
    error ZeroAddress();

    // treasury safe (eth chain 2 + base chain 30), left-padded to bytes32
    bytes32 internal constant ETH_SAFE = 0x000000000000000000000000d557aeaf1e0cb3d226bff3b7a10c2cda9da081e7;

    // sa = para-2034 sovereign account (holds the tokens); owner = eoa sweeper (0 disables); bridge = wormhole token bridge
    constructor(address sa, address owner, address bridge) {
        if (sa == address(0) || bridge == address(0)) revert ZeroAddress();
        SA = sa;
        OWNER = owner;
        BRIDGE = ITokenBridge(bridge);
    }

    modifier auth() {
        if (msg.sender != SA && msg.sender != OWNER) revert NotAuthorized();
        _;
    }

    // moonbeam erc20 token -> (wormhole recipient chain, bytes32 treasury recipient). reverts for anything unlisted.
    function _destFor(address token) internal pure returns (uint16 chain, bytes32 recipient) {
        if (token == 0x06e605775296e851FF43b4dAa541Bb0984E9D6fD) return (2, ETH_SAFE); // DAI
        if (token == 0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D) return (2, ETH_SAFE); // WBTC
        if (token == 0xab3f0245B83feB11d15AAffeFD7AD465a59817eD) return (2, ETH_SAFE); // WETH
        if (token == 0x931715FEE2d06333043d11F658C8CE934aC61D0c) return (2, ETH_SAFE); // USDC
        if (token == 0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f) return (2, ETH_SAFE); // USDT
        if (token == 0xDa430218862d3dB25DE9F61458645Dde49a9e9C1) return (2, ETH_SAFE); // sUSDS
        if (token == 0x3f9610A50630Bc7D4530736942ee2bC9e00E8De8) return (30, ETH_SAFE); // EURC (Base)
        // solana (chain 1) — per-mint squads-vault ATAs
        if (token == 0xE9F9a2e3dEaE4093c00FBC57b22bb51a4c05ad88) return (1, 0x7e87fb82d2851e1630b6c0ea3fc59b02b8be023a501c017b79cc9002316cb89b); // jitoSOL
        if (token == 0x52b2f622F5676E92dBeA3092004EB9fFb85A8D07) return (1, 0xce2911d2bf99077bc8ac59dc15097bc76f25f67f8178298bf3412550064ba593); // PRIME
        if (token == 0x99Fec54a5Ad36D50A4Bba3a41CAB983a5BB86A7d) return (1, 0x4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65); // SOL
        // sui (chain 21)
        if (token == 0x484eCCE6775143D3335Ed2C7bCB22151C53B9F49) return (21, 0x9fed34580e448224db25a7ea654460d105d9c6f961d3f6861af1362cfe23c86b); // SUI
        revert UnknownToken(token);
    }

    // read the hardcoded (chain, recipient) for a token
    function destOf(address token) external pure returns (uint16 chain, bytes32 recipient) {
        return _destFor(token);
    }

    // sweep the full SA balance of token to its hardcoded dest. bal==0 -> no-op
    function sweep(address token) external payable auth returns (uint64 seq) {
        return _sweep(token, IERC20(token).balanceOf(SA));
    }

    // sweep up to amount — for governor pacing
    function sweepAmount(address token, uint256 amount) external payable auth returns (uint64 seq) {
        return _sweep(token, amount);
    }

    function _sweep(address token, uint256 amount) internal returns (uint64 seq) {
        (uint16 chain, bytes32 recipient) = _destFor(token);

        // floor to 8dp so no dust is stranded here; remainder stays in the SA
        uint8 dec = IERC20(token).decimals();
        if (dec > 8) {
            uint256 unit = 10 ** (uint256(dec) - 8);
            amount = amount - (amount % unit);
        }
        if (amount == 0) return 0;

        require(IERC20(token).transferFrom(SA, address(this), amount), "transferFrom");
        require(IERC20(token).approve(address(BRIDGE), amount), "approve");
        seq = BRIDGE.transferTokens{value: msg.value}(token, amount, chain, recipient, 0, 0);
        emit Swept(token, amount, chain, recipient, seq);
    }
}
