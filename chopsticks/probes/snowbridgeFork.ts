import { Binary } from "polkadot-api";
import type { Hex } from "viem";

import type { ChainSpec } from "../lib/configs";
import type { Network } from "../lib/network";
import { getEventsAt } from "../lib/queries";
import { toJson } from "../lib/utils";

import {
  ASSET_HUB_PARA_ID,
  BRIDGE_HUB_PARA_ID,
  HYDRATION_PARA_ID,
  assertProposal,
  encodeBatchAll,
  encodeWhitelistedDispatch,
  type Call,
} from "./snowbridgeExit";

export const FORK_SPECS: ChainSpec[] = [
  {
    key: "hydration",
    name: "Hydration",
    endpoint: "wss://hdx.tarn.hydration.cloud",
    port: Number(process.env.PORT_HYDRATION ?? 18361),
    paraId: HYDRATION_PARA_ID,
  },
  {
    key: "assetHub",
    name: "Asset Hub",
    endpoint: ["wss://polkadot-asset-hub-rpc.polkadot.io", "wss://asset-hub-polkadot-rpc.n.dwellir.com"],
    port: Number(process.env.PORT_ASSET_HUB ?? 18362),
    paraId: ASSET_HUB_PARA_ID,
  },
  {
    key: "bridgeHub",
    name: "Bridge Hub",
    endpoint: ["wss://polkadot-bridge-hub-rpc.polkadot.io", "wss://bridge-hub-polkadot-rpc.n.dwellir.com"],
    port: Number(process.env.PORT_BRIDGE_HUB ?? 18363),
    paraId: BRIDGE_HUB_PARA_ID,
  },
];

export type Ev = { event: { type: string; value: { type: string; value: unknown } }; phase?: unknown };

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function eventsAt(net: Network, at: string, typed = false): Promise<Ev[]> {
  let last: unknown;
  for (let i = 0; i < 12; i++) {
    try {
      if (typed) return (await getEventsAt(net, at)) as unknown as Ev[];
      return (await net.client.getUnsafeApi().query.System.Events.getValue({ at })) as Ev[];
    } catch (e) {
      last = e;
      if (typed && i === 2) typed = false;
      await sleep(300);
    }
  }
  throw last;
}

export const pick = (evs: Ev[], pallet: string, name?: string) =>
  evs.filter((e) => e.event.type === pallet && (!name || e.event.value.type === name));

export function summarize(evs: Ev[]): string[] {
  return evs.map((e) => `${e.event.type}.${e.event.value.type} ${toJson(e.event.value.value)}`.slice(0, 600));
}

export async function dispatchAs(
  net: Network,
  callHex: Hex,
  origin: unknown,
  extraStorage: Record<string, unknown> = {},
): Promise<{ blockHash: string; events: Ev[] }> {
  const when = net.chain.head.number + 1;
  const bytes = Binary.fromHex(callHex);
  const registry = await net.chain.head.registry;
  const hash = registry.hash(bytes).toHex() as Hex;
  await net.setStorage({
    ...extraStorage,
    Preimage: { PreimageFor: [[[[hash, bytes.length]], Array.from(bytes)]] },
    Scheduler: {
      Agenda: [
        [
          [when],
          [{ maybeId: null, priority: 0, call: { Lookup: { hash, len: bytes.length } }, maybePeriodic: null, origin }],
        ],
      ],
    },
  });
  const block = await net.chain.newBlock();
  return { blockHash: block.hash, events: await eventsAt(net, block.hash, true) };
}

export async function enactWhitelisted(
  net: Network,
  outer: Hex,
  innerHash: Hex,
): Promise<{ blockHash: string; events: Ev[] }> {
  return dispatchAs(net, outer, { Origins: "WhitelistedCaller" }, { Whitelist: { WhitelistedCall: [[[innerHash], {}]] } });
}

export function checklist() {
  const items: [string, boolean, string?][] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    items.push([name, ok, detail]);
    console.log(`   ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
    return ok;
  };
  const failed = () => items.filter(([, ok]) => !ok);
  return { check, failed };
}

export type Check = ReturnType<typeof checklist>["check"];

export async function finalize(net: Network, calls: Call[]) {
  const inner = calls.length === 1 ? calls[0].hex : encodeBatchAll(calls.map((c) => c.hex));
  const outer = encodeWhitelistedDispatch(inner);
  if (calls.length > 1) await assertProposal(net.client, outer, calls);
  const registry = await net.chain.head.registry;
  const innerHash = registry.hash(Binary.fromHex(inner)).toHex() as Hex;
  return { inner, outer, innerHash, innerBytes: inner.length / 2 - 1, outerBytes: outer.length / 2 - 1 };
}

export function dispatchOk(evs: Ev[], check: Check, batch = true): boolean {
  const dispatched = pick(evs, "Scheduler", "Dispatched").map((e) => toJson(e.event.value.value));
  const wl = pick(evs, "Whitelist", "WhitelistedCallDispatched").map((e) => toJson(e.event.value.value));
  const a = check("Scheduler.Dispatched ok", dispatched.some((d) => d.includes('"success":true')), dispatched.join(" "));
  const b = check(
    "Whitelist.WhitelistedCallDispatched ok",
    wl.length > 0 && !wl.some((w) => w.includes('"success":false')),
    wl.join(" ").slice(0, 300),
  );
  const c =
    !batch ||
    check(
      "Utility.BatchCompleted",
      pick(evs, "Utility", "BatchCompleted").length > 0 && pick(evs, "Utility", "BatchInterrupted").length === 0,
    );
  return a && b && c;
}
