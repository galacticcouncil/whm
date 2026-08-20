// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IHollarBaseVault {
    // ─── Types ──────────────────────────────────────────────────

    /// @notice Init arguments, grouped. Eleven of them do not fit on the stack as parameters, and
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
        /// @dev What the recipient is paid, net of fee.
        uint256 amount;
        /// @dev What left `principal` to book this credit. Cancelling returns this, not `amount`:
        ///      the redeemer burned the gross and no service was rendered, so charging them the
        ///      fee for a redemption they walked away from would be a permanent shortfall.
        uint256 gross;
    }


    // ─── Events ─────────────────────────────────────────────────

    event Deposited(address indexed from, bytes32 indexed recipient, uint256 amount, uint64 sequence);
    event RedeemCredited(address indexed recipient, uint256 gross, uint256 fee, uint256 credited, uint8 kind);
    event Disputed(address indexed recipient, uint256 amount, uint256 principal);
    event DisputeResolved(address indexed recipient, uint256 amount, bool credited);
    event Claimed(address indexed recipient, uint256 amount);
    event RedemptionCancelled(
        uint256 indexed index, address indexed recipient, uint256 gross, uint64 sequence
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

    // ─── Errors ─────────────────────────────────────────────────

    error DepositsPaused();
    error ClaimsPaused();
    error EmitterAlreadySet();
    error ZeroAddress();
    error ZeroAmount();
    error OraclePriceInvalid(int256 answer);
    error UsdcBelowFloor(uint256 price, uint256 floorPrice);
    error OracleNotConfigured();
    error NotAtQueueHead(address caller, address head);
    error NotYourCredit(uint256 index, address owner);
    error NotQueued(uint256 index);
    error NothingUnpayable(address recipient);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error UnexpectedKind(uint8 kind);
    error UnexpectedEmitterChain(uint16 chainId);
    error FeeTooHigh(uint256 bps);
    error NotDisputed(address recipient, uint256 requested, uint256 disputed);
    error SurplusBelowFloor(uint256 requested, uint256 sweepable);
    error ProtectedToken(address token);
    error InsufficientMessageFee(uint256 provided, uint256 required);
    error RefundFailed();
    error Disabled();
}
