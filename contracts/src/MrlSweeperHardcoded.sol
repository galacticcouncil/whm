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

/// Drains the Hydration Moonbeam sovereign account (SA) over the Wormhole token bridge to a
/// per-token treasury destination that is HARDCODED IN THE BYTECODE (see `_destFor`). There is no
/// constructor arg and no setter for destinations — an authorized caller can only ever push funds
/// to the fixed treasury address for each token, never redirect them. So the owner key is
/// non-custodial for theft: worst case it moves funds to the treasury on someone else's schedule.
///
/// Flow: governance sets a standing SA->this ERC20 approval once (XCM Transact from the SA); then
/// either the SA (governance) or the owner EOA calls sweep()/sweepAmount() per token, as many times
/// as needed (bal==0-safe) to catch stragglers, pacing amounts against the Wormhole Governor.
/// Amounts are floored to Wormhole's 8-decimal precision so no dust is trapped here (remainder stays
/// in the SA). sweep()/sweepAmount() forward msg.value as the Wormhole messageFee (0 on Moonbeam today).
///
/// ⚠️ The hardcoded recipients are PROVISIONAL — before any real deploy confirm the ETH Safe (chain 2/30)
/// is live on Ethereum mainnet and the Sui recipient (chain 21) is the final msig. Changing a recipient
/// is a source edit + redeploy (the CREATE2 address changes with the bytecode).
contract MrlSweeperHardcoded {
    address public immutable SA;
    address public immutable OWNER;
    ITokenBridge public immutable BRIDGE;

    event Swept(address indexed token, uint256 amount, uint16 chain, bytes32 recipient, uint64 seq);

    error NotAuthorized();
    error UnknownToken(address token);
    error ZeroAddress();

    // treasury Safe (Gnosis 4-of-7), Ethereum (chain 2) + Base (chain 30), left-padded to bytes32
    bytes32 internal constant ETH_SAFE = 0x000000000000000000000000d557aeaf1e0cb3d226bff3b7a10c2cda9da081e7;

    /// @param sa      Hydration para-2034 sovereign account on Moonbeam (holds the tokens)
    /// @param owner    EOA allowed to trigger sweeps alongside the SA (passed explicitly for CREATE2; 0 disables the EOA path)
    /// @param bridge   Wormhole token bridge on Moonbeam
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

    /// Hardcoded (Moonbeam ERC20 token) → (Wormhole recipient chain, bytes32 treasury recipient).
    /// Reverts UnknownToken for anything not listed. Source of truth — reviewed in code, not passed at deploy.
    function _destFor(address token) internal pure returns (uint16 chain, bytes32 recipient) {
        if (token == 0x06e605775296e851FF43b4dAa541Bb0984E9D6fD) return (2, ETH_SAFE); // DAI
        if (token == 0xE57eBd2d67B462E9926e04a8e33f01cD0D64346D) return (2, ETH_SAFE); // WBTC
        if (token == 0xab3f0245B83feB11d15AAffeFD7AD465a59817eD) return (2, ETH_SAFE); // WETH
        if (token == 0x931715FEE2d06333043d11F658C8CE934aC61D0c) return (2, ETH_SAFE); // USDC
        if (token == 0xc30E9cA94CF52f3Bf5692aaCF81353a27052c46f) return (2, ETH_SAFE); // USDT
        if (token == 0xDa430218862d3dB25DE9F61458645Dde49a9e9C1) return (2, ETH_SAFE); // sUSDS
        if (token == 0x3f9610A50630Bc7D4530736942ee2bC9e00E8De8) return (30, ETH_SAFE); // EURC (Base)
        // Solana (chain 1) — per-mint associated token accounts of the Squads vault
        if (token == 0xE9F9a2e3dEaE4093c00FBC57b22bb51a4c05ad88) return (1, 0x7e87fb82d2851e1630b6c0ea3fc59b02b8be023a501c017b79cc9002316cb89b); // jitoSOL
        if (token == 0x52b2f622F5676E92dBeA3092004EB9fFb85A8D07) return (1, 0xce2911d2bf99077bc8ac59dc15097bc76f25f67f8178298bf3412550064ba593); // PRIME
        if (token == 0x99Fec54a5Ad36D50A4Bba3a41CAB983a5BB86A7d) return (1, 0x4e69fc5b9315ae4d2aeeddfc7957aec78c921a5230d7e1fa75fcf24c3630ea65); // SOL
        // Sui (chain 21) — ⚠️ provisional msig
        if (token == 0x484eCCE6775143D3335Ed2C7bCB22151C53B9F49) return (21, 0x9fed34580e448224db25a7ea654460d105d9c6f961d3f6861af1362cfe23c86b); // SUI
        revert UnknownToken(token);
    }

    /// external view for inspection/verification — the hardcoded (chain, recipient) for a token.
    function destOf(address token) external pure returns (uint16 chain, bytes32 recipient) {
        return _destFor(token);
    }

    /// sweep the full current SA balance of `token` (floored to 8dp) to its hardcoded destination. bal==0 ⇒ no-op.
    function sweep(address token) external payable auth returns (uint64 seq) {
        return _sweep(token, IERC20(token).balanceOf(SA));
    }

    /// sweep up to `amount` (floored to 8dp) — lets the caller pace against the Wormhole Governor.
    function sweepAmount(address token, uint256 amount) external payable auth returns (uint64 seq) {
        return _sweep(token, amount);
    }

    function _sweep(address token, uint256 amount) internal returns (uint64 seq) {
        (uint16 chain, bytes32 recipient) = _destFor(token); // reverts UnknownToken if unlisted

        // floor to Wormhole's 8-decimal precision so no dust is stranded here; remainder stays in the SA.
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
