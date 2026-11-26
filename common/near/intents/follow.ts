import type { JsonRpcProvider } from "near-api-js";

import { view } from "../utils";

import { balances } from "./account";
import type { UtxoLeg } from "./payout";

/**
 * Follow a trade until it is done: `A`'s balances, `A_utxo`'s on a UTXO route, and — with a scan
 * API — the trade's status and each payout's transaction on its chain. Done when scan calls the trade
 * completed or refunded and every UTXO delivery has landed; without scan, when `A` has held something
 * and is empty again.
 *
 * @param o What to follow
 */
export async function followTrade(o: {
  provider: JsonRpcProvider;
  account: string;
  authPath: string;
  asset: string;
  eth: string;
  utxo?: UtxoLeg;
  scanApi?: string;
  minutes: number;
}): Promise<void> {
  let last = "";
  let funded = false;
  for (const until = Date.now() + o.minutes * 60_000; Date.now() < until; await new Promise((r) => setTimeout(r, 15_000))) {
    const held = await balances(o.provider, o.account, [o.eth, o.asset]);
    const parts: string[] = [];
    let done = false;
    if (o.scanApi) {
      const r = await fetch(`${o.scanApi}/trades/${o.authPath}`);
      if (r.ok) {
        const t = (await r.json()) as {
          trade: { status: string; order_count: number; swapped: number; planned: number | null };
          payouts: { state: string; dest_tx: string | null }[];
        };
        const delivered = t.payouts.filter((p) => p.state === "delivered");
        const landed = delivered.filter((p) => p.dest_tx).length;
        parts.push(`trade ${t.trade.status}, ${t.trade.swapped}/${t.trade.planned ?? t.trade.order_count} swapped`);
        if (delivered.length) parts.push(`${delivered.length} payout(s)${o.utxo ? `, ${landed} landed` : ""}`);
        const finished = t.trade.status === "completed" || t.trade.status === "refunded";
        done = finished && (!o.utxo || landed === delivered.length);
      } else parts.push(`trade ${r.status}`);
    }
    parts.push(`A: ${held[o.eth]} wei ETH, ${held[o.asset]} out`);
    if (o.utxo) {
      const onToken = await view<string>(o.provider, o.utxo.token, "ft_balance_of", { account_id: o.utxo.account });
      parts.push(`A_utxo: ${onToken}`);
    }
    const line = parts.join(", ");
    if (line !== last) console.log(`   +${new Date().toISOString().slice(11, 19)} ${(last = line)}`);
    if (done) return console.log("\nDone.");
    const empty = held[o.eth] === 0n && held[o.asset] === 0n;
    if (!o.scanApi && funded && empty) return console.log("\nDone: A is empty again — delivered, or refunded.");
    funded ||= !empty;
  }
  console.log(`\nFollowed for ${o.minutes} min.`);
}
