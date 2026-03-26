import type { MigrationStep } from "../../types";
import { setAuthorizedEmitter } from "../../actions/receiver/setAuthorizedEmitter";

/**
 * Register the Solana emitter as an authorized source on the dispatcher.
 * (MessageDispatcher inherits from MessageReceiver.)
 */
const step: MigrationStep = {
  name: "register-emitter",
  description: "Register authorized Wormhole emitter on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;
    const emitter = ctx.env.EMITTER_ADDRESS;
    const sourceChain = ctx.env.EMITTER_SOURCE_CHAIN;
    if (!emitter) throw new Error("Missing EMITTER_ADDRESS");
    if (!sourceChain) throw new Error("Missing EMITTER_SOURCE_CHAIN");

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      receiverAddress: dispatcherAddress as `0x${string}`,
      emitter: emitter as `0x${string}`,
      sourceChain,
    });
  },
};

export default step;
