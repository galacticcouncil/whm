import { BuildBlockMode, connectParachains, setupWithServer } from "@galacticcouncil/chopsticks";
import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

import type { ChainSpec } from "./configs";

export interface Network {
  spec: ChainSpec;
  chain: Awaited<ReturnType<typeof setupWithServer>>["chain"];
  client: PolkadotClient;
  url: string;
  /** Build one block, optionally injecting raw signed extrinsics. Returns the new block hash. */
  newBlock: (transactions?: string[]) => Promise<string>;
  /** Override storage (dev_setStorage). bigints are stringified automatically. */
  setStorage: (values: unknown) => Promise<unknown>;
  close: () => Promise<void>;
}

/**
 * Fork a single chain (chopsticks server + a papi client). Runs in **Manual** block-build mode:
 * each extrinsic is injected via `newBlock([ext])`, which returns the exact hash of the block that
 * contains it — deterministic reads, no race against an Instant-mode auto-sealer (Instant + manual
 * `dev_newBlock` fight and deadlock).
 */
export async function spawn(spec: ChainSpec): Promise<Network> {
  const { chain, addr, close } = await setupWithServer({
    endpoint: spec.endpoint,
    port: spec.port,
    "mock-signature-host": true, // skip signature verification — submit as any origin
    "build-block-mode": BuildBlockMode.Manual,
  });

  const url = `ws://${addr}`;
  const client = createClient(getWsProvider(url));

  const newBlock = (transactions?: string[]): Promise<string> =>
    client._request("dev_newBlock", [transactions ? { transactions } : {}]);

  const setStorage = (values: unknown): Promise<unknown> => {
    const serializable = JSON.parse(
      JSON.stringify(values, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
    return client._request("dev_setStorage", [serializable]);
  };

  const name = await client._request<string>("system_name", []);
  console.log(`🥢 ${spec.name} (${name}) forked → ${url}`);

  return { spec, chain, client, url, newBlock, setStorage, close };
}

/**
 * Fork all given chains and wire HRMP between the parachains; keyed by `spec.key`. Spawns
 * sequentially so a mid-way failure can't leave a sibling's server bound with no handle to close —
 * and on any error, closes whatever already came up so ports aren't orphaned.
 */
export async function spawnForks(specs: ChainSpec[]): Promise<Record<string, Network>> {
  const list: Network[] = [];
  try {
    for (const spec of specs) {
      list.push(await spawn(spec));
    }
    await connectParachains(list.map((n) => n.chain));
    console.log(`🥢 HRMP wired: ${list.map((n) => n.spec.key).join(" ⇄ ")}`);
    return Object.fromEntries(list.map((n) => [n.spec.key, n]));
  } catch (err) {
    for (const n of list) {
      try {
        n.client.destroy();
        await n.close();
      } catch {}
    }
    throw err;
  }
}

export async function teardownForks(networks: Record<string, Network>): Promise<void> {
  for (const n of Object.values(networks)) {
    n.client.destroy();
    await n.close();
  }
}
