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

import {
  FORK_SPECS,
  arg,
  checklist,
  dispatchAs,
  dispatchOk,
  enactWhitelisted,
  eventsAt,
  finalize,
  flag,
  pick,
  summarize,
  type Ev,
} from "./snowbridgeFork";
import {
  DEFAULT_FEES,
  ETHER_LOCATION,
  HYDRATION_SA_ON_ASSET_HUB,
  SNOWBRIDGE_ASSETS,
  TC_SAFE_ETHEREUM,
  buildExitXcm,
  encodeRetireLocation,
  encodeSendToAssetHub,
  exitTopic,
  retiredLocationShape,
  sameValue,
  tokenLocation,
  type Call,
} from "./snowbridgeExit";

const USDT_ASSET_HUB = 1984;
const USDC_ASSET_HUB = 1337;
const USDC_SNOWBRIDGE: Hex = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

async function main(): Promise<void> {
  const assetId = Number(arg("asset") ?? 41);
  const asset = SNOWBRIDGE_ASSETS.find((a) => a.id === assetId);
  if (!asset) throw new Error(`asset ${assetId} is not one of the ${SNOWBRIDGE_ASSETS.length} Snowbridge assets`);
  const { token, symbol } = asset;
  const retire = !flag("no-retire");
  const asRoot = flag("root");

  const nets = await spawnForks(FORK_SPECS);
  const { hydration, assetHub, bridgeHub } = nets;
  const { check, failed } = checklist();

  try {
    const hdx: any = hydration.client.getUnsafeApi();
    const ah: any = assetHub.client.getUnsafeApi();
    const bh: any = bridgeHub.client.getUnsafeApi();
    const sa = AccountId(0).dec(Binary.fromHex(HYDRATION_SA_ON_ASSET_HUB));

    const decimals: number = (await hdx.query.AssetRegistry.Assets.getValue(assetId))?.decimals ?? 0;
    const locBefore = await hdx.query.AssetRegistry.AssetLocations.getValue(assetId);
    if (!sameValue(locBefore, tokenLocation(token))) {
      throw new Error(`${symbol} (${assetId}) is not at its Snowbridge location: ${toJson(locBefore)}`);
    }
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
      dotWithdraw: BigInt(arg("dot-withdraw") ?? DEFAULT_FEES.dotWithdraw),
      dotLocalFee: BigInt(arg("dot-fee") ?? DEFAULT_FEES.dotLocalFee),
      etherFee: BigInt(arg("ether-fee") ?? DEFAULT_FEES.etherFee),
      topic: exitTopic(assetId, amount),
    };

    console.log(`\n🥢 ${symbol} (${assetId}) → Snowbridge → ${TC_SAFE_ETHEREUM}`);
    console.log(`   token ${token}  decimals ${decimals}`);
    console.log(`   Hydration issuance ${issuance}  SA ${saBefore.token}  amount ${amount}`);
    console.log(`   Asset Hub supply ${supplyBefore}  Bridge Hub outbound nonce ${nonceBefore}`);

    const xcm = buildExitXcm(params);
    const send = await encodeSendToAssetHub(hydration.client, xcm);
    const calls: Call[] = [
      ...(retire
        ? [
            {
              name: "AssetRegistry.update",
              hex: encodeRetireLocation(assetId, token),
              args: { asset_id: assetId, location: retiredLocationShape(token) },
            },
          ]
        : []),
      { name: "PolkadotXcm.send", hex: send },
    ];
    const { inner, outer, innerHash, innerBytes } = await finalize(hydration, calls);

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
    console.log(`   inner ${innerBytes} bytes, blake2-256 ${innerHash}`);

    console.log(`\n🥢 Hydration: enact ${asRoot ? "inner call as Root" : "whitelisted dispatch as WhitelistedCaller"}`);
    const { blockHash, events: hEvents } = asRoot
      ? await dispatchAs(hydration, inner, { system: "Root" })
      : await enactWhitelisted(hydration, outer, innerHash);

    if (asRoot) {
      const dispatched = pick(hEvents, "Scheduler", "Dispatched").map((e) => toJson(e.event.value.value));
      check("Scheduler.Dispatched ok", dispatched.some((d) => d.includes('"success":true')), dispatched.join(" "));
    } else {
      dispatchOk(hEvents, check, retire);
    }
    check("PolkadotXcm.Sent", pick(hEvents, "PolkadotXcm", "Sent").length > 0);
    if (retire) {
      const locAfter = await hdx.query.AssetRegistry.AssetLocations.getValue(assetId, { at: blockHash });
      check("AssetLocations = retired marker", sameValue(locAfter, retiredLocationShape(token)), toJson(locAfter));
    }
    if (failed().length) for (const l of summarize(hEvents)) console.log(`     ${l}`);

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
    if (failed().length) for (const l of summarize(ahEvents)) console.log(`     ${l}`);

    console.log(`\n🥢 Bridge Hub`);
    const bhEvents: Ev[] = [];
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
    const ours = pick(bhEvents, "EthereumOutboundQueueV2", "MessageQueued")
      .map((e) => (e.event.value.value as { message: { id: unknown; commands: { type: string; value: Record<string, unknown> }[] } }).message)
      .filter((m) => String(m.id).toLowerCase() === params.topic.toLowerCase());
    const commands = ours.flatMap((m) => m.commands);
    const tokenHex = token === "ETH" ? "0x0000000000000000000000000000000000000000" : token;
    check(
      "one message under our topic: one UnlockNativeToken of the amount to the Safe",
      ours.length === 1 &&
        commands.length === 1 &&
        commands[0].type === "UnlockNativeToken" &&
        String(commands[0].value.token).toLowerCase() === tokenHex.toLowerCase() &&
        String(commands[0].value.recipient).toLowerCase() === TC_SAFE_ETHEREUM.toLowerCase() &&
        BigInt(commands[0].value.amount as bigint) === amount,
      toJson(commands).slice(0, 400),
    );
    const nonceAfter = (await bh.query.EthereumOutboundQueueV2.Nonce.getValue()) as bigint;
    check("outbound nonce +1", nonceAfter === nonceBefore + 1n, `${nonceBefore} → ${nonceAfter}`);

    const bad = failed();
    console.log(`\n🥢 ${bad.length ? `❌ ${bad.length} check(s) failed` : "✅ all checks passed"}`);
    process.exitCode = bad.length ? 1 : 0;
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
