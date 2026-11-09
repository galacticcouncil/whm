/**
 * The explorer's price chart, without React: a neutral line over a fading area, drawn on a time
 * axis, with a crosshair, a dot and a tooltip under the pointer. A card's sparkline is the same
 * line, small and still.
 */

import { at, esc, statusLabel } from "/shared/app.js";

const W = 820;
const H = 220;
const PAD = 14;
const SPARK_W = 240;
const SPARK_H = 52;

let gradients = 0;

/**
 * A raw 18-decimal value as a number — precise enough to draw, and to print at a few places.
 *
 * @param {string|number} raw
 */
export const num = (raw) =>
  typeof raw === "number" ? raw : Number(BigInt(String(raw).split(".")[0])) / 1e18;

/**
 * A feed's value as the pages print it: a price in dollars, a rate to six places — a rate moves
 * slowly, and its last digits are where it moves.
 *
 * @param {string|number|null} raw 18 decimals, or a number already.
 * @param {{kind: string}} feed
 */
export function fmt(raw, feed) {
  if (raw === null || raw === undefined) return "—";
  const n = num(raw);
  if (feed.kind === "rate") {
    return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
  }
  return n >= 1
    ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${n.toLocaleString("en-US", { maximumSignificantDigits: 4 })}`;
}

/**
 * Geometry over a series: scales, and the line and area as paths.
 *
 * @param {[number, string][]} points Oldest first: unix ms, raw value.
 * @param {number} w
 * @param {number} h
 * @param {number} pad Top and bottom inset, so the line never touches the edges.
 */
function geometry(points, w, h, pad) {
  const ts = points.map((p) => p[0]);
  const vs = points.map((p) => num(p[1]));
  let min = Math.min(...vs);
  let max = Math.max(...vs);
  // A flat series still needs a band to sit in the middle of.
  if (max === min) {
    const d = Math.abs(min) * 0.01 || 1;
    min -= d;
    max += d;
  }
  const t0 = ts[0];
  const span = ts[ts.length - 1] - t0 || 1;
  const sx = (t) => ((t - t0) / span) * w;
  const sy = (v) => pad + (1 - (v - min) / (max - min)) * (h - 2 * pad);
  const line = vs.map((v, i) => `${i ? "L" : "M"} ${sx(ts[i]).toFixed(1)} ${sy(v).toFixed(1)}`).join(" ");
  const area = `${line} L ${sx(ts[ts.length - 1]).toFixed(1)} ${h} L 0 ${h} Z`;
  return { ts, vs, min, max, sx, sy, line, area };
}

/**
 * The line and its area, as SVG content.
 *
 * @param {{line: string, area: string}} g
 */
function paths(g) {
  const id = `apxg${++gradients}`;
  return `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--chart-neutral)" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="var(--chart-neutral)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${g.area}" fill="url(#${id})"/>
    <path d="${g.line}" fill="none" stroke="var(--chart-neutral)" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
}

/**
 * A card's sparkline.
 *
 * @param {[number, string][]} points Oldest first: unix ms, raw value.
 */
export function sparkline(points) {
  if (!points || points.length < 2) return '<div class="spark-empty">no updates this week</div>';
  const g = geometry(points, SPARK_W, SPARK_H, 4);
  return `<svg class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">${paths(g)}</svg>`;
}

/**
 * A moment on the axis: a time within a day's span, else a date.
 *
 * @param {number} ms
 * @param {number} span The axis's span, ms.
 */
function tick(ms, span) {
  const d = new Date(ms);
  return span <= 2 * 86_400_000
    ? d.toISOString().slice(11, 16)
    : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
}

/**
 * A full chart, drawn into `host`, reading out the update under the pointer: when, the value, and
 * whether it was delivered. Touch scrubs; a mouse leaving clears.
 *
 * @param {HTMLElement} host
 * @param {[number, string, string][]} points Oldest first: unix ms, raw value, status.
 * @param {{kind: string}} feed
 */
export function chart(host, points, feed) {
  if (!points || points.length < 2) {
    host.innerHTML = `<div class="apx-empty">${points?.length ? "one update in this range" : "no updates in this range"}</div>`;
    return;
  }
  const g = geometry(points, W, H, PAD);
  const span = g.ts[g.ts.length - 1] - g.ts[0];
  host.innerHTML = `
    <div class="apx-wrap">
      <svg class="apx-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${paths(g)}</svg>
      <span class="apx-y" style="top:0">${esc(fmt(g.max, feed))}</span>
      <span class="apx-y" style="bottom:0">${esc(fmt(g.min, feed))}</span>
      <div class="apx-cross" hidden><div class="apx-vline"></div><div class="apx-dot"></div></div>
      <div class="apx-tip" hidden></div>
    </div>
    <div class="apx-axis"><span>${esc(tick(g.ts[0], span))}</span><span>${esc(tick(g.ts[g.ts.length - 1], span))}</span></div>`;

  const wrap = host.querySelector(".apx-wrap");
  const cross = host.querySelector(".apx-cross");
  const vline = host.querySelector(".apx-vline");
  const dot = host.querySelector(".apx-dot");
  const tip = host.querySelector(".apx-tip");

  /** The point nearest a time, by binary search over the sorted times. */
  const nearest = (t) => {
    let lo = 0;
    let hi = g.ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (g.ts[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && t - g.ts[lo - 1] < g.ts[lo] - t ? lo - 1 : lo;
  };

  const move = (e) => {
    const r = wrap.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const i = nearest(g.ts[0] + frac * span);
    const x = (g.sx(g.ts[i]) / W) * 100;
    vline.style.left = `${x}%`;
    dot.style.left = `${x}%`;
    dot.style.top = `${(g.sy(g.vs[i]) / H) * 100}%`;
    tip.innerHTML = `<span class="t-d">${esc(at(g.ts[i]))}</span><span>${esc(fmt(g.vs[i], feed))}</span><span class="t-d">${esc(statusLabel(points[i][2]))}</span>`;
    cross.hidden = false;
    tip.hidden = false;
    // Kept inside the chart, as the explorer's tooltip is.
    const half = tip.offsetWidth / 2;
    const px = (x / 100) * r.width;
    tip.style.left = `${r.width <= half * 2 ? r.width / 2 : Math.min(Math.max(px, half), r.width - half)}px`;
  };
  const hide = () => {
    cross.hidden = true;
    tip.hidden = true;
  };

  wrap.addEventListener("pointermove", move);
  wrap.addEventListener("pointerdown", move);
  wrap.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && hide());
}
