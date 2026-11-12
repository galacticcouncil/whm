// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IIntentResolutionReceiver} from "./IIntentResolutionReceiver.sol";

/// @title IIntentDispatcher — intents v2 on Hydration: one order, priced, bridged and published
/// @notice Takes WETH, prices the terms' destination from Hydration feeds, bridges it to the
///         Ethereum forwarder over NTT with the forwarding instruction in the transfer's payload,
///         and publishes the order message NEAR's router swaps against. Two entries into one path:
///         ICE's `execute` callback, which arrives holding WETH, and `dispatch` for a direct caller,
///         which batches `router.sell` before it if it holds anything else.
///
/// @dev The router pins this contract as the order emitter, and the forwarder pins it as the NTT
///      sender — both by its proxy address, which ICE intents also store. A stale or missing feed
///      reverts before value leaves Hydration. Layouts: docs/intents-v2/schema.md.
interface IIntentDispatcher is IIntentResolutionReceiver {
    // ─── Types ───────────────────────────────────────────────────

    /// @notice One action's terms — a swap, or a whole DCA schedule. Hashed into the MPC derivation
    ///         path, so they fix the account `A` and every rule it can be spent under.
    /// @param owner The Hydration account whose orders these are — its EVM address, which ICE calls
    ///        `execute` as. The only caller an order of these terms is taken from.
    /// @param quoteId Random per action. Keeps one user's actions on disjoint accounts; reuse merges.
    /// @param maxSlippageBps How far below the order's oracle rate a fill may land.
    /// @param minOutPerIn The user's hard floor, destination units per 1e18 wei; 0 = none.
    /// @param minDelivery Before the deadline, deliver only once `A` holds this much of the
    ///        destination — at least the bridge's minimum withdrawal.
    /// @param deadline Unix seconds. Swaps end by it; refunds start after it.
    /// @param recipientKind 0 = withdraw off NEAR through POA to `recipient`; 1 = `recipient` is a
    ///        NEAR intents account.
    /// @param refundTo Ethereum address refunds go to, as native ETH.
    /// @param destinationAsset Intents ledger id to buy, e.g. `nep141:zec.omft.near`.
    /// @param recipient Where the destination asset goes. The value the whole design protects.
    struct Quote {
        address owner;
        bytes32 quoteId;
        uint16 maxSlippageBps;
        uint128 minOutPerIn;
        uint128 minDelivery;
        uint64 deadline;
        uint8 recipientKind;
        address refundTo;
        string destinationAsset;
        string recipient;
    }

    /// @notice One execution, priced.
    /// @param seq The NTT message id of its transfer — the order's id.
    /// @param amount The least ETH `A` receives, wei: the WETH taken less the rail's costs, trimmed,
    ///        less the relay ceiling.
    /// @param outPerIn Destination smallest units per 1e18 wei, from the oracle, before slippage.
    struct Order {
        uint64 seq;
        uint128 amount;
        uint128 outPerIn;
    }

    /// @notice How a destination asset is priced: two USD feeds, and the asset's decimals on NEAR.
    /// @param ethFeed ETH/USD, `AggregatorV3`
    /// @param destFeed Destination/USD, `AggregatorV3`
    /// @param destDecimals The destination's decimals in its intents ledger (ZEC 8, wNEAR 24)
    struct PriceRoute {
        address ethFeed;
        address destFeed;
        uint8 destDecimals;
    }

    // ─── Events ──────────────────────────────────────────────────

    /// @notice An order was bridged and published — what the bot acts on.
    /// @param authPath Hash of the terms — the MPC derivation path
    /// @param seq The order's NTT message id
    /// @param caller Who placed it: a direct caller, or the ICE intent's owner (the runtime calls
    ///        `execute` as the user)
    /// @param depositAddress POA's deposit address the ETH is forwarded to
    /// @param amount The least ETH `A` receives — bridged less the relay ceiling
    /// @param outPerIn The rate it was priced at
    /// @param messageSequence Wormhole core sequence of the order message
    /// @param terms The encoded terms, in full — what the bot passes to the router
    event OrderPublished(
        bytes32 indexed authPath,
        uint64 indexed seq,
        address indexed caller,
        address depositAddress,
        uint128 amount,
        uint128 outPerIn,
        uint64 messageSequence,
        bytes terms
    );

    event PriceRouteSet(string destinationAsset, address ethFeed, address destFeed, uint8 destDecimals);
    event MaxFeedAgeSet(uint256 maxFeedAge);
    event MinOrderAmountSet(uint256 minOrderAmount);
    event NttManagerSet(address nttManager);
    event ForwarderSet(bytes32 forwarder);
    event Swept(address indexed asset, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotConfigured();
    error ZeroAmount();
    error InvalidDepositAddress();
    error SettlementRouteMismatch(address expected, address actual);
    /// @dev ICE pushed something other than WETH — only a trade into WETH can become an order.
    error NotWeth(address assetOut);
    /// @dev Only the terms' owner places their orders — anyone else could spend `A`'s ETH at a
    ///      moment of their choosing.
    error NotTermsOwner(address caller, address owner);
    /// @dev `execute` was called for more WETH than arrived since the last order — the rest is
    ///      dust earlier orders left, not this caller's.
    error UnbackedAmount(uint256 amountOut);
    /// @dev The WETH does not cover the rail's delivery price and the order message's fee.
    error AmountBelowCost(uint256 weth, uint256 cost);
    /// @dev What would bridge is below the floor: POA's minimum deposit plus the relay ceiling.
    error AmountBelowMinimum(uint256 amount, uint256 minimum);
    /// @dev The relay ceiling is over half of what bridges — `A` could receive under half the
    ///      order, more than one router fill.
    error RelayFeeTooHigh(uint256 maxRelayFee, uint256 amount);
    error UnpricedAsset(string destinationAsset);
    error InvalidFeedAnswer(address feed, int256 answer);
    error StaleFeed(address feed, uint256 updatedAt);
    error InvalidRate(uint256 outPerIn);

    // ─── Dispatch ────────────────────────────────────────────────

    /// @notice Send `amount` of the caller's WETH as one order of the action `terms` describe.
    /// @param depositAddress POA's deposit address for the account the terms derive — the SDK
    ///        computes it once per action; nothing on-chain binds the two.
    /// @param maxRelayFee Ceiling a redeemer may claim on Ethereum.
    /// @dev Not payable: the rail's costs come out of `amount`, as they do out of an ICE trade. What
    ///      bridges must be at least POA's minimum deposit plus `maxRelayFee`, and `maxRelayFee` at
    ///      most half of it, so the order credits and swaps in one fill.
    /// @return seq The order's NTT message id
    function dispatch(
        uint256 amount,
        address depositAddress,
        uint256 maxRelayFee,
        Quote calldata terms
    ) external returns (uint64 seq);

    /// @notice The rate the next order for `destinationAsset` would carry: destination smallest
    ///         units per 1e18 wei. Reverts on a missing route or a stale feed, as a dispatch would.
    function outPerIn(string calldata destinationAsset) external view returns (uint128);

    /// @notice The MPC derivation path a set of terms hashes to. Turn this into the NEAR account and
    ///         its POA deposit address off-chain.
    function computeAuthPath(Quote calldata terms) external pure returns (bytes32);

    /// @notice The exact bytes the terms encode to — the preimage of their path.
    function computeTerms(Quote calldata terms) external pure returns (bytes memory);

    // ─── Admin ───────────────────────────────────────────────────

    function setPriceRoute(string calldata destinationAsset, PriceRoute calldata route) external;

    function setMaxFeedAge(uint256 maxFeedAge) external;

    function setMinOrderAmount(uint256 minOrderAmount) external;

    function setNttManager(address nttManager) external;

    function setForwarder(bytes32 forwarder) external;

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
