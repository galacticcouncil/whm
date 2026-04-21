import type { PolkadotClient } from "polkadot-api";

import type { LogRef, EventRef } from "../../db";

export function createUtils(client: PolkadotClient) {
  const blockTimeCache = new Map<bigint, number>();

  async function withBlockTime(ref: LogRef): Promise<EventRef> {
    const n = BigInt(ref.blockNumber);
    let ms = blockTimeCache.get(n);
    if (ms === undefined) {
      const hash = await client._request<string>("chain_getBlockHash", [Number(n)]);
      const t = await client.getUnsafeApi().query.Timestamp.Now.getValue({ at: hash });
      ms = Number(t);
      blockTimeCache.set(n, ms);
    }
    return { ...ref, blockTimestamp: ms };
  }

  return { withBlockTime };
}
