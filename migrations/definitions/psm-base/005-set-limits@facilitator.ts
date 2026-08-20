import type { MigrationStep } from "./types";
import { setLimits } from "../../actions/psm/setFacilitatorConfig";

const step: MigrationStep = {
  name: "005-set-limits@facilitator",
  description: "Set inbound (mint) and outbound (redeem) rate limits on the facilitator",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    const facilitator = ctx.outputs["001-deploy-facilitator"].proxyAddress;

    return await setLimits({
      ...ctx.wallet.hydration,
      contract: facilitator as `0x${string}`,
      inboundCapacity: BigInt(required("INBOUND_CAPACITY")),
      outboundCapacity: BigInt(required("OUTBOUND_CAPACITY")),
      window: BigInt(required("LIMIT_WINDOW")),
    });
  },
};

export default step;
