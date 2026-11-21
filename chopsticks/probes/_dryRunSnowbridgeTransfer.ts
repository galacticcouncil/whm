/**
 * Dry-run the transfer proposal's Asset Hub messages against live Asset Hub and Bridge Hub (DryRunApi).
 *
 *   npx tsx probes/_dryRunSnowbridgeTransfer.ts [--proposal probes/snowbridge-transfer-proposal.json]
 */
import { readFileSync } from "node:fs";

import { AccountId, Binary, createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

import { toJson } from "../lib/utils";

import { arg } from "./snowbridgeFork";
import {
  ASSET_HUB_PARA_ID,
  BRIDGE_HUB_PARA_ID,
  HYDRATION_PARA_ID,
  HYDRATION_SA_ON_ASSET_HUB,
  TC_SAFE_ETHEREUM,
  buildExitBatchXcm,
  tokenLocation,
} from "./snowbridgeExit";

const sibling = (para: number) => ({
  type: "V5",
  value: { parents: 1, interior: { type: "X1", value: { type: "Parachain", value: para } } },
});

async function main(): Promise<void> {
  const p = JSON.parse(readFileSync(arg("proposal") ?? "probes/snowbridge-transfer-proposal.json", "utf8"));
  const ah = createClient(getWsProvider("wss://polkadot-asset-hub-rpc.polkadot.io"));
  const bh = createClient(getWsProvider("wss://polkadot-bridge-hub-rpc.polkadot.io"));
  const aapi: any = ah.getUnsafeApi();
  const bapi: any = bh.getUnsafeApi();
  const fees = {
    dotWithdraw: BigInt(p.fees.dotWithdraw),
    dotLocalFee: BigInt(p.fees.dotLocalFee),
    etherFee: BigInt(p.fees.etherFee),
  };
  let ok = true;
  try {
    for (const [i, msg] of p.messages.entries()) {
      const assets = msg.assets.map((a: { token: `0x${string}` | "ETH"; amount: string }) => ({
        token: a.token,
        amount: BigInt(a.amount),
      }));
      const xcm = buildExitBatchXcm({ assets, beneficiary: msg.beneficiary ?? TC_SAFE_ETHEREUM, ...fees, topic: msg.topic });
      const r = await aapi.apis.DryRunApi.dry_run_xcm(sibling(HYDRATION_PARA_ID), { type: "V5", value: xcm });
      const res = r?.success ? r.value : r;
      const ahOk = res?.execution_result?.type === "Complete";
      const symbols = msg.assets.map((a: { symbol: string }) => a.symbol).join(",");
      console.log(`message ${i + 1} [${symbols}] Asset Hub ${ahOk ? "✅" : "❌"} ${toJson(res?.execution_result).slice(0, 200)}`);
      ok &&= ahOk;
      if (!ahOk) {
        const sa = AccountId(0).dec(Binary.fromHex(HYDRATION_SA_ON_ASSET_HUB));
        for (const a of msg.assets) {
          const live = ((await aapi.query.ForeignAssets.Account.getValue(tokenLocation(a.token), sa))?.balance ?? 0n) as bigint;
          if (live < BigInt(a.amount)) console.log(`   ${a.symbol}: live SA ${live} < proposal ${a.amount}`);
        }
      }
      for (const [dest, msgs] of res?.forwarded_xcms ?? []) {
        if (!toJson(dest).includes(String(BRIDGE_HUB_PARA_ID))) continue;
        for (const m of msgs) {
          const b = await bapi.apis.DryRunApi.dry_run_xcm(sibling(ASSET_HUB_PARA_ID), m);
          const bres = b?.success ? b.value : b;
          const queued = (bres?.emitted_events ?? []).find(
            (e: any) => e.type === "EthereumOutboundQueueV2" && e.value?.type === "MessageQueued",
          );
          const bhOk = bres?.execution_result?.type === "Complete" && !!queued;
          ok &&= bhOk;
          console.log(`   Bridge Hub ${bhOk ? "✅" : "❌"} ${toJson(bres?.execution_result).slice(0, 160)}`);
          for (const c of queued?.value.value.message.commands ?? []) {
            console.log(`     ${c.type} ${c.value.token} → ${c.value.recipient} ${c.value.amount}`);
          }
        }
      }
    }
  } finally {
    ah.destroy();
    bh.destroy();
  }
  process.exitCode = ok ? 0 : 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
