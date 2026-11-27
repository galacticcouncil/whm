import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Alerter, AlertLog } from "./notify";

/** The Redis calls incidents use — an ioredis client satisfies it. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

/** One failed attempt a person has to look at before the bot tries again. */
export interface Incident {
  /** What failed — an `auth_path`, an `A`. */
  id: string;
  reason: string;
  /** Unix ms. */
  at: number;
}

interface Stored extends Incident {
  token: string;
}

export interface IncidentsOptions {
  redis: RedisLike;
  /** Key prefix, e.g. the app's own. */
  prefix: string;
  /** The app, in every alert. */
  app: string;
  alerter: Alerter;
  /** Where the bot's `/reprocess` page is reachable; without it alerts carry no link. */
  publicUrl?: string;
  /** Redeems allowed per hour, across all incidents — a leaked link cannot buy many signatures. */
  maxRedeemsPerHour?: number;
  log?: AlertLog;
  now?: () => number;
}

/**
 * Failed attempts that stop a bot from trying again on its own. A bot pays for a signature before
 * the step that can fail, so it tries once: a failure opens an incident, posts it with a link, and
 * the bot leaves that id alone until a person reprocesses it — the link's token is good for one
 * reprocess. Kept in Redis, so a restart remembers them.
 */
export class Incidents {
  private readonly redeems: number[] = [];

  constructor(private readonly o: IncidentsOptions) {}

  private key(id: string): string {
    return `${this.o.prefix}:incident:${id}`;
  }

  private get index(): string {
    return `${this.o.prefix}:incidents`;
  }

  /**
   * Open an incident for `id`, unless one is open, and alert it.
   *
   * @param id What failed.
   * @param reason Why — shown in the alert and on `/api/status`.
   */
  async open(id: string, reason: string): Promise<void> {
    if (await this.get(id)) return;
    const now = (this.o.now ?? Date.now)();
    const token = randomBytes(24).toString("base64url");
    const stored: Stored = { id, reason, at: now, token };
    await this.o.redis.set(this.key(id), JSON.stringify(stored));
    await this.o.redis.sadd(this.index, id);
    const link = this.o.publicUrl ? `\nReprocess once: ${this.o.publicUrl.replace(/\/$/, "")}/reprocess/${encodeURIComponent(id)}?token=${token}` : "";
    this.o.alerter.alert(`incident:${id}`, String(now), `🔴 **${this.o.app}** stopped on \`${id}\`: ${reason.slice(0, 1200)}${link}`);
  }

  /**
   * @param id What failed.
   * @returns Its open incident, if any — without its token.
   */
  async get(id: string): Promise<Incident | undefined> {
    const raw = await this.o.redis.get(this.key(id));
    if (!raw) return undefined;
    const { token: _token, ...incident } = JSON.parse(raw) as Stored;
    return incident;
  }

  /** @returns Every open incident, oldest first — without tokens. */
  async list(): Promise<Incident[]> {
    const ids = await this.o.redis.smembers(this.index);
    const all = await Promise.all(ids.map((id) => this.get(id)));
    return all.filter((i): i is Incident => i !== undefined).sort((a, b) => a.at - b.at);
  }

  /**
   * Close `id`'s incident with its token, so the bot tries once more. Good once.
   *
   * @param id What failed.
   * @param token The token from the alert's link.
   * @returns `ok`, or why not.
   */
  async redeem(id: string, token: string): Promise<"ok" | "unknown" | "limited"> {
    const now = (this.o.now ?? Date.now)();
    while (this.redeems.length && now - this.redeems[0] > 3_600_000) this.redeems.shift();
    if (this.redeems.length >= (this.o.maxRedeemsPerHour ?? 10)) return "limited";

    const raw = await this.o.redis.get(this.key(id));
    if (!raw) return "unknown";
    const stored = JSON.parse(raw) as Stored;
    const given = Buffer.from(token);
    const expected = Buffer.from(stored.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "unknown";

    this.redeems.push(now);
    await this.o.redis.del(this.key(id));
    await this.o.redis.srem(this.index, id);
    this.o.alerter.clear(`incident:${id}`);
    (this.o.log ?? console).warn(`[${this.o.app}] ${id} reprocessed — the next pass tries once more`);
    return "ok";
  }
}

/**
 * The page an alert links to. Opening it changes nothing — Discord fetches links to preview them —
 * its button posts the token.
 *
 * @param app The app.
 * @param id What failed.
 * @param token The token from the link.
 * @returns HTML.
 */
export function reprocessPage(app: string, id: string, token: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reprocess</title>
<body style="font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">${esc(app)}: reprocess</h1><p><code style="word-break:break-all">${esc(id)}</code></p>
<p>The bot tries once more on its next pass. It may sign again, which its account pays for.</p>
<button id="go" style="font:inherit;padding:.5rem 1rem">Reprocess once</button><p id="out"></p>
<script>
document.getElementById("go").onclick = async (e) => {
  e.target.disabled = true;
  const r = await fetch(location.pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ${JSON.stringify(token)} }) });
  document.getElementById("out").textContent = r.ok ? "Done — the next pass tries once more." : "Refused: " + (await r.text());
};
</script></body>`;
}
