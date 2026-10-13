import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

const HYDRATION_WORMHOLE_CHAIN_ID = 73;

const step: MigrationStep = {
  name: "004-authorize-emitter@receiver",
  description: "Register Hydration OracleEmitter as authorized source on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["003-deploy-receiver"].proxyAddress;
    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet.robinhood,
      receiverAddress: receiverAddress as `0x${string}`,
      emitter: emitter as `0x${string}`,
      sourceChain: String(HYDRATION_WORMHOLE_CHAIN_ID),
    });
  },
};

export default step;
