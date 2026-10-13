import { teraToGas } from "near-api-js";
import { isAddress } from "viem";

import { args } from "@whm/common";
import { call, events } from "@whm/common/near";

import { report, run, signer } from "./shared";

const { requiredArg, requiredEnv } = args;

/** Wormhole chain id of Hydration. */
const HYDRATION = 73;

/**
 * NEAR → Hydration: `ft_transfer_call` the token into the NTT contract, which locks it and
 * publishes the NTT message. The trim dust comes straight back; an over-limit or otherwise refused
 * transfer comes back whole.
 *
 * Usage: tsx transfer.ts --contract <ntt> --token <token> --amount <token units>
 *                        --recipient <0x H160> --account <sender> --pk <ed25519:…>
 */
run(async () => {
  const contract = requiredArg("--contract");
  const token = requiredArg("--token");
  const amount = requiredArg("--amount");
  const recipient = requiredArg("--recipient");
  if (!isAddress(recipient)) throw new Error("--recipient must be a Hydration EVM address");

  const { account } = signer();
  const msg = JSON.stringify({ recipient_chain: HYDRATION, recipient });
  const outcome = await call(
    account,
    token,
    "ft_transfer_call",
    { receiver_id: contract, amount, msg },
    { deposit: 1n, gas: teraToGas(150) },
  );
  report(outcome);

  const publish = events(outcome, "wormhole").find((e) => e.event === "publish") as
    | { emitter?: string; seq?: number }
    | undefined;
  if (!publish) {
    console.log("no Wormhole message published — see the events above");
    return;
  }
  // The core's event is flat (not NEP-297 `data`): emitter and seq at the top level.
  const scan = requiredEnv("RPC_NEAR").includes("testnet")
    ? "https://api.testnet.wormholescan.io"
    : "https://api.wormholescan.io";
  console.log(`VAA: ${scan}/api/v1/vaas/15/${publish.emitter}/${publish.seq}`);
});
