import "dotenv/config";

import { args } from "@whm/common";
import { call, view } from "@whm/common/near";

import type { Config } from "./shared";
import { report, run, signer } from "../ntt-manager/shared";

const { optionalArg, requiredArg } = args;

type Params = Config["params"];

/** Flag per param; only the flags given change, the rest keep their live value. */
const FLAGS: Record<keyof Params, string> = {
  price_validity: "--price-validity",
  max_quote_age: "--max-quote-age",
  min_quote_slippage_bps: "--min-quote-slippage",
  transfer_validity: "--transfer-validity",
  max_order_shortfall_bps: "--max-order-shortfall",
  min_refund: "--min-refund",
};

/**
 * The router's params, set as its owner. Reads the live params, overrides the ones given, and sends
 * `set_params` — which replaces the whole struct, 1 yocto attached; the router checks each against
 * its bounds. The router bot reads the params at boot: restart it after.
 *
 * Usage: tsx params.ts --contract <router> --account <owner> --pk <ed25519:…>
 *          [--price-validity <s>] [--max-quote-age <s>] [--transfer-validity <s>]
 *          [--min-quote-slippage <bps>] [--max-order-shortfall <bps>] [--min-refund <wei>] [--dry-run]
 */
async function main(): Promise<void> {
  const contract = requiredArg("--contract");
  const { provider, account } = signer();

  const owner = await view<string>(provider, contract, "owner");
  if (owner !== account.accountId) throw new Error(`${contract} is owned by ${owner}, not ${account.accountId}`);

  const live = (await view<Config>(provider, contract, "get_config")).params;
  const params: Params = { ...live };
  for (const [key, flag] of Object.entries(FLAGS) as [keyof Params, string][]) {
    const value = optionalArg(flag);
    if (value !== undefined) (params as Record<keyof Params, unknown>)[key] = key === "min_refund" ? value : Number(value);
  }

  const changed = (Object.keys(FLAGS) as (keyof Params)[]).filter((k) => String(params[k]) !== String(live[k]));
  if (changed.length === 0) return console.log("nothing to change — pass a param flag");
  for (const k of changed) console.log(`${k.padEnd(24)} ${live[k]} → ${params[k]}`);
  if (process.argv.includes("--dry-run")) return console.log("dry run — not sent");

  report(await call(account, contract, "set_params", { params }, { deposit: 1n }));
  console.log(`params ${JSON.stringify((await view<Config>(provider, contract, "get_config")).params)}`);
  console.log("restart the router bot — it reads the params at boot");
}

run(main);
