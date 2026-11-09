import type { JsonRpcProvider } from "near-api-js";

import { decodeBase58 } from "../chains/base58";
import type { UtxoChain } from "../chains";

import { view } from "./client";

/** What `get_params` returns. */
export interface Params {
  mpc_signer: string;
  token: string;
  connector: string;
  validity: number;
  withdraw_tgas: number;
}

/** Derivations never change; the bound only caps memory. */
const CACHE_MAX = 100_000;

/**
 * Derives a chain's withdraw accounts exactly as its contract does — `path_of`, then
 * `derived_public_key` on the MPC signer with the contract as predecessor and domain 1. Views only,
 * no keys.
 */
export class Deriver {
  private readonly cache = new Map<string, string>();

  private constructor(
    private readonly provider: JsonRpcProvider,
    public readonly chain: UtxoChain,
    public readonly params: Params,
  ) {}

  /**
   * Read the contract's params and check the chain's golden vector, so a wrong RPC, signer or path
   * fails before anything is served or signed.
   *
   * @param provider A NEAR provider.
   * @param chain The chain.
   * @returns A deriver.
   * @throws When the golden address does not derive the golden account.
   */
  static async create(provider: JsonRpcProvider, chain: UtxoChain): Promise<Deriver> {
    const params = await view<Params>(provider, chain.contract, "get_params");
    const deriver = new Deriver(provider, chain, params);
    const account = await deriver.account(chain.golden.address);
    if (account !== chain.golden.account) {
      throw new Error(`[${chain.name}] golden vector derived ${account}, expected ${chain.golden.account}`);
    }
    return deriver;
  }

  /**
   * The withdraw account an address derives. The address must already be valid — `path_of` panics
   * on anything else.
   *
   * @param address The address string.
   * @returns The implicit account id, lowercase hex.
   */
  async account(address: string): Promise<string> {
    const hit = this.cache.get(address);
    if (hit) return hit;

    const path = await view<string>(this.provider, this.chain.contract, "path_of", { address });
    const key = await view<string>(this.provider, this.params.mpc_signer, "derived_public_key", {
      path,
      predecessor: this.chain.contract,
      domain_id: 1,
    });
    const account = decodeBase58(key.replace(/^ed25519:/, "")).toString("hex");

    if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(address, account);
    return account;
  }
}
