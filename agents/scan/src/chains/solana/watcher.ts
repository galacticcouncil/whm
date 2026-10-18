import { nearTopic } from "../../abi";
import { applyRewinds, insertEvents, loadCursor, saveCursor, type RawEvent } from "../../db";
import { WORMHOLE_CORE } from "../../deployments";
import log from "../../logger";
import type { Watch } from "../../types";
import { cursorId } from "../cursor";
import { topicsMatch } from "../events";

import { decode, instructions, postedVaas, type Decoded } from "./decode";
import { SolanaRpc } from "./rpc";
import type { SolanaChain, Tx } from "./types";

/** How often a pass saves how far it has got, and says so. */
const CHECKPOINT_MS = 15_000;

/** A transaction found among the signatures, and the addresses whose signatures it was found in. */
interface Found {
  slot: bigint;
  via: Set<string>;
}

/**
 * Reads Solana through the signatures of the programs we own, then those transactions whole.
 *
 * NTT on Solana logs nothing worth reading, so a transaction is decoded instruction by instruction
 * — see `decode` — into the events NEAR-style legs read. Like NEAR, a shared program — the Wormhole
 * core — is read through the programs of ours that call it (`via`), never through its own history.
 *
 * Everything is read at `finalized`, so the cursor is a slot nothing below will ever change.
 */
export class SolanaWatcher {
  private timer?: NodeJS.Timeout;
  private socket?: WebSocket;
  private busy = false;
  private again = false;
  private tip = 0n;
  /** Watch entries by the address whose signatures surface them. */
  private readonly sources = new Map<string, Watch[]>();
  /** Every NTT program a watch keeps — what a delivery is decoded from. */
  private readonly programs: Set<string>;
  private readonly rpc: SolanaRpc;

  constructor(
    public readonly cfg: SolanaChain,
    private readonly watches: Watch[],
    private readonly onIngest?: (chain: string) => void,
  ) {
    for (const w of watches) {
      for (const a of w.via ?? w.at) this.sources.set(a, [...(this.sources.get(a) ?? []), w]);
    }
    this.programs = new Set(watches.flatMap((w) => w.at).filter((a) => a !== WORMHOLE_CORE.solana));
    this.rpc = new SolanaRpc(cfg.rpcUrl);
  }

  async latestSafe(): Promise<bigint> {
    return this.tip;
  }

  async start(): Promise<void> {
    await this.drain();
    this.timer = setInterval(() => void this.drain(), this.cfg.pollMs);
    if (this.cfg.wssUrl) this.subscribe(this.cfg.wssUrl);
    log.info(
      `[${this.cfg.name}] live: signatures every ${this.cfg.pollMs}ms${this.cfg.wssUrl ? ", woken by logsSubscribe" : ""}`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
  }

  /**
   * Wake on any log that mentions a source. The notice itself is not read — it is not finalized yet
   * — it only brings the next read forward; the poll stays the backstop.
   *
   * @param url The websocket.
   */
  private subscribe(url: string): void {
    const ws = new WebSocket(url);
    this.socket = ws;
    let id = 0;
    ws.onopen = () => {
      for (const a of this.sources.keys()) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: ++id,
            method: "logsSubscribe",
            params: [{ mentions: [a] }, { commitment: "finalized" }],
          }),
        );
      }
    };
    ws.onmessage = (m) => {
      if (String(m.data).includes('"logsNotification"')) void this.drain();
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      setTimeout(() => this.subscribe(url), 5_000);
    };
    ws.onerror = () => log.warn(`[${this.cfg.name}] websocket error — polling until it reconnects`);
  }

  private async drain(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.tick();
      } while (this.again);
    } catch (e) {
      log.error(`[${this.cfg.name}] drain: ${(e as Error).stack ?? String(e)}`);
    } finally {
      this.busy = false;
    }
  }

  /** Each watch's cursor, defaulted to just before its own start slot. */
  private async cursors(): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const w of this.watches) {
      out.set(cursorId(w), (await loadCursor(this.cfg.name, cursorId(w))) ?? w.from - 1n);
    }
    return out;
  }

  private async tick(): Promise<void> {
    await applyRewinds(this.cfg.name, this.watches.map(cursorId));
    const cursors = await this.cursors();
    // Read before the signatures, so whatever finalized up to here is in them.
    const head = await this.rpc.slot();

    const found = new Map<string, Found>();
    for (const [address, ws] of this.sources) {
      const after = ws.map((w) => cursors.get(cursorId(w))!).reduce((a, b) => (b < a ? b : a));
      for (const r of await this.rpc.signatures(address, after)) {
        // A failed transaction changed nothing.
        if (r.err) continue;
        const f = found.get(r.signature) ?? { slot: BigInt(r.slot), via: new Set<string>() };
        f.via.add(address);
        found.set(r.signature, f);
      }
    }

    const ordered = [...found].sort(([sa, a], [sb, b]) =>
      a.slot === b.slot ? sa.localeCompare(sb) : a.slot < b.slot ? -1 : 1,
    );

    // A long pass saves its progress as it goes, so one that fails — the public RPC throttles — or a
    // restart resumes there rather than from the start. Transactions run oldest slot first, so every
    // slot below the last one written is done; that slot itself may have more to come. The cursors
    // the pass filters by stay as they were: only what is saved moves.
    const saved = new Map(cursors);
    let checkpointAt = Date.now();
    let ingested = 0;
    for (let i = 0; i < ordered.length; i += this.cfg.concurrency) {
      const batch = ordered.slice(i, i + this.cfg.concurrency);
      const txs = await Promise.all(batch.map(([s]) => this.rpc.transaction(s)));
      const ixs = txs.map(instructions);
      const vaas = await this.rpc.accounts([
        ...new Set(ixs.flatMap((x) => postedVaas(x, this.programs))),
      ]);
      for (let j = 0; j < batch.length; j++) {
        const events = this.extract(
          txs[j],
          batch[j][1],
          cursors,
          decode(txs[j], ixs[j], WORMHOLE_CORE.solana, this.programs, vaas, nearTopic),
        );
        const n = await insertEvents(this.cfg.name, events);
        if (n > 0) this.onIngest?.(this.cfg.name);
        ingested += n;
      }
      if (Date.now() - checkpointAt >= CHECKPOINT_MS) {
        const done = batch[batch.length - 1][1].slot - 1n;
        for (const w of this.watches) {
          if (done <= saved.get(cursorId(w))!) continue;
          await saveCursor(this.cfg.name, cursorId(w), done);
          saved.set(cursorId(w), done);
        }
        checkpointAt = Date.now();
        log.info(
          `[${this.cfg.name}] at ${done} (${i + batch.length}/${ordered.length} txs, ${ingested} events)`,
        );
      }
    }

    const top = ordered.reduce((m, [, f]) => (f.slot > m ? f.slot : m), head);
    for (const w of this.watches) {
      if (top <= cursors.get(cursorId(w))!) continue;
      await saveCursor(this.cfg.name, cursorId(w), top);
    }
    this.tip = top;
    if (found.size > 0) {
      log.info(`[${this.cfg.name}] ingested ${ingested} events from ${found.size} txs, at ${top}`);
    }
  }

  /**
   * The decoded events the watches that found a transaction keep: from a program a watch keeps, in
   * a transaction found through that watch's `via`, past its cursor, passing its topic filter.
   *
   * @param tx The transaction.
   * @param f Where it was found.
   * @param cursors Each watch's cursor.
   * @param decoded What it did.
   */
  private extract(tx: Tx, f: Found, cursors: Map<string, bigint>, decoded: Decoded[]): RawEvent[] {
    return decoded
      .filter((d) =>
        this.watches.some(
          (w) =>
            w.at.includes(d.program) &&
            cursors.get(cursorId(w))! < f.slot &&
            (w.via ?? w.at).some((a) => f.via.has(a)) &&
            topicsMatch(d.topics, w.topics),
        ),
      )
      .map((d) => ({
        txHash: tx.transaction.signatures[0],
        logIndex: d.index,
        address: d.program,
        blockNumber: f.slot,
        blockTimestamp: (tx.blockTime ?? 0) * 1000,
        topics: d.topics,
        data: JSON.stringify(d.data),
        sender: tx.transaction.message.accountKeys[0],
      }));
  }
}
