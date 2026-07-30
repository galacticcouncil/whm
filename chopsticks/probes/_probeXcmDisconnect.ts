/**
 * XCM-DISCONNECT test — does repointing DAI (asset 18) to a parents:0 sentinel ("option 2")
 * cause a stale-UI XTokens send to Moonbeam to PROCEED-AND-TRAP the user, or REJECT ATOMICALLY?
 *
 * Single Hydration fork (port 8061). One scenario per run:
 *   baseline  — leave asset 18 pointing at its Moonbeam GMP location (sanity: send should succeed)
 *   option2   — Root-dispatch AssetRegistry.update(18, Some(parents:0 sentinel)); then send
 *   optionB   — setStorage-delete AssetLocations(18) + reverse key (no location); then send
 *
 * The send is a normal user XTokens.transfer(18, 1000 DAI, dest=Moonbeam AccountKey20). papi v2.1.6
 * can't build the v5-Location XTokens.transfer codec, so the call is hand-encoded with chopsticks'
 * @polkadot/types registry, signFake'd, and its signature overwritten with the chopsticks mock
 * marker (0xdeadbeef + 0xcd-fill) that mock-signature-host accepts.
 *
 * Verdict: ExtrinsicSuccess + DAI balance DECREASED + XCM sent => funds LEFT the wallet.
 *          ExtrinsicFailed + balance UNCHANGED => REJECTED ATOMICALLY (safe, no custody loss).
 */
import { Binary, type SS58String } from "polkadot-api";
import type { Hex } from "viem";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks } from "../lib/network";

const SCENARIO = (process.argv[2] ?? "option2") as "baseline" | "option2" | "optionB";

const USER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" as SS58String; // Alice
const ASSET = 18;
const DAI = 10n ** 18n;
const START_DAI = 10_000n * DAI;
const SEND_DAI = 1_000n * DAI;

// Wormhole-specific sentinel: parents:0 / X2[GeneralKey(b"wh", pad32), GeneralIndex(18)]
const WH_GENERALKEY_DATA = "7768" + "0".repeat(60); // b"wh" right-padded to 32 bytes
// SCALE(v5 Location): parents=00, interior X2=02,
//   GeneralKey=06 + length u8=02 + data[32], GeneralIndex=05 + compact(18)=48
const SENTINEL_SCALE = "00" + "02" + "06" + "02" + WH_GENERALKEY_DATA + "05" + "48";

const J = (v: any) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x?.asHex ? x.asHex() : x));
const assetIdLe = (id: number) => Buffer.from(Uint32Array.of(id).buffer).toString("hex");

async function daiBalance(api: any): Promise<bigint> {
  const ta: any = await api.query.Tokens.Accounts.getValue(USER, ASSET);
  return BigInt(ta?.free ?? 0n);
}

async function main() {
  console.log(`\n==================== SCENARIO: ${SCENARIO} ====================`);
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const api = hydration.client.getUnsafeApi();

    // ── 1. fund Alice: 10k DAI + 1k HDX, bump DAI issuance ──────────────────
    const ti0: bigint = BigInt(String(await api.query.Tokens.TotalIssuance.getValue(ASSET)));
    await hydration.setStorage({
      Tokens: {
        Accounts: [[[USER, ASSET], { free: START_DAI, reserved: 0n, frozen: 0n }]],
        TotalIssuance: [[[ASSET], ti0 + START_DAI]],
      },
      System: { Account: [[[USER], { providers: 1, sufficients: 1, data: { free: 1_000n * DAI, reserved: 0n, frozen: 0n, flags: 0n } }]] },
    });
    const funded = await daiBalance(api);
    const hdx: any = await api.query.System.Account.getValue(USER);
    console.log(`funded: DAI ${funded}  HDX(free) ${String(hdx?.data?.free)}`);
    if (funded !== START_DAI) throw new Error("funding failed");

    // ── 2. apply scenario ───────────────────────────────────────────────────
    if (SCENARIO === "option2") {
      // faithful: Root-dispatch hand-encoded AssetRegistry.update(18, ..None.., location=Some(sentinel))
      // 33 01 | asset_id u32 LE | 7×None(00) | 01 Some | SCALE(sentinel)
      const updateHex = ("0x3301" + assetIdLe(ASSET) + "00000000000000" + "01" + SENTINEL_SCALE) as Hex;
      const bytes = Binary.fromHex(updateHex);
      const len = bytes.length;
      const hash = (await hydration.chain.head.registry).hash(bytes as any).toHex() as Hex;
      const when = hydration.chain.head.number + 1;
      await hydration.setStorage({
        Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes as any)]] },
        Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
      });
      const b = await hydration.chain.newBlock();
      const ev: any[] = await api.query.System.Events.getValue({ at: b.hash });
      const disp = ev.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
      console.log(`option2 update dispatched as Root → result: ${J(disp?.event?.value?.value?.result)}`);
    } else if (SCENARIO === "optionB") {
      // remove the forward location: key is AssetId(u32=18) → chopsticks can encode it; null deletes.
      // (the LocationAssets reverse key has a v5-Location key chopsticks can't encode in typed form,
      //  but it is irrelevant to an OUTBOUND convert(18) which only reads AssetLocations(18).)
      await hydration.setStorage({ AssetRegistry: { AssetLocations: [[[ASSET], null]] } });
    }
    // baseline: no change

    // verify resulting registry state (LocationAssets key can't be papi-encoded → scan entries)
    const locAfter: any = await api.query.AssetRegistry.AssetLocations.getValue(ASSET);
    const laEntries: any[] = await api.query.AssetRegistry.LocationAssets.getEntries();
    const revFor18 = laEntries.filter((e) => String(e.value) === String(ASSET)).map((e) => J(e.keyArgs));
    console.log(`AssetLocations(18) = ${locAfter ? J(locAfter) : "None"}`);
    console.log(`LocationAssets reverse-key(s) mapping →18 : ${revFor18.length ? revFor18.join(" | ") : "NONE"}`);

    // ── 3. the test: user XTokens.transfer(18, 1000 DAI → Moonbeam AccountKey20) ──
    // papi v2.1.6 can't build the v5-Location XTokens.transfer codec, so hand-encode the call with
    // chopsticks' @polkadot/types registry, then produce a signFake'd signed extrinsic (mock-sig-host).
    const reg: any = await hydration.chain.head.registry;
    const hx = (u: Uint8Array) => Buffer.from(u).toString("hex");
    const vl = reg.createType("XcmVersionedLocation", {
      V4: { parents: 1, interior: { X2: [{ Parachain: 2004 }, { AccountKey20: { network: null, key: "0x1111111111111111111111111111111111111111" } }] } },
    });
    const cid = reg.createType("u32", ASSET);
    const amt = reg.createType("u128", SEND_DAI.toString());
    const wl = reg.createType("XcmV3WeightLimit", { Unlimited: null });
    const callHex = "0x8900" + hx(cid.toU8a()) + hx(amt.toU8a()) + hx(vl.toU8a()) + hx(wl.toU8a());
    const callCheck = reg.createType("Call", callHex);
    console.log(`\nXTokens call: ${callCheck.section}.${callCheck.method}  (currency_id=${(callCheck.toHuman().args as any).currency_id}, amount=${(callCheck.toHuman().args as any).amount})`);

    const genesisHash = await hydration.client._request<string>("chain_getBlockHash", [0]);
    const rv = await hydration.client._request<any>("state_getRuntimeVersion", []);
    const nonce = Number(BigInt(String((await api.query.System.Account.getValue(USER))?.nonce ?? 0)));
    const ext = reg.createType("Extrinsic", callCheck);
    ext.signFake(USER, { nonce, tip: 0, era: 0, genesisHash, blockHash: genesisHash, runtimeVersion: rv });
    // chopsticks mock-signature-host accepts a signature of 0xdeadbeef + 0xcd-fill (64 bytes)
    const mock = new Uint8Array(64); mock.fill(0xcd); mock.set([0xde, 0xad, 0xbe, 0xef]);
    ext.signature.set(mock);
    const signedHex = ext.toHex();

    const before = await daiBalance(api);
    let submitErr: any = null;
    try { await hydration.client._request("author_submitExtrinsic", [signedHex]); }
    catch (e: any) { submitErr = e?.message ?? JSON.stringify(e); }
    const b2: any = await hydration.newBlock();
    const atHash = typeof b2 === "string" ? b2 : (b2?.hash ?? b2?.blockHash);
    const events: any[] = await api.query.System.Events.getValue({ at: atHash });
    const ta: any = await api.query.Tokens.Accounts.getValue(USER, ASSET, { at: atHash });
    const after = BigInt(ta?.free ?? 0n);
    if (submitErr) console.log(`author_submitExtrinsic REJECTED at pool: ${submitErr}`);
    console.log(`\nALL events in block (${events.length}):`);
    for (const e of events) console.log(`  ${e.event?.type}.${e.event?.value?.type}`);

    // ── 4. classify ─────────────────────────────────────────────────────────
    const success = events.find((e) => e.event?.type === "System" && e.event?.value?.type === "ExtrinsicSuccess");
    const failed = events.find((e) => e.event?.type === "System" && e.event?.value?.type === "ExtrinsicFailed");
    console.log(`\n── XTokens.transfer result ──`);
    console.log(`ExtrinsicSuccess: ${!!success}   ExtrinsicFailed: ${!!failed}`);
    if (failed) console.log(`DispatchError: ${J(failed.event.value.value.dispatch_error ?? failed.event.value.value)}`);
    console.log(`DAI balance  before ${before}  after ${after}   Δ ${after - before}`);

    const interesting = events.filter((e: any) => {
      const t = e.event?.type, v = e.event?.value?.type;
      return (t === "XTokens") || (t === "PolkadotXcm") || (t === "XcmpQueue") ||
        (t === "Tokens" && ["Withdrawn", "Transfer", "Reserved", "Deposited"].includes(v)) ||
        (t === "Currencies") || (t === "Broadcast") || (t === "ParachainSystem" && v === "UpwardMessageSent");
    });
    console.log(`\nrelevant events (${interesting.length}):`);
    for (const e of interesting) console.log(`  ${e.event.type}.${e.event.value.type}: ${J(e.event.value.value)}`);

    const xcmSent = interesting.some((e: any) =>
      (e.event.type === "XTokens" && e.event.value.type === "TransferredAssets") ||
      (e.event.type === "XTokens" && e.event.value.type === "TransferredMultiAssets") ||
      (e.event.type === "PolkadotXcm" && ["Sent", "Attempted"].includes(e.event.value.type)) ||
      (e.event.type === "XcmpQueue" && e.event.value.type === "XcmpMessageSent"));

    console.log(`\n────────── VERDICT (${SCENARIO}) ──────────`);
    if (success && after < before && xcmSent) console.log(`TRAPPED: extrinsic succeeded, ${before - after} DAI LEFT the wallet, XCM dispatched to Moonbeam.`);
    else if ((failed || submitErr) && after === before) console.log(`REJECTED ATOMICALLY: ${failed ? "ExtrinsicFailed" : "pool-rejected"}, balance UNCHANGED, no XCM.`);
    else console.log(`OTHER: success=${!!success} failed=${!!failed} submitErr=${!!submitErr} Δ=${after - before} xcmSent=${xcmSent}`);
  } finally {
    await teardownForks(nets);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
