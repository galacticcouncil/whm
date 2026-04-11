// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  ChainId,
  TokenBridgePayload
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {getPayloadWithFallback, createTransferQueue, TransferTask} from "./common";

const ETH_TOKEN_BRIDGE = "0x3ee18B2214AFF97000D974cf647E7C347E8fa585";

const eth = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC || 'https://eth.llamarpc.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, eth);
const tokenBridge = new Contract(
  ETH_TOKEN_BRIDGE,
  [
    'function completeTransfer(bytes memory encodedVm) external',
    'function completeTransferWithPayload(bytes memory encodedVm) external returns (bytes memory)',
  ],
  signer
);

(async function main() {
  const queue = createTransferQueue(eth, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Found VAA, completing transfer on Ethereum`);

    const feeData = await eth.getFeeData();
    const gasOverrides = {
      nonce,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: 1,
    };

    if (task.payloadType === TokenBridgePayload.TransferWithPayload) {
      await tokenBridge.callStatic.completeTransferWithPayload(task.vaa.bytes, {nonce});
      task.logger.info(`Completing transfer with payload`);
      const tx = await tokenBridge.completeTransferWithPayload(task.vaa.bytes, gasOverrides);
      await tx.wait();
      return tx.hash;
    } else {
      await tokenBridge.callStatic.completeTransfer(task.vaa.bytes, {nonce});
      task.logger.info(`Completing transfer`);
      const tx = await tokenBridge.completeTransfer(task.vaa.bytes, gasOverrides);
      await tx.wait();
      return tx.hash;
    }
  });

  const currentNonce = await queue.initNonce();
  logger.info(`Ethereum relayer starting`);
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || `eth-relayer`,
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: {host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379},
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_MOONBEAM as ChainId]: BigInt(process.env.MOONBEAM_FROM_SEQ || 95495),
        }
      }
    },
  );

  app.tokenBridge([CHAIN_ID_MOONBEAM],
    async (ctx, next) => {
      const {vaa, sourceTxHash} = ctx;
      const ctxLogger = ctx.logger.child({sourceTxHash});

      const payload = await getPayloadWithFallback(ctx, ctxLogger);

      if (!payload) {
        ctxLogger.info('No payload available from any source');
        return next();
      }
      ctxLogger.debug('payload', payload);

      const {payloadType, toChain} = payload;
      const to = payload.to.toString("hex");

      if (toChain === CHAIN_ID_ETH) {
        ctxLogger.info("Found message from Moonbeam to ETH:", {to, payloadType});

        if (payloadType === TokenBridgePayload.Transfer ||
            payloadType === TokenBridgePayload.TransferWithPayload) {
          queue.addToQueue({vaa, payloadType, logger: ctxLogger, next});
        } else {
          ctxLogger.info(`Unsupported payload type: ${payloadType}`);
          return next();
        }
      } else {
        ctxLogger.info(`Message not for Ethereum. ToChain: ${toChain}`);
        return next();
      }
    },
  );

  await app.listen();
})();
