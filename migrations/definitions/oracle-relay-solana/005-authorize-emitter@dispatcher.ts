import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

const SOLANA_WORMHOLE_CHAIN_ID = 1;

const step: MigrationStep = {
  name: "005-authorize-emitter@dispatcher",
  description: "Register Solana oracle-emitter as authorized source on OracleDispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["002-deploy-dispatcher"].proxyAddress;
    const emitter = ctx.outputs["001-deploy-emitter"].emitterBytes32;
    if (!emitter) throw new Error("Missing emitterBytes32 from 001-deploy-emitter");

    return await setAuthorizedEmitter({
      ...ctx.wallet.moonbeam,
      receiverAddress: dispatcherAddress as `0x${string}`,
      emitter: emitter as `0x${string}`,
      sourceChain: String(SOLANA_WORMHOLE_CHAIN_ID),
    });
  },
};

export default step;
