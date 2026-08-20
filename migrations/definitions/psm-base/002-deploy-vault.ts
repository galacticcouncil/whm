import type { MigrationStep } from "./types";
import { deployVault } from "../../actions/psm/deployVault";

const step: MigrationStep = {
  name: "002-deploy-vault",
  description: "Deploy HollarBaseVault UUPS proxy on Base (deposits paused, oracle gate set)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deployVault({
      ...ctx.wallet.base,
      wormholeCore: required("WORMHOLE_CORE_BASE") as `0x${string}`,
      usdc: required("USDC_BASE") as `0x${string}`,
      aUsdc: required("AUSDC_BASE") as `0x${string}`,
      addressesProvider: required("AAVE_ADDRESSES_PROVIDER_BASE") as `0x${string}`,
      hydrationChainId: Number(required("WORMHOLE_ID_HYDRATION")),
      // Refused at init if zero — the mint gate never ships unconfigured.
      minUsdcPrice: BigInt(required("MIN_USDC_PRICE")),
      admin: ctx.wallet.base.account.address,
      guardian: required("VAULT_GUARDIAN") as `0x${string}`,
      treasurer: required("VAULT_TREASURER") as `0x${string}`,
    });
  },
};

export default step;
