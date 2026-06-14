// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ITokenBridge} from "wormhole-solidity-sdk/interfaces/ITokenBridge.sol";

import {IIntentReceiver} from "./interfaces/IIntentReceiver.sol";

/// @dev Minimal canonical wrapped-native interface (WETH9 pattern — WETH, WGLMR, WMATIC, …).
interface IWETH {
    function withdraw(uint256 amount) external;
}

/// @title IntentReceiver — Ethereum redeemer for the direct TokenBridge (payload-3) intent path
/// @notice Replaces the Basejump fast-path + landing pool for the Moonbeam→Ethereum direction:
///         Moonbeam finalizes in ~seconds, so fronting liquidity from a pre-funded pool to beat
///         slow source finality buys nothing here. Instead the source bridges WETH straight through
///         the Wormhole TokenBridge with a payload (`transferTokensWithPayload`); a relayer calls
///         `redeem(vaa)` on this contract, which pulls the released WETH, unwraps it to native ETH,
///         and forwards the exact redeemed amount to the OneClick `depositAddress` from the payload.
///
///         Holds no liquidity in the happy path. Redemption is permissionless — the payload, not the
///         caller, dictates the destination, and the TokenBridge restricts `completeTransferWithPayload`
///         to the encoded recipient (this contract) and marks the VAA consumed (replay-safe). If the
///         forward fails the whole call reverts, leaving the VAA redeemable for retry; `sweep` exists
///         for operator recovery of stray funds.
///
///         The unwrap path is taken only when the delivered token equals the configured
///         `wrappedNative`; any other token is forwarded as the delivered ERC20, so a token-identity
///         mismatch degrades to an ERC20 forward instead of bricking. The relay-cost fee, if charged,
///         belongs here on the destination side (native in, native out — no FX), deducted from
///         `amount` before the forward; left out for now.
contract IntentReceiver is Initializable, UUPSUpgradeable, IIntentReceiver {
    using SafeERC20 for IERC20;

    /// @notice Sentinel `asset` value for native ETH in `sweep`.
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address public owner;
    ITokenBridge public tokenBridge;

    /// @notice Wrapped-native token (e.g. WETH) unwrapped to native ETH on delivery. A delivered
    ///         token equal to this is unwrapped to native; any other delivered token is forwarded as-is.
    address public wrappedNative;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    function _onlyOwner() internal view {
        if (msg.sender != owner) revert NotOwner();
    }

    constructor() {
        _disableInitializers();
    }

    function initialize(address _tokenBridge, address _wrappedNative) public initializer {
        owner = msg.sender;
        tokenBridge = ITokenBridge(_tokenBridge);
        wrappedNative = _wrappedNative;
    }

    /// @notice Accept native ETH produced by `IWETH.withdraw`.
    receive() external payable {}

    // ─── Core ────────────────────────────────────────────────────

    function redeem(bytes calldata vaa) external {
        // 1. Redeem — TokenBridge releases the token to this contract and returns the transfer body.
        ITokenBridge.TransferWithPayload memory t =
            tokenBridge.parseTransferWithPayload(tokenBridge.completeTransferWithPayload(vaa));

        // The ERC20 actually released on this chain (canonical token if home-chain, else wrapped form).
        address delivered = t.tokenChain == tokenBridge.chainId()
            ? _bytes32ToAddress(t.tokenAddress)
            : tokenBridge.wrappedAsset(t.tokenChain, t.tokenAddress);

        // This contract holds no liquidity between redeems (forwards 100%, reverts on failure), so its
        // balance of the delivered token IS what this VAA just released.
        uint256 amount = IERC20(delivered).balanceOf(address(this));
        if (amount == 0) revert NothingDelivered();

        if (t.payload.length != 64) revert MalformedPayload();
        (bytes32 intentId, address depositAddress) = abi.decode(t.payload, (bytes32, address));
        if (depositAddress == address(0)) revert MalformedPayload();

        // If the delivered token is the wrapped-native, unwrap it and pay native ETH; otherwise
        // forward the ERC20 as-is.
        address asset;
        if (delivered == wrappedNative) {
            IWETH(wrappedNative).withdraw(amount);
            _sendNative(depositAddress, amount);
            asset = NATIVE;
        } else {
            IERC20(delivered).safeTransfer(depositAddress, amount);
            asset = delivered;
        }

        emit IntentForwarded(intentId, asset, depositAddress, amount);
    }

    // ─── Helpers ─────────────────────────────────────────────────

    function _bytes32ToAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setWrappedNative(address _wrappedNative) external onlyOwner {
        emit WrappedNativeUpdated(wrappedNative, _wrappedNative);
        wrappedNative = _wrappedNative;
    }

    /// @notice Emergency withdrawal of ERC20 tokens (or native ETH when `asset == NATIVE`).
    function sweep(address asset, address to, uint256 amount) external onlyOwner {
        if (asset == NATIVE) {
            _sendNative(to, amount);
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
        emit Swept(asset, to, amount);
    }
}
