// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_ACALA,
  CHAIN_ID_BASE,
  CHAIN_ID_ETH,
  CHAIN_ID_MOONBEAM,
  CHAIN_ID_SOLANA,
  CHAIN_ID_SUI,
  ChainId,
  TokenBridgePayload
} from "@certusone/wormhole-sdk";
import logger from "./logger";
import {Contract, ethers} from "ethers";
import {getPayloadWithFallback, createTransferQueue, TransferTask} from "./common";

const MRL_ADDRESS = "0000000000000000000000000000000000000000000000000000000000000816";

// Basejump on Base (emits fast-path Wormhole messages)
const BASEJUMP_BASE = "0xf5b9334e44f800382cb47fc19669401d694e529b";

// BasejumpProxy on Moonbeam (receives fast-path VAAs, dispatches via XCM to Hydration)
const BASEJUMP_MOONBEAM = "0xf5b9334e44f800382cb47fc19669401d694e529b";

// Basejump on Ethereum (emits fast-path Wormhole messages)
const BASEJUMP_ETH = "0xba3eadd48274d9ff08c685e1206100e04833f94f";

// BasejumpProxy on Moonbeam for the Ethereum corridor (receives fast-path VAAs)
const BASEJUMP_ETH_MOONBEAM = "0xbe999b97a5217e9814c69688bad7e248d3b6f50a";

// Solana oracle emitter program ID (base58 — SDK derives the emitter PDA internally)
const SOLANA_ORACLE_EMITTER = "8j68bb2BLUSgEW6rdF3LnkxZFGieokLfJMBVd8bjATiz";

// OracleDispatcher proxy on Moonbeam (oracle relay)
const DISPATCHER_PROXY = "0x32d53dc510a4cdbb4634207e0e1e64b552a1c24c";

// Ethereum-source oracle: emitter on Ethereum (Wormhole chain 2) + its own Moonbeam dispatcher
const ETH_ORACLE_EMITTER = "0xbf937cb0abd3d179a15d77492eb3c13b455c2d62";
const ETH_DISPATCHER_PROXY = "0x3513cee1ecc972604d2ac8ee50d3eefb1a69eeb3";

const moonbeam = new ethers.providers.JsonRpcProvider(process.env.MOONBEAM_RPC || 'https://moonbeam-rpc.n.dwellir.com');
const signer = new ethers.Wallet(process.env.PRIVKEY, moonbeam);
const gmp = new Contract('0x0000000000000000000000000000000000000816', ['function wormholeTransferERC20(bytes) external'], signer);
const basejumpProxy = new Contract(
  BASEJUMP_MOONBEAM,
  ['function completeTransfer(bytes memory vaa) external'],
  signer
);
const basejumpProxyEth = new Contract(
  BASEJUMP_ETH_MOONBEAM,
  ['function completeTransfer(bytes memory vaa) external'],
  signer
);
const dispatcher = new Contract(
  DISPATCHER_PROXY,
  ['function receiveMessage(bytes memory vaa) external'],
  signer
);
const ethDispatcher = new Contract(
  ETH_DISPATCHER_PROXY,
  ['function receiveMessage(bytes memory vaa) external'],
  signer
);

(async function main() {
  const queue = createTransferQueue(moonbeam, signer, async (task: TransferTask, nonce: number) => {
    if (task.type === 'oracle') {
      task.logger.info(`Submitting oracle VAA to dispatcher`);
      await dispatcher.callStatic.receiveMessage(task.vaa.bytes, {nonce});
      task.logger.info(`Completing oracle relay`);
      const tx = await dispatcher.receiveMessage(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    } else if (task.type === 'oracle-eth') {
      task.logger.info(`Submitting Ethereum oracle VAA to dispatcher`);
      await ethDispatcher.callStatic.receiveMessage(task.vaa.bytes, {nonce});
      task.logger.info(`Completing Ethereum oracle relay`);
      const tx = await ethDispatcher.receiveMessage(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    } else if (task.type === 'insta') {
      task.logger.info(`Found instant VAA, completing transfer on Moonbeam`);
      await basejumpProxy.callStatic.completeTransfer(task.vaa.bytes, {nonce});
      task.logger.info(`Completing insta transfer`);
      const tx = await basejumpProxy.completeTransfer(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    } else if (task.type === 'insta-eth') {
      task.logger.info(`Found instant VAA, completing transfer on Moonbeam (eth corridor)`);
      await basejumpProxyEth.callStatic.completeTransfer(task.vaa.bytes, {nonce});
      task.logger.info(`Completing insta transfer (eth)`);
      const tx = await basejumpProxyEth.completeTransfer(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    } else {
      task.logger.info(`Found VAA`);
      await gmp.callStatic.wormholeTransferERC20(task.vaa.bytes, {nonce});
      task.logger.info(`Completing transfer`);
      const tx = await gmp.wormholeTransferERC20(task.vaa.bytes, {nonce});
      await tx.wait();
      return tx.hash;
    }
  });

  const currentNonce = await queue.initNonce();
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);
  logger.info(`Watching Basejump on Base: ${BASEJUMP_BASE}`);
  logger.info(`Submitting to BasejumpProxy on Moonbeam: ${BASEJUMP_MOONBEAM}`);
  logger.info(`Watching Basejump on Ethereum: ${BASEJUMP_ETH}`);
  logger.info(`Submitting to BasejumpProxy (eth) on Moonbeam: ${BASEJUMP_ETH_MOONBEAM}`);
  logger.info(`Watching Solana oracle emitter: ${SOLANA_ORACLE_EMITTER}`);
  logger.info(`Submitting to Dispatcher on Moonbeam: ${DISPATCHER_PROXY}`);
  logger.info(`Watching Ethereum oracle emitter: ${ETH_ORACLE_EMITTER}`);
  logger.info(`Submitting to ETH Dispatcher on Moonbeam: ${ETH_DISPATCHER_PROXY}`);

  const spyEndpoint = process.env.SPY_ENDPOINT || "localhost:7073";
  const redis = {host: process.env.REDIS_HOST || "localhost", port: Number(process.env.REDIS_PORT) || 6379};

  // MRL relayer app
  const mrlApp = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || `mrelayer11`,
      logger,
      spyEndpoint,
      redis,
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_ACALA as ChainId]: BigInt(process.env.ACA_FROM_SEQ || 3358),
          [CHAIN_ID_BASE as ChainId]: BigInt(process.env.BASE_FROM_SEQ || 244981),
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.ETH_FROM_SEQ || 499562),
          [CHAIN_ID_SOLANA as ChainId]: BigInt(process.env.SOLANA_FROM_SEQ || 1211243),
          [CHAIN_ID_SUI as ChainId]: BigInt(process.env.SUI_FROM_SEQ || 217370),
        }
      }
    },
  );

  mrlApp.tokenBridge([CHAIN_ID_ACALA, CHAIN_ID_BASE, CHAIN_ID_ETH, CHAIN_ID_SOLANA, CHAIN_ID_SUI],
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

      if (payloadType === TokenBridgePayload.TransferWithPayload
          && toChain === CHAIN_ID_MOONBEAM) {
        ctxLogger.info("Found message to MOONBEAM:", {to});

        if (to === MRL_ADDRESS) {
          queue.addToQueue({vaa, type: 'mrl', logger: ctxLogger, next});
        } else {
          ctxLogger.info(`Message not for MRL address. Target: ${to}, Expected: ${MRL_ADDRESS}`);
          return next();
        }
      } else {
        ctxLogger.info(`Message not for processing. PayloadType: ${payloadType}, ToChain: ${toChain}`);
        return next();
      }
    },
  );

  // Basejump relayer app
  const basejumpApp = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.BASEJUMP_APP_NAME || `basejump-relayer`,
      logger,
      spyEndpoint,
      redis,
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_BASE as ChainId]: BigInt(process.env.BASEJUMP_BASE_FROM_SEQ || 0),
        }
      }
    },
  );

  basejumpApp.chain(CHAIN_ID_BASE as ChainId).address(
    BASEJUMP_BASE,
    async (ctx, next) => {
      const {vaa} = ctx;
      const ctxLogger = logger.child({
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });

      ctxLogger.info(`Received fast-path message from Basejump on Base`);

      queue.addToQueue({vaa, type: 'insta', logger: ctxLogger, next});
    },
  );

  // Basejump (Ethereum) relayer app
  const basejumpEthApp = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.BASEJUMP_ETH_APP_NAME || `basejump-eth-relayer`,
      logger,
      spyEndpoint,
      redis,
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.BASEJUMP_ETH_FROM_SEQ || 0),
        }
      }
    },
  );

  basejumpEthApp.chain(CHAIN_ID_ETH as ChainId).address(
    BASEJUMP_ETH,
    async (ctx, next) => {
      const {vaa} = ctx;
      const ctxLogger = logger.child({
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });

      ctxLogger.info(`Received fast-path message from Basejump on Ethereum`);

      queue.addToQueue({vaa, type: 'insta-eth', logger: ctxLogger, next});
    },
  );

  // Oracle relay app
  const oracleApp = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.ORACLE_APP_NAME || `oracle-relayer`,
      logger,
      spyEndpoint,
      redis,
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_SOLANA as ChainId]: BigInt(process.env.ORACLE_SOLANA_FROM_SEQ || 0),
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.ORACLE_ETH_FROM_SEQ || 0),
        }
      }
    },
  );

  oracleApp.chain(CHAIN_ID_SOLANA as ChainId).address(
    SOLANA_ORACLE_EMITTER,
    async (ctx, next) => {
      const {vaa} = ctx;
      const ctxLogger = logger.child({
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });

      ctxLogger.info(`Received oracle message from Solana`);
      queue.addToQueue({vaa, type: 'oracle', logger: ctxLogger, next});
    },
  );

  oracleApp.chain(CHAIN_ID_ETH as ChainId).address(
    ETH_ORACLE_EMITTER,
    async (ctx, next) => {
      const {vaa} = ctx;
      const ctxLogger = logger.child({
        emitterChain: vaa.emitterChain,
        sequence: vaa.sequence.toString(),
      });

      ctxLogger.info(`Received oracle message from Ethereum`);
      queue.addToQueue({vaa, type: 'oracle-eth', logger: ctxLogger, next});
    },
  );

  await Promise.all([mrlApp.listen(), basejumpApp.listen(), basejumpEthApp.listen(), oracleApp.listen()]);
})();
