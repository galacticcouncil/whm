import { TX_PAGE } from "./consts";
import type { Tx } from "./types";

const REQUEST_TIMEOUT_MS = 30_000;

const TRANSACTIONS = `
query($obj: SuiAddress!, $after: String, $cp: UInt53) {
  transactions(first: ${TX_PAGE}, after: $after, filter: { affectedObject: $obj, afterCheckpoint: $cp }) {
    pageInfo { hasNextPage endCursor }
    nodes {
      digest
      sender { address }
      effects {
        status timestamp checkpoint { sequenceNumber }
        events { nodes { contents { type { repr } json } } }
      }
      kind {
        __typename
        ... on ProgrammableTransaction {
          inputs { nodes { __typename ... on MoveValue { type { repr } bcs } ... on SharedInput { address } } }
          commands { nodes { __typename ... on MoveCallCommand { function { name module { name package { address } } } } } }
        }
      }
    }
  }
}`;

/** Sui's GraphQL service: the transactions touching an object, and the latest checkpoint. */
export class SuiGraphql {
  /**
   * @param url The service's endpoint.
   */
  constructor(private readonly url: string) {}

  /** The latest checkpoint. */
  async checkpoint(): Promise<bigint> {
    const r = await this.query<{ checkpoint: { sequenceNumber: number } }>(
      "{ checkpoint { sequenceNumber } }",
    );
    return BigInt(r.checkpoint.sequenceNumber);
  }

  /**
   * Every transaction that touched an object after a checkpoint, oldest first.
   *
   * @param object A shared object.
   * @param after Exclusive lower bound, a checkpoint.
   */
  async transactions(object: string, after: bigint): Promise<Tx[]> {
    const out: Tx[] = [];
    let cursor: string | null = null;
    for (;;) {
      const r: {
        transactions: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Tx[] };
      } = await this.query(TRANSACTIONS, { obj: object, after: cursor, cp: Number(after) });
      out.push(...r.transactions.nodes);
      if (!r.transactions.pageInfo.hasNextPage) return out;
      cursor = r.transactions.pageInfo.endCursor;
    }
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`graphql: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length)
      throw new Error(`graphql: ${body.errors.map((e) => e.message).join("; ")}`);
    return body.data as T;
  }
}
