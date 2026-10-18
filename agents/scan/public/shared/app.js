/**
 * Shared page helpers. No framework and no build step — every page is one file the server reads at
 * boot, so this stays small enough to read in one sitting.
 *
 * Everything here that renders a value returns HTML and escapes its own inputs — `asset`, `badge`,
 * `kv`, `legCard`, and every `*Link`. Wrapping one of them in `esc()` escapes the markup too and
 * prints the tags. `esc()` is for raw values a page interpolates itself, and nothing else.
 */

const HDX_LOGO = `<svg class="logo" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M18.0532 11.3604C18.2827 11.1319 18.5778 10.8381 18.8718 10.5463C19.5265 9.89543 19.5265 8.83853 18.8718 8.18664L18.1782 7.49598C15.6959 9.96786 11.982 10.4637 9.00484 8.98646C11.017 9.35678 13.1028 9.06807 14.951 8.0785C16.1876 7.41641 16.4222 5.74741 15.4295 4.75886L11.3366 0.683262C10.4217 -0.227754 8.93928 -0.227754 8.02542 0.683262L3.61392 5.07613C6.51941 3.84682 10.0089 4.4171 12.3714 6.78594C8.76716 5.04349 4.30136 5.66171 1.3088 8.64164C1.07931 8.87016 0.78323 9.16499 0.490223 9.45676C-0.163408 10.1086 -0.163408 11.1645 0.490223 11.8154L1.18279 12.505C3.66515 10.0332 7.37896 9.53735 10.3562 11.0146C8.34404 10.6442 6.25816 10.933 4.40996 11.9225C3.17339 12.5846 2.93878 14.2536 3.93152 15.2422L8.0244 19.3178C8.93928 20.2288 10.4217 20.2288 11.3356 19.3178L15.7471 14.9249C12.8416 16.1542 9.35215 15.5839 6.98965 13.2151C10.5938 14.9575 15.0596 14.3393 18.0522 11.3594L18.0532 11.3604Z"></path></svg>`;

/**
 * Render the top bar. Same shape as the explorer's — mark, wordmark, pill nav, right-hand cluster —
 * so the two sit beside each other without looking like different products.
 *
 * @param {string} domain Wordmark suffix, where the explorer says "Explorer".
 * @param {Array<[string, string]>} links `[href, label]`; the one matching the path is current.
 */
export function topbar(domain, links = []) {
  const here = location.pathname;
  const nav = links
    .map(([href, label]) => {
      const active = href === "/" ? here === "/" : here.startsWith(href);
      return `<a href="${href}"${active ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
    })
    .join("");

  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div class="topbar"><div class="wrap">
       <a class="brand" href="/">${HDX_LOGO}<span class="wm">Hydration</span><span class="pr">${esc(domain)}</span></a>
       ${nav ? `<nav class="nav">${nav}</nav>` : ""}
       <div class="topbar-right">
         <span class="conn"><span class="dot"></span><span class="label">connecting</span></span>
         <button class="theme" type="button" title="Toggle theme"></button>
       </div>
     </div></div>`,
  );
  theme.init();
}

/** Theme, remembered per browser under the same key the explorer uses. */
export const theme = {
  KEY: "explorer-theme",
  init() {
    const btn = document.querySelector(".theme");
    if (!btn) return;
    const paint = () => {
      btn.textContent =
        document.documentElement.dataset.theme === "light" ? "◐" : "◑";
    };
    btn.addEventListener("click", () => {
      const next =
        document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(theme.KEY, next);
      } catch {}
      paint();
    });
    paint();
  },
};

/**
 * Fetch JSON, returning null rather than throwing — a page renders "—" far better than a blank
 * screen with an error in the console.
 *
 * @param {string} url
 */
export async function json(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/**
 * Subscribe to the domain's row changes and flip the connection dot.
 *
 * Nothing replays what a dropped connection missed — there is no Last-Event-ID handling — so the
 * page is told when the stream (re)opens and refetches, rather than sitting on a view that quietly
 * stopped being live.
 *
 * @param {string} flow Flow name to filter to.
 * @param {(update: object) => void} onUpdate
 * @param {() => void} [onOpen] Called on every successful connect, first one included.
 */
export function live(flow, onUpdate, onOpen) {
  const dot = document.querySelector(".conn .dot");
  const label = document.querySelector(".conn .label");
  const es = new EventSource(`/api/events?flow=${encodeURIComponent(flow)}`);
  const mark = (up) => {
    if (dot) dot.classList.toggle("live", up);
    if (label) label.textContent = up ? "live" : "reconnecting";
  };
  es.onopen = () => {
    mark(true);
    onOpen?.();
  };
  es.onerror = () => mark(false);
  for (const kind of ["created", "updated"]) {
    es.addEventListener(kind, (e) => {
      try {
        onUpdate(JSON.parse(e.data));
      } catch {}
    });
  }
  return es;
}

// ─── Explorers ────────────────────────────────────────────────

const HYDRATION_EXPLORER = "https://hydration-explorer.neckwork.net";

/** Whether a reference has a real transaction behind it, rather than a block-and-event identity. */
const hasTx = (r) => !!r.txHash && !r.txHash.includes("-");

/**
 * A chain's own explorer for one event reference.
 *
 * Hydration's EVM logs are substrate events. Most come in as an ethereum call and do carry a
 * transaction — that is what a reader expects to be shown, so link it. The landing's XCM-driven
 * deliveries carry none at all, and those fall back to the block-and-event identity, which is the
 * only name they have.
 */
const EVENT_URL = {
  hydration: (r) =>
    hasTx(r)
      ? `${HYDRATION_EXPLORER}/extrinsic/${r.txHash}`
      : `${HYDRATION_EXPLORER}/event/${r.blockNumber}-${r.logIndex}`,
  ethereum: (r) => `https://etherscan.io/tx/${r.txHash}`,
  base: (r) => `https://basescan.org/tx/${r.txHash}`,
  near: (r) => `https://nearblocks.io/txns/${r.txHash}`,
  zcash: (r) => `https://blockchair.com/zcash/transaction/${r.txHash}`,
  hyperevm: (r) => `https://hyperevmscan.io/tx/${r.txHash}`,
};

const EVENT_LABEL = {
  hydration: (r) =>
    hasTx(r) ? short(r.txHash, 10, 8) : `${r.blockNumber}-${r.logIndex}`,
  ethereum: (r) => short(r.txHash, 10, 8),
  base: (r) => short(r.txHash, 10, 8),
  near: (r) => short(r.txHash, 8, 6),
  zcash: (r) => short(r.txHash, 10, 8),
  hyperevm: (r) => short(r.txHash, 10, 8),
  robinhood: (r) => short(r.txHash, 10, 8),
};

const ADDR_URL = {
  hydration: (a) => `${HYDRATION_EXPLORER}/account/${encodeURIComponent(a)}`,
  ethereum: (a) => `https://etherscan.io/address/${a}`,
  base: (a) => `https://basescan.org/address/${a}`,
  near: (a) => `https://nearblocks.io/address/${a}`,
  zcash: (a) => `https://blockchair.com/zcash/address/${a}`,
  hyperevm: (a) => `https://hyperevmscan.io/address/${a}`,
};

/**
 * Where the user's asset actually lands, keyed by the 1Click `blockchain` value.
 *
 * The destination is whatever the quote named, not a fixed chain. These are the ones we can link
 * today; anything else renders as plain text rather than a wrong link, so adding a chain is adding
 * an entry here and nothing else.
 */
const DEST_ADDR_URL = {
  near: (a) => `https://nearblocks.io/address/${a}`,
  zec: (a) => `https://blockchair.com/zcash/address/${a}`,
  btc: (a) => `https://blockchair.com/bitcoin/address/${a}`,
};

const DEST_TX_URL = {
  near: (h) => `https://nearblocks.io/txns/${h}`,
  zec: (h) => `https://3xpl.com/zcash/transaction/${h}`,
  btc: (h) => `https://blockchair.com/bitcoin/transaction/${h}`,
};

/** The whole 1Click execution, keyed by the deposit address it was quoted for. */
export const nearIntentsUrl = (deposit) =>
  `https://explorer.near-intents.org/transactions/${deposit}`;

// ─── Icons ────────────────────────────────────────────────────

const METADATA =
  "https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@latest/v2";

/**
 * Chain marks, by our chain name and by 1Click's `blockchain` value alike — the destination is
 * whichever chain the quote named, so both vocabularies land here.
 */
const CHAIN_ICON = {
  hydration: `${METADATA}/polkadot/2034/icon.svg`,
  ethereum: `${METADATA}/ethereum/1/icon.svg`,
  // The registry has no Base mark.
  base: "https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/base/info/logo.png",
  hyperevm: `${METADATA}/ethereum/999/icon.svg`,
  robinhood: `${METADATA}/ethereum/4663/icon.svg`,
  wormhole:
    "https://cdn.jsdelivr.net/gh/sodazone/intergalactic-asset-metadata/v2/wormhole/1/icon.svg",
  eth: `${METADATA}/ethereum/1/icon.svg`,
  near: "https://s2.coinmarketcap.com/static/img/coins/64x64/6535.png",
  zec: "https://s2.coinmarketcap.com/static/img/coins/64x64/1437.png",
  zcash: "https://s2.coinmarketcap.com/static/img/coins/64x64/1437.png",
  btc: "https://s2.coinmarketcap.com/static/img/coins/64x64/1.png",
};

/**
 * A Hydration asset's own mark. Coverage is partial — the registry has no icon for every id — and a
 * miss removes the image rather than leaving a broken one, so the symbol beside it still reads.
 *
 * @param id Hydration asset id.
 */
export const assetIcon = (id) =>
  id === null || id === undefined
    ? null
    : `${METADATA}/polkadot/2034/assets/${id}/icon.svg`;

/**
 * @param chain Chain name, or a 1Click `blockchain` value.
 */
export const chainIcon = (chain) => CHAIN_ICON[chain] ?? null;

/**
 * A small round mark that deletes itself if the source 404s, which the asset registry regularly
 * does. Never the only carrier of meaning — a symbol or a name always sits beside it.
 *
 * `name` becomes a class, so a mark that cannot stand on its own gets styled for it: Wormhole's is
 * a solid white glyph with no backdrop and disappears entirely on a light panel.
 *
 * @param {string|null} src
 * @param {string} [alt]
 * @param {string} [name] Chain or asset name, slugified into `icon-<name>`.
 */
export function icon(src, alt, name) {
  if (!src) return "";
  const slug = name
    ? ` icon-${String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}`
    : "";
  return `<img class="icon${slug}" src="${esc(src)}" alt="${esc(alt ?? "")}" loading="lazy" onerror="this.remove()">`;
}

/**
 * Link an event reference to its chain's explorer.
 *
 * @param {{chain: string, txHash: string, blockNumber: string, logIndex: number}|null} ref
 */
export function eventLink(ref) {
  if (!ref) return '<span class="dim">—</span>';
  const url = EVENT_URL[ref.chain]?.(ref);
  const text = esc(
    (EVENT_LABEL[ref.chain] ?? ((r) => short(r.txHash, 10, 8)))(ref),
  );
  return url
    ? `<a class="link" href="${url}" target="_blank" rel="noreferrer">${text}</a>`
    : text;
}

/**
 * Link an address on a given chain.
 *
 * @param {string|null} address
 * @param {string} chain Chain name, or a 1Click `blockchain` value for the destination.
 */
export function addrLink(address, chain) {
  if (!address) return '<span class="dim">—</span>';
  const url = ADDR_URL[chain]?.(address) ?? DEST_ADDR_URL[chain]?.(address);
  const text = esc(short(address, 8, 6));
  return url
    ? `<a class="link" href="${url}" target="_blank" rel="noreferrer">${text}</a>`
    : text;
}

/**
 * Link a transaction on a chain that has no event reference for it — a coin's payout, a deposit
 * paid on its own chain.
 *
 * @param {string|null} hash
 * @param {string} chain
 */
export function txLink(hash, chain) {
  if (!hash) return '<span class="dim">—</span>';
  return eventLink({ chain, txHash: hash, blockNumber: "", logIndex: 0 });
}

/** Wormholescan for a VAA id, which is already in `chain/emitter/sequence` form. */
export function vaaLink(vaaId) {
  if (!vaaId) return '<span class="dim">—</span>';
  return `<a class="link" href="https://wormholescan.io/#/tx/${esc(vaaId)}" target="_blank" rel="noreferrer">${esc(short(vaaId, 12, 8))}</a>`;
}

/**
 * Link the destination-chain settlement transaction, preferring whatever 1Click gave us. A chain we
 * cannot link renders as plain text — a wrong explorer is worse than none.
 *
 * @param {string|null} hash
 * @param {string|null} url 1Click's own explorer url, when it supplied one.
 * @param {string|null} chain 1Click `blockchain` value.
 */
export function destTxLink(hash, url, chain) {
  if (!hash) return null;
  const href = url || DEST_TX_URL[chain]?.(hash);
  const text = esc(short(hash, 10, 8));
  return href
    ? `<a class="link" href="${esc(href)}" target="_blank" rel="noreferrer">${text}</a>`
    : text;
}

// ─── Formatting ───────────────────────────────────────────────

/** Shorten a hash or address to its ends, which is all anyone reads. */
export function short(v, head = 6, tail = 4) {
  if (!v) return "—";
  const s = String(v);
  return s.length > head + tail + 2
    ? `${s.slice(0, head)}…${s.slice(-tail)}`
    : s;
}

/**
 * A raw integer amount at a given precision, kept to a few significant figures.
 *
 * @param {string|number|bigint|null} raw
 * @param {number} decimals
 * @param {number} sig Significant figures.
 */
export function amount(raw, decimals = 18, sig = 4) {
  if (raw === null || raw === undefined || raw === "") return "—";
  try {
    const n = Number(BigInt(String(raw).split(".")[0])) / 10 ** decimals;
    if (!isFinite(n)) return String(raw);
    return n.toLocaleString("en-US", { maximumSignificantDigits: sig });
  } catch {
    return String(raw);
  }
}

/**
 * Format an amount with its symbol, from whichever token list it belongs to.
 *
 * Returns a chip — mark, amount and symbol on one centred row — so it aligns the same wherever it
 * is dropped: a table cell, a key/value row, or a leg card.
 *
 * @param {string|null} raw
 * @param {{symbol: string, decimals: number}|undefined} meta
 * @param {string} fallback Shown in place of a symbol we do not know.
 */
export function asset(raw, meta, fallback = "", iconUrl = null) {
  if (raw === null || raw === undefined) return '<span class="dim">—</span>';
  const value = amount(raw, meta?.decimals ?? 18, 4);
  const symbol = meta?.symbol ?? fallback;
  return `<span class="asset-chip">${icon(iconUrl, symbol, symbol)}${esc(value)}${symbol ? `<span class="sym">${esc(symbol)}</span>` : ""}</span>`;
}

/** Unix ms to a compact age. Block timestamps are ms, written at ingest. */
export function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Absolute time for a title attribute, where the exact moment matters. */
export function at(ms) {
  return ms
    ? new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 19) + "Z"
    : "";
}

/** How long one leg took to follow another. */
export function elapsed(fromMs, toMs) {
  if (!fromMs || !toMs) return "";
  const s = Math.max(0, Math.round((Number(toMs) - Number(fromMs)) / 1000));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.round(s / 60)}m`
      : `${Math.round(s / 3600)}h`;
}

export function badge(state) {
  return `<span class="badge ${esc(state ?? "")}">${esc(state ?? "—")}</span>`;
}

/** Escape untrusted text before it goes into innerHTML. */
export function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// ─── Legs ─────────────────────────────────────────────────────

/**
 * One hop of the route.
 *
 * A hop that has not happened is dimmed rather than dropped, because where a transfer stopped is
 * the thing worth seeing. `held` marks the one state that needs a human: the destination rate
 * limiter is holding the settlement and nothing has been credited.
 *
 * @param {object} leg `{where, kind, ref, rows, pending, held}` — `rows` are extra `[label, html]`.
 */
export function legCard({
  where,
  kind,
  ref,
  rows = [],
  pending = false,
  held = false,
  since,
}) {
  const done = !pending && (ref || rows.length);
  const body = [
    ref ? ["", eventLink(ref)] : null,
    ref ? ["", `<span class="dim">block ${esc(ref.blockNumber)}</span>`] : null,
    ...rows,
  ]
    .filter(Boolean)
    .map(([label, html]) =>
      label
        ? `<div>${esc(label)} <span class="v">${html}</span></div>`
        : `<div>${html}</div>`,
    )
    .join("");

  const when = ref?.blockTimestamp;
  const gap = since && when ? elapsed(since, when) : "";

  return `
    <div class="leg${done ? "" : " pending"}${held ? " held" : ""}">
      <div class="leg-head">
        <div class="leg-title">
          ${icon(chainIcon(where), where, where)}<span class="where">${esc(where)}</span>
          <span class="leg-kind${done ? "" : " pending"}">${esc(kind)}</span>
        </div>
        ${done ? '<span class="check">✓</span>' : ""}
      </div>
      <div class="leg-body">
        ${body || '<div class="dim">not yet</div>'}
        ${when ? `<div class="dim" title="${at(when)}">${ago(when)} ago${gap ? ` · +${gap}` : ""}</div>` : ""}
      </div>
    </div>`;
}

/** A key/value row, in the explorer's 220px grid. */
export function kv(label, html) {
  return `<div class="kv-row"><div class="kk">${esc(label)}</div><div class="vv">${html}</div></div>`;
}
