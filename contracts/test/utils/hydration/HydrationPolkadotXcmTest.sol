// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {Test, console2} from "forge-std/Test.sol";
import {XcmV4} from "../../../src/utils/XcmV4.sol";
import {HydrationPolkadotXcm} from "../../../src/utils/hydration/HydrationPolkadotXcm.sol";
import {HydrationUtility} from "../../../src/utils/hydration/HydrationUtility.sol";
import {MoonbeamEthereumXcm} from "../../../src/utils/moonbeam/MoonbeamEthereumXcm.sol";

/// @notice Byte-level checks for the polkadotXcm / utility encoders that assemble the MRL batch.
///         Run with `forge test --mc HydrationPolkadotXcmTest -vv` to print the full batch_all
///         calldata and diff it against your SDK/papi JSON (the example pasted in review).
contract HydrationPolkadotXcmTest is Test {
    // Values mirrored from the reference SDK JSON.
    uint32 constant MOONBEAM = 2004;
    address constant MDA = 0x5DAC9319aAf8a18cF60Ad5b94f8daB3232ac9FfC;
    address constant WETH_ERC20 = 0xab3f0245B83feB11d15AAffeFD7AD465a59817eD;
    address constant BASEJUMP_PROXY = 0xB1731c586ca89a23809861c6103F0b96B3F57D92;

    // GLMR as seen from Hydration: { parents:1, X2(Parachain(2004), PalletInstance(10)) }
    bytes constant GLMR_REMOTE = hex"010200511f040a";
    // GLMR local to Moonbeam: { parents:0, X1(PalletInstance(10)) }
    bytes constant GLMR_LOCAL = hex"0001040a";
    // WETH from Hydration: { parents:1, X3(Parachain(2004), PalletInstance(110), AccountKey20(WETH)) }
    bytes WETH_LOCATION = abi.encodePacked(hex"010300511f046e0300", bytes20(WETH_ERC20));

    // utility.batch_all([c1, c2]) → 0d(utility 13) 02 08(compact 2) ++ c1 ++ c2
    function test_batchAll_framing() public pure {
        bytes memory c1 = hex"aabb";
        bytes memory c2 = hex"ccddee";
        assertEq(HydrationUtility.batchAll(c1, c2), hex"0d0208" hex"aabb" hex"ccddee");
    }

    // ─── Full calldata (copy-paste & diff against SDK) ───────────

    function test_log_transferAssets() public view {
        bytes memory call = HydrationPolkadotXcm.encodeTransferAssets(
            HydrationPolkadotXcm.TransferParams({
                destParaId: MOONBEAM,
                feeLocation: GLMR_REMOTE,
                feeAmount: 1 ether, // 1 GLMR
                assetLocation: WETH_LOCATION,
                assetAmount: 1e15, // example WETH amount
                beneficiary: XcmV4.accountKey20(MDA)
            })
        );
        console2.log("transfer_assets_using_type_and_then:");
        console2.logBytes(call);
    }

    function test_log_sendTransact() public pure {
        bytes memory transactCall = MoonbeamEthereumXcm.transact(5_000_000, BASEJUMP_PROXY, hex"00");
        bytes memory call = HydrationPolkadotXcm.encodeSendTransact(
            HydrationPolkadotXcm.SendTransactParams({
                destParaId: MOONBEAM,
                feeLocation: GLMR_LOCAL,
                feeAmount: 0.9 ether, // 0.9 GLMR
                refTime: 125_059_217_000,
                proofSize: 625_000,
                transactCall: transactCall,
                beneficiary: XcmV4.accountKey20(MDA)
            })
        );
        console2.log("polkadotXcm.send (transact leg):");
        console2.logBytes(call);
    }

    function test_log_batchAll() public view {
        bytes memory transferCall = HydrationPolkadotXcm.encodeTransferAssets(
            HydrationPolkadotXcm.TransferParams({
                destParaId: MOONBEAM,
                feeLocation: GLMR_REMOTE,
                feeAmount: 1 ether,
                assetLocation: WETH_LOCATION,
                assetAmount: 1e15,
                beneficiary: XcmV4.accountKey20(MDA)
            })
        );
        bytes memory sendCall = HydrationPolkadotXcm.encodeSendTransact(
            HydrationPolkadotXcm.SendTransactParams({
                destParaId: MOONBEAM,
                feeLocation: GLMR_LOCAL,
                feeAmount: 0.9 ether,
                refTime: 125_059_217_000,
                proofSize: 625_000,
                transactCall: MoonbeamEthereumXcm.transact(5_000_000, BASEJUMP_PROXY, hex"00"),
                beneficiary: XcmV4.accountKey20(MDA)
            })
        );
        console2.log("utility.batch_all([transfer, send]):");
        console2.logBytes(HydrationUtility.batchAll(transferCall, sendCall));
    }
}
