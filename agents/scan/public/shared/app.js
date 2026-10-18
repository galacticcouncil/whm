/**
 * Shared page helpers. No framework and no build step — every page is one file the server reads at
 * boot, so this stays small enough to read in one sitting.
 *
 * The components are the Hydration explorer's (hydration-neckwork/explorer-ui), ported to strings of
 * HTML: the address pill, chain badge, asset icon, status badge, copy button and pager render the
 * same markup its React components do, so the shared stylesheet styles both alike.
 *
 * Everything here that renders a value returns HTML and escapes its own inputs. `esc()` is for raw
 * values a page interpolates itself, and nothing else.
 */

const HDX_LOGO = `<svg class="logo" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M18.0532 11.3604C18.2827 11.1319 18.5778 10.8381 18.8718 10.5463C19.5265 9.89543 19.5265 8.83853 18.8718 8.18664L18.1782 7.49598C15.6959 9.96786 11.982 10.4637 9.00484 8.98646C11.017 9.35678 13.1028 9.06807 14.951 8.0785C16.1876 7.41641 16.4222 5.74741 15.4295 4.75886L11.3366 0.683262C10.4217 -0.227754 8.93928 -0.227754 8.02542 0.683262L3.61392 5.07613C6.51941 3.84682 10.0089 4.4171 12.3714 6.78594C8.76716 5.04349 4.30136 5.66171 1.3088 8.64164C1.07931 8.87016 0.78323 9.16499 0.490223 9.45676C-0.163408 10.1086 -0.163408 11.1645 0.490223 11.8154L1.18279 12.505C3.66515 10.0332 7.37896 9.53735 10.3562 11.0146C8.34404 10.6442 6.25816 10.933 4.40996 11.9225C3.17339 12.5846 2.93878 14.2536 3.93152 15.2422L8.0244 19.3178C8.93928 20.2288 10.4217 20.2288 11.3356 19.3178L15.7471 14.9249C12.8416 16.1542 9.35215 15.5839 6.98965 13.2151C10.5938 14.9575 15.0596 14.3393 18.0522 11.3594L18.0532 11.3604Z"></path></svg>`;

/**
 * Render the top bar. Same shape as the explorer's — mark, wordmark, pill nav, right-hand cluster.
 *
 * @param {string} domain Wordmark suffix, where the explorer says "Explorer".
 * @param {Array<[string, string]>} links `[href, label]`; the one matching the path is current.
 * @param {{conn?: boolean}} [opts] `conn: false` when the page shows its live state itself.
 */
export function topbar(domain, links = [], opts = {}) {
  const here = location.pathname;
  const nav = links
    .map(([href, label]) => {
      const active = href === "/" ? here === "/" : here.startsWith(href);
      return `<a href="${href}"${active ? ' aria-current="page"' : ""}>${esc(label)}</a>`;
    })
    .join("");
  const conn =
    opts.conn === false
      ? ""
      : '<span class="conn"><span class="dot"></span><span class="label">connecting</span></span>';

  const burger = nav
    ? `<button class="nav-burger" type="button" aria-label="Open menu" aria-haspopup="dialog">${BURGER}</button>`
    : "";

  document.body.insertAdjacentHTML(
    "afterbegin",
    `<div class="topbar"><div class="wrap">
       <a class="brand" href="/">${HDX_LOGO}<span class="wm">Hydration</span><span class="pr">${esc(domain)}</span></a>
       ${nav ? `<nav class="nav">${nav}</nav>` : ""}
       <div class="topbar-right">${conn}<button class="theme" type="button" title="Toggle theme"></button>${burger}</div>
     </div></div>`,
  );
  theme.init();
  document.querySelector(".nav-burger")?.addEventListener("click", () => drawer(domain, nav));
}

const BURGER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
const CLOSE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

/**
 * The explorer's mobile menu: a drawer from the right holding the nav the top bar hides below
 * 860px. The theme stays in the top bar, beside the burger. Closes on the scrim, the close button,
 * a link or Escape.
 *
 * @param {string} domain Wordmark suffix.
 * @param {string} nav The nav's links, as rendered for the top bar.
 */
function drawer(domain, nav) {
  const scrim = document.createElement("div");
  scrim.className = "drawer-scrim";
  scrim.innerHTML = `
    <nav class="drawer" role="dialog" aria-modal="true" aria-label="Menu">
      <div class="drawer-head">
        <span class="brand"><span class="wm">Hydration</span><span class="pr">${esc(domain)}</span></span>
        <button class="theme drawer-close" type="button" aria-label="Close menu">${CLOSE}</button>
      </div>
      <div class="drawer-sec"><div class="sec-lbl">Navigate</div>${nav.replace(/aria-current="page"/g, 'aria-current="page" class="active"')}</div>
    </nav>`;
  const close = () => {
    scrim.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => e.key === "Escape" && close();
  scrim.addEventListener("click", (e) => {
    if (e.target === scrim || e.target.closest(".drawer-close, .drawer-sec > a")) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(scrim);
}

/** Theme, remembered per browser under the same key the explorer uses. */
export const theme = {
  KEY: "explorer-theme",
  init(btn = document.querySelector(".topbar .theme")) {
    if (!btn) return;
    const paint = () => {
      btn.textContent = document.documentElement.dataset.theme === "light" ? "◐" : "◑";
    };
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(theme.KEY, next);
      } catch {}
      for (const b of document.querySelectorAll(".theme:not(.drawer-close)")) {
        b.textContent = next === "light" ? "◐" : "◑";
      }
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
 * Subscribe to the domain's row changes and flip every connection dot on the page.
 *
 * Nothing replays what a dropped connection missed, so the page is told when the stream (re)opens
 * and refetches, rather than sitting on a view that quietly stopped being live.
 *
 * @param {string} flows Flow names to follow, comma-separated.
 * @param {(update: object) => void} onUpdate
 * @param {() => void} [onOpen] Called on every successful connect, first one included.
 */
export function live(flows, onUpdate, onOpen) {
  const es = new EventSource(`/api/events?flow=${encodeURIComponent(flows)}`);
  const mark = (up) => {
    for (const dot of document.querySelectorAll(".conn .dot")) dot.classList.toggle("live", up);
    for (const label of document.querySelectorAll(".conn .label")) {
      label.textContent = up ? "live" : "reconnecting";
    }
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

// ─── Chains ───────────────────────────────────────────────────

const HYDRATION_EXPLORER = "https://hydration-explorer.neckwork.net";
const METADATA = "https://cdn.jsdelivr.net/gh/galacticcouncil/intergalactic-asset-metadata@latest/v2";

/** Whether a reference has a real transaction behind it, rather than a block-and-event identity. */
const hasTx = (r) => !!r.txHash && !r.txHash.includes("-");

/**
 * Every chain a transfer can touch: its label, its badge colours (the explorer's CHAIN_COLORS —
 * gradient from, to, and a text colour where white would not read), its mark, and its explorer.
 * A chain missing here still renders, as a grey badge with plain-text addresses — a wrong explorer
 * is worse than none.
 */
const CHAINS = {
  hydration: {
    label: "Hydration",
    local: true,
    icon: `${METADATA}/polkadot/2034/icon.svg`,
    // An ethereum call by its hash; a substrate call by its extrinsic; an XCM delivery, which ran in
    // no extrinsic at all, by its event.
    tx: (r) =>
      hasTx(r)
        ? `${HYDRATION_EXPLORER}/extrinsic/${r.txHash}`
        : r.extrinsic
          ? `${HYDRATION_EXPLORER}/extrinsic/${r.extrinsic}`
          : `${HYDRATION_EXPLORER}/event/${r.blockNumber}-${r.logIndex}`,
    addr: (a) => `${HYDRATION_EXPLORER}/account/${encodeURIComponent(a)}`,
  },
  ethereum: {
    label: "Ethereum",
    c: ["#627EEA", "#3c54b8"],
    icon: `${METADATA}/ethereum/1/icon.svg`,
    tx: (r) => `https://etherscan.io/tx/${r.txHash}`,
    addr: (a) => `https://etherscan.io/address/${a}`,
  },
  base: {
    label: "Base",
    c: ["#0052ff", "#0036a8"],
    // The registry has no Base mark.
    icon: "https://cdn.jsdelivr.net/gh/trustwallet/assets@master/blockchains/base/info/logo.png",
    tx: (r) => `https://basescan.org/tx/${r.txHash}`,
    addr: (a) => `https://basescan.org/address/${a}`,
  },
  robinhood: {
    label: "Robinhood",
    c: ["#00C805", "#00a304", "#000"],
    icon: `${METADATA}/ethereum/4663/icon.svg`,
    tx: (r) => `https://robin.etherscan.io/tx/${r.txHash}`,
    addr: (a) => `https://robin.etherscan.io/address/${a}`,
  },
  hyperevm: {
    label: "HyperEVM",
    c: ["#16857a", "#0b4c45"],
    icon: `${METADATA}/ethereum/999/icon.svg`,
    tx: (r) => `https://hyperevmscan.io/tx/${r.txHash}`,
    addr: (a) => `https://hyperevmscan.io/address/${a}`,
  },
  solana: {
    label: "Solana",
    c: ["#9945FF", "#5b21b6"],
    icon: "https://s2.coinmarketcap.com/static/img/coins/64x64/5426.png",
    tx: (r) => `https://solscan.io/tx/${r.txHash}`,
    addr: (a) => `https://solscan.io/account/${a}`,
  },
  near: {
    label: "NEAR",
    c: ["#00c586", "#00875c"],
    icon: "https://s2.coinmarketcap.com/static/img/coins/64x64/6535.png",
    tx: (r) => `https://nearblocks.io/txns/${r.txHash}`,
    addr: (a) => `https://nearblocks.io/address/${a}`,
  },
  zcash: {
    label: "Zcash",
    c: ["#b8860b", "#7a5a08"],
    icon: "https://s2.coinmarketcap.com/static/img/coins/64x64/1437.png",
    tx: (r) => `https://blockchair.com/zcash/transaction/${r.txHash}`,
    addr: (a) => `https://blockchair.com/zcash/address/${a}`,
  },
  wormhole: {
    label: "Wormhole",
    c: ["#3a3f4b", "#1b1e25"],
    icon: "https://cdn.jsdelivr.net/gh/sodazone/intergalactic-asset-metadata/v2/wormhole/1/icon.svg",
  },
};

/** 1Click's `blockchain` values, where the intents domain names a destination chain. */
const ALIAS = { eth: "ethereum", zec: "zcash", sol: "solana" };
const chainOf = (c) => CHAINS[c] ?? CHAINS[ALIAS[c]];

/** The explorer's label for a host, so an external account says where it links. */
const SITES = [
  ["neckwork.net", "Explorer"],
  ["nearblocks.io", "NearBlocks"],
  ["blockchair.com", "Blockchair"],
  ["etherscan.io", "Etherscan"],
  ["basescan.org", "Basescan"],
  ["hyperevmscan.io", "HyperEVMScan"],
  ["solscan.io", "Solscan"],
];

/** @param {string} url */
export function siteName(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "explorer";
  }
  for (const [suffix, name] of SITES) if (host.endsWith(suffix)) return name;
  return host.replace(/^www\./, "");
}

/** @param {string} chain */
export const chainLabel = (chain) => chainOf(chain)?.label ?? chain;

/** A chain's mark, by our chain name or a 1Click `blockchain` value. */
export const chainIcon = (chain) => chainOf(chain)?.icon ?? null;

/**
 * A chain as the explorer badges it: its name on its own gradient. Hydration — always one end —
 * takes the brand accent.
 *
 * @param {string} chain
 */
export function chainBadge(chain) {
  const c = chainOf(chain);
  if (c?.local) return `<span class="chain-badge chain-badge-local" title="Hydration">Hydration</span>`;
  const [from, to, text] = c?.c ?? ["#666", "#444"];
  const style = `background:linear-gradient(135deg,${from},${to})${text ? `;color:${text}` : ""}`;
  return `<span class="chain-badge" style="${style}" title="${esc(c?.label ?? chain)}">${esc(c?.label ?? chain ?? "?")}</span>`;
}

// ─── Accounts ─────────────────────────────────────────────────

const EMOJI_POOL = ["🦊", "🦉", "🦝", "🦌", "🦢", "🐺", "🦅", "🦜", "🐢", "🐝", "🦋", "🐞", "🦂", "🦓", "🦒", "🦔", "🦇", "🐡", "🦈", "🦭", "🦦", "🐌", "🦗", "🦚", "🦩", "🐿️", "🦫", "🐬", "🦏", "🦛", "🐊", "🦣", "🦤", "🦃", "🦙", "🦥"];

/** The explorer's deterministic avatar for an address — the same glyph it shows for it. */
export function emojiFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return EMOJI_POOL[h % EMOJI_POOL.length];
}

/**
 * An address as the explorer shortens it: a head, an ellipsis, and the tail with its last three
 * characters raised — the tail is the identity.
 *
 * @param {string} addr
 */
export function shortAddr(addr) {
  const head = addr.startsWith("0x") ? addr.slice(0, 6) : addr.slice(0, 4);
  const tail = addr.slice(-5);
  return `<span class="addr-head">${esc(head)}…${esc(tail.slice(0, 2))}</span><span class="last3">${esc(tail.slice(-3))}</span>`;
}

const COPY_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const COPIED_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>`;

/**
 * The explorer's icon-only copy button. Clicks are handled once, below, so a button rendered into
 * any string works without wiring.
 *
 * @param {string} text What to copy.
 */
export function copyBtn(text) {
  return `<button type="button" class="copy" title="Copy" aria-label="Copy" data-copy="${esc(text)}">${COPY_ICON}</button>`;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".copy[data-copy]");
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  void navigator.clipboard?.writeText(btn.dataset.copy);
  btn.classList.add("done");
  btn.innerHTML = COPIED_ICON;
  btn.title = "Copied";
  clearTimeout(btn._t);
  btn._t = setTimeout(() => {
    btn.classList.remove("done");
    btn.innerHTML = COPY_ICON;
    btn.title = "Copy";
  }, 1400);
});

/**
 * An account on any chain: avatar, shortened address and a copy button. Off Hydration it links to
 * the chain's own explorer and says which, as the explorer's external-account pill does; a chain
 * with no explorer renders the address unlinked.
 *
 * @param {string|null} address
 * @param {string} chain Chain name, or a 1Click `blockchain` value.
 */
export function addrLink(address, chain) {
  if (!address) return '<span class="dim">—</span>';
  const c = chainOf(chain);
  const url = c?.addr?.(address);
  const site = url && !c.local ? `<span class="ext-site">${esc(siteName(url))}</span>` : "";
  const body = `<span class="emoji">${emojiFor(address)}</span><span class="a mono">${shortAddr(address)}</span>${site}`;
  const pill = url
    ? `<a class="addr-pill" href="${esc(url)}" target="_blank" rel="noreferrer" title="${esc(address)}">${body}</a>`
    : `<span class="addr-pill" title="${esc(address)}">${body}</span>`;
  return `<span class="addr-wrap">${pill}${copyBtn(address)}</span>`;
}

// ─── Transactions ─────────────────────────────────────────────

/**
 * What a reference is called: its transaction hash, or — for a Hydration event that came in without
 * one — its extrinsic, else its event. What is shown, and what a copy button copies.
 *
 * @param {{chain: string, txHash: string, blockNumber: string, logIndex: number, extrinsic?: string}} ref
 */
export function refId(ref) {
  if (ref.chain === "hydration" && !hasTx(ref)) return ref.extrinsic ?? `${ref.blockNumber}-${ref.logIndex}`;
  return ref.txHash;
}

/**
 * Link an event reference to its chain's explorer. Hydration's XCM-driven deliveries carry no
 * transaction, and fall back to the block-and-event identity — the only name they have.
 *
 * @param {{chain: string, txHash: string, blockNumber: string, logIndex: number}|null} ref
 */
export function eventLink(ref) {
  if (!ref) return '<span class="dim">—</span>';
  const url = chainOf(ref.chain)?.tx?.(ref);
  const text = ref.chain === "hydration" && !hasTx(ref) ? refId(ref) : short(ref.txHash, 8, 6);
  const title = url ? `${ref.txHash} · open in ${siteName(url)}` : ref.txHash;
  return url
    ? `<a class="hash" href="${esc(url)}" target="_blank" rel="noreferrer" title="${esc(title)}">${esc(text)}</a>`
    : `<span class="hash" title="${esc(title)}">${esc(text)}</span>`;
}

/**
 * A transaction known only by its hash — a coin's payout, a deposit paid on its own chain.
 *
 * @param {string|null} hash
 * @param {string} chain
 */
export function txLink(hash, chain) {
  if (!hash) return '<span class="dim">—</span>';
  return `<span class="txl">${eventLink({ chain, txHash: hash, blockNumber: "", logIndex: 0 })}${copyBtn(hash)}</span>`;
}

/** Wormholescan for a VAA id, which is already in `chain/emitter/sequence` form. */
export function vaaLink(vaaId) {
  if (!vaaId) return '<span class="dim">—</span>';
  return `<a class="hash" href="https://wormholescan.io/#/tx/${esc(vaaId)}" target="_blank" rel="noreferrer">${esc(short(vaaId, 12, 8))}</a>`;
}

/**
 * The explorer's external-link chip: "Etherscan ↗".
 *
 * @param {string|null} url
 * @param {string} [label] Defaults to the site's name.
 */
export function extLink(url, label) {
  if (!url) return "";
  return `<a class="ext-link" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label ?? siteName(url))} ↗</a>`;
}

/** The explorer for one reference, as a chip — or nothing where the chain has none. */
export function refLink(ref) {
  const url = ref ? chainOf(ref.chain)?.tx?.(ref) : null;
  return url ? extLink(url) : "";
}

/** Where 1Click's destination settlements are linked, by its `blockchain` value. */
const DEST_TX_URL = {
  near: (h) => `https://nearblocks.io/txns/${h}`,
  zec: (h) => `https://3xpl.com/zcash/transaction/${h}`,
  btc: (h) => `https://blockchair.com/bitcoin/transaction/${h}`,
};

/**
 * Link the destination-chain settlement transaction, preferring whatever 1Click gave us.
 *
 * @param {string|null} hash
 * @param {string|null} url 1Click's own explorer url, when it supplied one.
 * @param {string|null} chain 1Click `blockchain` value.
 */
export function destTxLink(hash, url, chain) {
  if (!hash) return null;
  const href = url || DEST_TX_URL[chain]?.(hash);
  const text = esc(short(hash, 10, 8));
  return href ? `<a class="hash" href="${esc(href)}" target="_blank" rel="noreferrer">${text}</a>` : text;
}

/** The whole 1Click execution, keyed by the deposit address it was quoted for. */
export const nearIntentsUrl = (deposit) => `https://explorer.near-intents.org/transactions/${deposit}`;

// ─── Assets ───────────────────────────────────────────────────

/**
 * A Hydration asset's mark in the registry.
 *
 * @param id Hydration asset id.
 */
export const assetIcon = (id) =>
  id === null || id === undefined ? null : `${METADATA}/polkadot/2034/assets/${id}/icon.svg`;

/** The explorer's curated gradients for a letter fallback, else a palette pick by symbol. */
const ASSET_COLORS = {
  HDX: ["#e53e76", "#b454da"],
  DOT: ["#2C89E9", "#95caff"],
  USDT: ["#74C742", "#45AC1F"],
  USDC: ["#2C89E9", "#1f5cab"],
  HOLLAR: ["#b3cf92", "#74C742"],
  DAI: ["#F7BF06", "#e3ae00"],
  WBTC: ["#F7BF06", "#e3ae00"],
  WETH: ["#6e7588", "#a8afc0"],
};
const PALETTE = [["#e53e76", "#b454da"], ["#2C89E9", "#95caff"], ["#74C742", "#45AC1F"], ["#cc6ef4", "#dfb1f3"], ["#F7BF06", "#e3ae00"], ["#ff6868", "#d83b3b"], ["#6e7588", "#a8afc0"], ["#b3cf92", "#74C742"]];

function gradient(symbol) {
  if (ASSET_COLORS[symbol]) return ASSET_COLORS[symbol];
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h + symbol.charCodeAt(i)) % PALETTE.length;
  return PALETTE[h];
}

/** The gradient-letter disc the explorer falls back to when no icon loads. */
function letterLogo(symbol, size) {
  const [a, b] = gradient(symbol);
  return `<span class="asset-logo" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px;background:linear-gradient(135deg,${a},${b})">${esc(symbol.slice(0, 3))}</span>`;
}

/**
 * Try the next candidate for an icon, then the letter disc. Inline `onerror` handlers call this, so
 * it lives on `window`.
 */
window.__nextIcon = (img) => {
  const rest = (img.dataset.next ?? "").split("|").filter(Boolean);
  if (rest.length) {
    img.dataset.next = rest.slice(1).join("|");
    img.src = rest[0];
    return;
  }
  img.outerHTML = letterLogo(img.dataset.sym ?? "?", Number(img.dataset.size ?? 20));
};

/**
 * An asset's icon as the explorer draws it: the registry's svg, then its png, then a gradient
 * letter disc — with the asset's home chain small in the corner.
 *
 * @param {{symbol: string, assetId?: number|null, home?: string|null}} meta
 * @param {number} [size]
 */
export function tokenIcon(meta, size = 20) {
  const symbol = meta?.symbol ?? "?";
  const id = meta?.assetId;
  const base = id === null || id === undefined ? null : `${METADATA}/polkadot/2034/assets/${id}/icon`;
  const img = base
    ? `<img src="${base}.svg" data-next="${base}.png" data-sym="${esc(symbol)}" data-size="${size}" alt="" loading="lazy" width="${size}" height="${size}" onerror="__nextIcon(this)">`
    : letterLogo(symbol, size);
  const home = meta?.home && meta.home !== "hydration" ? chainIcon(meta.home) : null;
  const corner = Math.max(10, Math.round(size * 0.42));
  const badge = home
    ? `<img class="ai-corner" src="${esc(home)}" alt="" aria-hidden="true" style="width:${corner}px;height:${corner}px" onerror="this.remove()">`
    : "";
  return `<span class="ai" style="width:${size}px;height:${size}px">${img}${badge}</span>`;
}

/**
 * An amount as the explorer phrases it: icon, symbol, amount.
 *
 * @param {string|null} raw Integer amount.
 * @param {{symbol: string, decimals: number, assetId?: number|null, home?: string|null}} meta
 * @param {number} [sig] Significant figures.
 */
export function tokenAmount(raw, meta, sig = 6) {
  if (raw === null || raw === undefined) return '<span class="dim">—</span>';
  return `<span class="trade-leg">${tokenIcon(meta)}<span class="sym">${esc(meta?.symbol ?? "")}</span><span class="mono">${esc(amount(raw, meta?.decimals ?? 18, sig))}</span></span>`;
}

/**
 * A small round mark that deletes itself if the source 404s. Never the only carrier of meaning.
 *
 * @param {string|null} src
 * @param {string} [alt]
 * @param {string} [name] Slugified into `icon-<name>`, for a mark that needs styling to stand alone.
 */
export function icon(src, alt, name) {
  if (!src) return "";
  const slug = name ? ` icon-${String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : "";
  // A registry asset ships as svg or png, not always both: try the other, then the letter disc.
  const asset = /\/assets\/\d+\/icon\.svg$/.test(src);
  const fallback = asset
    ? `data-next="${esc(src.replace(/\.svg$/, ".png"))}" data-sym="${esc(alt ?? "?")}" data-size="20" onerror="__nextIcon(this)"`
    : `onerror="this.remove()"`;
  return `<img class="icon${slug}" src="${esc(src)}" alt="${esc(alt ?? "")}" loading="lazy" ${fallback}>`;
}

/**
 * Format an amount with its symbol, from whichever token list it belongs to — the older chip the
 * intents pages use: mark, amount, symbol.
 *
 * @param {string|null} raw
 * @param {{symbol: string, decimals: number}|undefined} meta
 * @param {string} fallback Shown in place of a symbol we do not know.
 * @param {string|null} [iconUrl]
 */
export function asset(raw, meta, fallback = "", iconUrl = null) {
  if (raw === null || raw === undefined) return '<span class="dim">—</span>';
  const value = amount(raw, meta?.decimals ?? 18, 4);
  const symbol = meta?.symbol ?? fallback;
  return `<span class="asset-chip">${icon(iconUrl, symbol, symbol)}${esc(value)}${symbol ? `<span class="sym">${esc(symbol)}</span>` : ""}</span>`;
}

// ─── Status ───────────────────────────────────────────────────

const STATUS = {
  completed: {
    cls: "ok",
    label: "Completed",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
  },
  failed: {
    cls: "fail",
    label: "Failed",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  },
  pending: {
    cls: "progress",
    label: "In progress",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  },
  held: {
    cls: "pending",
    label: "Held",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><line x1="10" y1="9" x2="10" y2="15"/><line x1="14" y1="9" x2="14" y2="15"/></svg>',
  },
  // An oracle update: written by its receiver, or past the window in which it still could be.
  delivered: {
    cls: "ok",
    label: "Delivered",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>',
  },
  expired: {
    cls: "expired",
    label: "Expired",
    svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 2h12M6 22h12M7 2c0 6 10 6 10 10S7 16 7 22M17 2c0 6-10 6-10 10s10 4 10 10"/></svg>',
  },
};

/** A status's label, for filters. */
export const statusLabel = (s) => STATUS[s]?.label ?? s;

/**
 * Where a transfer is, as the explorer's status badge: done green, in flight sky, held amber,
 * failed red. `compact` is the round icon-only form a list column uses.
 *
 * @param {string} status `completed`, `pending`, `held`, `failed` — or an oracle update's
 *   `delivered`, `expired`.
 * @param {{compact?: boolean, title?: string}} [opts]
 */
export function statusBadge(status, opts = {}) {
  const s = STATUS[status] ?? STATUS.pending;
  const title = esc(opts.title ?? s.label);
  return opts.compact
    ? `<span class="badge ${s.cls} badge-icon" title="${title}" aria-label="${esc(s.label)}">${s.svg}</span>`
    : `<span class="badge ${s.cls}" title="${title}">${s.svg}${esc(s.label)}</span>`;
}

/** A lifecycle stage, in its own colour. */
export function badge(state) {
  return `<span class="badge ${esc(state ?? "")}">${esc(state ?? "—")}</span>`;
}

/**
 * A kind of thing in its own colour — the explorer's type pill.
 *
 * @param {string} label
 * @param {string} color A CSS colour or variable.
 */
export function pill(label, color) {
  return `<span class="pill-badge" style="--c:${esc(color)}">${esc(label)}</span>`;
}

// ─── Formatting ───────────────────────────────────────────────

/** Shorten a hash or address to its ends, which is all anyone reads. */
export function short(v, head = 6, tail = 4) {
  if (!v) return "—";
  const s = String(v);
  return s.length > head + tail + 2 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
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

/** Unix ms to a compact age. */
export function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.round((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** The explorer's age: always two units — "4m 3s ago", "2h 5m ago", "3d 4h ago". */
export function agoLong(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - Number(ms)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

/** Absolute time, the explorer's way: "Mon 05 Oct 2026 · 14:03:22 UTC". */
export function at(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms));
  const day = d.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return `${day.replace(/,/g, "")} · ${d.toISOString().slice(11, 19)} UTC`;
}

/** How long one leg took to follow another. */
export function elapsed(fromMs, toMs) {
  if (!fromMs || !toMs) return "";
  const s = Math.max(0, Math.round((Number(toMs) - Number(fromMs)) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

/** Escape untrusted text before it goes into innerHTML. */
export function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

// ─── Legs ─────────────────────────────────────────────────────

/**
 * One hop of the route.
 *
 * A hop that has not happened is dimmed rather than dropped, because where a transfer stopped is
 * the thing worth seeing. `held` marks the one state that needs a human.
 *
 * @param {object} leg `{where, kind, ref, rows, pending, held, since}` — `rows` are `[label, html]`.
 */
export function legCard({ where, kind, ref, rows = [], pending = false, held = false, since }) {
  const done = !pending && (ref || rows.length);
  const body = [
    // The hash links to the chain's explorer itself — a chip beside it would only crowd the card.
    ref ? ["", `<span class="txl">${eventLink(ref)}${copyBtn(refId(ref))}</span>`] : null,
    ref?.blockNumber ? ["", `<span class="dim">block ${esc(ref.blockNumber)}</span>`] : null,
    ...rows,
  ]
    .filter(Boolean)
    .map(([label, html]) =>
      label ? `<div>${esc(label)} <span class="v">${html}</span></div>` : `<div>${html}</div>`,
    )
    .join("");

  const when = ref?.blockTimestamp;
  const gap = since && when ? elapsed(since, when) : "";

  return `
    <div class="leg${done ? "" : " pending"}${held ? " held" : ""}">
      <div class="leg-head">
        <div class="leg-title">${chainBadge(where)}<span class="leg-kind${done ? "" : " pending"}">${esc(kind)}</span></div>
        ${done ? '<span class="check">✓</span>' : ""}
      </div>
      <div class="leg-body">
        ${body || '<div class="dim">not yet</div>'}
        ${when ? `<div class="dim" title="${esc(at(when))}">${agoLong(when)}${gap ? ` · +${gap}` : ""}</div>` : ""}
      </div>
    </div>`;
}

/** A key/value row — the older form, still used by intents. */
export function kv(label, html) {
  return `<div class="kv-row"><div class="kk">${esc(label)}</div><div class="vv">${html}</div></div>`;
}

/**
 * The explorer's key/value grid: a 200px key column, values beside it.
 *
 * @param {Array<[string, string]|null>} rows `[label, html]`; null rows are skipped.
 */
export function dl(rows) {
  return `<div class="dl">${rows
    .filter(Boolean)
    .map(([k, v]) => `<div class="dt">${esc(k)}</div><div class="dd">${v}</div>`)
    .join("")}</div>`;
}

// ─── Pager ────────────────────────────────────────────────────

/**
 * The explorer's pager: "Page 3 of 40" and « ‹ five numbers › ».
 *
 * @param {number} page 1-based.
 * @param {number} pages
 * @returns {string} Buttons carry `data-page`; the page wires one click handler.
 */
export function pager(page, pages) {
  pages = Math.max(1, pages);
  const btn = (p, label, title, on = false) =>
    `<button type="button" data-page="${p}"${on ? ' class="on"' : ""} title="${title}"${!on && (p < 1 || p > pages || p === page) ? " disabled" : ""}>${label}</button>`;
  const from = Math.max(1, Math.min(page - 2, pages - 4));
  const nums = [];
  for (let p = from; p <= Math.min(pages, from + 4); p++) {
    nums.push(btn(p, String(p), `Page ${p}`, p === page));
  }
  return `<span class="info">Page ${page} of ${pages}</span>
    <div class="btns">${btn(1, "«", "First")}${btn(page - 1, "‹", "Newer")}${nums.join("")}${btn(page + 1, "›", "Older")}${btn(pages, "»", "Last")}</div>`;
}

// ─── Filters ──────────────────────────────────────────────────

const CHEV = `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

const SLIDERS = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`;

/**
 * The narrow-screen switch for a filter bar: below 720px the pills hide behind "Filters", and open
 * as full-width rows. Shows how many filters are set.
 *
 * @param {HTMLElement} fbar The bar it opens.
 * @returns {{count: (n: number) => void}} Updates the number shown beside it.
 */
export function filterToggle(fbar) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ftoggle";
  btn.innerHTML = `<span>Filters</span><span class="fb" hidden></span>${SLIDERS}`;
  fbar.parentElement.insertBefore(btn, fbar);
  btn.addEventListener("click", () => {
    fbar.classList.toggle("open");
    btn.classList.toggle("open", fbar.classList.contains("open"));
  });
  const fb = btn.querySelector(".fb");
  return {
    count(n) {
      fb.hidden = n === 0;
      fb.textContent = String(n);
    },
  };
}

/**
 * A filter dropdown: a pill trigger reading "Name  Value ▾", and a popover of checkbox rows — one
 * list, or several side by side (`cols`) for a filter with two sides, like origin and destination.
 * Selections are sets of values, keyed per column, in a state object the page owns.
 *
 * @param {HTMLElement} host Where the dropdown is mounted.
 * @param {{
 *   label: string,
 *   title?: string,
 *   search?: boolean,
 *   cols: Array<{key: string, title?: string, options: Array<{value: string, label: string, html?: string}>}>,
 * }} spec
 * @param {Record<string, Set<string>>} state Shared with the page; mutated in place.
 * @param {() => void} onChange
 * @returns {{paint: () => void}} Repaints the trigger after the page changes `state` itself.
 */
export function filterDrop(host, spec, state, onChange) {
  const root = document.createElement("div");
  root.className = "fdrop";
  root.innerHTML = `
    <button type="button" class="ftrig"><span class="k">${esc(spec.label)}</span><span class="v"></span>${CHEV}</button>
    <div class="fpop" hidden>
      <div class="fpop-head"><span>${esc(spec.title ?? `Select ${spec.label}`)}</span><span class="fpop-acts"><button type="button" data-clear>Clear all</button><button type="button" class="fpop-close" data-close aria-label="Close">${CLOSE}</button></span></div>
      ${spec.search ? `<input class="fpop-search" placeholder="Search…" />` : ""}
      <div class="fpop-body"></div>
    </div>`;
  host.appendChild(root);

  const trig = root.querySelector(".ftrig");
  const pop = root.querySelector(".fpop");
  const body = root.querySelector(".fpop-body");
  const search = root.querySelector(".fpop-search");
  for (const c of spec.cols) state[c.key] ??= new Set();

  const paint = () => {
    const picked = spec.cols.flatMap((c) =>
      [...state[c.key]].map((v) => c.options.find((o) => o.value === v)?.label ?? v),
    );
    root.querySelector(".v").innerHTML =
      picked.length === 0 ? "All" : picked.length === 1 ? esc(picked[0]) : `<span class="fb">${picked.length}</span>`;
    trig.classList.toggle("has", picked.length > 0);
  };

  const renderBody = () => {
    const q = (search?.value ?? "").trim().toLowerCase();
    const col = (c) => {
      const rows = c.options
        .filter((o) => !q || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
        .map(
          (o) =>
            `<label class="fopt"><input type="checkbox" data-col="${esc(c.key)}" value="${esc(o.value)}"${state[c.key].has(o.value) ? " checked" : ""}>${o.html ?? esc(o.label)}</label>`,
        )
        .join("");
      return `<div>${c.title ? `<div class="fpop-col-title">${esc(c.title)}</div>` : ""}${rows || '<div class="fempty">No matches</div>'}</div>`;
    };
    body.innerHTML =
      spec.cols.length > 1 ? `<div class="fpop-cols">${spec.cols.map(col).join("")}</div>` : col(spec.cols[0]);
  };

  // On a phone the popover becomes a full-screen modal. It moves to <body> for that: anything
  // transformed above it (the page's rise-in) would otherwise pin a fixed element to itself, not
  // to the screen.
  const narrow = matchMedia("(max-width: 720px)");
  let scrim = null;

  const open = (yes) => {
    if (yes === !pop.hidden) return;
    pop.hidden = !yes;
    trig.classList.toggle("open", yes);
    if (yes && narrow.matches) {
      scrim = document.createElement("div");
      scrim.className = "fsheet-scrim";
      scrim.appendChild(pop);
      pop.classList.add("sheet");
      document.body.appendChild(scrim);
      document.body.classList.add("noscroll");
    }
    if (!yes && scrim) {
      pop.classList.remove("sheet");
      root.appendChild(pop);
      scrim.remove();
      scrim = null;
      document.body.classList.remove("noscroll");
    }
    if (yes) {
      renderBody();
      // Not on a phone: focusing raises the keyboard over the list just opened.
      if (!narrow.matches) search?.focus();
    }
  };

  trig.addEventListener("click", () => {
    const opening = pop.hidden;
    document.dispatchEvent(new CustomEvent("fdrop:close"));
    open(opening);
  });
  document.addEventListener("fdrop:close", () => open(false));
  document.addEventListener("click", (e) => {
    if (e.target === scrim || e.target.closest?.("[data-close]")) return open(false);
    if (!root.contains(e.target) && !pop.contains(e.target)) open(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") open(false);
  });
  search?.addEventListener("input", renderBody);
  body.addEventListener("change", (e) => {
    const box = e.target.closest("input[type=checkbox]");
    if (!box) return;
    const set = state[box.dataset.col];
    if (box.checked) set.add(box.value);
    else set.delete(box.value);
    paint();
    onChange();
  });
  root.querySelector("[data-clear]").addEventListener("click", () => {
    for (const c of spec.cols) state[c.key].clear();
    renderBody();
    paint();
    onChange();
  });

  paint();
  return { paint };
}
