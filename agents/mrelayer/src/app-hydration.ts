// @ts-nocheck
import {
  Environment,
  StandardRelayerApp,
  StandardRelayerContext,
} from "@wormhole-foundation/relayer-engine";
import {
  CHAIN_ID_BASE,
  CHAIN_ID_ETH,
  CHAIN_ID_SOLANA,
  CHAIN_ID_SUI,
  ChainId,
} from "@certusone/wormhole-sdk";
import { Contract, ethers } from "ethers";

import logger from "./logger";

const HYDRATION_EVM_CHAIN_ID = 222222;
const NTT_WORMHOLE_PAYLOAD_PREFIX = "9945ff10";

type NttRoute = {
  token: string;
  sourceChain: ChainId;
  sourceEmitter: string;
  hydrationManager: string;
  hydrationTransceiver: string;
};

// Mainnet routes from native-token-transfers/ops/tokens/*/deployment.json.
// Solana routes use the NTT program address; relayer-engine derives the
// Wormhole emitter PDA before subscribing to the Spy stream.
const NTT_ROUTES: NttRoute[] = [
  {
    token: "DAI",
    sourceChain: CHAIN_ID_ETH,
    sourceEmitter: "0x99673a01C5779Ebf59399B4B228c1825c0113571",
    hydrationManager: "0xcFd576F88C90844AEBF45378Fd09931281D8b14d",
    hydrationTransceiver: "0xe8660CA48f6f4D98BC48DB7Dd07C1a8E555801eA",
  },
  {
    token: "WBTC",
    sourceChain: CHAIN_ID_ETH,
    sourceEmitter: "0x3FE8fBB8505c8dB2264f6Ebc5559c7C2b2647218",
    hydrationManager: "0x6BFca089916c045b0Ca4A09B655aF9F926189993",
    hydrationTransceiver: "0x9a8a1ab288f6749Ce5626DEE1B5d59441BdC187F",
  },
  {
    token: "WETH",
    sourceChain: CHAIN_ID_ETH,
    sourceEmitter: "0xbA0Cd32131b8206AF4feB79A1A3aaF0AEfe18b48",
    hydrationManager: "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7",
    hydrationTransceiver: "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae",
  },
  {
    token: "USDC",
    sourceChain: CHAIN_ID_ETH,
    sourceEmitter: "0xA108BD5dBc6CE665aEbB6895351e0609c76F8EFc",
    hydrationManager: "0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC",
    hydrationTransceiver: "0x0d7488B39AA64468a709eC3b3d354DeFE539eD97",
  },
  {
    token: "USDT",
    sourceChain: CHAIN_ID_ETH,
    sourceEmitter: "0x45c566f6595CF93e639E77cc1bbE57A8D27901c2",
    hydrationManager: "0x5E6C488103b47F804824AE15861638af4C436795",
    hydrationTransceiver: "0xd2a16B736F32Df7C0DE72838837656FE0f85Ac0F",
  },
  {
    token: "sUSDS",
    sourceChain: CHAIN_ID_ETH,
    sourceEmitter: "0x7C236d237BEbBE1b7902131B31b7b3270005a810",
    hydrationManager: "0x1973E7044d9A7C7bB2d6ea1693A296a9e4B7E448",
    hydrationTransceiver: "0x68Ecadd7934D4FcFEABAfB209C95D379B96400cb",
  },
  {
    token: "EURC",
    sourceChain: CHAIN_ID_BASE,
    sourceEmitter: "0xa84b362290b0CFdB55e877dfc633284091e0B3F7",
    hydrationManager: "0x8dd1286A29dF5a2785FB638d6fB1598144Cfbc4C",
    hydrationTransceiver: "0x2e84fac378D67Dc2e11026fB4919E80263a87375",
  },
  {
    token: "SOL",
    sourceChain: CHAIN_ID_SOLANA,
    sourceEmitter: "DiGxk55uAQNVzzg2FucPgdrQ4azb5SDvWQvzpzJD3o7J",
    hydrationManager: "0x9e200C0f28D92D296b201D96C8269d3CAFFfA9FF",
    hydrationTransceiver: "0x2F04AcF249091425d51e67EeA3C3161ccE283202",
  },
  {
    token: "jitoSOL",
    sourceChain: CHAIN_ID_SOLANA,
    sourceEmitter: "9HFvXujdkXubvmf93gyzkH1g3VPowDrmp85sWsfdcBTh",
    hydrationManager: "0xcE73C15B9ED02413066DE5B904A36F8e8f9B5331",
    hydrationTransceiver: "0xF38D9C3bA6999Dc331b32B416083Fd7e02D17B04",
  },
  {
    token: "PRIME",
    sourceChain: CHAIN_ID_SOLANA,
    sourceEmitter: "4T5m5NtRVewiCVzP2mnfeUoMYRqncfkrS21X2dhVCNRT",
    hydrationManager: "0xFCaF4aA069C565d25539028970703F01e47D3E0B",
    hydrationTransceiver: "0x4e7b1E55D2354d4Dc6ABD876096Dc201de0541D1",
  },
  {
    token: "SUI",
    sourceChain: CHAIN_ID_SUI,
    // Sui VAAs use the EmitterCap id stored in the deployment manifest.
    sourceEmitter:
      "0x6afb4a6a9c4e5b6eeed568381ce95a79590f0c17ab8d0c59295826f2775bf832",
    hydrationManager: "0x978443f00cAB6b09445140321EC73a221ebFF5F8",
    hydrationTransceiver: "0xA224D6f4e0E276b34D91bfE6c3A5fE6838322AF7",
  },
];

type RedeemTask = {
  route: NttRoute;
  vaa: any;
  logger: any;
};

const TRANSCEIVER_ABI = [
  "function receiveMessage(bytes encodedMessage) external",
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
];

function errorText(error: any): string {
  const fields = [
    error?.errorName,
    error?.reason,
    error?.message,
    error?.error?.errorName,
    error?.error?.reason,
    error?.error?.message,
  ].filter(Boolean);

  try {
    fields.push(JSON.stringify(error));
  } catch (_) {
    fields.push(String(error));
  }

  return fields.join(" ").toLowerCase();
}

function isAlreadyRedeemed(error: any): boolean {
  const text = errorText(error);
  return (
    text.includes("transferalreadycompleted") ||
    text.includes("transfer already completed") ||
    text.includes("already been redeemed") ||
    text.includes("vaa already processed")
  );
}

function isNonceTooLow(error: any): boolean {
  return errorText(error).includes("nonce too low");
}

function isNttTransferVaa(vaa: any): boolean {
  return (
    Buffer.from(vaa.payload).subarray(0, 4).toString("hex") ===
    NTT_WORMHOLE_PAYLOAD_PREFIX
  );
}

function isForHydrationManager(vaa: any, route: NttRoute): boolean {
  // TransceiverMessage wire format: prefix (4), source manager (32),
  // recipient manager (32), then the variable-length manager payload.
  const recipientManager = Buffer.from(vaa.payload)
    .subarray(36, 68)
    .toString("hex");
  const expectedManager = ethers.utils
    .hexZeroPad(route.hydrationManager, 32)
    .slice(2)
    .toLowerCase();

  return recipientManager === expectedManager;
}

function createRedeemQueue(
  provider: ethers.providers.JsonRpcProvider,
  signer: ethers.Wallet
) {
  let currentNonce: number;
  let queueTail: Promise<void> = Promise.resolve();

  const contracts = new Map(
    NTT_ROUTES.map((route) => [
      route.hydrationTransceiver.toLowerCase(),
      new Contract(route.hydrationTransceiver, TRANSCEIVER_ABI, signer),
    ])
  );

  async function initNonce() {
    currentNonce = await provider.getTransactionCount(
      signer.address,
      "pending"
    );
    return currentNonce;
  }

  async function redeem(task: RedeemTask, nonceRetry = false): Promise<void> {
    const transceiver = contracts.get(
      task.route.hydrationTransceiver.toLowerCase()
    );
    if (!transceiver) {
      throw new Error(
        `No Hydration transceiver configured for ${task.route.token}`
      );
    }

    try {
      task.logger.info(`Submitting ${task.route.token} NTT VAA to Hydration`);
      await transceiver.callStatic.receiveMessage(task.vaa.bytes, {
        nonce: currentNonce,
      });

      const tx = await transceiver.receiveMessage(task.vaa.bytes, {
        nonce: currentNonce,
      });
      task.logger.info(
        `Submitted ${task.route.token} redemption in ${tx.hash}`
      );
      await tx.wait();

      currentNonce += 1;
      task.logger.info(
        `Completed ${task.route.token} redemption in ${tx.hash}`
      );
    } catch (error) {
      if (isAlreadyRedeemed(error)) {
        task.logger.info(`${task.route.token} transfer already completed`);
        return;
      }

      if (!nonceRetry && isNonceTooLow(error)) {
        task.logger.info("Nonce too low, reloading pending nonce");
        currentNonce = await provider.getTransactionCount(
          signer.address,
          "pending"
        );
        return redeem(task, true);
      }

      throw error;
    }
  }

  function add(task: RedeemTask): Promise<void> {
    const result = queueTail.then(() => redeem(task));
    // Keep later transfers moving even when this workflow is handed back to
    // the relayer engine for retry.
    queueTail = result.catch(() => undefined);
    return result;
  }

  return { initNonce, add };
}

(async function main() {
  if (!process.env.PRIVKEY) {
    throw new Error("PRIVKEY is required");
  }

  const hydration = new ethers.providers.JsonRpcProvider(
    process.env.HYDRATION_RPC || "https://hydration-rpc.n.dwellir.com"
  );
  const signer = new ethers.Wallet(process.env.PRIVKEY, hydration);

  const network = await hydration.getNetwork();
  if (network.chainId !== HYDRATION_EVM_CHAIN_ID) {
    throw new Error(
      `HYDRATION_RPC returned chain ${network.chainId}; expected ${HYDRATION_EVM_CHAIN_ID}`
    );
  }

  const queue = createRedeemQueue(hydration, signer);
  const currentNonce = await queue.initNonce();

  logger.info("Hydration NTT relayer starting");
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);
  logger.info(`watching ${NTT_ROUTES.length} NTT routes`);

  const app = new StandardRelayerApp<StandardRelayerContext>(
    Environment.MAINNET,
    {
      name: process.env.APP_NAME || "hydration-ntt-relayer",
      logger,
      spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
      redis: {
        host: process.env.REDIS_HOST || "localhost",
        port: Number(process.env.REDIS_PORT) || 6379,
      },
      missedVaaOptions: {
        startingSequenceConfig: {
          [CHAIN_ID_ETH as ChainId]: BigInt(process.env.NTT_ETH_FROM_SEQ || 0),
          [CHAIN_ID_BASE as ChainId]: BigInt(
            process.env.NTT_BASE_FROM_SEQ || 0
          ),
          [CHAIN_ID_SOLANA as ChainId]: BigInt(
            process.env.NTT_SOLANA_FROM_SEQ || 0
          ),
          [CHAIN_ID_SUI as ChainId]: BigInt(process.env.NTT_SUI_FROM_SEQ || 0),
        },
      },
    }
  );

  for (const route of NTT_ROUTES) {
    app
      .chain(route.sourceChain)
      .address(route.sourceEmitter, async (ctx, next) => {
        const { vaa, sourceTxHash } = ctx;
        const ctxLogger = ctx.logger.child({
          token: route.token,
          sourceTxHash,
          emitterChain: vaa.emitterChain,
          sequence: vaa.sequence.toString(),
        });

        // The same emitter publishes setup/peer broadcasts. Only standard NTT
        // transfer payloads are accepted by receiveMessage.
        if (!isNttTransferVaa(vaa)) {
          ctxLogger.info("Ignoring non-transfer NTT transceiver message");
          return next();
        }

        if (!isForHydrationManager(vaa, route)) {
          ctxLogger.info(
            "Ignoring NTT transfer for another destination manager"
          );
          return next();
        }

        try {
          await queue.add({ route, vaa, logger: ctxLogger });
          return next();
        } catch (error) {
          ctxLogger.error(error?.error || error?.message || error);
          throw error;
        }
      });
  }

  await app.listen();
})();
