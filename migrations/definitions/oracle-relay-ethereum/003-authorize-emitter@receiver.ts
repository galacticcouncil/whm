import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

const ETHEREUM_WORMHOLE_CHAIN_ID = 2;

const step: MigrationStep = {
  name: "003-authorize-emitter@receiver",
  description: "Register Ethereum OracleEmitter as authorized source on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["002-deploy-receiver"].proxyAddress;
    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      emitter: emitter as `0x${string}`,
      sourceChain: String(ETHEREUM_WORMHOLE_CHAIN_ID),
    });
  },
};

export default step;
