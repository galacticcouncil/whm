import { type Address, type PublicClient } from "viem";

import log from "../../logger";
import { OrderProcessedEvt } from "./abi";
import { submitDeposit } from "./oneclick";

export interface IntentWatcherCfg {
  name: string;
  receiver: Address;
}

// How often to probe the socket. viem reconnects + re-subscribes on its own; this only makes the
// drop/recovery visible in the logs (and surfaces a socket that never comes back).
const HEARTBEAT_MS = 30_000;

/**
 * Watches `IntentReceiver.OrderProcessed` over a WebSocket transport (viem `eth_subscribe`, no
 * polling) and pings 1Click for each forward so the deposit is detected immediately. viem reconnects
 * and re-subscribes on drop; submissions are deduped by (txHash, depositAddress) against redelivery.
 */
export class IntentWatcher {
  private unwatch?: () => void;
  private heartbeat?: NodeJS.Timeout;
  private degraded = false;
  private readonly seen = new Set<string>();

  constructor(
    public readonly cfg: IntentWatcherCfg,
    private readonly client: PublicClient,
  ) {}

  /** Number of deposits submitted to 1Click so far (deduped). */
  get processed(): number {
    return this.seen.size;
  }

  /** Open the subscription and start the heartbeat. */
  start(): void {
    this.unwatch = this.client.watchContractEvent({
      address: this.cfg.receiver,
      abi: [OrderProcessedEvt],
      eventName: "OrderProcessed",
      onLogs: (logs) => {
        for (const l of logs) {
          const { depositAddress, transferSequence } = l.args as {
            depositAddress?: Address;
            transferSequence?: bigint;
          };
          if (depositAddress && l.transactionHash) {
            void this.notify(depositAddress, l.transactionHash, transferSequence);
          }
        }
      },
      // viem auto-reconnects and re-subscribes; this fires on each drop (the recovery is silent, so
      // the heartbeat below is what confirms the socket came back).
      onError: (e) => log.warn(`[${this.cfg.name}] watch: ${e.message || e}`),
    });
    this.heartbeat = setInterval(() => void this.probe(), HEARTBEAT_MS);
    log.info(`[${this.cfg.name}] watching OrderProcessed @ ${this.cfg.receiver}`);
  }

  stop(): void {
    this.unwatch?.();
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  /** Probe the socket so a drop and its recovery are observable in the logs. */
  private async probe(): Promise<void> {
    try {
      const block = await this.client.getBlockNumber();
      if (this.degraded) {
        this.degraded = false;
        log.info(`[${this.cfg.name}] socket healthy again @ block ${block}`);
      } else {
        log.debug(`[${this.cfg.name}] alive @ block ${block}`);
      }
    } catch (e) {
      this.degraded = true;
      log.warn(`[${this.cfg.name}] socket probe failed: ${(e as Error).message || e}`);
    }
  }

  /**
   * Submit a forwarded deposit to 1Click once, deduped by (txHash, depositAddress).
   *
   * @param depositAddress OneClick deposit address from the event.
   * @param txHash         Forwarding tx hash.
   * @param sequence       NTT manager sequence, logged so a deposit can be traced back to the
   *                       settlement and the emitter's instruction. Not part of the dedupe key —
   *                       the receiver consumes each instruction once, so one forward is one tx.
   * @returns The 1Click status, or null when skipped (duplicate) or the call failed.
   */
  async notify(depositAddress: string, txHash: string, sequence?: bigint): Promise<string | null> {
    const key = `${txHash}:${depositAddress}`.toLowerCase();
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    const seq = sequence === undefined ? "?" : sequence.toString();
    log.info(`[${this.cfg.name}] OrderProcessed seq=${seq} -> ${depositAddress} (tx ${txHash})`);
    try {
      const r = await submitDeposit(depositAddress, txHash);
      log.info(`[${this.cfg.name}] submitDepositTx ${depositAddress} -> ${r.status}`);
      return r.status;
    } catch (e) {
      this.seen.delete(key); // best-effort: let a later event / manual call retry
      log.error(
        `[${this.cfg.name}] submitDepositTx failed for ${depositAddress}: ${(e as Error).message}`,
      );
      return null;
    }
  }
}
