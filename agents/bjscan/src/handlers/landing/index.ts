import type { PolkadotClient } from "polkadot-api";

import { destination } from "../../config";
import {
  findByPendingId,
  findInitiated,
  upsertTransfer,
  type TransferState,
  type LogEvent,
} from "../../db";
import type { HandlerMap } from "../../processor";
import { broadcast } from "../../subscribers";
import { normalizeRecipient } from "../../utils";

import { PendingTransferFulfilledEvt, TransferExecutedEvt, TransferQueuedEvt } from "./abi";
import { createUtils } from "./utils";

type DeliveryArgs = {
  sourceAsset: `0x${string}`;
  destAsset: `0x${string}`;
  recipient: `0x${string}`;
  amount: bigint;
};

export function landing(client: PolkadotClient): HandlerMap {
  const { withBlockTime } = createUtils(client);

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
    const ref = await withBlockTime(ev.ref);
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
      dest_chain_id: destination.chainId,
      source_asset: a.sourceAsset,
      dest_asset: a.destAsset,
      recipient,
      net_amount: netAmount,
      ...fieldRef,
      ...extra,
    });

    broadcast(
      created
        ? { kind: "created", transfer: row }
        : { kind: "updated", transfer: row, previousState: previousState! },
    );
  }

  return {
    TransferExecuted: { abi: TransferExecutedEvt, handle: executed },
    TransferQueued: { abi: TransferQueuedEvt, handle: queued },
    PendingTransferFulfilled: { abi: PendingTransferFulfilledEvt, handle: fulfilled },
  };
}

function orphanId(ev: LogEvent, kind: string): string {
  return `orphan-${kind}-${ev.chain}-${ev.ref.txHash}-${ev.ref.logIndex}`;
}
