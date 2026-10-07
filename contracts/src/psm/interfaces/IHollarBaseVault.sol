// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHollarBaseVault {
    // ─── Types ──────────────────────────────────────────────────

    /// @notice Init arguments, grouped. Nine of them do not fit on the stack as parameters, and
    ///         at this width names at the call site are worth more than positions anyway.
    struct VaultInit {
        address wormhole;
        address usdc;
        address aUsdc;
        address addressesProvider;
        uint16 hydrationChainId;
        /// @dev Mint gate, in the Aave oracle's 8-dp USD base.
        uint256 minUsdcPrice;
        address admin;
        address guardian;
        address treasurer;
    }

    /// @notice One queued claim. A recipient may hold several; they are paid in arrival order
    ///         like anyone else's.
    struct Credit {
        address recipient;
        /// @dev The Hydration account the value came from — the redeemer, or for a refund the
        ///      recipient of the entry it undid. A cancellation re-mints here and nowhere else:
        ///      it is the one address known to exist on that chain.
        address origin;
        /// @dev Booked from a KIND_REFUND: a deposit that never minted. Cancelling it attests the
        ///      deposit again (KIND_MINT), so a second cancel on Hydration still refunds fee-free.
        ///      Only its recipient may cancel it: its origin put nothing in.
        bool refund;
        /// @dev What the recipient is paid, net of fee.
        uint256 amount;
        /// @dev What left `principal` to book this credit. Cancelling returns this, not `amount`:
        ///      the redeemer burned the gross and no service was rendered, so charging them the
        ///      fee for a redemption they walked away from would be a permanent shortfall.
        uint256 gross;
    }


    // ─── Events ─────────────────────────────────────────────────

    event Deposited(address indexed from, bytes32 indexed recipient, uint256 amount, uint64 sequence);
    /// @dev `index` is the queue slot `cancelQueuedRedemption` takes.
    event RedeemCredited(
        uint256 indexed index, address indexed recipient, uint256 gross, uint256 fee, uint256 credited, uint8 kind
    );
    event Disputed(address indexed recipient, uint256 amount, uint256 principal);
    /// @dev A redemption that landed above its own fee limit: nothing booked, HOLLAR sent back.
    event RedeemReturned(
        address indexed recipient, address indexed origin, uint256 amount, uint256 feeBps, uint256 maxFeeBps, uint64 sequence
    );
    event Claimed(address indexed recipient, uint256 amount);
    event RedemptionCancelled(
        uint256 indexed index, address indexed recipient, uint256 gross, bytes32 hydrationRecipient, uint64 sequence
    );
    event CreditUnpayable(uint256 indexed index, address indexed recipient, uint256 amount);
    event UnpayableClaimed(address indexed recipient, uint256 amount);
    event Invested(uint256 amount);
    event Unwound(uint256 amount);
    event SurplusSwept(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    event HydrationEmitterSet(bytes32 emitter);
    event DepositLimitSet(uint256 capacity, uint256 window);
    event FeesSet(uint256 redeemFeeBps, uint256 surplusFloorBps);
    event DepositsPausedSet(bool paused);
    event ClaimsPausedSet(bool paused);
    event InvestPausedSet(bool paused);

    // ─── Errors ─────────────────────────────────────────────────

    error DepositsPaused();
    error ClaimsPaused();
    error EmitterAlreadySet();
    error EmitterNotSet();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidChainId(uint16 chainId);
    error RecipientUnpayable(address recipient);
    error FloorTooHigh(uint256 bps);
    error OraclePriceInvalid(int256 answer);
    error UsdcBelowFloor(uint256 price, uint256 floorPrice);
    error OracleNotConfigured();
    error NotAtQueueHead(address caller, address head);
    error CancelNotAtHead(uint256 index, uint256 head);
    error NotYourCredit(uint256 index, address owner);
    error OriginCancelTooEarly(uint256 index, uint256 opensAt);
    error NotQueued(uint256 index);
    error NothingUnpayable(address recipient);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error UnexpectedKind(uint8 kind);
    error UnexpectedEmitterChain(uint16 chainId);
    error MessageAlreadyProcessed(uint64 sequence);
    error PayoutFailed(address recipient);
    error FeeTooHigh(uint256 bps);
    error SurplusBelowFloor(uint256 requested, uint256 sweepable);
    error ProtectedToken(address token);
    error InsufficientMessageFee(uint256 provided, uint256 required);
    error RefundFailed();
    error Disabled();
}
