/**
 * Dry-run a transfer proposal against live Asset Hub and Bridge Hub (DryRunApi). The messages are decoded
 * from `calls.inner` with live Hydration metadata, so what runs is what the committee whitelists.
 *
 *   npx tsx probes/_dryRunSnowbridgeTransfer.ts [--proposal probes/snowbridge-transfer-proposal.json] [--rehearsal]
 */
import { readFileSync } from "node:fs";

import { AccountId, Binary, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import type { Hex } from "viem";

import { toJson } from "../lib/utils";

import { arg, flag } from "./snowbridgeFork";
import {
  ASSET_HUB_PARA_ID,
  BRIDGE_HUB_PARA_ID,
  HYDRATION_PARA_ID,
  HYDRATION_SA_ON_ASSET_HUB,
  callName,
  decodeCall,
  sameValue,
  tokenLocation,
  type DecodedCall,
  type SnowbridgeToken,
} from "./snowbridgeExit";

const HYDRATION_WS = process.env.RPC_HYDRATION_WS ?? "wss://hdx.tarn.hydration.cloud";
const ZERO = "0x0000000000000000000000000000000000000000";

const sibling = (para: number) => ({
  type: "V5",
  value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: para } } },
});

const hex = (v: unknown): string =>
  (typeof v === "string" ? v : v instanceof Uint8Array ? Binary.toHex(v) : String(JSON.parse(toJson(v)))).toLowerCase();

const junctions = (interior: { type: string; value: unknown }): any[] =>
  interior.type === "Here" ? [] : Array.isArray(interior.value) ? interior.value : [interior.value];

// token, amount and ethereum beneficiary exactly as an exit message encodes them
function unlockOf(xcm: any[]): { token: string; amount: bigint; beneficiary: string } | undefined {
  const it = xcm.find((i) => i.type === "InitiateTransfer")?.value;
  const assets = it?.assets?.[0]?.value?.value;
  const deposit = it?.remote_xcm?.find((i: any) => i.type === "DepositAsset")?.value;
  if (!assets || assets.length !== 1 || !deposit) return undefined;
  const key = junctions(assets[0].id.interior).find((j) => j.type === "AccountKey20")?.value.key;
  const ben = junctions(deposit.beneficiary.interior).find((j) => j.type === "AccountKey20")?.value.key;
  return { token: key === undefined ? ZERO : hex(key), amount: BigInt(assets[0].fun.value), beneficiary: hex(ben) };
}

async function main(): Promise<void> {
  const file = arg("proposal") ?? "probes/snowbridge-transfer-proposal.json";
  const p = JSON.parse(readFileSync(file, "utf8"));
  if (p.stage !== "transfer") throw new Error(`${file} is not a transfer proposal`);
  if (p.submittable !== true && !flag("rehearsal")) {
    throw new Error(`${file} is not submittable (${(p.blockers ?? []).join("; ")}); --rehearsal dry-runs it anyway`);
  }
  const hdx = createClient(getWsProvider(HYDRATION_WS));
  const ah = createClient(getWsProvider("wss://polkadot-asset-hub-rpc.polkadot.io"));
  const bh = createClient(getWsProvider("wss://polkadot-bridge-hub-rpc.polkadot.io"));
  const aapi: any = ah.getUnsafeApi();
  const bapi: any = bh.getUnsafeApi();
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    console.log(`❌ ${msg}`);
  };
  try {
    const head = await hdx.getFinalizedBlock();
    console.log(`hydration #${head.number}; proposal built on a fork of #${p.forkedAt?.hydration} (${p.builtOn})`);

    const outer = await decodeCall(hdx, p.calls.outer as Hex);
    const inner = await decodeCall(hdx, p.calls.inner as Hex);
    if (callName(outer) !== "Whitelist.dispatch_whitelisted_call_with_preimage" || !sameValue(outer.value.value.call, inner)) {
      fail("calls.outer is not the whitelisted dispatch of calls.inner");
    }
    const calls = (callName(inner) === "Utility.batch_all" ? inner.value.value.calls : [inner]) as DecodedCall[];
    const sends = calls.filter((c) => callName(c) === "PolkadotXcm.send");
    for (const c of calls.filter((c) => callName(c) !== "PolkadotXcm.send")) {
      console.log(`   ${callName(c)} ${toJson(c.value.value)}`);
    }
    if (sends.length !== p.messages.length) fail(`calls.inner sends ${sends.length} messages, messages[] lists ${p.messages.length}`);

    for (const [i, send] of sends.entries()) {
      const { dest, message } = send.value.value as { dest: unknown; message: { type: string; value: any[] } };
      const summary = p.messages[i];
      const label = `message ${i + 1} [${summary?.assets?.map((a: { symbol: string }) => a.symbol).join(",")}]`;
      if (!sameValue(dest, sibling(ASSET_HUB_PARA_ID))) fail(`${label}: sent to ${toJson(dest)}`);
      if (summary?.placeholder) fail(`${label}: placeholder beneficiary ${summary.beneficiary}`);
      const u = unlockOf(message.value);
      const want = summary?.assets?.[0];
      if (
        !u ||
        u.token !== (want?.token === "ETH" ? ZERO : String(want?.token).toLowerCase()) ||
        u.amount !== BigInt(want?.amount ?? -1) ||
        u.beneficiary !== String(summary?.beneficiary).toLowerCase()
      ) {
        fail(`${label}: calls.inner unlocks ${toJson(u)}, messages[] says ${toJson(summary)}`);
      }

      const r = await aapi.apis.DryRunApi.dry_run_xcm(sibling(HYDRATION_PARA_ID), message);
      const res = r?.success ? r.value : r;
      const ahOk = res?.execution_result?.type === "Complete";
      console.log(`${label} Asset Hub ${ahOk ? "✅" : "❌"} ${toJson(res?.execution_result).slice(0, 200)}`);
      if (!ahOk) {
        ok = false;
        const sa = AccountId(0).dec(Binary.fromHex(HYDRATION_SA_ON_ASSET_HUB));
        const token = (want?.token ?? "ETH") as SnowbridgeToken;
        const live = ((await aapi.query.ForeignAssets.Account.getValue(tokenLocation(token), sa))?.balance ?? 0n) as bigint;
        if (live < BigInt(want?.amount ?? 0)) console.log(`   ${want?.symbol}: live SA ${live} < proposal ${want?.amount}`);
      }

      const forwarded = ((res?.forwarded_xcms ?? []) as [unknown, unknown[]][])
        .filter(([d]) => sameValue(d, sibling(BRIDGE_HUB_PARA_ID)))
        .flatMap(([, msgs]) => msgs);
      if (forwarded.length !== 1) {
        fail(`${label}: ${forwarded.length} messages forwarded to Bridge Hub`);
        continue;
      }
      const b = await bapi.apis.DryRunApi.dry_run_xcm(sibling(ASSET_HUB_PARA_ID), forwarded[0]);
      const bres = b?.success ? b.value : b;
      const queued = (bres?.emitted_events ?? []).filter(
        (e: any) => e.type === "EthereumOutboundQueueV2" && e.value?.type === "MessageQueued",
      );
      const commands = queued.flatMap((q: any) => q.value.value.message.commands);
      const bhOk =
        bres?.execution_result?.type === "Complete" &&
        queued.length === 1 &&
        commands.length === 1 &&
        commands[0].type === "UnlockNativeToken" &&
        hex(commands[0].value.token) === u?.token &&
        hex(commands[0].value.recipient) === u?.beneficiary &&
        BigInt(commands[0].value.amount) === u?.amount;
      ok &&= bhOk;
      console.log(`   Bridge Hub ${bhOk ? "✅" : "❌"} ${toJson(bres?.execution_result).slice(0, 160)}`);
      for (const c of commands) console.log(`     ${c.type} ${hex(c.value.token)} → ${hex(c.value.recipient)} ${c.value.amount}`);
    }
  } finally {
    hdx.destroy();
    ah.destroy();
    bh.destroy();
  }
  console.log(ok ? "✅ every message unlocks exactly what the proposal says" : "❌ dry run failed");
  process.exitCode = ok ? 0 : 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
