import { LogMessagePublishedEvt } from "../../../abi";
import { NEAR_PUBLISH, type NearPublished } from "../../../ingest/flows/messages";
import { parseNttTransfer } from "../../../ingest/payload";
import type { Flow, LogEvent } from "../../../types";
import { bytes32ToAddress } from "../../../utils";
import { wormholeId } from "../../../chains";

import { WithdrawRequestedEvt } from "./abi";
import {
  byConnector,
  byEmitter,
  byWithdraw,
  depositSender,
  ROUTES,
  withdrawSender,
} from "./routes";

interface Requested {
  sequence: bigint;
  nearAccount: `0x${string}`;
  sender: `0x${string}`;
  amount: bigint;
  fee: bigint;
  destination: `0x${string}`;
}

interface Published {
  sender: `0x${string}`;
  sequence: bigint;
  payload: `0x${string}`;
}

/** `verify_deposit_v2`'s arguments: the order, the coin's transaction and its proof. */
interface VerifyDeposit {
  deposit_msg: {
    recipient_id: string;
    safe_deposit?: { msg: string };
    refund_address?: string;
  };
  tx_bytes: string | number[];
  vout: number;
  proof?: { tx_block_blockhash?: string };
}

interface DepositDetails {
  mint_amount: string;
  protocol_fee?: string;
  relayer_fee?: string;
  success: boolean;
}

/** A row's key: the source transaction, on the chain it was sent from. */
const source = (ev: LogEvent) => `${ev.chain}:${ev.ref.txHash}`;

/** NTT senders that mark a transfer as one of ours, by direction. */
const WITHDRAW_SENDERS = new Set(ROUTES.map(withdrawSender));
const DEPOSIT_SENDERS = new Set(ROUTES.map(depositSender));

/**
 * The digest of an NTT transfer this flow rides, or null for anyone else's.
 *
 * @param payload The transceiver payload.
 * @param ev The publishing event.
 * @param senders Which senders count.
 */
function ownDigest(payload: string, ev: LogEvent, senders: Set<string>): string | null {
  const t = parseNttTransfer(payload, wormholeId(ev.chain));
  return t && senders.has(t.sender) ? t.digest : null;
}

/**
 * The Hydration recipient an order names: an H160, or one left-padded to 32 bytes.
 *
 * @param msg `safe_deposit.msg` — our `TransferMsg`, as JSON.
 */
function recipientOf(msg: string | undefined): string | null {
  try {
    const r = String(JSON.parse(msg ?? "").recipient ?? "").toLowerCase();
    if (/^0x[0-9a-f]{64}$/.test(r)) return bytes32ToAddress(r);
    return /^0x[0-9a-f]{40}$/.test(r) ? r : null;
  } catch {
    return null;
  }
}

/**
 * UTXO coins moving through Omni's connectors and our NTT corridors — deposits from the coin's own
 * chain onto Hydration, and withdrawals back.
 *
 * A row is keyed by its source transaction: a deposit's NEAR proof, a withdrawal's Hydration send.
 * Every leg in that transaction keys the same way and merges, so log order never matters. The NTT
 * transfer it rides is `ntt_transfers`, joined by digest — and recognised as ours by its sender: the
 * coin's emitter going out, the connector coming in.
 *
 * What happens after is not on any watched account: a withdrawal's NEAR leg runs on its derived
 * account, and the coin's chain is not indexed at all. Pollers carry those — `withdrawn` and
 * `confirmed`.
 */
export const utxo: Flow = {
  name: "utxo",
  table: "utxo_transfers",
  key: { column: "id", type: "TEXT" },
  unique: ["digest"],
  states: { requested: 0, deposited: 0, withdrawn: 1, confirmed: 2 },
  columns: {
    direction: "TEXT",
    /** The coin's chain. */
    chain: "TEXT",
    /** The NTT transfer it rides. Joins to `ntt_transfers`. */
    digest: "TEXT",
    /** A deposit's payer on the coin's chain; a withdrawal's caller on Hydration. */
    sender: "TEXT",
    /** A deposit's Hydration account; a withdrawal's address on the coin's chain. */
    recipient: "TEXT",
    /** What crosses: the coin's output on a deposit, the net bridged on a withdrawal. */
    amount: "NUMERIC",
    /** The emitter's fee, on a withdrawal. */
    fee: "NUMERIC",
    /** Omni's cut: protocol + relayer fee on a deposit, the withdraw fee on a withdrawal. */
    bridge_fee: "NUMERIC",
    miner_fee: "NUMERIC",
    /** What the coin's chain pays out, on a withdrawal. */
    received: "NUMERIC",
    /** The NEAR account a withdrawal goes through, as the implicit account id. */
    near_account: "TEXT",
    deposit_address: "TEXT",
    refund_address: "TEXT",
    /** False when the manager refused the mint — the coin waits at the deposit address for refund. */
    deposit_ok: "BOOLEAN",
    /** The coin's transaction: what was paid in, or what pays out. */
    utxo_tx: "TEXT",
    utxo_vout: "INTEGER",
    /** The block it was proven in, on a deposit. */
    utxo_block: "TEXT",
    /** The NTT manager's sequence, on a withdrawal — what the emitter logs. */
    ntt_sequence: "BIGINT",
    requested: "JSONB",
    deposited: "JSONB",
    withdrawn: "JSONB",
    confirmed: "JSONB",
  },
  indexes: [
    `CREATE INDEX IF NOT EXISTS idx_utxo_transfers_sender ON utxo_transfers (lower(sender));`,
    `CREATE INDEX IF NOT EXISTS idx_utxo_transfers_recipient ON utxo_transfers (lower(recipient));`,
    `CREATE INDEX IF NOT EXISTS idx_utxo_transfers_account ON utxo_transfers (near_account);`,
  ],
  legs: [
    // ─── Withdraw: one Hydration transaction ───
    {
      role: "utxo-emitter",
      abi: WithdrawRequestedEvt,
      state: "requested",
      key: (_a: Requested, ev: LogEvent) => (byEmitter(ev.address) ? source(ev) : null),
      patch: (a: Requested, ev: LogEvent) => {
        const route = byEmitter(ev.address)!;
        return {
          direction: "withdraw",
          chain: route.chain,
          sender: a.sender.toLowerCase(),
          recipient: route.address(a.destination),
          amount: a.amount.toString(),
          fee: a.fee.toString(),
          near_account: a.nearAccount.slice(2).toLowerCase(),
          ntt_sequence: a.sequence.toString(),
          requested: ev.ref,
        };
      },
    },
    {
      role: "wormhole-core",
      abi: LogMessagePublishedEvt,
      state: "requested",
      key: (a: Published, ev: LogEvent) =>
        ownDigest(a.payload, ev, WITHDRAW_SENDERS) ? source(ev) : null,
      patch: (a: Published, ev: LogEvent) => ({
        digest: ownDigest(a.payload, ev, WITHDRAW_SENDERS),
      }),
    },

    // ─── Deposit: one NEAR transaction ───
    {
      // The proof's arguments carry what no log does: the coin's transaction — so who paid, and to
      // which address — and the order with its refund address.
      role: "utxo-connector",
      near: { standard: "call", event: "verify_deposit_v2" },
      state: "deposited",
      key: (_a: VerifyDeposit, ev: LogEvent) => (byConnector(ev.address) ? source(ev) : null),
      patch: (a: VerifyDeposit, ev: LogEvent) => {
        const route = byConnector(ev.address)!;
        const raw =
          typeof a.tx_bytes === "string"
            ? Buffer.from(a.tx_bytes, "base64")
            : Buffer.from(a.tx_bytes);
        const tx = route.parseTx(raw);
        const out = tx?.outputs[a.vout];
        return {
          direction: "deposit",
          chain: route.chain,
          sender: tx?.inputs.find((i) => i.address)?.address ?? null,
          recipient: recipientOf(a.deposit_msg.safe_deposit?.msg),
          refund_address: a.deposit_msg.refund_address ?? null,
          deposit_address: out?.address ?? null,
          amount: out ? out.value.toString() : null,
          utxo_vout: a.vout,
          utxo_block: a.proof?.tx_block_blockhash ?? null,
          deposited: ev.ref,
        };
      },
    },
    {
      // A v5 transaction's id commits to more than its bytes' double hash, so the id comes from the
      // connector, which names the coin it now holds as `txid@vout`.
      role: "utxo-connector",
      near: { standard: "bridge", event: "utxo_added" },
      state: "deposited",
      key: (_a: unknown, ev: LogEvent) => (byConnector(ev.address) ? source(ev) : null),
      patch: (a: { utxo_storage_keys: string[] }) => ({
        utxo_tx: a.utxo_storage_keys[0]?.split("@")[0] ?? null,
      }),
    },
    {
      role: "utxo-connector",
      near: { standard: "bridge", event: "verify_deposit_details" },
      state: "deposited",
      key: (_a: unknown, ev: LogEvent) => (byConnector(ev.address) ? source(ev) : null),
      patch: (a: DepositDetails) => ({
        bridge_fee: (BigInt(a.protocol_fee ?? 0) + BigInt(a.relayer_fee ?? 0)).toString(),
        deposit_ok: a.success,
      }),
    },
    {
      role: "wormhole-core",
      near: NEAR_PUBLISH,
      state: "deposited",
      key: (a: NearPublished, ev: LogEvent) =>
        ownDigest(`0x${a.data}`, ev, DEPOSIT_SENDERS) ? source(ev) : null,
      patch: (a: NearPublished, ev: LogEvent) => ({
        digest: ownDigest(`0x${a.data}`, ev, DEPOSIT_SENDERS),
      }),
    },
  ],
};

/** `UtxoWithdraw.signed` — one delegate signed for a derived account. */
interface Signed {
  action: string;
  account: string;
  address: string;
  amount: string;
  input?: unknown;
}

/**
 * Every delegate our `UtxoWithdraw` signs: proof that a withdrawal was asked for and signed, before
 * anyone relays it.
 *
 * A table of its own, keyed by the signing log, rather than a leg on the withdrawal: the sign is on
 * NEAR and the withdrawal's row on Hydration, read at different speeds — and one sign takes the
 * account's whole balance, which may be several withdrawals. A withdrawal is matched to the first
 * sign for its account after its NEAR delivery, when read.
 */
export const signs: Flow = {
  name: "utxo-signs",
  table: "utxo_signs",
  key: { column: "id", type: "TEXT" },
  states: { signed: 0 },
  columns: {
    chain: "TEXT",
    /** `withdraw`, or the account's one-time `claim`. */
    action: "TEXT",
    /** The derived account, as its implicit id. */
    account: "TEXT",
    /** The coin's address it pays. */
    address: "TEXT",
    amount: "NUMERIC",
    /** The connector coin it spends, as signed. */
    input: "TEXT",
    signed: "JSONB",
  },
  indexes: [`CREATE INDEX IF NOT EXISTS idx_utxo_signs_account ON utxo_signs (account, action);`],
  legs: [
    {
      role: "utxo-withdraw",
      near: { standard: "whm-utxo-withdraw", event: "signed" },
      state: "signed",
      key: (_a: Signed, ev: LogEvent) =>
        byWithdraw(ev.address) ? `${ev.ref.txHash}:${ev.ref.logIndex}` : null,
      patch: (a: Signed, ev: LogEvent) => ({
        chain: byWithdraw(ev.address)!.chain,
        action: a.action,
        account: a.account,
        address: a.address,
        amount: a.amount,
        input: a.input === undefined ? null : JSON.stringify(a.input),
        signed: ev.ref,
      }),
    },
  ],
};
