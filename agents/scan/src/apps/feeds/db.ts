import { pool } from "../../db";

import type { Feed } from "./feeds";

/** A receiver refuses an update older than this — `OracleReceiver.maxPriceAge`, never changed. */
const MAX_AGE_S = 300;

/** Points a full chart is thinned to, and a card's sparkline. */
const CHART_POINTS = 500;
const SPARK_POINTS = 60;

/** How long an update is kept — Postgres has no TTL, so the app prunes. A month of history is enough. */
export const RETENTION_S = 30 * 86_400;

/** How far back a chart reaches, by the range a page asks for. Nothing is kept past the longest. */
export const RANGES: Record<string, number | null> = {
  "24h": 86_400,
  "7d": 7 * 86_400,
  "30d": RETENTION_S,
};

/**
 * Drop updates older than the retention. The event store keeps them, so a rebuild brings them back
 * — until the next prune.
 *
 * @returns How many went.
 */
export async function prune(): Promise<number> {
  const r = await pool.query(
    `DELETE FROM oracle_updates WHERE vaa_time < EXTRACT(EPOCH FROM NOW())::bigint - $1`,
    [RETENTION_S],
  );
  return r.rowCount ?? 0;
}

/**
 * Where an update stands. A publish the receiver never wrote is pending while it could still land,
 * and expired once the receiver would refuse it.
 */
const STATUS = `CASE WHEN state = 'delivered' THEN 'delivered'
                     WHEN vaa_time < EXTRACT(EPOCH FROM NOW())::bigint - ${MAX_AGE_S} THEN 'expired'
                     ELSE 'pending' END`;

/** One update, as the pages read it. */
export interface UpdateView {
  id: string;
  /** The VAA's timestamp — when it was published — unix ms. */
  time: number;
  /** When the receiver wrote it into the oracle, unix ms; null until it has. */
  deliveredAt: number | null;
  value: string;
  status: string;
  sequence: string | null;
  vaa_id: string | null;
  source_chain: string;
  dest_chain: string | null;
  published: Record<string, unknown> | null;
  delivered: Record<string, unknown> | null;
}

/**
 * Rows of a feed, as the pages read them.
 *
 * @param r A row of `oracle_updates`, with `status`.
 */
const view = (r: Record<string, any>): UpdateView => ({
  id: r.id,
  time: Number(r.vaa_time) * 1000,
  deliveredAt: r.delivered ? Number(r.delivered.blockTimestamp) : null,
  value: r.value,
  status: r.status,
  sequence: r.sequence,
  vaa_id: r.vaa_id,
  source_chain: r.source_chain,
  dest_chain: r.dest_chain,
  published: r.published,
  delivered: r.delivered,
});

/**
 * A series thinned to at most `points`: the last value in each of as many equal spans of time. The
 * last point always survives, so a chart ends where the feed is now.
 *
 * @param rows Oldest first: unix ms, value, status.
 * @param points The most to keep.
 */
function thin(rows: [number, string, string][], points: number): [number, string, string][] {
  if (rows.length <= points) return rows;
  const t0 = rows[0][0];
  const span = (rows[rows.length - 1][0] - t0) / points || 1;
  const out = new Map<number, [number, string, string]>();
  for (const r of rows) out.set(Math.min(points - 1, Math.floor((r[0] - t0) / span)), r);
  return [...out.values()];
}

/** When a row's receiver wrote it, unix ms. */
const WRITTEN = `(delivered->>'blockTimestamp')::bigint`;

/**
 * The oracle's own history since a moment, oldest first: each value its receiver wrote, at the
 * moment it wrote it. A publish never delivered never moved the oracle, so it is not a point.
 *
 * @param f The feed.
 * @param sinceMs Unix ms, or null for all of it.
 */
async function points(f: Feed, sinceMs: number | null): Promise<[number, string, string][]> {
  const r = await pool.query(
    `SELECT ${WRITTEN} AS t, value FROM oracle_updates
      WHERE asset_id = $1 AND source_chain = $2 AND state = 'delivered'
        AND ($3::bigint IS NULL OR ${WRITTEN} >= $3)
      ORDER BY ${WRITTEN}`,
    [f.assetId, f.source, sinceMs],
  );
  return r.rows.map((x) => [Number(x.t), x.value, "delivered"]);
}

/**
 * The newest delivery indexed on each destination, unix ms — how far its receivers have been read.
 * A destination still backfilling has none recent, and a feed landing there cannot be called dead
 * for want of one.
 */
export async function deliveredUpTo(): Promise<Record<string, number>> {
  const r = await pool.query(
    `SELECT dest_chain, MAX(${WRITTEN}) AS t FROM oracle_updates
      WHERE state = 'delivered' GROUP BY dest_chain`,
  );
  return Object.fromEntries(r.rows.map((x) => [x.dest_chain, Number(x.t)]));
}

/**
 * Every feed as its oracle stands: the last value its receiver wrote and when, how many it wrote
 * over the last day, and a week of them as a sparkline — beside how many its emitter published, which
 * is more wherever the receiver refused some.
 *
 * @param feeds The registry.
 */
export async function overview(feeds: Feed[]) {
  const week = Date.now() - RANGES["7d"]! * 1000;
  return Promise.all(
    feeds.map(async (f) => {
      const [delivered, day] = await Promise.all([
        pool.query(
          `SELECT *, 'delivered' AS status FROM oracle_updates
            WHERE asset_id = $1 AND source_chain = $2 AND state = 'delivered'
            ORDER BY ${WRITTEN} DESC LIMIT 1`,
          [f.assetId, f.source],
        ),
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE state = 'delivered'
                                     AND ${WRITTEN} >= (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint - 86400000)::int AS written,
                  COUNT(*) FILTER (WHERE vaa_time >= EXTRACT(EPOCH FROM NOW())::bigint - 86400)::int AS published
             FROM oracle_updates WHERE asset_id = $1 AND source_chain = $2`,
          [f.assetId, f.source],
        ),
      ]);
      return {
        ...f,
        delivered: delivered.rows[0] ? view(delivered.rows[0]) : null,
        updates24h: day.rows[0].written,
        published24h: day.rows[0].published,
        spark: thin(await points(f, week), SPARK_POINTS).map(([t, v]) => [t, v]),
      };
    }),
  );
}

/**
 * A feed's chart over a range.
 *
 * @param f The feed.
 * @param range A key of `RANGES`.
 */
export async function series(f: Feed, range: string) {
  const back = RANGES[range] ?? null;
  const since = back === null ? null : Date.now() - back * 1000;
  return { range, points: thin(await points(f, since), CHART_POINTS) };
}

/**
 * A feed's updates, newest first.
 *
 * @param f The feed.
 * @param limit Page size.
 * @param offset Rows to skip.
 */
export async function updatesOf(f: Feed, limit: number, offset: number) {
  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT *, ${STATUS} AS status FROM oracle_updates
        WHERE asset_id = $1 AND source_chain = $2
        ORDER BY vaa_time DESC LIMIT $3 OFFSET $4`,
      [f.assetId, f.source, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM oracle_updates WHERE asset_id = $1 AND source_chain = $2`,
      [f.assetId, f.source],
    ),
  ]);
  return { items: rows.rows.map(view), total: total.rows[0].n };
}
