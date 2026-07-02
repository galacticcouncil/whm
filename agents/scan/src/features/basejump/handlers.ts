import type { Enrich } from "../../enrich";
import type { EventHandler, LogEvent } from "../../types";
import { broadcast } from "../../subscribers";
import { normalizeRecipient } from "../../utils";

import { upsertTransfer, type TransferRow, type TransferState } from "./db";
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

/** The three delivery handlers for one landing deployment. */
export interface LandingHandlers {
  executed: EventHandler;
  queued: EventHandler;
  fulfilled: EventHandler;
}

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
 * Build the Basejump handlers. The source `initiated` handler is shared across all source chains;
 * landing handlers are produced per landing via `landing(destChainId)`, so multiple
 * independent deployments (separate Moonbeam/Hydration harnesses, each with its own landing) stay
 * correctly correlated while merging into one unified transfers view.
 *
 * @param enrich shared per-chain block-time / sender enrichment
 * @returns the shared `initiated` source handler and a per-landing handler factory
 */
export function basejumpHandlers(enrich: Enrich): {
  initiated: EventHandler;
  landing: (destChainId: number) => LandingHandlers;
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

  // Namespace the landing's pending-queue id by the landing address: two independent landings each
  // run their own id counter, so the address keeps their pending ids from colliding.
  const pendingKey = (ev: LogEvent, id: bigint): string => `${ev.address.toLowerCase()}:${id}`;

  async function apply(
    id: string,
    state: TransferState,
    ev: LogEvent,
    a: DeliveryArgs,
    recipient: string,
    netAmount: string,
    destChainId: number,
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

  /**
   * Delivery handlers for a single landing.
   *
   * @param destChainId chain id recorded on rows delivered to this landing
   */
  function landing(destChainId: number): LandingHandlers {
    // Deliveries match the oldest un-delivered source by (source asset, recipient, net amount);
    // distinct source assets keep separate corridors apart.
    async function executed(ev: LogEvent): Promise<void> {
      const a = ev.args as DeliveryArgs;
      const recipient = normalizeRecipient(a.recipient);
      const netAmount = a.amount.toString();
      const matchId = await findInitiated(a.sourceAsset, recipient, netAmount);
      await apply(matchId ?? orphanId(ev, "exec"), "completed", ev, a, recipient, netAmount, destChainId);
    }

    async function queued(ev: LogEvent): Promise<void> {
      const a = ev.args as DeliveryArgs & { id: bigint };
      const recipient = normalizeRecipient(a.recipient);
      const netAmount = a.amount.toString();
      const matchId = await findInitiated(a.sourceAsset, recipient, netAmount);
      await apply(matchId ?? orphanId(ev, "queue"), "queued", ev, a, recipient, netAmount, destChainId, {
        pending_id: pendingKey(ev, a.id),
      });
    }

    async function fulfilled(ev: LogEvent): Promise<void> {
      const a = ev.args as DeliveryArgs & { id: bigint };
      const key = pendingKey(ev, a.id);
      const matchId = await findByPendingId(key);
      await apply(
        matchId ?? orphanId(ev, "fulfill"),
        "fulfilled",
        ev,
        a,
        normalizeRecipient(a.recipient),
        a.amount.toString(),
        destChainId,
        { pending_id: key },
      );
    }

    return {
      executed: { abi: TransferExecutedEvt, handle: executed },
      queued: { abi: TransferQueuedEvt, handle: queued },
      fulfilled: { abi: PendingTransferFulfilledEvt, handle: fulfilled },
    };
  }

  return { initiated: { abi: BridgeInitiatedEvt, handle: initiated }, landing };
}
