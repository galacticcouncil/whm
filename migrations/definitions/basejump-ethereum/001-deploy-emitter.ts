import type { MigrationStep } from "./types";
import { deploy } from "../../actions/basejump-emitter/deploy";

const step: MigrationStep = {
  name: "001-deploy-emitter",
  description: "Deploy BasejumpEmitter UUPS proxy on Ethereum",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };

    return await deploy({
      ...ctx.wallet.ethereum,
      wormholeId: Number(required("WORMHOLE_ID_ETHEREUM")),
      wormholeCore: required("WORMHOLE_CORE_ETHEREUM") as `0x${string}`,
      // Instant (200), as deployed: deliberately not an env value, so no env edit can move the
      // live Ethereum corridor, or an implementation built for it, off 200.
      consistencyLevel: 200,
    });
  },
};

export default step;
