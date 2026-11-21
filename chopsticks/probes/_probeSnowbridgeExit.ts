/**
 * Build and rehearse the single-asset Snowbridge exit proposal on Hydration + Asset Hub + Bridge Hub forks.
 *
 *   npx tsx probes/_probeSnowbridgeExit.ts --asset 41 [--amount <raw>] [--no-retire] [--root]
 *     [--ether-fee <wei>] [--dot-withdraw <planck>] [--dot-fee <planck>] [--out <file>]
 */
import { writeFileSync } from "node:fs";

import { AccountId, Binary } from "polkadot-api";
import type { Hex } from "viem";

import { spawnForks, teardownForks } from "../lib/network";
import { toJson } from "../lib/utils";

import { FORK_SPECS, arg, dispatchAs, eventsAt, flag, pick, summarize, type Ev } from "./snowbridgeFork";
import {
  ETHER_LOCATION,
  HYDRATION_SA_ON_ASSET_HUB,
  TC_SAFE_ETHEREUM,
  buildExitXcm,
  encodeBatchAll,
  encodeRetireLocation,
  encodeSendToAssetHub,
  encodeWhitelistedDispatch,
  exitTopic,
  retiredLocationShape,
  tokenLocation,
  type SnowbridgeToken,
} from "./snowbridgeExit";

const USDT_ASSET_HUB = 1984;
const USDC_ASSET_HUB = 1337;
const USDC_SNOWBRIDGE: Hex = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

async function main(): Promise<void> {
  const assetId = Number(arg("asset") ?? 41);
  const retire = !flag("no-retire");
  const asRoot = flag("root");

  const nets = await spawnForks(FORK_SPECS);
  const { hydration, assetHub, bridgeHub } = nets;
  const checks: [string, boolean, string?][] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push([name, ok, detail]);
    console.log(`   ${ok ? "✅" : "❌"} ${name}${detail ? `  ${detail}` : ""}`);
  };

  try {
    const hdx: any = hydration.client.getUnsafeApi();
    const ah: any = assetHub.client.getUnsafeApi();
    const bh: any = bridgeHub.client.getUnsafeApi();
    const sa = AccountId(0).dec(Binary.fromHex(HYDRATION_SA_ON_ASSET_HUB));

    const meta = await hdx.query.AssetRegistry.Assets.getValue(assetId);
    const symbol = meta?.symbol ? Buffer.from(meta.symbol).toString("utf8") : `#${assetId}`;
    const decimals: number = meta?.decimals ?? 0;
    const locBefore = await hdx.query.AssetRegistry.AssetLocations.getValue(assetId);
    const keyMatch = toJson(locBefore).match(/"key":"(0x[0-9a-fA-F]{40})"/);
    const token: SnowbridgeToken = keyMatch ? (keyMatch[1].toLowerCase() as Hex) : "ETH";
    if (!/GlobalConsensus/.test(toJson(locBefore))) throw new Error(`asset ${assetId} is not Snowbridge-located`);
    const issuance: bigint = await hdx.query.Tokens.TotalIssuance.getValue(assetId);

    const loc = tokenLocation(token);
    const readSa = async () => ({
      token: ((await ah.query.ForeignAssets.Account.getValue(loc, sa))?.balance ?? 0n) as bigint,
      dot: ((await ah.query.System.Account.getValue(sa)).data.free ?? 0n) as bigint,
      ether: ((await ah.query.ForeignAssets.Account.getValue(ETHER_LOCATION, sa))?.balance ?? 0n) as bigint,
      usdcSnowbridge: ((await ah.query.ForeignAssets.Account.getValue(tokenLocation(USDC_SNOWBRIDGE), sa))?.balance ??
        0n) as bigint,
      usdt: ((await ah.query.Assets.Account.getValue(USDT_ASSET_HUB, sa))?.balance ?? 0n) as bigint,
      usdc: ((await ah.query.Assets.Account.getValue(USDC_ASSET_HUB, sa))?.balance ?? 0n) as bigint,
    });
    const saBefore = await readSa();
    const supplyBefore = ((await ah.query.ForeignAssets.Asset.getValue(loc))?.supply ?? 0n) as bigint;
    const nonceBefore = (await bh.query.EthereumOutboundQueueV2.Nonce.getValue()) as bigint;

    const amount = arg("amount") ? BigInt(arg("amount")!) : saBefore.token;
    const params = {
      token,
      amount,
      beneficiary: TC_SAFE_ETHEREUM,
      dotWithdraw: BigInt(arg("dot-withdraw") ?? 50_000_000_000n),
      dotLocalFee: BigInt(arg("dot-fee") ?? 10_000_000_000n),
      etherFee: BigInt(arg("ether-fee") ?? 1_000_000_000_000_000n),
      topic: exitTopic(assetId, amount),
    };

    console.log(`\n🥢 ${symbol} (${assetId}) → Snowbridge → ${TC_SAFE_ETHEREUM}`);
    console.log(`   token ${token}  decimals ${decimals}`);
    console.log(`   Hydration issuance ${issuance}  SA ${saBefore.token}  amount ${amount}`);
    console.log(`   Asset Hub supply ${supplyBefore}  Bridge Hub outbound nonce ${nonceBefore}`);

    const xcm = buildExitXcm(params);
    const send = await encodeSendToAssetHub(hydration.client, xcm);
    const inner = retire ? encodeBatchAll([encodeRetireLocation(assetId, token), send]) : send;
    const outer = encodeWhitelistedDispatch(inner);
    const registry = await hydration.chain.head.registry;
    const innerHash = registry.hash(Binary.fromHex(inner)).toHex() as Hex;

    const out = arg("out") ?? `probes/snowbridge-exit-${symbol.toLowerCase()}-proposal.json`;
    writeFileSync(
      out,
      toJson(
        {
          asset: { id: assetId, symbol, decimals, token },
          amount: amount.toString(),
          beneficiary: TC_SAFE_ETHEREUM,
          retireLocation: retire ? retiredLocationShape(token) : null,
          fees: {
            dotWithdraw: params.dotWithdraw,
            dotLocalFee: params.dotLocalFee,
            etherFee: params.etherFee,
          },
          topic: params.topic,
          forkedAt: {
            hydration: hydration.chain.head.number,
            assetHub: assetHub.chain.head.number,
            bridgeHub: bridgeHub.chain.head.number,
          },
          calls: {
            send,
            inner,
            innerHash,
            whitelistedDispatch: outer,
          },
          xcm,
        },
        2,
      ),
    );
    console.log(`   proposal → ${out}`);
    console.log(`   inner ${inner.length / 2 - 1} bytes, blake2-256 ${innerHash}`);

    console.log(`\n🥢 Hydration: enact ${asRoot ? "inner call as Root" : "whitelisted dispatch as WhitelistedCaller"}`);
    const { blockHash, events: hEvents } = asRoot
      ? await dispatchAs(hydration, inner, { system: "Root" })
      : await dispatchAs(
          hydration,
          outer,
          { Origins: "WhitelistedCaller" },
          { Whitelist: { WhitelistedCall: [[[innerHash], {}]] } },
        );

    const dispatched = pick(hEvents, "Scheduler", "Dispatched").map((e) => toJson(e.event.value.value));
    check("Scheduler.Dispatched ok", dispatched.some((d) => d.includes('"success":true') || d.includes('"Ok"')), dispatched.join(" "));
    if (!asRoot) {
      const wl = pick(hEvents, "Whitelist", "WhitelistedCallDispatched").map((e) => toJson(e.event.value.value));
      check(
        "Whitelist.WhitelistedCallDispatched ok",
        wl.length > 0 && !wl.some((w) => w.includes('"success":false')),
        wl.join(" "),
      );
    }
    check("PolkadotXcm.Sent", pick(hEvents, "PolkadotXcm", "Sent").length > 0);
    if (retire) {
      check("Utility.BatchCompleted", pick(hEvents, "Utility", "BatchCompleted").length > 0);
      const locAfter = await hdx.query.AssetRegistry.AssetLocations.getValue(assetId, { at: blockHash });
      check(
        "AssetLocations = retired marker",
        toJson(locAfter).toLowerCase() === toJson(retiredLocationShape(token)).toLowerCase(),
        toJson(locAfter),
      );
    }
    if (checks.some(([, ok]) => !ok)) for (const l of summarize(hEvents)) console.log(`     ${l}`);

    console.log(`\n🥢 Asset Hub`);
    let ahEvents: Ev[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await assetHub.chain.newBlock();
      const evs = await eventsAt(assetHub, b.hash);
      const mq = pick(evs, "MessageQueue");
      if (mq.length) {
        ahEvents = evs;
        console.log(`   #${b.number}: ${mq.map((e) => `${e.event.value.type} ${toJson(e.event.value.value)}`).join(" | ").slice(0, 400)}`);
        break;
      }
    }
    const processed = pick(ahEvents, "MessageQueue", "Processed").map((e) => e.event.value.value as { success: boolean });
    check("MessageQueue.Processed success", processed.length > 0 && processed.every((p) => p.success));
    check("AssetConversion swap DOT → ETH", pick(ahEvents, "AssetConversion").length > 0);
    check("XcmpQueue.XcmpMessageSent (→ Bridge Hub)", pick(ahEvents, "XcmpQueue", "XcmpMessageSent").length > 0);

    const saAfter = await readSa();
    const supplyAfter = ((await ah.query.ForeignAssets.Asset.getValue(loc))?.supply ?? 0n) as bigint;
    const dDot = saBefore.dot - saAfter.dot;
    check("SA token −amount", saBefore.token - saAfter.token === amount, `${saBefore.token} → ${saAfter.token}`);
    const supplyDrop = token === "ETH" ? amount + params.etherFee : amount;
    check(
      `Asset Hub supply −${token === "ETH" ? "(amount + ether fee)" : "amount"}`,
      supplyBefore - supplyAfter === supplyDrop,
      `${supplyBefore} → ${supplyAfter}`,
    );
    check("SA DOT spent ≤ withdraw", dDot > 0n && dDot <= params.dotWithdraw, `${Number(dDot) / 1e10} DOT`);
    if (token !== "ETH") check("SA ether untouched", saAfter.ether === saBefore.ether);
    check(
      "SA other holdings untouched",
      saAfter.usdt === saBefore.usdt &&
        saAfter.usdc === saBefore.usdc &&
        (token === USDC_SNOWBRIDGE || saAfter.usdcSnowbridge === saBefore.usdcSnowbridge),
    );
    if (checks.some(([n, ok]) => !ok && !n.startsWith("Scheduler") && !n.startsWith("Whitelist")))
      for (const l of summarize(ahEvents)) console.log(`     ${l}`);

    console.log(`\n🥢 Bridge Hub`);
    let bhEvents: Ev[] = [];
    for (let i = 0; i < 4; i++) {
      const b = await bridgeHub.chain.newBlock();
      const evs = await eventsAt(bridgeHub, b.hash);
      if (pick(evs, "MessageQueue").length || pick(evs, "EthereumOutboundQueueV2").length) {
        bhEvents.push(...evs);
        console.log(`   #${b.number}: ${summarize(evs.filter((e) => /MessageQueue|EthereumOutboundQueueV2|XcmpQueue|PolkadotXcm/.test(e.event.type))).join(" | ").slice(0, 900)}`);
      }
    }
    const bhProcessed = pick(bhEvents, "MessageQueue", "Processed").map((e) => e.event.value.value as { success: boolean });
    check("Bridge Hub MessageQueue.Processed success", bhProcessed.length > 0 && bhProcessed.every((p) => p.success));
    const oq = pick(bhEvents, "EthereumOutboundQueueV2");
    check("EthereumOutboundQueueV2 events", oq.length > 0, oq.map((e) => e.event.value.type).join(","));
    const queued = oq.map((e) => toJson(e.event.value.value)).join(" ").toLowerCase();
    const tokenHex = token === "ETH" ? "0x0000000000000000000000000000000000000000" : token;
    check("UnlockNativeToken token", queued.includes(tokenHex.slice(2)), tokenHex);
    check("UnlockNativeToken recipient = Safe", queued.includes(TC_SAFE_ETHEREUM.slice(2).toLowerCase()));
    check("UnlockNativeToken amount", queued.includes(`"${amount}"`) || queued.includes(amount.toString()));
    const nonceAfter = (await bh.query.EthereumOutboundQueueV2.Nonce.getValue()) as bigint;
    check("outbound nonce +1", nonceAfter === nonceBefore + 1n, `${nonceBefore} → ${nonceAfter}`);
    for (const e of oq) console.log(`     ${e.event.value.type} ${toJson(e.event.value.value)}`.slice(0, 2000));

    const failed = checks.filter(([, ok]) => !ok);
    console.log(`\n🥢 ${failed.length ? `❌ ${failed.length} check(s) failed` : "✅ all checks passed"}`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    await teardownForks(nets);
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
