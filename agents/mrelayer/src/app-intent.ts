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
// currently above the user's maxRelayFee may become payable shortly. Retries are driven by the
// relayer engine's own Redis-backed delayed queue (exponential backoff), not an in-process timer, so
// they survive restarts and don't hold worker slots. The engine's default strategy is
// `min(2^attemptsMade * baseDelayMs, maxDelayMs)`, so baseDelayMs=60_000 yields 2, 4, 8, 16, 32, 64
// min between attempts. INTENT_RETRIES caps the attempt count, but the terminal condition is the VAA
// age check below — we stop bothering once a VAA is older than INTENT_MAX_VAA_AGE_MS (default 1h),
// since by then gas is unlikely to recover meaningfully and the OneClick quote has expired.
const INTENT_RETRIES = Number(process.env.INTENT_RETRIES || 8);
const INTENT_RETRY_BASE_MS = Number(process.env.INTENT_RETRY_BASE_MS || 60_000);
const INTENT_RETRY_MAX_MS = Number(process.env.INTENT_RETRY_MAX_MS || 70 * 60_000);
const INTENT_MAX_VAA_AGE_MS = Number(process.env.INTENT_MAX_VAA_AGE_MS || 60 * 60_000);

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
    // Total attempts per VAA. A handler that throws (unprofitable / quoter down) is rescheduled with
    // exponential backoff (see retryBackoffOptions). The VAA age cap in the handler is the real
    // terminator; this is just a hard ceiling so a permanently-stuck VAA eventually stops.
    workflows: { retries: INTENT_RETRIES },
    // Backoff between retries: min(2^attemptsMade * baseDelayMs, maxDelayMs) → 2, 4, 8, 16, 32, 64 min.
    retryBackoffOptions: {
      baseDelayMs: INTENT_RETRY_BASE_MS,
      maxDelayMs: INTENT_RETRY_MAX_MS,
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

    // Decode failures are permanent (malformed payload), so drop the VAA rather than retry it.
    let decoded;
    try {
      decoded = decodeIntent(vaa.payload);
    } catch (e) {
      ctxLogger.error(`intent decode failed, dropping: ${e.message || e}`);
      return next();
    }
    const { tokenAddress, tokenChain, intentId, depositAddress, maxRelayFee } = decoded;

    // Terminal condition: stop retrying once the VAA is older than the cap — gas is unlikely to
    // recover meaningfully past this point and the OneClick quote has expired. Ack (return, don't
    // throw) so the engine marks the job complete instead of scheduling another backoff retry.
    const ageMs = Date.now() - vaa.timestamp * 1000;
    if (ageMs > INTENT_MAX_VAA_AGE_MS) {
      ctxLogger.info(
        `Drop stale intent ${intentId}: VAA age ${Math.round(ageMs / 60_000)}m > ` +
          `${Math.round(INTENT_MAX_VAA_AGE_MS / 60_000)}m`,
      );
      return next();
    }

    const attempt = ctx.storage?.job?.attempts ?? 0;

    // Re-quote on every delivery. deliveredToken / quoteRelayFee hit external services, so transient
    // failures throw → the engine reschedules with exponential backoff (same as unprofitable).
    const feeAsset = await deliveredToken(tokenAddress, tokenChain);
    const feeRequested = await quoteRelayFee(feeAsset);

    // Still above the user's ceiling: throw so the engine retries with backoff (2, 4, 8, 16, 32,
    // 64 min). Gas often settles within minutes of a spike; the age cap above stops us eventually.
    if (feeRequested > maxRelayFee) {
      throw new Error(
        `intent ${intentId} unprofitable (attempt ${attempt}/${INTENT_RETRIES}): ` +
          `feeRequested ${feeRequested} > maxRelayFee ${maxRelayFee}; retrying with backoff`,
      );
    }

    ctxLogger.info(
      `Intent → ${depositAddress}: feeRequested ${feeRequested} ≤ maxRelayFee ${maxRelayFee} ` +
        `(attempt ${attempt}/${INTENT_RETRIES})`,
    );
    queue.addToQueue({
      vaa,
      type: "intent",
      feeRequested: feeRequested.toString(),
      logger: ctxLogger,
      next,
    });
  });

  await app.listen();
})();
