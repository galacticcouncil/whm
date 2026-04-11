// @ts-nocheck
import logger from "./logger";
import {ethers} from "ethers";

// Patch global fetch to inject Wormhole API key for wormholescan requests
if (process.env.WORMHOLE_API_KEY) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('wormholescan.io')) {
      init = init || {};
      init.headers = new Headers(init.headers);
      init.headers.set('X-API-KEY', process.env.WORMHOLE_API_KEY!);
    }
    return originalFetch(input, init);
  };
}

export async function loadVaaFromWormholeApi(emitterChain: number, emitterAddr: string, sequence: number) {
  const url = `https://api.wormholescan.io/api/v1/vaas/${emitterChain}/${emitterAddr}/${sequence}?parsedPayload=true`;

  try {
    const response = await fetch(url);
    const apiData = await response.json();

    if (!apiData.data) {
      throw new Error('No VAA data found');
    }

    const {data} = apiData;
    const {payload} = data;

    const vaaBytes = Buffer.from(data.vaa, 'base64');
    const to = payload.toAddress.replace('0x', '').toLowerCase();
    const toChain = payload.toChain;
    const payloadType = payload.payloadType;
    const amount = payload.amount;
    const fromAddress = payload.fromAddress;
    const tokenAddress = payload.tokenAddress;
    const tokenChain = payload.tokenChain;

    const tokenBridgePayload = {
      payloadType,
      toChain,
      to: Buffer.from(to, 'hex'),
      tokenTransferPayload: {
        amount: BigInt(amount),
        fromAddress,
        tokenAddress,
        tokenChain
      }
    };

    return {
      payload: tokenBridgePayload,
      sourceTxHash: data.txHash,
      timestamp: data.timestamp,
      emitterChain: data.emitterChain,
      sequence: data.sequence,
      vaaBytes
    };

  } catch (error) {
    logger.error(`Failed to load VAA from Wormhole API: ${error.message}`);
    throw error;
  }
}

export async function getPayloadWithFallback(ctx: any, ctxLogger: any) {
  const {vaa} = ctx;
  let {payload} = ctx.tokenBridge;

  if (!payload) {
    ctxLogger.info('Payload missing, attempting to load from Wormhole API...');

    const emitterChain = vaa.emitterChain;
    const emitterAddr = vaa.emitterAddress.toString('hex');
    const sequence = vaa.sequence;

    ctxLogger.info(`Loading VAA ${emitterChain}/${emitterAddr}/${sequence} from API`);

    const apiVaaData = await loadVaaFromWormholeApi(emitterChain, emitterAddr, Number(sequence));
    payload = apiVaaData.payload;

    ctxLogger.info('Successfully loaded payload from Wormhole API');
    ctxLogger.debug('API payload', payload);
  }

  return payload;
}

export type TransferTask = {
  vaa: any;
  type?: 'mrl' | 'insta' | 'oracle';
  payloadType?: number;
  logger: any;
  next: () => void;
};

export function createTransferQueue(
  provider: ethers.providers.JsonRpcProvider,
  signer: ethers.Wallet,
  executeTransfer: (task: TransferTask, nonce: number) => Promise<string>
) {
  let currentNonce: number;
  const transferQueue: TransferTask[] = [];
  let isProcessing = false;

  async function initNonce() {
    currentNonce = await provider.getTransactionCount(signer.address);
    return currentNonce;
  }

  async function processQueue() {
    if (isProcessing || transferQueue.length === 0) return;

    isProcessing = true;
    const task = transferQueue.shift()!;

    try {
      const txHash = await executeTransfer(task, currentNonce);
      task.logger.info(`Transfer completed in ${txHash}`);
      task.logger.info(`Next nonce: ${++currentNonce}`);
      task.next();
    } catch (e) {
      const text = JSON.stringify(e);
      if (text.indexOf('transfer already completed') !== -1 || text.indexOf('already been redeemed') !== -1 || text.indexOf('VAA already processed') !== -1) {
        task.logger.info(`Transfer already completed`);
        task.next();
      } else if (text.indexOf('Invalid GMP Payload') !== -1) {
        task.logger.error(`Invalid GMP payload`);
        task.next();
      } else if (text.indexOf('nonce too low') !== -1) {
        task.logger.info(`nonce too low, reloading nonce...`);
        currentNonce = await provider.getTransactionCount(signer.address);
        transferQueue.unshift(task);
      } else {
        task.logger.error(e.error || e.message || e);
        task.next();
      }
    } finally {
      isProcessing = false;
      processQueue();
    }
  }

  function addToQueue(task: TransferTask) {
    transferQueue.push(task);
    processQueue();
  }

  return {initNonce, addToQueue, getCurrentNonce: () => currentNonce};
}
