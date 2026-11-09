import type { Account, JsonRpcProvider } from "near-api-js";

import type { ConnectorConfig } from "../../chains";
import log from "../../logger";
import { view } from "../../near/client";
import { listCoins, pickCoin, type Coin } from "../../near/coins";
import type { Deriver } from "../../near/derive";

import type { Store, Withdrawal } from "./store";
import { balanceOf, ensureAccount, withdraw } from "./withdraw";

export interface WithdrawWorkerCfg {
  intervalMs: number;
  stuckMs: number;
}

/**
 * Retries every open withdrawal until it is processed. A pass reads `A`'s balance; at or above the
 * connector's minimum — `ntt-near` has completed the settlement — it withdraws the whole balance and
 * relays it. The record closes once the balance has left; anything else leaves the funds in `A`, and
 * the next pass tries again with a fresh coin.
 */
export class WithdrawWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly warnedAt = new Map<string, number>();

  /**
   * @param derivers One per chain, by route key — each carries its chain and its contract's params.
   */
  constructor(
    private readonly cfg: WithdrawWorkerCfg,
    private readonly provider: JsonRpcProvider,
    private readonly account: Account,
    private readonly derivers: Record<string, Deriver>,
    private readonly store: Store,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.pass(), this.cfg.intervalMs);
    void this.pass();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async pass(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const open = await this.store.open();
      for (const chain of new Set(open.map((w) => w.chain))) {
        await this.passChain(this.derivers[chain], open.filter((w) => w.chain === chain));
      }
      for (const w of open) this.warnIfStuck(w);
    } catch (e) {
      log.error(`[withdraw] pass: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /**
   * One chain's open records. Records of one `A` go out together: the contract withdraws the whole
   * balance.
   *
   * @param deriver The chain's deriver — its chain and contract params.
   * @param open Its open records.
   */
  private async passChain(deriver: Deriver, open: Withdrawal[]): Promise<void> {
    const { connector } = deriver.params;
    const byAccount = new Map<string, Withdrawal[]>();
    for (const w of open) byAccount.set(w.account, [...(byAccount.get(w.account) ?? []), w]);

    const config = await view<ConnectorConfig>(this.provider, connector, "get_config");
    let coins: Promise<Coin[]> | undefined;
    const coinSet = () => (coins ??= listCoins(this.provider, connector));

    for (const [account, records] of byAccount) {
      try {
        await this.withdraw(deriver, account, records, config, coinSet);
      } catch (e) {
        const message = (e as Error).message;
        log.warn(`[${deriver.chain.name} ${account}] ${message}`);
        for (const w of records) await this.store.fail(w, message);
      }
    }
  }

  /**
   * Withdraw `A`'s whole balance once it has arrived, and close the records it covers.
   *
   * @param deriver The chain's deriver.
   * @param account `A`.
   * @param records Its open records.
   * @param config The connector's config.
   * @param coins The connector's coin set, read on first use and shared across accounts.
   */
  private async withdraw(
    deriver: Deriver,
    account: string,
    records: Withdrawal[],
    config: ConnectorConfig,
    coins: () => Promise<Coin[]>,
  ): Promise<void> {
    const { chain, params } = deriver;
    const min = BigInt(config.min_withdraw_amount);
    const held = await balanceOf(this.provider, params.token, account);
    if (held < min) return;

    if (await ensureAccount(this.account, account)) log.info(`[${chain.name} ${account}] created`);
    const coin = pickCoin(await coins(), config, held, chain.minerFee(config));
    const tx = await withdraw(this.account, chain.contract, records[0].address, coin);

    // A failed receipt anywhere refunds `A`; only a balance that left means the connector has it.
    const left = await balanceOf(this.provider, params.token, account);
    if (left >= min) throw new Error(`relay ${tx} left ${left} in ${account}`);

    for (const w of records) await this.store.withdrawn(w, tx);
    log.info(`[${chain.name} ${account}] ${held} -> ${records[0].address} via ${coin}: ${tx}`);
  }

  /** Log a record open longer than `stuckMs`, once per `stuckMs`. */
  private warnIfStuck(w: Withdrawal): void {
    const now = Date.now();
    const id = `${w.chain}:${w.sequence}`;
    if (now - w.createdAt < this.cfg.stuckMs || now - (this.warnedAt.get(id) ?? 0) < this.cfg.stuckMs) return;
    this.warnedAt.set(id, now);
    const min = Math.round((now - w.createdAt) / 60_000);
    log.warn(`[${id}] open ${min} min: ${w.lastError ?? "waiting for the settlement"}`);
  }
}
