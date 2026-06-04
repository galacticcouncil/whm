import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

const ETHEREUM_WORMHOLE_CHAIN_ID = 2;

const step: MigrationStep = {
  name: "005-authorize-emitter@dispatcher",
  description: "Register Ethereum OracleEmitter as authorized source on OracleDispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["002-deploy-dispatcher"].proxyAddress;
    const emitter = ctx.outputs["001-deploy-emitter"].proxyAddress;

    return await setAuthorizedEmitter({
      ...ctx.wallet.moonbeam,
      receiverAddress: dispatcherAddress as `0x${string}`,
      emitter: emitter as `0x${string}`,
      sourceChain: String(ETHEREUM_WORMHOLE_CHAIN_ID),
    });
  },
};

export default step;
