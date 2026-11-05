import type { MigrationStep } from "./types";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

const ETHEREUM_WORMHOLE_CHAIN_ID = 2;

const step: MigrationStep = {
  name: "013-authorize-emitter@receiver-apyusd",
  description: "Register Ethereum OracleEmitter as authorized source on the apyUSD OracleReceiver",
  action: async (ctx) => {
    const receiverAddress = ctx.outputs["012-deploy-receiver-apyusd"].proxyAddress;
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
