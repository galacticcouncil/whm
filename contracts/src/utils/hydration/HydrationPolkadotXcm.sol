// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {ScaleCodec} from "../ScaleCodec.sol";
import {XcmV4} from "../XcmV4.sol";

/// @title HydrationPolkadotXcm — encoders for "polkadotXcm" pallet.
library HydrationPolkadotXcm {
    uint8 internal constant PALLET = 107;

    uint8 internal constant SEND = 0; // polkadotXcm.send
    uint8 internal constant TRANSFER_ASSETS_TYPE = 13; // polkadotXcm.transfer_assets_using_type_and_then

    /// @param destParaId    destination parachain id
    /// @param feeLocation   location of the fee asset
    /// @param feeAmount     fee asset amount to transfer (pays dest arrival fee)
    /// @param assetLocation location of the transfer asset
    /// @param assetAmount   transfer asset amount
    /// @param beneficiary   location the custom xcm deposits everything to
    struct TransferParams {
        uint32 destParaId;
        bytes feeLocation;
        uint256 feeAmount;
        bytes assetLocation;
        uint256 assetAmount;
        bytes beneficiary;
    }

    /// @param destParaId   destination parachain id
    /// @param feeLocation  location of the local fee asset on dest
    /// @param feeAmount    fee asset amount for WithdrawAsset/BuyExecution
    /// @param refTime      transact require_weight_at_most.ref_time
    /// @param proofSize    transact require_weight_at_most.proof_size
    /// @param transactCall the SCALE-encoded dest runtime call to transact
    /// @param beneficiary  location to deposit leftovers to
    struct SendTransactParams {
        uint32 destParaId;
        bytes feeLocation;
        uint256 feeAmount;
        uint64 refTime;
        uint64 proofSize;
        bytes transactCall;
        bytes beneficiary;
    }

    /// @dev transfer_assets_using_type_and_then — reserve-transfer [fee, asset] to the dest,
    ///      depositing both (AllCounted(2)) to `beneficiary`. fee pays the arrival fee.
    function encodeTransferAssets(TransferParams memory p) internal pure returns (bytes memory) {
        bytes memory customXcm =
            abi.encodePacked(XcmV4.VERSION, ScaleCodec.compactU32(1), XcmV4.depositAllCounted(2, p.beneficiary));

        bytes memory assets = abi.encodePacked(
            XcmV4.VERSION,
            ScaleCodec.compactU32(2),
            XcmV4.fungible(p.feeLocation, p.feeAmount),
            XcmV4.fungible(p.assetLocation, p.assetAmount)
        );

        return abi.encodePacked(
            PALLET,
            TRANSFER_ASSETS_TYPE,
            XcmV4.versionedParachain(p.destParaId), // dest
            assets,
            XcmV4.TRANSFER_TYPE_DEST_RESERVE, // assets_transfer_type
            XcmV4.VERSION, // remote_fees_id: VersionedAssetId = V4 + fee Location
            p.feeLocation,
            XcmV4.TRANSFER_TYPE_DEST_RESERVE, // fees_transfer_type
            customXcm, // custom_xcm_on_dest
            uint8(0x00) // weight_limit: Unlimited
        );
    }

    /// @dev send(dest, message) with message =
    ///      [ WithdrawAsset(fee), BuyExecution(fee), Transact(call), RefundSurplus, DepositAsset(→ beneficiary) ]
    function encodeSendTransact(SendTransactParams memory p) internal pure returns (bytes memory) {
        bytes memory fee = XcmV4.fungible(p.feeLocation, p.feeAmount);

        bytes memory withdrawBuy = abi.encodePacked(
            XcmV4.I_WITHDRAW_ASSET, ScaleCodec.compactU32(1), fee, XcmV4.I_BUY_EXECUTION, fee, uint8(0x00)
        );

        bytes memory transact = abi.encodePacked(
            XcmV4.I_TRANSACT,
            XcmV4.ORIGIN_KIND_SOVEREIGN,
            ScaleCodec.compactU128(uint128(p.refTime)),
            ScaleCodec.compactU128(uint128(p.proofSize)),
            ScaleCodec.encodeVecU8(p.transactCall)
        );

        bytes memory message = abi.encodePacked(
            XcmV4.VERSION,
            ScaleCodec.compactU32(5),
            withdrawBuy,
            transact,
            XcmV4.I_REFUND_SURPLUS,
            XcmV4.depositAllCounted(1, p.beneficiary)
        );

        return abi.encodePacked(PALLET, SEND, XcmV4.versionedParachain(p.destParaId), message);
    }
}
