import { setTimeout as sleep } from "timers/promises";

import type { Account, JsonRpcProvider } from "near-api-js";

import { duration, type Alerter, type Incidents } from "@whm/common/discord";

import type { ConnectorConfig } from "../../chains";
import log from "../../logger";
import { view } from "../../near/client";
import { listCoins, pickCoin, type Coin } from "../../near/coins";
import type { Deriver, Params } from "../../near/derive";

import { alerts, incidentFields } from "./alerts";
import { BALANCE_FLOOR, PASS_ALERT_MS, RELAY_ATTEMPTS, RELAY_RETRY_MS } from "./config";
import { Refused } from "./types";
import type { Store, Withdrawal } from "./store";
import { balanceOf, ensureAccount, relay, signWithdraw } from "./withdraw";

export interface WithdrawWorkerCfg {
  intervalMs: number;
  stuckMs: number;
}

/**
 * Sees every open withdrawal through. A pass reads `A`'s balance; at or above the connector's
 * minimum — `ntt-near` has completed the settlement — the contract signs a withdrawal of the whole
 * balance, and the relayer relays it. The record closes once the balance has left.
 *
 * The signature costs the relaying account before the step that can fail, so the relayer tries once:
 * a sign that fails, a relay still failing after a few resends of the same delegate, or a balance
 * that did not leave opens an incident for `A`, and the relayer leaves `A` alone until a person
 * reprocesses it. Incidents are in Redis, so a restart does not pay for them again.
 */
export class WithdrawWorker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly warnedAt = new Map<string, number>();
  /** When a pass last completed — a pass failing past `PASS_ALERT_MS` is alerted. */
  private lastOk = Date.now();

  /**
   * @param derivers One per chain, by route key — each carries its chain and its contract's params.
   */
  constructor(
    private readonly cfg: WithdrawWorkerCfg,
    private readonly provider: JsonRpcProvider,
    private readonly account: Account,
    private readonly derivers: Record<string, Deriver>,
    private readonly store: Store,
    private readonly incidents: Incidents,
    private readonly alerter: Alerter,
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
      await this.checkBalance();
      this.lastOk = Date.now();
      this.alerter.clear("pass");
    } catch (e) {
      log.error(`[withdraw] pass: ${(e as Error).stack ?? String(e)}`);
      if (Date.now() - this.lastOk > PASS_ALERT_MS) {
        this.alerter.alert("pass", "failing", alerts.passFailing(Date.now() - this.lastOk, (e as Error).message));
      }
    } finally {
      this.busy = false;
    }
  }

  /** Alert while the relaying account is below `BALANCE_FLOOR`. */
  private async checkBalance(): Promise<void> {
    const balance = await this.account.getBalance().catch(() => undefined);
    if (balance === undefined) return;
    if (balance >= BALANCE_FLOOR) return this.alerter.clear("balance");
    this.alerter.alert("balance", "low", alerts.balanceLow(this.account.accountId, balance));
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
    if (await this.incidents.get(account)) return;
    const held = await balanceOf(this.provider, params.token, account);
    if (held < min) return;

    // Read now, not at startup: the owner may have changed the rate since.
    const { fee_rate: feeRate } = await view<Params>(this.provider, chain.contract, "get_params");
    // A rate under the market's would leave the transaction waiting; the balance waits here instead.
    if (chain.ready && !(await chain.ready(feeRate))) return;
    const coin = pickCoin(await coins(), config, held, chain.minerFee(config, feeRate));

    // The paid part, once: anything failing past here waits for a person.
    let step = "sign";
    try {
      if (await ensureAccount(this.account, account)) log.info(`[${chain.name} ${account}] created`);
      const signed = await signWithdraw(this.account, chain.contract, records[0].address, coin);
      log.info(`[${chain.name} ${account}] signed ${held} -> ${records[0].address} via ${coin}: ${signed.tx}`);
      step = "relay";
      const tx = await resend(() => relay(this.account, signed.delegate));
      // A failed receipt anywhere refunds `A`; only a balance that left means the connector has it.
      const left = await balanceOf(this.provider, params.token, account);
      if (left >= min) throw new Refused(`relay ${tx} left ${left} in ${account}`);
      for (const w of records) await this.store.withdrawn(w, tx);
      log.info(`[${chain.name} ${account}] ${held} -> ${records[0].address}: ${tx}`);
    } catch (e) {
      await this.incidents.open(
        account,
        `${chain.name} ${step} — ${(e as Error).message}`,
        incidentFields(chain.name, held, records[0].address, account),
      );
      throw e;
    }
  }

  /** Log and alert a record open longer than `stuckMs`, once per `stuckMs`. */
  private warnIfStuck(w: Withdrawal): void {
    const now = Date.now();
    const id = `${w.chain}:${w.sequence}`;
    if (now - w.createdAt < this.cfg.stuckMs || now - (this.warnedAt.get(id) ?? 0) < this.cfg.stuckMs) return;
    this.warnedAt.set(id, now);
    log.warn(`[${id}] open ${duration(now - w.createdAt)}: ${w.lastError ?? "waiting for the settlement"}`);
    this.alerter.alert(`stuck:${id}`, String(now), alerts.stuck(w, now));
  }
}

/**
 * Relay, and relay the same delegate again while it reaches no decision. A refusal is final at once.
 *
 * @param send The relay.
 * @returns Its transaction hash.
 * @throws A refusal, or the last failure.
 */
async function resend(send: () => Promise<string>): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      if (e instanceof Refused || attempt >= RELAY_ATTEMPTS) throw e;
      log.warn(`relay failed (${(e as Error).message}), relaying the same delegate again`);
      await sleep(RELAY_RETRY_MS);
    }
  }
}
