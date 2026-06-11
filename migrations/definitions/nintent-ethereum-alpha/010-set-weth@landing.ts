import type { MigrationStep } from "./types";
import { setDestNative } from "../../actions/basejump-landing-native/setDestNative";
import { setWrappedNative } from "../../actions/basejump-landing-native/setWrappedNative";

const step: MigrationStep = {
  name: "011-set-weth@landing",
  description:
    "Configure WETH → native-ETH delivery: map source → NATIVE, set Ethereum WETH as the wrapped-native to unwrap",
  action: async (ctx) => {
    const basejumpLandingAddress = ctx.outputs["003-deploy-landing"].proxyAddress as `0x${string}`;
    const sourceAsset = ctx.env.WETH_SOURCE_ASSET;
    const wrappedNative = ctx.env.WETH_DEST_ASSET;

    if (!sourceAsset || !wrappedNative) {
      console.log("  ⚠️  No WETH config (WETH_SOURCE_ASSET / WETH_DEST_ASSET), skipping");
      return {};
    }

    // 1. Moonbeam-WETH source → native ETH payout.
    const dest = await setDestNative({
      ...ctx.wallet.ethereum,
      basejumpLandingAddress,
      sourceAsset: sourceAsset as `0x${string}`,
    });

    // 2. Ethereum WETH = the wrapped-native the landing unwraps for native payouts.
    const wrapped = await setWrappedNative({
      ...ctx.wallet.ethereum,
      basejumpLandingAddress,
      wrappedNative: wrappedNative as `0x${string}`,
    });

    const out: Record<string, string> = {
      setDestNativeTx: dest.txHash,
      setWrappedNativeTx: wrapped.txHash,
      sourceAsset,
      wrappedNative,
    };
    return out;
  },
};

export default step;
