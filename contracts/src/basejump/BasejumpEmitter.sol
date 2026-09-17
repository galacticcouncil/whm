// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IWormhole} from "wormhole-solidity-sdk/interfaces/IWormhole.sol";

import {HydrationConsts} from "../utils/hydration/HydrationConsts.sol";

import {IBasejumpEmitter} from "./interfaces/IBasejumpEmitter.sol";
import {IBasejumpPayload} from "./interfaces/IBasejumpPayload.sol";
import {INttManager} from "../ntt/interfaces/INttManager.sol";

/// @title BasejumpEmitter — source end of the direct EVM → Hydration corridor
/// @notice Funds move on two rails between exactly two chains:
///
///           SETTLEMENT  nttManagerFor[asset].transfer(gross, 73, landing)
///           FAST PATH   wormhole.publishMessage(net, consistency 200)
///
///         The settlement replenishes the pool the fast path pays out of; the difference between
///         the two legs is `assetFee`, which accrues in the landing.
///
/// @dev Deliberately inherits NO receiver: this contract has no `receiveMessage`, no
///      `authorizedEmitters` and no `processedVaas`. Hydration finalizes in seconds, so nothing
///      bridges *out* of Hydration through a pre-funded pool and the reverse direction has no
///      reason to exist. Keeping the two roles in separate contracts also keeps the source from
///      carrying four slots it would never read, and means no permissionless publish function can
///      ever reach this contract's Wormhole emitter address.
contract BasejumpEmitter is Initializable, UUPSUpgradeable, IBasejumpEmitter, IBasejumpPayload {
    using SafeERC20 for IERC20;

    uint16 public constant DEST_CHAIN_ID = HydrationConsts.WORMHOLE_CHAIN_ID;
    
    uint8 public constant CONSISTENCY_INSTANT = 200;

    IWormhole public wormhole;
    address public owner;
    uint32 public emitterNonce;

    /// @notice Fixed fee per source asset (e.g. 1e5 for 0.1 EURC), retained by the landing.
    mapping(address => uint256) public assetFee;

    /// @notice Landing pool on the destination chain — the settlement recipient.
    bytes32 public landing;

    /// @notice Source asset → the NTT manager that settles it.
    mapping(address => address) public nttManagerFor;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Init ────────────────────────────────────────────────────

    constructor() {
        _disableInitializers();
    }

    function initialize(address _wormhole) public initializer {
        wormhole = IWormhole(_wormhole);
        owner = msg.sender;
    }

    // ─── Core ────────────────────────────────────────────────────

    /// @inheritdoc IBasejumpEmitter
    function bridgeViaWormhole(
        address asset,
        uint256 amount,
        bytes32 recipient,
        bytes memory data
    ) external payable returns (uint64 transferSequence, uint64 messageSequence) {
        if (amount == 0) revert ZeroAmount();
        // Disarm switch: setLanding(0) reverts here, before any token is pulled.
        if (landing == bytes32(0)) revert LandingNotSet();

        address manager = nttManagerFor[asset];
        if (manager == address(0)) revert SettlementRouteNotSet(asset);

        // Balance delta, not `amount`: a fee-on-transfer asset settles and pays out what arrived.
        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        uint256 actualAmount = IERC20(asset).balanceOf(address(this)) - balanceBefore;
        if (actualAmount == 0) revert ZeroAmountReceived();

        // 1. Settlement — the gross amount, addressed to the landing on Hydration. Attempted BEFORE
        //    publication, and the 3-arg NTT overload hardcodes shouldQueue = false, so a paused rail
        //    or a rate-limit breach reverts the whole call rather than queueing behind a payout that
        //    has already been promised.
        (, uint256 deliveryPrice) = INttManager(manager).quoteDeliveryPrice(DEST_CHAIN_ID, hex"00");

        IERC20(asset).forceApprove(manager, actualAmount);
        transferSequence =
            INttManager(manager).transfer{value: deliveryPrice}(actualAmount, DEST_CHAIN_ID, landing);

        // 2. Fast path — the net amount, paid out of the pool this settlement replenishes. `data`
        //    rides along untouched for a contract recipient to act on (inbound intents).
        messageSequence = _fastTrack(asset, actualAmount, recipient, transferSequence, data);
    }

    /// @inheritdoc IBasejumpEmitter
    function quoteFee(address asset) public view returns (uint256 fee) {
        fee = assetFee[asset];
    }

    // ─── Internal ────────────────────────────────────────────────

    /// @dev Publish the payout instruction for `amount` minus the asset's fee.
    /// @param amount The gross amount settled on the NTT rail.
    /// @param transferSequence The settlement leg's sequence, carried for correlation.
    /// @param data Opaque bytes forwarded to the delivery, untouched.
    /// @return messageSequence The Wormhole core sequence of the published message.
    function _fastTrack(
        address sourceAsset,
        uint256 amount,
        bytes32 recipient,
        uint64 transferSequence,
        bytes memory data
    ) internal returns (uint64 messageSequence) {
        uint256 fee = quoteFee(sourceAsset);
        if (amount <= fee) revert AmountTooLowForFee(amount, fee);

        bytes memory payload = abi.encode(
            TransferPayload({
                sourceAsset: sourceAsset,
                amount: amount - fee,
                recipient: recipient,
                transferSequence: transferSequence,
                data: data
            })
        );

        messageSequence =
            wormhole.publishMessage{value: wormhole.messageFee()}(emitterNonce, payload, CONSISTENCY_INSTANT);
        emitterNonce++;

        emit BridgeInitiated(
            sourceAsset, amount, fee, DEST_CHAIN_ID, recipient, transferSequence, messageSequence
        );
    }

    // ─── Upgrade ─────────────────────────────────────────────────

    function _authorizeUpgrade(address) internal view override onlyOwner {}

    // ─── Admin ───────────────────────────────────────────────────

    function setOwner(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    function setLanding(bytes32 _landing) external onlyOwner {
        landing = _landing;
    }

    function setNttManager(address asset, address manager) external onlyOwner {
        nttManagerFor[asset] = manager;
    }

    function setAssetFee(address asset, uint256 fee) external onlyOwner {
        assetFee[asset] = fee;
    }
}
