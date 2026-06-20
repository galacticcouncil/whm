import type { Enrich } from "../../enrich";
import type { EventHandler, LogEvent } from "../../types";
import { broadcast } from "../../subscribers";
import { bytes32ToAddress } from "../../utils";

import { upsertIntent, type IntentRow, type IntentState } from "./db";
import { decodeIntentPayload, parseTransferWithPayload } from "./payload";
import {
  BridgeInitiatedEvt,
  IntentForwardedEvt,
  LogMessagePublishedEvt,
  RelayFeePaidEvt,
} from "./abi";

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
 * @param enrich           shared per-chain block-time enrichment
 * @param receiverEthereum the Ethereum IntentReceiver — the published leg only counts transfers addressed to it
 * @returns named handlers: `emitted` (Hydration), `published` (Moonbeam), `forwarded` + `relayFee` (Ethereum)
 */
export function intentsHandlers(
  enrich: Enrich,
  receiverEthereum: string,
): {
  emitted: EventHandler;
  published: EventHandler;
  forwarded: EventHandler;
  relayFee: EventHandler;
} {
  const receiver = receiverEthereum.toLowerCase();

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
    const { row, created, previousState } = await upsertIntent(a.intentId.toLowerCase(), "emitted", {
      caller: a.caller.toLowerCase(),
      asset_in: Number(a.assetIn),
      amount_in: a.amountIn.toString(),
      eth_out: a.ethOut.toString(),
      deposit_address: a.intentDepositAddress.toLowerCase(),
      emitted: ref,
    });
    emit(created, row, previousState);
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
    if (bytes32ToAddress(transfer.to).toLowerCase() !== receiver) return; // not addressed to our receiver
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
