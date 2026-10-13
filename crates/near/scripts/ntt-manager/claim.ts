import { teraToGas } from "near-api-js";

import { args } from "@whm/common";
import { call, view } from "@whm/common/near";

import { report, run, signer } from "./shared";

const { requiredArg } = args;

/**
 * Pays out the signer's `claimable` balance — what a failed pay-out credited (an inbound unlock or
 * a refund whose `ft_transfer` failed, e.g. for an unregistered account).
 *
 * Usage: tsx claim.ts --contract <ntt> --account <claimant> --pk <ed25519:…>
 */
run(async () => {
  const contract = requiredArg("--contract");
  const { account, provider } = signer();

  const claimable = await view<string>(provider, contract, "claimable_of", {
    account_id: account.accountId,
  });
  console.log(`claimable ${claimable}`);
  if (claimable === "0") return;

  report(await call(account, contract, "claim", {}, { deposit: 1n, gas: teraToGas(100) }));
});
