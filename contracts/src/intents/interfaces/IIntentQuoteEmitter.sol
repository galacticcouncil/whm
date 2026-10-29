// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

/// @title IIntentQuoteEmitter — the order message NEAR's IntentRouter swaps against
/// @notice One message per execution: the terms' path, the order's NTT sequence and amount, and the
///         oracle rate its swap must clear. The router pins this contract's address as the only
///         emitter it reads, so it stays thin and stable; all logic lives in the dispatcher.
///
/// @dev Owns its Wormhole emitter address. `IntentReceiver` pins the emitter it accepts forwarding
///      instructions from, so order messages published here are never instructions to it.
///      Layouts: docs/intents-v2/schema.md §2–3.
interface IIntentQuoteEmitter {
    // ─── Types ───────────────────────────────────────────────────

    /// @notice One action's terms — a swap, or a whole DCA schedule. Hashed into the MPC derivation
    ///         path, so they fix the account `A` and every rule it can be spent under.
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
    /// @dev The NEAR account is absent by design: it is derived *from* these terms.
    struct Quote {
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
    /// @param seq The NTT manager sequence `placeOrder` returned — the order's id.
    /// @param amount WETH the order sent — what bounds the router's fill.
    /// @param outPerIn Destination smallest units per 1e18 wei, from the oracle, before slippage.
    struct Order {
        uint64 seq;
        uint128 amount;
        uint128 outPerIn;
    }

    // ─── Events ──────────────────────────────────────────────────

    /// @param authPath Hash of the terms — the MPC derivation path, and the join key for indexers
    /// @param seq The order's NTT sequence
    /// @param dispatcher The authorized dispatcher that priced and placed it
    /// @param amount WETH the order sent
    /// @param outPerIn The rate it was priced at
    /// @param messageSequence Wormhole core sequence of the order message
    /// @param terms The encoded terms, in full — what the bot passes to the router, so it needs no
    ///        other source for them
    event OrderPublished(
        bytes32 indexed authPath,
        uint64 indexed seq,
        address dispatcher,
        uint128 amount,
        uint128 outPerIn,
        uint64 messageSequence,
        bytes terms
    );

    event DispatcherSet(address indexed dispatcher, bool authorized);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotDispatcher();
    error ZeroRate();
    error InvalidMessageFee(uint256 required, uint256 provided);
    // Term validation lives in `IntentCodec`, which declares its own errors — those checks are what
    // make the encoding unambiguous, so they belong welded to the encoder rather than duplicated by
    // every caller.

    // ─── Orders ──────────────────────────────────────────────────

    /// @notice Publish one order's price for the account its terms derive.
    /// @dev Authorized dispatchers only: an order's `seq` must come from a real `placeOrder`, and
    ///      every dispatcher is a price authority for every path. `msg.value` must be exactly the
    ///      message fee.
    /// @return authPath The derivation path the terms hash to
    /// @return messageSequence Wormhole core sequence of the order message
    function publishOrder(Quote calldata terms, Order calldata order)
        external
        payable
        returns (bytes32 authPath, uint64 messageSequence);

    /// @notice The MPC derivation path a set of terms hashes to. Turn this into the NEAR account and
    ///         its POA deposit address off-chain.
    function computeAuthPath(Quote calldata terms) external pure returns (bytes32);

    /// @notice The exact bytes the terms encode to — the preimage of their path.
    /// @dev Pins the off-chain encoder and the router's decoder against this one — a hash mismatch
    ///      says only that something diverged, the bytes say which field.
    function computeTerms(Quote calldata terms) external pure returns (bytes memory);

    // ─── Admin ───────────────────────────────────────────────────

    /// @notice Authorize or revoke a dispatcher. Normally one; a second only during a migration.
    function setDispatcher(address dispatcher, bool authorized) external;

    function isDispatcher(address dispatcher) external view returns (bool);

    function setOwner(address newOwner) external;

    function owner() external view returns (address);
}
