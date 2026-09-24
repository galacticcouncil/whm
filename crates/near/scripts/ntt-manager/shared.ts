import "dotenv/config";

import { args } from "@whm/common";
import { events, receiptFailures, wallet, type TxOutcome } from "@whm/common/near";

const { requiredArg, requiredEnv } = args;

/**
 * The signing wallet every script uses: `RPC_NEAR` from env, `--account` and `--pk` from args.
 *
 * @returns The NEAR wallet
 */
export function signer() {
  return wallet.getWallet(requiredEnv("RPC_NEAR"), requiredArg("--account"), requiredArg("--pk"));
}

/**
 * Prints what a transaction did: its hash, every `whm-ntt` event, and any failed receipt — a
 * NEAR transaction can succeed while a callback inside it fails.
 *
 * @param outcome A final execution outcome
 */
export function report(outcome: TxOutcome): void {
  console.log(`tx ${outcome.transaction.hash}`);
  for (const e of events(outcome, "whm-ntt")) {
    console.log(`  ${e.event}`, JSON.stringify(e.data));
  }
  for (const f of receiptFailures(outcome)) {
    console.log(`  ✗ ${f.executor}`, JSON.stringify(f.failure));
  }
}

/**
 * Runs a script's `main`, exiting non-zero on error.
 *
 * @param main The script body
 */
export function run(main: () => Promise<void>): void {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
