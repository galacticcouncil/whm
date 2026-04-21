import type { PublicClient } from "viem";

import type { LogRef, EventRef } from "../../db";

export function createUtils(client: PublicClient) {
  const blockTimeCache = new Map<bigint, number>();

  async function withBlockTime(ref: LogRef): Promise<EventRef> {
    const n = BigInt(ref.blockNumber);
    let ms = blockTimeCache.get(n);
    if (ms === undefined) {
      const b = await client.getBlock({ blockNumber: n });
      ms = Number(b.timestamp) * 1000;
      blockTimeCache.set(n, ms);
    }
    return { ...ref, blockTimestamp: ms };
  }

  async function getSender(ref: LogRef): Promise<string> {
    const tx = await client.getTransaction({ hash: ref.txHash });
    return tx.from;
  }

  return { withBlockTime, getSender };
}
