import type { MigrationStep } from "../../evm";
import { setAuthorizedEmitter } from "../../actions/message-receiver/setAuthorizedEmitter";

// Reads the Ethereum OracleEmitter proxy from the `oracle-emitter` migration's
// state. Defaults to the current env; override with EMITTER_ENV when the
// emitter was deployed under a different env name (prod: ETH env vs. moon env).
const step: MigrationStep = {
  name: "register-emitter",
  description: "Register Ethereum OracleEmitter as authorized emitter on dispatcher",
  action: async (ctx) => {
    const dispatcherAddress = ctx.outputs["deploy-dispatcher"].proxyAddress;
    const sourceChain = ctx.env.EMITTER_SOURCE_CHAIN;
    if (!sourceChain) throw new Error("Missing EMITTER_SOURCE_CHAIN");

    const emitterEnv = ctx.env.EMITTER_ENV;
    const emitterOutput = ctx.ref("oracle-emitter", "deploy", emitterEnv);
    const emitter = emitterOutput.proxyAddress as `0x${string}`;

    return await setAuthorizedEmitter({
      ...ctx.wallet,
      receiverAddress: dispatcherAddress as `0x${string}`,
      emitter,
      sourceChain,
    });
  },
};

export default step;
