import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

const SOLANA_WORMHOLE_CHAIN_ID = 1;

const step: MigrationStep = {
  name: "003-authorize-emitter@receiver",
  description: "Register Solana oracle-emitter as authorized source on OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["002-deploy-receiver"].proxyAddress;
    const emitter = ctx.outputs["001-deploy-emitter"].emitterBytes32;
    if (!emitter) throw new Error("Missing emitterBytes32 from 001-deploy-emitter");

    return await setAuthorizedEmitter({
      ...ctx.wallet.hydration,
      receiverAddress: receiverAddress as `0x${string}`,
      emitter: emitter as `0x${string}`,
      sourceChain: String(SOLANA_WORMHOLE_CHAIN_ID),
    });
  },
};

export default step;
