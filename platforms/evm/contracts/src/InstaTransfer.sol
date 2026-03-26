// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {ScaleCodec} from "./utils/ScaleCodec.sol";

/// @title InstaTransfer - Instant token delivery for cross-chain bridges on Hydration
/// @notice Pre-funded liquidity pool. Authorized bridges call transfer() to
///         deliver tokens instantly via currencies.transfer extrinsic.
///         Fees are deducted on the InstaBridge side. Replay protection is
///         handled by the bridge layer (MessageReceiver.processedVaas).
contract InstaTransfer is Initializable, UUPSUpgradeable {
    /// @notice Hydration dispatch precompile at 0x0401 (1025 decimal)
    address public constant DISPATCH = 0x0000000000000000000000000000000000000401;

    /// @notice Currencies pallet index on Hydration runtime
    uint8 public constant CURRENCIES_PALLET_INDEX = 79;

    /// @notice Transfer call index within currencies pallet
    uint8 public constant CURRENCIES_TRANSFER_INDEX = 0;

    address public owner;
    mapping(address => bool) public authorizedBridges;
    mapping(address => mapping(address => bool)) public allowedAssetPairs;

    struct PendingTransfer {
        address sourceAsset;
        address destAsset;
        uint256 amount;
        bytes32 recipient;
    }

    uint256 public nextPendingId;
    mapping(uint256 => PendingTransfer) public pendingTransfers;

    // ─── Events ──────────────────────────────────────────────────

    event TransferExecuted(address indexed sourceAsset, address indexed destAsset, bytes32 indexed recipient, uint256 amount);
    event TransferQueued(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount);
    event PendingTransferFulfilled(uint256 indexed id, address indexed sourceAsset, address destAsset, bytes32 recipient, uint256 amount);
    event Withdrawn(address indexed asset, uint256 amount, address indexed to);
    event AllowedAssetPairUpdated(address indexed sourceAsset, address indexed destAsset, bool enabled);

    // ─── Errors ──────────────────────────────────────────────────

    error NotOwner();
    error NotAuthorizedBridge();
    error DispatchFailed();
    error ERC20TransferFailed();
    error PendingTransferNotFound(uint256 id);
    error InsufficientBalance();
    error AssetPairNotAllowed(address sourceAsset, address destAsset);

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

    /// @notice Deliver tokens to recipient. If insufficient balance, queue as pending.
    /// @param sourceAsset The source chain asset address (for validation)
    /// @param destAsset The destination asset address (encodes currency ID in last 4 bytes)
    /// @param amount The amount to transfer
    /// @param recipient The recipient as bytes32 (AccountId32)
    function transfer(address sourceAsset, address destAsset, uint256 amount, bytes32 recipient) external onlyAuthorizedBridge {
        if (!allowedAssetPairs[sourceAsset][destAsset]) revert AssetPairNotAllowed(sourceAsset, destAsset);

        if (IERC20(destAsset).balanceOf(address(this)) >= amount) {
            _executeTransfer(destAsset, amount, recipient);
            emit TransferExecuted(sourceAsset, destAsset, recipient, amount);
        } else {
            uint256 id = nextPendingId++;
            pendingTransfers[id] = PendingTransfer({sourceAsset: sourceAsset, destAsset: destAsset, amount: amount, recipient: recipient});
            emit TransferQueued(id, sourceAsset, destAsset, recipient, amount);
        }
    }

    /// @notice Fulfill a pending transfer once liquidity is available.
    function fulfillPending(uint256 id) external {
        PendingTransfer memory pt = pendingTransfers[id];
        if (pt.recipient == bytes32(0)) revert PendingTransferNotFound(id);
        if (IERC20(pt.destAsset).balanceOf(address(this)) < pt.amount) revert InsufficientBalance();

        delete pendingTransfers[id];

        _executeTransfer(pt.destAsset, pt.amount, pt.recipient);
        emit PendingTransferFulfilled(id, pt.sourceAsset, pt.destAsset, pt.recipient, pt.amount);
    }

    /// @notice Execute currencies.transfer via dispatch precompile
    function _executeTransfer(address asset, uint256 amount, bytes32 recipient) internal {
        bytes memory encodedCall = _encodeCurrenciesTransfer(asset, recipient, amount);
        (bool success,) = DISPATCH.call(encodedCall);
        if (!success) revert DispatchFailed();
    }

    /// @notice Encode a currencies.transfer extrinsic
    /// @dev Format: pallet_index + call_index + dest (MultiAddress::Id) + currency_id (u32 LE) + amount (Compact<u128>)
    function _encodeCurrenciesTransfer(address asset, bytes32 recipient, uint256 amount) internal pure returns (bytes memory) {
        // Currency ID is derived from the last 4 bytes of the asset address
        uint32 currencyId = uint32(uint160(asset));

        return abi.encodePacked(
            CURRENCIES_PALLET_INDEX,
            CURRENCIES_TRANSFER_INDEX,
            ScaleCodec.multiAddressId(recipient),   // dest: MultiAddress::Id(AccountId32)
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

    function setAllowedAssetPair(address sourceAsset, address destAsset, bool enabled) external onlyOwner {
        allowedAssetPairs[sourceAsset][destAsset] = enabled;
        emit AllowedAssetPairUpdated(sourceAsset, destAsset, enabled);
    }

    /// @notice Emergency withdrawal of ERC20 tokens
    function withdraw(address asset, uint256 amount, address to) external onlyOwner {
        if (!IERC20(asset).transfer(to, amount)) revert ERC20TransferFailed();
        emit Withdrawn(asset, amount, to);
    }
}
