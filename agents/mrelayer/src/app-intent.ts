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
  TokenBridgePayload,
} from "@certusone/wormhole-sdk";
import { Contract, ethers } from "ethers";

import logger from "./logger";
import { getPayloadWithFallback, createTransferQueue, TransferTask } from "./common";

// Ethereum TokenBridge — only used to resolve a foreign token's wrapped form for the fee asset.
const ETH_TOKEN_BRIDGE = "0x3ee18B2214AFF97000D974cf647E7C347E8fa585";

// IntentReceiver proxy on Ethereum (the payload-3 recipient; redeem() completes the transfer).
const INTENT_RECEIVER = (process.env.INTENT_RECEIVER || "").toLowerCase();

// quoter service that prices the relay fee (see agents/quoter).
const QUOTER_URL = process.env.QUOTER_URL || "http://localhost:8080";

// Re-quote + retry an unprofitable intent before dropping it — gas can fall within minutes, so a fee
// currently above the user's maxRelayFee may become payable shortly. Default: 3 attempts, 2 min apart.
const INTENT_MAX_ATTEMPTS = Number(process.env.INTENT_MAX_ATTEMPTS || 3);
const INTENT_RETRY_DELAY_MS = Number(process.env.INTENT_RETRY_DELAY_MS || 120_000);

const eth = new ethers.providers.JsonRpcProvider(process.env.ETH_RPC || "https://eth.llamarpc.com");
// Dedicated, reimbursed wallet — separate from the generic app-eth relayer (PRIVKEY).
const signer = new ethers.Wallet(process.env.INTENT_PRIVKEY, eth);

const intentReceiver = new Contract(
  INTENT_RECEIVER,
  ["function redeem(bytes vaa, uint256 feeRequested) external", "error AlreadyRedeemed()"],
  signer,
);
const tokenBridge = new Contract(
  ETH_TOKEN_BRIDGE,
  ["function wrappedAsset(uint16 tokenChain, bytes32 tokenAddress) view returns (address)"],
  eth,
);

// TokenBridge transfer (payload-3) byte layout in the VAA payload:
//   payloadID(1) amount(32) tokenAddress(32) tokenChain(2) to(32) toChain(2) from(32) | payload(rest)
const TOKEN_ADDR_OFFSET = 33;
const TOKEN_CHAIN_OFFSET = 65;
const PAYLOAD_OFFSET = 133;

/**
 * Decode an intent VAA's TokenBridge transfer payload.
 *
 * The arbitrary inner payload is `abi.encode(bytes32 intentId, address depositAddress,
 * uint256 maxRelayFee)`.
 *
 * @param vaaPayload Raw TokenBridge transfer bytes (the VAA payload, starting with the payloadID).
 * @returns The delivered token (address + origin chain) and the decoded intent fields.
 */
function decodeIntent(vaaPayload: Buffer) {
  const buf = Buffer.from(vaaPayload);
  const tokenAddress = buf.subarray(TOKEN_ADDR_OFFSET, TOKEN_ADDR_OFFSET + 32);
  const tokenChain = buf.readUInt16BE(TOKEN_CHAIN_OFFSET);
  const inner = buf.subarray(PAYLOAD_OFFSET);
  const [intentId, depositAddress, maxRelayFee] = ethers.utils.defaultAbiCoder.decode(
    ["bytes32", "address", "uint256"],
    inner,
  );
  return {
    tokenAddress,
    tokenChain,
    intentId,
    depositAddress,
    maxRelayFee: BigInt(maxRelayFee.toString()),
  };
}

/**
 * Resolve the ERC20 released on Ethereum for a bridged token: the canonical token when it's
 * home-chain, otherwise its Wormhole wrapped form.
 *
 * @param tokenAddress 32-byte Wormhole token address from the transfer.
 * @param tokenChain   Wormhole chain id of the token's origin.
 * @returns The ERC20 contract address on Ethereum.
 */
async function deliveredToken(tokenAddress: Buffer, tokenChain: number): Promise<string> {
  if (tokenChain === CHAIN_ID_ETH) {
    return ethers.utils.getAddress("0x" + Buffer.from(tokenAddress).subarray(12).toString("hex"));
  }
  return tokenBridge.wrappedAsset(tokenChain, "0x" + Buffer.from(tokenAddress).toString("hex"));
}

/**
 * Fetch the relay fee for redeeming on Ethereum from the quoter service.
 *
 * Requests `marginBps=0` — the relayer asks its real cost; the headroom buffer lives on the user's
 * `maxRelayFee` (sized by the UI), not on the relayer's ask, so the two don't double-count.
 *
 * @param feeAsset The delivered asset — `native` or an ERC20 address — the fee is paid in.
 * @returns The fee to pass as `feeRequested`, in the asset's smallest unit.
 */
async function quoteRelayFee(feeAsset: string): Promise<bigint> {
  const res = await fetch(`${QUOTER_URL}/relay-fee?chain=ethereum&feeAsset=${feeAsset}&marginBps=0`);
  if (!res.ok) throw new Error(`quoter ${res.status}: ${await res.text()}`);
  const { feeRequested } = await res.json();
  return BigInt(feeRequested);
}

(async function main() {
  const queue = createTransferQueue(eth, signer, async (task: TransferTask, nonce: number) => {
    task.logger.info(`Redeeming intent VAA (feeRequested ${task.feeRequested})`);
    const feeData = await eth.getFeeData();
    const overrides = { nonce, maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: 1 };

    await intentReceiver.callStatic.redeem(task.vaa.bytes, task.feeRequested, { nonce });
    const tx = await intentReceiver.redeem(task.vaa.bytes, task.feeRequested, overrides);
    await tx.wait();
    return tx.hash;
  });

  const currentNonce = await queue.initNonce();
  logger.info(`Intent relayer starting`);
  logger.info(`account ${signer.address}`);
  logger.info(`nonce ${currentNonce}`);
  logger.info(`IntentReceiver ${INTENT_RECEIVER}`);
  logger.info(`Quoter ${QUOTER_URL}`);

  const app = new StandardRelayerApp<StandardRelayerContext>(Environment.MAINNET, {
    name: process.env.INTENT_APP_NAME || `intent-relayer`,
    logger,
    spyEndpoint: process.env.SPY_ENDPOINT || "localhost:7073",
    redis: {
      host: process.env.REDIS_HOST || "localhost",
      port: Number(process.env.REDIS_PORT) || 6379,
    },
    missedVaaOptions: {
      startingSequenceConfig: {
        [CHAIN_ID_MOONBEAM as ChainId]: BigInt(process.env.MOONBEAM_FROM_SEQ || 0),
      },
    },
  });

  app.tokenBridge([CHAIN_ID_MOONBEAM], async (ctx, next) => {
    const { vaa, sourceTxHash } = ctx;
    const ctxLogger = ctx.logger.child({ sourceTxHash });

    const payload = await getPayloadWithFallback(ctx, ctxLogger);
    if (!payload) return next();

    const { payloadType, toChain } = payload;

    const to = "0x" + payload.to.toString("hex").slice(-40);

    // Only payload-3 transfers to Ethereum addressed to our IntentReceiver.
    if (
      toChain !== CHAIN_ID_ETH ||
      payloadType !== TokenBridgePayload.TransferWithPayload ||
      to.toLowerCase() !== INTENT_RECEIVER
    ) {
      return next();
    }

    try {
      const { tokenAddress, tokenChain, intentId, depositAddress, maxRelayFee } = decodeIntent(
        vaa.payload,
      );
      const feeAsset = await deliveredToken(tokenAddress, tokenChain);

      // Re-quote and queue once the fee is within the user's maxRelayFee. If still unprofitable,
      // retry up to INTENT_MAX_ATTEMPTS (spaced INTENT_RETRY_DELAY_MS apart) before dropping it —
      // gas may fall in the meantime. Retries run out-of-band so the engine's queue isn't blocked.
      const attempt = async (n: number) => {
        let feeRequested: bigint;
        try {
          feeRequested = await quoteRelayFee(feeAsset);
        } catch (e) {
          ctxLogger.error(`quote failed (attempt ${n}/${INTENT_MAX_ATTEMPTS}): ${e.message || e}`);
          feeRequested = maxRelayFee + 1n; // treat as unprofitable → retry/skip
        }

        if (feeRequested <= maxRelayFee) {
          ctxLogger.info(
            `Intent → ${depositAddress}: feeRequested ${feeRequested} ≤ maxRelayFee ${maxRelayFee} (attempt ${n})`,
          );
          queue.addToQueue({
            vaa,
            type: "intent",
            feeRequested: feeRequested.toString(),
            logger: ctxLogger,
            next,
          });
          return;
        }

        if (n >= INTENT_MAX_ATTEMPTS) {
          ctxLogger.info(
            `Skip after ${n} attempts: feeRequested ${feeRequested} > maxRelayFee ${maxRelayFee}`,
          );
          return next();
        }

        ctxLogger.info(
          `Unprofitable (attempt ${n}/${INTENT_MAX_ATTEMPTS}): ${feeRequested} > ${maxRelayFee}; retry in ${INTENT_RETRY_DELAY_MS}ms`,
        );
        setTimeout(() => {
          attempt(n + 1).catch((e) =>
            ctxLogger.error(`intent retry ${n + 1} failed: ${e.message || e}`),
          );
        }, INTENT_RETRY_DELAY_MS);
      };

      await attempt(1);
    } catch (e) {
      ctxLogger.error(`intent decode/quote failed: ${e.message || e}`);
      return next();
    }
  });

  await app.listen();
})();
