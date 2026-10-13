import "dotenv/config";

import { JsonRpcProvider } from "near-api-js";

import { args } from "@whm/common";
import { view } from "@whm/common/near";

const { optionalArg, requiredArg, requiredEnv } = args;

/**
 * Reads the NEAR NTT contract: config, peer, both rate limits, and — with `--account` — its
 * claimable balance, with `--digest` whether an inbound message was executed.
 *
 * Usage: tsx status.ts --contract <ntt> [--chain 73] [--account <account>] [--digest <hex>]
 */
async function main(): Promise<void> {
  const provider = new JsonRpcProvider({ url: requiredEnv("RPC_NEAR") });
  const contract = requiredArg("--contract");
  const chain = Number(optionalArg("--chain") ?? 73);
  const v = <T>(method: string, a: object = {}) => view<T>(provider, contract, method, a);

  console.log("contract ", contract);
  console.log("owner    ", await v("owner"));
  console.log("token    ", await v("token"));
  console.log("paused   ", await v("is_paused"));
  console.log("emitter  ", await v("emitter"));
  console.log(`peer ${chain}  `, JSON.stringify(await v("get_peer", { chain_id: chain })));
  console.log("outbound ", await v("outbound_capacity"));
  console.log(`inbound ${chain}`, await v("inbound_capacity", { chain_id: chain }));

  const account = optionalArg("--account");
  if (account) console.log("claimable", await v("claimable_of", { account_id: account }));

  const digest = optionalArg("--digest");
  if (digest) {
    console.log("executed ", await v("is_executed", { digest }));
    console.log("queued   ", JSON.stringify(await v("get_queued_inbound", { digest })));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
