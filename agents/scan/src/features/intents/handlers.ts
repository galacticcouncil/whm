import type { Enrich } from "../../enrich";
import type { EventHandler, LogEvent } from "../../types";
import { broadcast } from "../../subscribers";
import { bytes32ToAddress } from "../../utils";

import { upsertIntent, type IntentRow, type IntentState } from "./db";
import { getExecution, jwtConfigured } from "./oneclick";
import { decodeIntentPayload, parseTransferWithPayload } from "./payload";
import {
  BridgeInitiatedEvt,
  IntentForwardedEvt,
  LogMessagePublishedEvt,
  RelayFeePaidEvt,
} from "./abi";

/**
 * Fetch the destination leg from 1Click and merge it into the intent. Runs detached (fire-and-forget
 * from the emitted handler) so it never blocks the processor; errors are swallowed since the
 * settlement poller backfills any miss.
 */
async function enrichDest(intentId: string, depositAddress: string): Promise<void> {
  try {
    const exec = await getExecution(depositAddress);
    if (!exec || !(exec.destAddress || exec.destAsset || exec.destAmount)) return;
    const { row, previousState } = await upsertIntent(intentId, "emitted", {
      dest_address: exec.destAddress,
      dest_asset: exec.destAsset,
      dest_amount: exec.destAmount,
      settlement_status: exec.status,
    });
    emit(false, row, previousState);
  } catch {
    // best-effort — the settlement poller will backfill the destination leg
  }
}

function emit(created: boolean, row: IntentRow, previousState: IntentState | null): void {
  broadcast(
    created
      ? { feature: "intents", kind: "created", record: row as unknown as Record<string, unknown> }
      : {
          feature: "intents",
          kind: "updated",
          record: row as unknown as Record<string, unknown>,
          previousState,
        },
  );
}

/**
 * Build the intents (WTT) event handlers. Correlation is by `intentId` end-to-end; the Moonbeam
 * leg recovers the intentId by parsing the TokenBridge payload-3 message.
 *
 * @param enrich      shared per-chain block-time enrichment
 * @param receivers   the Ethereum IntentReceiver address(es) — the published leg only counts transfers addressed to one
 * @param emitterMdas the emitters' Moonbeam MDA address(es), derived from the Hydration emitters; the published leg keeps only transfers bridged from one of these (filters out non-Hydration traffic to the receiver). Empty disables the filter.
 * @returns named handlers: `emitted` (Hydration), `published` (Moonbeam), `forwarded` + `relayFee` (Ethereum)
 */
export function intentsHandlers(
  enrich: Enrich,
  receivers: string[],
  emitterMdas: string[],
): {
  emitted: EventHandler;
  published: EventHandler;
  forwarded: EventHandler;
  relayFee: EventHandler;
} {
  const receiverSet = new Set(receivers.map((r) => r.toLowerCase()));
  const mdaSet = new Set(emitterMdas.map((a) => a.toLowerCase()));

  async function emitted(ev: LogEvent): Promise<void> {
    const a = ev.args as {
      intentId: `0x${string}`;
      caller: `0x${string}`;
      assetIn: number;
      amountIn: bigint;
      ethOut: bigint;
      intentDepositAddress: `0x${string}`;
    };
    const ref = await enrich.withBlockTime(ev.chain, ev.ref);
    const depositAddress = a.intentDepositAddress.toLowerCase();
    const { row, created, previousState } = await upsertIntent(
      a.intentId.toLowerCase(),
      "emitted",
      {
        caller: a.caller.toLowerCase(),
        asset_in: Number(a.assetIn),
        amount_in: a.amountIn.toString(),
        eth_out: a.ethOut.toString(),
        deposit_address: depositAddress,
        emitted: ref,
      },
    );
    emit(created, row, previousState);

    // Destination leg: the deposit address derives from a 1Click quote that already knows where the
    // funds land, so fetch it on emit for immediacy — but FIRE-AND-FORGET. The processor runs
    // handlers serially, so we must never block it on a 1Click round-trip (that stalls indexing).
    // A miss here is still backfilled by the settlement poller.
    if (jwtConfigured) void enrichDest(a.intentId.toLowerCase(), depositAddress);
  }

  async function published(ev: LogEvent): Promise<void> {
    const a = ev.args as {
      sender: `0x${string}`;
      sequence: bigint;
      nonce: number;
      payload: `0x${string}`;
      consistencyLevel: number;
    };
    const transfer = parseTransferWithPayload(a.payload);
    if (!transfer) return; // not a payload-3 TokenBridge transfer
    if (!receiverSet.has(bytes32ToAddress(transfer.to).toLowerCase())) return; // not addressed to a known receiver
    // Genuine Hydration intents bridge from the emitter's Moonbeam MDA — drop other TokenBridge
    // traffic to the receiver (it has no Hydration emitted leg and would show up as an orphan).
    if (mdaSet.size > 0 && !mdaSet.has(bytes32ToAddress(transfer.fromAddress).toLowerCase())) return;
    const intent = decodeIntentPayload(transfer.inner);
    if (!intent) return; // not the 96-byte intent payload

    const ref = await enrich.withBlockTime(ev.chain, ev.ref);
    const { row, created, previousState } = await upsertIntent(
      intent.intentId.toLowerCase(),
      "published",
      {
        deposit_address: intent.depositAddress.toLowerCase(),
        max_relay_fee: intent.maxRelayFee.toString(),
        wormhole_sequence: a.sequence.toString(),
        published: ref,
      },
    );
    emit(created, row, previousState);
  }

  async function forwarded(ev: LogEvent): Promise<void> {
    const a = ev.args as {
      intentId: `0x${string}`;
      asset: `0x${string}`;
      depositAddress: `0x${string}`;
      amount: bigint;
    };
    const ref = await enrich.withBlockTime(ev.chain, ev.ref);
    const { row, created, previousState } = await upsertIntent(
      a.intentId.toLowerCase(),
      "forwarded",
      {
        forwarded_asset: a.asset.toLowerCase(),
        forwarded_amount: a.amount.toString(),
        deposit_address: a.depositAddress.toLowerCase(),
        forwarded: ref,
      },
    );
    emit(created, row, previousState);
  }

  // Same tx as the forward; carries the relay fee. State stays at `forwarded` (monotonic).
  async function relayFee(ev: LogEvent): Promise<void> {
    const a = ev.args as { intentId: `0x${string}`; relayer: `0x${string}`; fee: bigint };
    const { row, created, previousState } = await upsertIntent(
      a.intentId.toLowerCase(),
      "forwarded",
      { relay_fee: a.fee.toString(), relayer: a.relayer.toLowerCase() },
    );
    emit(created, row, previousState);
  }

  return {
    emitted: { abi: BridgeInitiatedEvt, handle: emitted },
    published: { abi: LogMessagePublishedEvt, handle: published },
    forwarded: { abi: IntentForwardedEvt, handle: forwarded },
    relayFee: { abi: RelayFeePaidEvt, handle: relayFee },
  };
}
