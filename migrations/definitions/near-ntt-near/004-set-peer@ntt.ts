import { pad } from "viem";

import type { MigrationStep } from "./types";
import { setPeer } from "../../actions/near-ntt/setPeer";

const step: MigrationStep = {
  name: "004-set-peer@ntt",
  description: "Peer the NTT contract with the Hydration manager + transceiver",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await setPeer({
      ...ctx.wallet.near,
      nttAccount: ctx.outputs["001-deploy-ntt"].nttAccount,
      chainId: Number(required("WORMHOLE_ID_HYDRATION")),
      manager: pad(required("HYDRATION_NTT_MANAGER") as `0x${string}`, { size: 32 }),
      // The Hydration transceiver's address is its Wormhole emitter.
      transceiver: pad(required("HYDRATION_NTT_TRANSCEIVER") as `0x${string}`, { size: 32 }),
      decimals: Number(required("HYDRATION_TOKEN_DECIMALS")),
      inboundLimit: required("NEAR_INBOUND_LIMIT"),
    });
  },
};

export default step;
