// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IBasejumpLandingNative} from "./interfaces/IBasejumpLandingNative.sol";
import {IBasejumpReceiver} from "./interfaces/IBasejumpReceiver.sol";

interface IWETH {
    function withdraw(uint256 amount) external;
}

/// @title BasejumpLandingNative — Instant token delivery for cross-chain bridges on EVM chains
/// @notice Pre-funded pool. Authorized bridges call transfer() with the *source-chain* `sourceAsset`
///         address (the only address the source contract knows when it emits). This landing maps it
///         to the payout asset on THIS chain via `destAssetFor` — mirroring the Hydration
///         BasejumpLanding, because the bridge layer cannot know the destination asset id up front.
///         The destination asset is either an ERC20 (delivered via transfer) or the `NATIVE`
///         sentinel (delivered as the chain's native currency / ETH).
///
///         If the pool is short on liquidity at delivery time, the transfer is queued and can be
///         fulfilled by anyone later via `fulfillPending` once the slow TokenBridge path
///         replenishes the pool (~13 min).
///
///         When the Basejump payload carries non-empty `data`, the recipient is treated as a
///         contract implementing IBasejumpReceiver and `onBasejumpReceive` is invoked atomically
///         with delivery — either immediately (sufficient liquidity) or at the moment
///         `fulfillPending` drains the queued entry. The callback receives the resolved
///         destination asset (the ERC20 actually paid out, or `NATIVE` for ETH). Quote-side TTL +
///         OneClick's refund-to-`refundTo` mechanism handles the case where the queue drains after
///         the receiver's intent expires.
contract BasejumpLandingNative is Initializable, UUPSUpgradeable, IBasejumpLandingNative {
    using SafeERC20 for IERC20;

    /// @notice Sentinel `destAsset` value meaning "pay out the chain's native currency (ETH)".
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address public owner;
    mapping(address => bool) public authorizedBridges;
    mapping(address => address) public destAssetFor;

    struct PendingTransfer {
        address sourceAsset;
        uint256 amount;
        bytes32 recipient;
        bytes data;
    }

    uint256 public pendingHead;
    uint256 public pendingTail;
    mapping(uint256 => PendingTransfer) public pendingTransfers;

    /// @notice Wrapped-native token (e.g. WETH) unwrapped to satisfy NATIVE payouts. Required
    ///         because the NATIVE sentinel isn't a real token address — this is what `withdraw()`
    ///         is called on. Unset → NATIVE payouts use the native balance directly.
    address public wrappedNative;

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

    /// @notice Accept native ETH for pool funding / replenishment.
    receive() external payable {}

    // ─── Core ────────────────────────────────────────────────────

    function transfer(address sourceAsset, uint256 amount, bytes32 recipient, bytes memory data)
        external
        onlyAuthorizedBridge
    {
        address destAsset = destAssetFor[sourceAsset];
        if (destAsset == address(0)) revert AssetNotConfigured(sourceAsset);

        address recipientAddr = address(uint160(uint256(recipient)));

        // Validate receiver shape upfront — applies whether we deliver now or queue.
        // (Code presence can only grow over time post-Cancun, so a contract recipient at
        // queue time is still a contract at drain time.)
        if (data.length > 0 && recipientAddr.code.length == 0) {
            revert ReceiverNotContract(recipientAddr);
        }

        if (_balance(destAsset) >= amount) {
            _deliver(sourceAsset, destAsset, amount, recipient, data);
        } else {
            uint256 id = pendingTail++;
            pendingTransfers[id] =
                PendingTransfer({sourceAsset: sourceAsset, amount: amount, recipient: recipient, data: data});
            emit TransferQueued(id, sourceAsset, destAsset, recipient, amount);
        }
    }

    function fulfillPending() external {
        if (pendingHead >= pendingTail) revert NoPendingTransfers();

        uint256 id = pendingHead;
        PendingTransfer memory pt = pendingTransfers[id];
        address destAsset = destAssetFor[pt.sourceAsset];
        if (_balance(destAsset) < pt.amount) revert InsufficientBalance();

        pendingHead++;
        delete pendingTransfers[id];

        _deliver(pt.sourceAsset, destAsset, pt.amount, pt.recipient, pt.data);
        emit PendingTransferFulfilled(id, pt.sourceAsset, destAsset, pt.recipient, pt.amount);
    }

    function isNative(address sourceAsset) external view returns (bool) {
        return destAssetFor[sourceAsset] == NATIVE;
    }

    /// @notice True when NATIVE payouts unwrap the configured wrapped-native; false → pure native reserve.
    function unwrapEnabled() public view returns (bool) {
        return wrappedNative != address(0);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _deliver(address sourceAsset, address destAsset, uint256 amount, bytes32 recipient, bytes memory data)
        internal
    {
        address recipientAddr = address(uint160(uint256(recipient)));

        // NATIVE → pay native ETH from the native balance; if it's short, unwrap the WHOLE WETH
        // reserve to ETH (the pool self-converts to ETH on the first short delivery).
        // Any other destAsset is delivered as that ERC20 as-is (e.g. USDC → USDC).
        if (destAsset == NATIVE) {
            if (unwrapEnabled() && address(this).balance < amount) {
                uint256 wrappedBal = IERC20(wrappedNative).balanceOf(address(this));
                IWETH(wrappedNative).withdraw(wrappedBal); // all wrapped-native → native ETH
            }
            _sendNative(recipientAddr, amount);
        } else {
            IERC20(destAsset).safeTransfer(recipientAddr, amount);
        }

        emit TransferExecuted(sourceAsset, destAsset, recipient, amount);

        if (data.length > 0) {
            IBasejumpReceiver(recipientAddr).onBasejumpReceive(destAsset, amount, data);
        }
    }

    function _balance(address destAsset) internal view returns (uint256) {
        if (destAsset == NATIVE) {
            // native + wrapped-native form one ETH-equivalent reserve (unwrapped on a short delivery)
            uint256 wrappedBal = unwrapEnabled() ? IERC20(wrappedNative).balanceOf(address(this)) : 0;
            return address(this).balance + wrappedBal;
        }
        return IERC20(destAsset).balanceOf(address(this));
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override {
        _onlyOwner();
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setAuthorizedBridge(address bridge, bool enabled) external onlyOwner {
        authorizedBridges[bridge] = enabled;
    }

    /// @notice Map a source asset to its payout asset on this chain — an ERC20, or the `NATIVE`
    ///         sentinel for native ETH. `setDestNative` is a convenience for the native case.
    function setDestAsset(address sourceAsset, address destAsset) external onlyOwner {
        destAssetFor[sourceAsset] = destAsset;
        emit DestAssetUpdated(sourceAsset, destAsset);
    }

    /// @notice Map a source asset to native-ETH payout on this chain (alias for setDestAsset(_, NATIVE)).
    function setDestNative(address sourceAsset) external onlyOwner {
        destAssetFor[sourceAsset] = NATIVE;
        emit DestAssetUpdated(sourceAsset, NATIVE);
    }

    /// @notice Set the wrapped-native token that backs NATIVE payouts via unwrap.
    ///         Set to address(0) to disable unwrap (native-out then uses only the native balance).
    function setWrappedNative(address _wrappedNative) external onlyOwner {
        emit WrappedNativeUpdated(wrappedNative, _wrappedNative);
        wrappedNative = _wrappedNative;
    }

    /// @notice Emergency withdrawal of ERC20 tokens (or native ETH when `asset == NATIVE`).
    function withdraw(address asset, uint256 amount, address to) external onlyOwner {
        if (asset == NATIVE) {
            _sendNative(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
        emit Withdrawn(asset, amount, to);
    }
}
