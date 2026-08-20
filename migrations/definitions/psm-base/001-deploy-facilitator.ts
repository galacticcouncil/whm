import type { MigrationStep } from "./types";
import { deployFacilitator } from "../../actions/psm/deployFacilitator";

const step: MigrationStep = {
  name: "001-deploy-facilitator",
  description: "Deploy HollarBaseFacilitator UUPS proxy on Hydration (ships paused)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deployFacilitator({
      ...ctx.wallet.hydration,
      wormholeCore: required("WORMHOLE_CORE_HYDRATION") as `0x${string}`,
      hollar: required("HOLLAR_HYDRATION") as `0x${string}`,
      usdcDecimals: Number(required("USDC_DECIMALS")),
      baseChainId: Number(required("WORMHOLE_ID_BASE")),
      // Admin is the deployer for now; steps 003 and 005 need it, and 010 hands it over.
      admin: ctx.wallet.hydration.account.address,
      guardian: required("FACILITATOR_GUARDIAN") as `0x${string}`,
    });
  },
};

export default step;
