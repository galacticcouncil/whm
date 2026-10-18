import { near } from "../../chains/near/factory";
import { FastNear } from "../../chains/near/fastnear";
import { banner } from "../../banner";
import { drainIntervalMs } from "../../config";
import { Drain, serve, subscribe } from "../../flow";
import log from "../../logger";
import { WATCH } from "../../watch";

import { routes } from "./api";
import { basejump } from "./basejump/flows";
import { ConfirmPoller } from "./utxo/confirms";
import { signs, utxo } from "./utxo/flows";
import { WithdrawPoller } from "./utxo/withdraws";

const NAME = "transfers";
const FLOWS = [basejump, utxo, signs];

/**
 * Every transfer Hydration takes part in, in one place: NTT corridors, UTXO coins through Omni, and
 * Basejump.
 *
 * Owns the rails no one else does — Basejump's payouts and the UTXO legs — and reads `ntt_transfers`,
 * which ingest owns, for the rest. A UTXO withdrawal's last two legs are on no watched account, so
 * two pollers carry them: the derived NEAR account's withdraw, and the coin's payout landing.
 */
async function main(): Promise<void> {
  banner(NAME);

  const drain = new Drain(NAME, FLOWS, WATCH);
  await drain.initSchema();

  subscribe((u) => {
    if (u.flow === "ntt") return; // relayed from ingest, logged there
    const id = u.record.id as string;
    if (u.kind === "created") log.info(`+ [${u.flow}] ${id} [${u.record.state}]`);
    else if (u.previousState !== u.record.state) {
      log.info(`~ [${u.flow}] ${id} [${u.previousState} -> ${u.record.state}]`);
    }
  });

  await serve({ name: NAME, flows: FLOWS, routes, follow: ["ntt"] });
  await drain.start(drainIntervalMs);

  new WithdrawPoller(new FastNear(near().txApi)).start();
  new ConfirmPoller().start();

  log.info("transfers ready.");
}

main().catch((err) => {
  log.error("fatal:", err);
  process.exit(1);
});
