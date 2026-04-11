// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_BASE,
  CHAIN_ID_MOONBEAM,
  ChainId,
  TokenBridgePayload
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {getPayloadWithFallback, createTransferQueue, TransferTask} from "./common";

const BASE_TOKEN_BRIDGE = "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627";

const base = new ethers.providers.JsonRpcProvider(process.env.BASE_RPC || 'https://mainnet.base.org');
const signer = new ethers.Wallet(process.env.PRIVKEY, base);
const tokenBridge = new Contract(
  BASE_TOKEN_BRIDGE,
  [
    'function completeTransfer(bytes memory encodedVm) external',
    'function completeTransferWithPayload(bytes memory encodedVm) external returns (bytes memory)',
  ],
  signer
);

(async function main() {
  const queue = createTransferQueue(base, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Found VAA, completing transfer on Base`);

    if (task.payloadType === TokenBridgePayload.TransferWithPayload) {
      await tokenBridge.callStatic.completeTransferWithPayload(task.vaa.bytes, {nonce});
      task.logger.info(`Completing transfer with payload`);
      const tx = await tokenBridge.completeTransferWithPayload(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    } else {
      await tokenBridge.callStatic.completeTransfer(task.vaa.bytes, {nonce});
      task.logger.info(`Completing transfer`);
      const tx = await tokenBridge.completeTransfer(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    }
  });

  const currentNonce = await queue.initNonce();
  logger.info(`Base relayer starting`);
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || `base-relayer`,
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: {host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379},
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_MOONBEAM as ChainId]: BigInt(process.env.MOONBEAM_FROM_SEQ || 0),
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

      if (toChain === CHAIN_ID_BASE) {
        ctxLogger.info("Found message from Moonbeam to BASE:", {to, payloadType});

        if (payloadType === TokenBridgePayload.Transfer ||
            payloadType === TokenBridgePayload.TransferWithPayload) {
          queue.addToQueue({vaa, payloadType, logger: ctxLogger, next});
        } else {
          ctxLogger.info(`Unsupported payload type: ${payloadType}`);
          return next();
        }
      } else {
        ctxLogger.info(`Message not for Base. ToChain: ${toChain}`);
        return next();
      }
    },
  );

  await app.listen();
})();
