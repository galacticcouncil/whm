import type { Enrich } from "../../enrich";
import type { EventHandler, LogEvent } from "../../types";
import { broadcast } from "../../subscribers";
import { normalizeRecipient } from "../../utils";

import {
  upsertTransfer,
  type TransferRow,
  type TransferState,
} from "./db";
import { findByPendingId, findInitiated } from "./db";
import {
  BridgeInitiatedEvt,
  PendingTransferFulfilledEvt,
  TransferExecutedEvt,
  TransferQueuedEvt,
} from "./abi";

type DeliveryArgs = {
  sourceAsset: `0x${string}`;
  destAsset: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
};

function emit(created: boolean, row: TransferRow, previousState: TransferState | null): void {
  broadcast(
    created
      ? { feature: "basejump", kind: "created", record: row as unknown as Record<string, unknown> }
      : {
          feature: "basejump",
          kind: "updated",
          record: row as unknown as Record<string, unknown>,
          previousState,
        },
  );
}

function orphanId(ev: LogEvent, kind: string): string {
  return `orphan-${kind}-${ev.chain}-${ev.ref.txHash}-${ev.ref.logIndex}`;
}

/**
 * Build the Basejump event handlers.
 *
 * @param enrich      shared per-chain block-time / sender enrichment
 * @param destChainId chain id recorded on landing rows (the Hydration delivery chain)
 * @returns named handlers — `initiated` (EVM source) and the three Hydration landing handlers
 */
export function basejumpHandlers(
  enrich: Enrich,
  destChainId: number,
): {
  initiated: EventHandler;
  executed: EventHandler;
  queued: EventHandler;
  fulfilled: EventHandler;
} {
  async function initiated(ev: LogEvent): Promise<void> {
    const a = ev.args as {
      asset: `0x${string}`;
      amount: bigint;
      fee: bigint;
      destChain: number;
      recipient: `0x${string}`;
      transferSequence: bigint;
      messageSequence: bigint;
    };
    const netAmount = (a.amount - a.fee).toString();
    const id = `init-${ev.chain}-${a.transferSequence}`;

    const [sender, ref] = await Promise.all([
      enrich.getSender(ev.chain, ev.ref),
      enrich.withBlockTime(ev.chain, ev.ref),
    ]);

    const { row, created, previousState } = await upsertTransfer(id, "initiated", {
      source_chain: ev.chain,
      sender,
      source_asset: a.asset,
      recipient: normalizeRecipient(a.recipient),
      gross_amount: a.amount.toString(),
      fee: a.fee.toString(),
      net_amount: netAmount,
      transfer_sequence: a.transferSequence.toString(),
      message_sequence: a.messageSequence.toString(),
      initiated: ref,
    });

    emit(created, row, previousState);
  }

  // Both corridors share one landing, so the emitting address can't pin the source chain.
  // findInitiated keys on source asset (USDC vs EURC), which already separates the corridors.
  async function executed(ev: LogEvent): Promise<void> {
    const a = ev.args as DeliveryArgs;
    const recipient = normalizeRecipient(a.recipient);
    const netAmount = a.amount.toString();
    const matchId = await findInitiated(a.sourceAsset, recipient, netAmount);
    const id = matchId ?? orphanId(ev, "exec");
    await apply(id, "completed", ev, a, recipient, netAmount);
  }

  async function queued(ev: LogEvent): Promise<void> {
    const a = ev.args as DeliveryArgs & { id: bigint };
    const recipient = normalizeRecipient(a.recipient);
    const netAmount = a.amount.toString();
    const matchId = await findInitiated(a.sourceAsset, recipient, netAmount);
    const id = matchId ?? orphanId(ev, "queue");
    await apply(id, "queued", ev, a, recipient, netAmount, { pending_id: a.id.toString() });
  }

  async function fulfilled(ev: LogEvent): Promise<void> {
    const a = ev.args as DeliveryArgs & { id: bigint };
    const matchId = await findByPendingId(a.id.toString());
    const id = matchId ?? orphanId(ev, "fulfill");
    await apply(id, "fulfilled", ev, a, normalizeRecipient(a.recipient), a.amount.toString(), {
      pending_id: a.id.toString(),
    });
  }

  async function apply(
    id: string,
    state: TransferState,
    ev: LogEvent,
    a: DeliveryArgs,
    recipient: string,
    netAmount: string,
    extra: { pending_id?: string } = {},
  ): Promise<void> {
    const ref = await enrich.withBlockTime(ev.chain, ev.ref);
    const fieldRef =
      state === "completed"
        ? { completed: ref }
        : state === "queued"
          ? { queued: ref }
          : state === "fulfilled"
            ? { fulfilled: ref }
            : {};

    const { row, created, previousState } = await upsertTransfer(id, state, {
      source_chain: id.startsWith("init-") ? id.split("-")[1] : "unknown",
      dest_chain: ev.chain,
      dest_chain_id: destChainId,
      source_asset: a.sourceAsset,
      dest_asset: a.destAsset,
      recipient,
      net_amount: netAmount,
      ...fieldRef,
      ...extra,
    });

    emit(created, row, previousState);
  }

  return {
    initiated: { abi: BridgeInitiatedEvt, handle: initiated },
    executed: { abi: TransferExecutedEvt, handle: executed },
    queued: { abi: TransferQueuedEvt, handle: queued },
    fulfilled: { abi: PendingTransferFulfilledEvt, handle: fulfilled },
  };
}
