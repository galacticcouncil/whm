// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ScaleCodec} from "../utils/ScaleCodec.sol";

import {IBasejumpLanding} from "./interfaces/IBasejumpLanding.sol";

/// @title BasejumpLanding - Instant token delivery for cross-chain bridges on Hydration
/// @notice Pre-funded liquidity pool. Authorized bridges call transfer() to
///         deliver tokens instantly via currencies.transfer extrinsic.
///         Fees are deducted on the Basejump side. Replay protection is
///         handled by the bridge layer (MessageReceiver.processedVaas).
contract BasejumpLanding is Initializable, UUPSUpgradeable, IBasejumpLanding {
    using SafeERC20 for IERC20;
    /// @notice Hydration dispatch precompile at 0x0401 (1025 decimal)
    address public constant DISPATCH = 0x0000000000000000000000000000000000000401;

    /// @notice Currencies pallet index on Hydration runtime
    uint8 public constant CURRENCIES_PALLET_INDEX = 79;

    /// @notice Transfer call index within currencies pallet
    uint8 public constant CURRENCIES_TRANSFER_INDEX = 0;

    /// @notice Gas `parkPending` hands the dispatch precompile. A `currencies.transfer` dispatch
    ///         measured 55,472 gas for the whole transaction on Hydration (eth_estimateGas,
    ///         2026-11-08), so a failure with this much gas is the call's own failure, not the caller's
    ///         gas choice.
    uint256 public constant PARK_DISPATCH_GAS = 500_000;

    address public owner;
    mapping(address => bool) public authorizedBridges;
    mapping(address => address) public destAssetFor;

    struct PendingTransfer {
        address sourceAsset;
        uint256 amount;
        bytes32 recipient;
    }

    uint256 public pendingHead;
    uint256 public pendingTail;
    mapping(uint256 => PendingTransfer) public pendingTransfers;

    // ─── Appended by the FIFO / park upgrade (slots 6-8) ─────────
    // UUPS proxy storage: every field above keeps its slot; new fields go below this line only.

    /// @notice Sum of the amounts still owed by queued and parked entries, per destination asset,
    ///         recorded at enqueue. A new transfer pays directly only from the balance above it.
    mapping(address => uint256) public reservedFor;

    /// @notice The destination asset an entry reserved at enqueue. Zero for an entry queued before
    ///         this upgrade (it reserved nothing) and for an entry already paid.
    mapping(uint256 => address) public reservedAssetOf;

    /// @notice Entries moved off the queue head by `parkPending` because their dispatch failed while
    ///         the pool held enough to pay them. Paid later by `fulfillParked`.
    mapping(uint256 => PendingTransfer) public parkedTransfers;

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyAuthorizedBridge() {
        _onlyAuthorizedBridge();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyAuthorizedBridge() internal view {
        if (!authorizedBridges[msg.sender]) revert NotAuthorizedBridge();
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @notice Deliver tokens to recipient, or queue the payout behind the ones already waiting.
    /// @dev FIFO rule: a payout is paid directly only when the pool's balance of its destination
    ///      asset covers every amount already reserved for that asset (queued or parked) plus this
    ///      one, and no entry queued before the reservation upgrade is still at the head. Otherwise it
    ///      queues and reserves its amount. Newer payouts therefore never spend liquidity an older
    ///      payout of the same asset is waiting for, while other assets keep paying directly.
    /// @param sourceAsset The source chain asset address (destAsset derived from destAssetFor mapping)
    /// @param amount The amount to transfer
    /// @param recipient The recipient as bytes32 (AccountId32)
    /// @param /* data */ Opaque bytes from the originating Basejump VAA. Ignored on Hydration —
    ///        recipients are AccountId32 substrate accounts without contract callback semantics.
    function transfer(address sourceAsset, uint256 amount, bytes32 recipient, bytes memory /* data */)
        external
        onlyAuthorizedBridge
    {
        address destAsset = destAssetFor[sourceAsset];
        if (destAsset == address(0)) revert AssetNotConfigured(sourceAsset);
        // currencies.transfer takes a u128; a larger amount could never be paid and would overflow
        // the reservation sum. Reverting leaves the VAA unconsumed (BasejumpReceiver).
        require(amount <= type(uint128).max, "Amount exceeds uint128");

        // Entries queued before this upgrade reserved nothing, so while one is at the head every
        // payout queues behind it (the strict rule); they are all older than any reserving entry.
        bool legacyAhead = pendingHead < pendingTail && reservedAssetOf[pendingHead] == address(0);
        uint256 reserved = reservedFor[destAsset];

        if (!legacyAhead && IERC20(destAsset).balanceOf(address(this)) >= reserved + amount) {
            _executeTransfer(destAsset, amount, recipient);
            emit TransferExecuted(sourceAsset, destAsset, recipient, amount);
        } else {
            uint256 id = pendingTail++;
            pendingTransfers[id] = PendingTransfer({sourceAsset: sourceAsset, amount: amount, recipient: recipient});
            reservedFor[destAsset] = reserved + amount;
            reservedAssetOf[id] = destAsset;
            emit TransferQueued(id, sourceAsset, destAsset, recipient, amount);
        }
    }

    /// @notice Fulfill the next pending transfer in queue once liquidity is available.
    function fulfillPending() external {
        if (pendingHead >= pendingTail) revert NoPendingTransfers();

        uint256 id = pendingHead;
        PendingTransfer memory pt = pendingTransfers[id];
        address destAsset = destAssetFor[pt.sourceAsset];
        if (IERC20(destAsset).balanceOf(address(this)) < pt.amount) revert InsufficientBalance();

        pendingHead++;
        delete pendingTransfers[id];
        _release(id, pt.amount);

        _executeTransfer(destAsset, pt.amount, pt.recipient);
        emit PendingTransferFulfilled(id, pt.sourceAsset, destAsset, pt.recipient, pt.amount);
    }

    /// @notice Pay the queue head, or park it when its dispatch fails although the pool can fund it.
    /// @dev Permissionless. A head the runtime refuses for good (an amount below the asset's
    ///      existential deposit to an empty account: `dispatch execution failed: ExistentialDeposit`,
    ///      observed on Hydration 2026-11-08) would make `fulfillPending` revert forever and hold every
    ///      later entry. Parking moves it to `parkedTransfers` and advances the head; nothing is paid
    ///      out or forgotten, and its reservation stays until `fulfillParked` pays it.
    ///      Two guards keep a caller from parking a payable head: the pool must hold the head's
    ///      amount (an unfunded head is never skipped), and the dispatch gets a fixed
    ///      `PARK_DISPATCH_GAS`, checked before the call, so the caller's gas limit cannot make it
    ///      fail. A head whose dispatch succeeds is simply paid, exactly as `fulfillPending` would.
    function parkPending() external {
        if (pendingHead >= pendingTail) revert NoPendingTransfers();

        uint256 id = pendingHead;
        PendingTransfer memory pt = pendingTransfers[id];
        address destAsset = destAssetFor[pt.sourceAsset];
        if (IERC20(destAsset).balanceOf(address(this)) < pt.amount) revert InsufficientBalance();

        pendingHead++;
        delete pendingTransfers[id];

        bytes memory encodedCall = _encodeCurrenciesTransfer(destAsset, pt.recipient, pt.amount);
        // EIP-150 forwards at most 63/64 of the gas left; require enough that the full stipend
        // reaches the precompile, plus a margin for the call's own access and memory cost.
        if (gasleft() < PARK_DISPATCH_GAS + PARK_DISPATCH_GAS / 63 + 10_000) revert InsufficientGas();
        (bool success,) = DISPATCH.call{gas: PARK_DISPATCH_GAS}(encodedCall);

        if (success) {
            _release(id, pt.amount);
            emit PendingTransferFulfilled(id, pt.sourceAsset, destAsset, pt.recipient, pt.amount);
        } else {
            parkedTransfers[id] = pt;
            emit TransferParked(id, pt.sourceAsset, destAsset, pt.recipient, pt.amount);
        }
    }

    /// @notice Pay a parked entry once its dispatch can succeed (e.g. the recipient's account now
    ///         exists). Permissionless; reverts and leaves the entry parked if the dispatch fails.
    /// @dev A parked entry was the queue head when parked, so it is older than every entry still
    ///      queued; paying it ahead of them keeps arrival order for its asset.
    function fulfillParked(uint256 id) external {
        PendingTransfer memory pt = parkedTransfers[id];
        if (pt.sourceAsset == address(0)) revert NotParked(id);
        address destAsset = destAssetFor[pt.sourceAsset];
        if (IERC20(destAsset).balanceOf(address(this)) < pt.amount) revert InsufficientBalance();

        delete parkedTransfers[id];
        _release(id, pt.amount);

        _executeTransfer(destAsset, pt.amount, pt.recipient);
        emit ParkedTransferFulfilled(id, pt.sourceAsset, destAsset, pt.recipient, pt.amount);
    }

    /// @notice Release the reservation an entry made at enqueue (none for a pre-upgrade entry).
    function _release(uint256 id, uint256 amount) internal {
        address reservedAsset = reservedAssetOf[id];
        if (reservedAsset != address(0)) {
            reservedFor[reservedAsset] -= amount;
            delete reservedAssetOf[id];
        }
    }

    /// @notice Execute currencies.transfer via dispatch precompile
    function _executeTransfer(address asset, uint256 amount, bytes32 recipient) internal {
        bytes memory encodedCall = _encodeCurrenciesTransfer(asset, recipient, amount);
        (bool success,) = DISPATCH.call(encodedCall);
        if (!success) revert DispatchFailed();
    }

    /// @notice Encode a currencies.transfer extrinsic
    /// @dev Format: pallet_index + call_index + dest (AccountId32) + currency_id (u32 LE) + amount (Compact<u128>)
    function _encodeCurrenciesTransfer(address asset, bytes32 recipient, uint256 amount) internal pure returns (bytes memory) {
        // Currency ID is derived from the last 4 bytes of the asset address
        uint32 currencyId = uint32(uint160(asset));

        require(amount <= type(uint128).max, "Amount exceeds uint128");

        return abi.encodePacked(
            CURRENCIES_PALLET_INDEX,
            CURRENCIES_TRANSFER_INDEX,
            recipient,                              // dest: AccountId32 (raw 32 bytes)
            ScaleCodec.u32Le(currencyId),           // currency_id: u32 (little-endian)
            ScaleCodec.compactU128(uint128(amount)) // amount: Compact<u128>
        );
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        if (msg.sender != owner) revert NotOwner();
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setAuthorizedBridge(address bridge, bool enabled) external onlyOwner {
        authorizedBridges[bridge] = enabled;
    }

    function setDestAsset(address sourceAsset, address destAsset) external onlyOwner {
        destAssetFor[sourceAsset] = destAsset;
        emit DestAssetUpdated(sourceAsset, destAsset);
    }

    /// @notice Emergency withdrawal of ERC20 tokens
    function withdraw(address asset, uint256 amount, address to) external onlyOwner {
        IERC20(asset).safeTransfer(to, amount);
        emit Withdrawn(asset, amount, to);
    }
}
