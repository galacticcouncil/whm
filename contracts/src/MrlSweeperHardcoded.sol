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
/// per-token HARDCODED treasury destination. Destinations are written once at construction and
/// have NO setter — an authorized caller can therefore only ever push funds to the fixed
/// treasury address, never redirect them. So the owner key is non-custodial for theft: worst
/// case it moves funds to the treasury on someone else's schedule.
///
/// Flow: governance sets a standing SA->this ERC20 approval once (XCM Transact from the SA); then
/// either the SA (governance) or the owner EOA calls sweep()/sweepAmount() per token, as many
/// times as needed (bal==0-safe) to catch stragglers, pacing amounts against the Wormhole Governor.
///
/// Amounts are floored to Wormhole's 8-decimal precision before leaving the SA, so no sub-1e-8
/// "dust" is ever trapped in this contract — any remainder stays in the SA (governance-recoverable).
/// sweep()/sweepAmount() are payable and forward msg.value as the Wormhole core messageFee (0 on
/// Moonbeam today) so a future nonzero fee does not permanently brick the sweeper.
contract MrlSweeperHardcoded {
    address public immutable SA;
    address public immutable OWNER;
    ITokenBridge public immutable BRIDGE;

    struct Dest {
        uint16 chain;
        bytes32 recipient;
        bool set;
    }

    mapping(address => Dest) public destOf; // set once in constructor, no setter

    event Swept(address indexed token, uint256 amount, uint16 chain, bytes32 recipient, uint64 seq);

    error NotAuthorized();
    error UnknownToken(address token);
    error LengthMismatch();
    error ZeroAddress();
    error BadDest(address token);
    error DuplicateToken(address token);

    /// @param sa          Hydration para-2034 sovereign account on Moonbeam (holds the tokens)
    /// @param owner        EOA allowed to trigger sweeps alongside the SA (the deployer, passed explicitly for CREATE2)
    /// @param bridge       Wormhole token bridge on Moonbeam
    /// @param tokens       per-token Moonbeam ERC20 addresses (must be non-zero, unique)
    /// @param chains       Wormhole recipient chain per token (must be non-zero)
    /// @param recipients   bytes32 treasury recipient per token (must be non-zero; evm left-pad / solana ATA / sui 32b)
    constructor(
        address sa,
        address owner,
        address bridge,
        address[] memory tokens,
        uint16[] memory chains,
        bytes32[] memory recipients
    ) {
        if (tokens.length != chains.length || tokens.length != recipients.length) revert LengthMismatch();
        if (sa == address(0) || bridge == address(0)) revert ZeroAddress(); // owner==0 is allowed (disables EOA path)
        SA = sa;
        OWNER = owner;
        BRIDGE = ITokenBridge(bridge);
        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            if (t == address(0) || chains[i] == 0 || recipients[i] == bytes32(0)) revert BadDest(t);
            if (destOf[t].set) revert DuplicateToken(t);
            destOf[t] = Dest(chains[i], recipients[i], true);
        }
    }

    modifier auth() {
        if (msg.sender != SA && msg.sender != OWNER) revert NotAuthorized();
        _;
    }

    /// sweep the full current SA balance of `token` (floored to 8dp) to its hardcoded destination. bal==0 ⇒ no-op.
    function sweep(address token) external payable auth returns (uint64 seq) {
        return _sweep(token, IERC20(token).balanceOf(SA));
    }

    /// sweep up to `amount` (floored to 8dp) — lets the caller pace against the Wormhole Governor
    /// (a sub-$100k leg under the daily notional cap, then the big-transfer tail).
    function sweepAmount(address token, uint256 amount) external payable auth returns (uint64 seq) {
        return _sweep(token, amount);
    }

    function _sweep(address token, uint256 amount) internal returns (uint64 seq) {
        Dest memory d = destOf[token];
        if (!d.set) revert UnknownToken(token);

        // floor to Wormhole's 8-decimal precision so no dust is stranded in this contract;
        // the sub-1e-8 remainder stays in the SA (governance-recoverable).
        uint8 dec = IERC20(token).decimals();
        if (dec > 8) {
            uint256 unit = 10 ** (uint256(dec) - 8);
            amount = amount - (amount % unit);
        }
        if (amount == 0) return 0;

        require(IERC20(token).transferFrom(SA, address(this), amount), "transferFrom");
        require(IERC20(token).approve(address(BRIDGE), amount), "approve");
        seq = BRIDGE.transferTokens{value: msg.value}(token, amount, d.chain, d.recipient, 0, 0);
        emit Swept(token, amount, d.chain, d.recipient, seq);
    }
}
