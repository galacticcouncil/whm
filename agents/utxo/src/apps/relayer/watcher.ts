import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { bytesToHex, decodeEventLog, toEventSelector } from "viem";

import type { UtxoChain } from "../../chains";
import log from "../../logger";

import { WithdrawRequestedEvt } from "./abi";
import type { Route } from "./config";
import type { Store } from "./store";

const WITHDRAW_REQUESTED = toEventSelector(WithdrawRequestedEvt);

/** Any single read. A request lost to a dropped socket never settles on its own. */
const RPC_TIMEOUT_MS = 60_000;

export interface HydrationWatcherCfg {
  wssUrl: string;
  confirmations: bigint;
  concurrency: number;
  checkpointEvery: bigint;
  liveIntervalMs: number;
}

export interface WithdrawRequested {
  chain: UtxoChain;
  sequence: bigint;
  nearAccount: `0x${string}`;
  amount: bigint;
  destination: `0x${string}`;
  block: bigint;
}

type RawRecord = { event: { type: string; value: { type: string; value: unknown } } };
type EvmLog = { log: { address: string; topics: string[]; data: Uint8Array } };

/**
 * Reads every route's `WithdrawRequested` out of Hydration's `System.Events`, as scan does: a send
 * that comes in as a substrate extrinsic has no ethereum receipt, so eth_getLogs would miss it.
 * Finalized blocks arrive over a subscription and drive the read; the interval is a backstop. One
 * cursor for all routes, starting at the earliest route's deployment block.
 */
export class HydrationWatcher {
  readonly client: PolkadotClient;
  private timer?: NodeJS.Timeout;
  private sub?: { unsubscribe(): void };
  private pendingSafe?: bigint;
  private busy = false;
  /** Each route's chain, by its emitter. */
  private readonly targets = new Map<string, UtxoChain>();
  private readonly from: bigint;

  constructor(
    private readonly cfg: HydrationWatcherCfg,
    routes: { route: Route; chain: UtxoChain }[],
    private readonly store: Store,
    private readonly onWithdrawal: (w: WithdrawRequested) => Promise<void>,
  ) {
    this.client = createClient(getWsProvider(cfg.wssUrl));
    for (const { route, chain } of routes) {
      this.targets.set(route.emitter.toLowerCase(), chain);
    }
    this.from = routes.map((r) => r.route.from).reduce((a, b) => (b < a ? b : a));
  }

  async start(): Promise<void> {
    this.subscribe();
    this.timer = setInterval(() => void this.drain(), this.cfg.liveIntervalMs);
    await this.drain();
    log.info(`[hydration] watching ${this.targets.size} emitters`);
  }

  stop(): void {
    this.sub?.unsubscribe();
    if (this.timer) clearInterval(this.timer);
    this.client.destroy();
  }

  private subscribe(): void {
    this.sub?.unsubscribe();
    this.sub = this.client.finalizedBlock$.subscribe({
      next: (b) => {
        const n = BigInt(b.number);
        this.pendingSafe = n > this.cfg.confirmations ? n - this.cfg.confirmations : 0n;
        void this.drain();
      },
      error: (e) => {
        log.error(`[hydration] finalizedBlock$: ${(e as Error)?.message ?? String(e)}`);
        setTimeout(() => this.subscribe(), 5_000);
      },
    });
  }

  private async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.pendingSafe === undefined) {
        const { number } = await withTimeout(this.client.getFinalizedBlock(), "finalized block");
        this.pendingSafe = BigInt(number) - this.cfg.confirmations;
      }
      while (this.pendingSafe !== undefined) {
        const safe = this.pendingSafe;
        this.pendingSafe = undefined;
        await this.read(safe);
      }
    } catch (e) {
      log.error(`[hydration] drain: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Read every block after the cursor up to `safe`, in order, `concurrency` fetches in flight. */
  private async read(safe: bigint): Promise<void> {
    const from = (await this.store.cursor()) ?? this.from - 1n;
    if (safe <= from) return;
    if (safe - from > this.cfg.checkpointEvery) log.info(`[hydration] reading ${from + 1n}..${safe}`);

    const inflight: Promise<WithdrawRequested[]>[] = [];
    let next = from + 1n;
    let checkpoint = from;
    try {
      while (inflight.length < this.cfg.concurrency && next <= safe) inflight.push(this.fetch(next++));
      for (let block = from + 1n; inflight.length > 0; block++) {
        for (const w of await inflight.shift()!) await this.onWithdrawal(w);
        if (next <= safe) inflight.push(this.fetch(next++));
        if (block - checkpoint >= this.cfg.checkpointEvery) {
          await this.store.saveCursor(block);
          checkpoint = block;
        }
      }
    } finally {
      // Abandoned on a failure — keep their later rejections from going unhandled.
      for (const p of inflight) p.catch(() => {});
    }
    await this.store.saveCursor(safe);
  }

  /** One block's `WithdrawRequested`, decoded from its `EVM.Log` events. */
  private async fetch(n: bigint): Promise<WithdrawRequested[]> {
    const hash = await withTimeout(this.client._request<string>("chain_getBlockHash", [Number(n)]), `#${n} hash`);
    if (!hash) throw new Error(`block #${n}: no hash`);
    const records = (await withTimeout(
      this.client.getUnsafeApi().query.System.Events.getValue({ at: hash }),
      `#${n} events`,
    )) as unknown as RawRecord[];

    const out: WithdrawRequested[] = [];
    for (const { event } of records) {
      if (event.type !== "EVM" || event.value.type !== "Log") continue;
      const { log: l } = event.value.value as EvmLog;
      const chain = this.targets.get(l.address.toLowerCase());
      if (!chain || l.topics[0]?.toLowerCase() !== WITHDRAW_REQUESTED) continue;

      const { args } = decodeEventLog({
        abi: [WithdrawRequestedEvt],
        topics: l.topics as [`0x${string}`, ...`0x${string}`[]],
        data: bytesToHex(l.data),
      });
      out.push({ ...args, chain, block: n });
    }
    return out;
  }
}

/**
 * Reject a read that has not settled within `RPC_TIMEOUT_MS`, so a lost request fails its drain
 * instead of holding it forever.
 *
 * @param p The read.
 * @param what What it reads, for the error.
 * @returns The read's own result.
 */
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: timed out`)), RPC_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
