import { toHex, type Hex } from "viem";

import { serializeLayout } from "@wormhole-foundation/sdk-connect";
import { relayInstructionsLayout, UniversalAddress } from "@wormhole-foundation/sdk-definitions";

/**
 * Wormhole Executor — a permissionless, pay-at-source relay marketplace. Instead of running your
 * own relayer, you fetch a signed quote for a destination execution, then call the Executor
 * contract's `requestExecution` paying the quoted cost in the SOURCE chain's native currency. An
 * off-chain executor picks up the `RequestForExecution` event, pulls the VAA from the Guardians,
 * and submits it to the destination.
 *
 * Labs-operated quote provider (mainnet): https://executor.labsapis.com
 */
export const EXECUTOR_MAINNET = "https://executor.labsapis.com";

/**
 * A relay instruction — the gas / native value you want bought on the destination. Mapped onto the
 * Wormhole SDK's `relayInstructionsLayout` (`GasInstruction` type 1, `GasDropOffInstruction` type 2).
 *
 *   gas      → buy `gasLimit` of execution (+ optional `msgValue` forwarded to the target)
 *   dropOff  → deliver `dropOff` native to `recipient` (32-byte universal address)
 */
export type RelayInstruction =
  | { type: "gas"; gasLimit: bigint; msgValue?: bigint }
  | { type: "dropOff"; dropOff: bigint; recipient: Hex };

/** Encode relay instructions into the `0x`-hex `relayInstructions` field the quote endpoint expects. */
export function encodeRelayInstructions(instructions: RelayInstruction[]): Hex {
  const requests = instructions.map((ri) =>
    ri.type === "gas"
      ? {
          request: {
            type: "GasInstruction" as const,
            gasLimit: ri.gasLimit,
            msgValue: ri.msgValue ?? 0n,
          },
        }
      : {
          request: {
            type: "GasDropOffInstruction" as const,
            dropOff: ri.dropOff,
            recipient: new UniversalAddress(ri.recipient),
          },
        },
  );
  return toHex(serializeLayout(relayInstructionsLayout, { requests }));
}

export type ExecutorQuote = {
  /** EQ01 signed authorization — pass (with the `0x`) into the on-chain `requestExecution`. */
  signedQuote: Hex;
  /** Relay cost in the SOURCE chain's native wei — attach verbatim as `msg.value`. */
  estimatedCost: bigint;
};

/**
 * Fetch a signed execution quote from an Executor provider for relaying a message between chains.
 * The provider does the gas math (destination gas × price, converted through src/dst USD prices)
 * and returns the cost ready to use — pass `estimatedCost` straight through as `msg.value`.
 *
 * @param srcChain          Wormhole chain id of the source (e.g. 16 = Moonbeam)
 * @param dstChain          Wormhole chain id of the destination (e.g. 2 = Ethereum)
 * @param relayInstructions Encoded gas/drop-off instructions (see `encodeRelayInstructions`)
 * @param opts.baseUrl      Provider base URL (defaults to mainnet `EXECUTOR_MAINNET`)
 */
export async function fetchExecutorQuote(
  srcChain: number,
  dstChain: number,
  relayInstructions: Hex,
  opts: { baseUrl?: string } = {},
): Promise<ExecutorQuote> {
  const baseUrl = opts.baseUrl ?? EXECUTOR_MAINNET;
  const res = await fetch(`${baseUrl}/v0/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ srcChain, dstChain, relayInstructions }),
  });
  if (!res.ok) {
    throw new Error(`Executor /v0/quote ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { signedQuote?: string; estimatedCost?: string };
  if (!json.signedQuote || json.estimatedCost === undefined) {
    throw new Error(`Executor /v0/quote returned no quote: ${JSON.stringify(json)}`);
  }
  return {
    signedQuote: json.signedQuote as Hex,
    estimatedCost: BigInt(json.estimatedCost),
  };
}
