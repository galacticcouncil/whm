import type { ChainClient } from "./clients";
import type { LogRef, EventRef } from "./types";

/**
 * Per-chain log enrichment: block timestamps (cached) and EVM tx senders, dispatched by
 * chain kind. Handlers across all features share one instance so the block-time cache is
 * shared. Substrate `getSender` returns undefined (an EVM.Log has no EVM tx origin to read).
 */
export class Enrich {
  private blockTime = new Map<string, Map<bigint, number>>();

  constructor(private readonly clients: Record<string, ChainClient>) {}

  /**
   * Attach the block timestamp (unix ms) to a log ref.
   *
   * @param chain chain name
   * @param ref   the log reference
   * @returns the ref extended with `blockTimestamp`
   */
  async withBlockTime(chain: string, ref: LogRef): Promise<EventRef> {
    let cache = this.blockTime.get(chain);
    if (!cache) {
      cache = new Map();
      this.blockTime.set(chain, cache);
    }
    const n = BigInt(ref.blockNumber);
    let ms = cache.get(n);
    if (ms === undefined) {
      ms = await this.fetchBlockTime(chain, n);
      cache.set(n, ms);
    }
    return { ...ref, blockTimestamp: ms };
  }

  private async fetchBlockTime(chain: string, n: bigint): Promise<number> {
    const c = this.clients[chain];
    if (c?.kind === "evm" && c.evm) {
      const b = await c.evm.getBlock({ blockNumber: n });
      return Number(b.timestamp) * 1000;
    }
    if (c?.kind === "substrate" && c.substrate) {
      const hash = await c.substrate._request<string>("chain_getBlockHash", [Number(n)]);
      const t = await c.substrate.getUnsafeApi().query.Timestamp.Now.getValue({ at: hash });
      return Number(t);
    }
    return 0;
  }

  /**
   * Resolve the EVM transaction sender for a log ref.
   *
   * @param chain chain name
   * @param ref   the log reference
   * @returns the `from` address, or undefined for non-EVM chains
   */
  async getSender(chain: string, ref: LogRef): Promise<string | undefined> {
    const c = this.clients[chain];
    if (c?.kind === "evm" && c.evm) {
      const tx = await c.evm.getTransaction({ hash: ref.txHash });
      return tx.from;
    }
    return undefined;
  }
}
