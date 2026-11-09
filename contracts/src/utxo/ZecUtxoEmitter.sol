// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {INttManager} from "../ntt/interfaces/INttManager.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";
import {HydrationRouter} from "../utils/hydration/HydrationRouter.sol";

import {IZecUtxoEmitter} from "./interfaces/IZecUtxoEmitter.sol";

/// @title ZecUtxoEmitter — Hydration → Zcash entry point
/// @notice `send` settles ZEC over NTT to the NEAR account derived from a Zcash address and emits the
///         address beside it; `refuel` turns the kept fees into NEAR for the bot that finishes each
///         withdrawal on NEAR. See docs/near-utxo/withdraw/spec.md.
///
/// @dev Holds nothing between calls except the fee ZEC waiting for a swap, and NEAR below the rail's
///      precision.
contract ZecUtxoEmitter is Initializable, UUPSUpgradeable, IZecUtxoEmitter {
    using SafeERC20 for IERC20;

    /// @notice Wormhole chain id of NEAR — the hub of both routes.
    uint16 public constant NEAR_WORMHOLE_ID = 15;

    /// @notice The Zcash connector's `min_withdraw_amount`, zatoshi — what must arrive on NEAR.
    uint256 public constant MIN_WITHDRAW = 100_000;

    /// @notice NTT trims to 8 decimals; NEAR has 24. The remainder accrues as sweepable dust.
    uint256 public constant TRIM_UNIT = 1e16;

    /// @notice Zcash mainnet transparent address versions: t1 (P2PKH) and t3 (P2SH).
    bytes2 internal constant ZCASH_P2PKH = 0x1cb8;
    bytes2 internal constant ZCASH_P2SH = 0x1cbd;

    address public owner;

    /// @notice NTT manager (ZEC) on Hydration — settles to the derived account.
    address public zecNttManager;

    /// @notice NTT manager (NEAR) on Hydration — carries swapped fees to the bot.
    address public nearNttManager;

    /// @notice ZEC kept per `send`, zatoshi.
    uint256 public fee;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @inheritdoc IZecUtxoEmitter
    function send(uint256 amount, bytes22 zcashAddress, bytes32 nearAccount) external returns (uint64 sequence) {
        if (zecNttManager == address(0)) revert NotConfigured();
        // The leading two bytes are the address version; truncation is the point.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes2 version = bytes2(zcashAddress);
        if (version != ZCASH_P2PKH && version != ZCASH_P2SH) revert InvalidZcashAddress();
        if (nearAccount == bytes32(0)) revert InvalidNearAccount();
        if (amount < fee + MIN_WITHDRAW) revert AmountBelowMinimum(amount, fee + MIN_WITHDRAW);

        uint256 net = amount - fee;

        IERC20(INttManager(zecNttManager).token()).safeTransferFrom(msg.sender, address(this), amount);

        // The NEAR NTT contract names an account by `sha256(account_id)`
        // An implicit account's id is its key in lowercase hex.
        sequence = _bridge(zecNttManager, net, sha256(bytes(_hex(nearAccount))));

        emit WithdrawRequested(sequence, nearAccount, msg.sender, net, fee, abi.encodePacked(zcashAddress));
    }

    /// @inheritdoc IZecUtxoEmitter
    function refuel(uint256 zecIn, uint256 minNearOut, string calldata account)
        external
        onlyOwner
        returns (uint64 sequence)
    {
        if (zecNttManager == address(0) || nearNttManager == address(0)) revert NotConfigured();
        if (bytes(account).length == 0) revert InvalidNearAccount();
        if (zecIn == 0) revert ZeroAmount();

        address zecToken = INttManager(zecNttManager).token();
        IERC20 nearToken = IERC20(INttManager(nearNttManager).token());

        _dispatch(
            HydrationRouter.encodeSell(
                HydrationConsts.toAssetId(zecToken), HydrationConsts.toAssetId(address(nearToken)), zecIn, minNearOut
            )
        );

        uint256 nearOut = nearToken.balanceOf(address(this));
        nearOut -= nearOut % TRIM_UNIT;
        if (nearOut == 0) revert AmountBelowTrimUnit(nearOut, TRIM_UNIT);

        sequence = _bridge(nearNttManager, nearOut, sha256(bytes(account)));

        emit Refueled(sequence, zecIn, nearOut, account);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    /// @dev Settle `amount` of the manager's token to `recipient` on NEAR.
    function _bridge(address manager, uint256 amount, bytes32 recipient) internal returns (uint64 sequence) {
        (, uint256 deliveryPrice) = INttManager(manager).quoteDeliveryPrice(NEAR_WORMHOLE_ID, hex"00");

        IERC20(INttManager(manager).token()).forceApprove(manager, amount);

        // Paused rail or a rate-limit reverts rather than queueing a settlement.
        sequence = INttManager(manager).transfer{value: deliveryPrice}(amount, NEAR_WORMHOLE_ID, recipient);
    }

    function _dispatch(bytes memory call) internal {
        (bool success,) = HydrationConsts.DISPATCH_PRECOMPILE.call(call);
        if (!success) revert DispatchFailed();
    }

    /// @dev 32 bytes → 64 lowercase hex characters, no prefix: a NEAR implicit account id.
    function _hex(bytes32 value) internal pure returns (string memory) {
        bytes16 digits = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            out[2 * i] = digits[uint8(value[i]) >> 4];
            out[2 * i + 1] = digits[uint8(value[i]) & 0x0f];
        }
        return string(out);
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Point settlement at the ZEC NTT manager.
    function setZecNttManager(address manager) external onlyOwner {
        zecNttManager = manager;
    }

    /// @notice Point fee swaps at the NEAR NTT manager.
    function setNearNttManager(address manager) external onlyOwner {
        nearNttManager = manager;
    }

    /// @notice ZEC kept per `send`, zatoshi.
    function setFee(uint256 newFee) external onlyOwner {
        fee = newFee;
        emit FeeSet(newFee);
    }

    /// @notice Recover quantization dust, or any asset sent here by mistake.
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        IERC20(asset).safeTransfer(to, amount);
        emit Swept(asset, to, amount);
    }
}
