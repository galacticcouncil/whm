import "dotenv/config";

import { JsonRpcProvider } from "near-api-js";

import { args } from "@whm/common";
import { view } from "@whm/common/near";

import { derive, type Params } from "./shared";
import { run } from "../ntt-manager/shared";

const { requiredArg, requiredEnv } = args;

/**
 * Read-only: the withdraw account for an address — path, key, implicit account — and its state:
 * whether the account exists, its token registration and balance, the connector's lost_found for it,
 * and the connector deposit address that mints straight to it (to fund it for a test — register it
 * on the token first).
 *
 * Usage: tsx derive.ts --contract <utxo-withdraw> --address <zcash address>
 */
async function main(): Promise<void> {
  const provider = new JsonRpcProvider({ url: requiredEnv("RPC_NEAR") });
  const contract = requiredArg("--contract");
  const address = requiredArg("--address");

  const params = await view<Params>(provider, contract, "get_params");
  const { path, publicKey, account } = await derive(provider, contract, address);
  console.log("contract   ", contract, JSON.stringify(params));
  console.log("path       ", path);
  console.log("key        ", publicKey);
  console.log("account    ", account);

  const exists = await provider.viewAccount({ accountId: account }).then(
    () => true,
    () => false,
  );
  console.log("exists     ", exists);
  console.log("registered ", JSON.stringify(await view(provider, params.token, "storage_balance_of", { account_id: account })));
  console.log("balance    ", await view(provider, params.token, "ft_balance_of", { account_id: account }));
  console.log("lost_found ", JSON.stringify(await view(provider, params.connector, "list_lost_found", { account_ids: [account] })));
  // A safe deposit with an empty msg is `safe_mint(A, amount, None)` — a plain ft_transfer to A,
  // which needs A registered on the token first, or the mint is refunded.
  console.log(
    "deposit to ",
    await view(provider, params.connector, "get_user_deposit_address", {
      deposit_msg: { recipient_id: account, safe_deposit: { msg: "" } },
    }),
  );
}

run(main);
