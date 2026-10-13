import { getContractAddress, type Hex } from "viem";
import { TypedApi } from "polkadot-api";

import { hydration } from "@galacticcouncil/descriptors";

import type { Network } from "../network";
import type { EventRecord } from "../events";

import { sendRawEthTx, sendRawEthTxs, type EthBatchResult, type EthTxResult } from "./submit";

const DEFAULT_GAS = 6_000_000n;
const DEFAULT_GAS_PRICE = 10_000_000n; // 0.01 gwei — realistic Hydration EVM gas price

export interface EthClientOpts {
  chainId: number;
  gas?: bigint;
  gasPrice?: bigint;
}

/**
 * Minimal structural signer — anything that can sign a legacy tx (e.g. a viem `LocalAccount`).
 * Typed structurally so it accepts accounts from any viem instance (the monorepo dedups several).
 */
export interface EvmSigner {
  address: Hex;
  signTransaction(tx: {
    type: "legacy";
    chainId: number;
    nonce: number;
    gasPrice: bigint;
    gas: bigint;
    value: bigint;
    to?: Hex;
    data: Hex;
  }): Promise<Hex>;
}

/**
 * A minimal eth "wallet" over a chopsticks fork.
 *
 * Signs legacy txs with a viem account and submits
 * them via {@link sendRawEthTx}. Tracks nonce locally.
 */
export class EthClient {
  private nonce = 0;

  constructor(
    private readonly net: Network,
    private readonly account: EvmSigner,
    private readonly opts: EthClientOpts,
  ) {}

  get address(): Hex {
    return this.account.address;
  }

  get api(): TypedApi<typeof hydration> {
    return this.net.client.getTypedApi(hydration);
  }

  /** Signs at the next nonce and advances it — the tx is not sent. */
  private async sign(fields: { to?: Hex; data: Hex; value?: bigint; gas?: bigint }): Promise<Hex> {
    const rawTx = await this.account.signTransaction({
      type: "legacy",
      chainId: this.opts.chainId,
      nonce: this.nonce,
      gasPrice: this.opts.gasPrice ?? DEFAULT_GAS_PRICE,
      gas: fields.gas ?? this.opts.gas ?? DEFAULT_GAS,
      value: fields.value ?? 0n,
      to: fields.to,
      data: fields.data,
    });
    this.nonce += 1;
    return rawTx;
  }

  private async submit(fields: { to?: Hex; data: Hex; value?: bigint }): Promise<EthTxResult> {
    return sendRawEthTx(this.net, await this.sign(fields));
  }

  /** Deploy via CREATE; returns the deterministic contract address + tx result. */
  async deploy(initCode: Hex, value = 0n): Promise<{ address: Hex; res: EthTxResult }> {
    const address = getContractAddress({ from: this.account.address, nonce: BigInt(this.nonce) });
    const res = await this.submit({ data: initCode, value });
    return { address, res };
  }

  /** Call an existing contract. */
  call(to: Hex, data: Hex, value = 0n): Promise<EthTxResult> {
    return this.submit({ to, data, value });
  }

  /**
   * Batching: sign a deploy now, send it later with {@link sendBatch}. Every block on a fork costs the
   * same fixed build time, so sealing several txs together is the main lever on a probe's runtime.
   * `gas` is per tx: each tx's gas limit is reserved against the block's, so size it.
   */
  async signDeploy(initCode: Hex, gas?: bigint, value = 0n): Promise<{ address: Hex; rawTx: Hex }> {
    const address = getContractAddress({ from: this.account.address, nonce: BigInt(this.nonce) });
    return { address, rawTx: await this.sign({ data: initCode, value, gas }) };
  }

  /** Batching: sign a call now, send it later with {@link sendBatch}. */
  signCall(to: Hex, data: Hex, gas?: bigint, value = 0n): Promise<Hex> {
    return this.sign({ to, data, value, gas });
  }

  /** Seals signed txs — in nonce order — into one block. */
  sendBatch(rawTxs: Hex[]): Promise<EthBatchResult> {
    return sendRawEthTxs(this.net, rawTxs);
  }

  events(blockHash: string): Promise<EventRecord[]> {
    return this.api.query.System.Events.getValue({ at: blockHash });
  }
}
