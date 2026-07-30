/**
 * MRL SWEEP probe — prove the MrlSweeper "drain everything" helper bridges the SA's ENTIRE current
 * balance of a token to the TC via the faithful governance XCM path, and is straggler-safe.
 *
 * Flow (single Hydration+Moonbeam fork, HRMP wired):
 *   1. seed the Hydration Moonbeam sovereign account (SA) with GLMR for gas.
 *   2. deploy MrlSweeper on the Moonbeam fork by injecting its resolved runtime bytecode
 *      (immutables SA+BRIDGE patched) into frontier EVM.AccountCodes; verify SA()/BRIDGE() getters.
 *   3. drive the REAL path: Root-dispatch on Hydration a polkadotXcm.send(dest=Moonbeam,
 *      Transact{SovereignAccount, EthereumXcm→Batch precompile([ DAI.approve(sweeper,MAX),
 *      sweeper.sweep(DAI, chain=2, recipient) ])}). The XCM envelope is the validated PRIME_TEST_EXIT
 *      template with its inner batchAll calldata swapped (approve+sweep) and SCALE lengths recomputed.
 *   4. verify sweep #1: SA DAI balance → 0 (full drain) + a Wormhole LogMessagePublished whose
 *      normalized transfer amount == normalize(pre-sweep balance), correct recipientChain/recipient.
 *   5. zero-balance no-op: re-run sweep on now-empty DAI → no VAA, no revert (bal==0 guard).
 *   6. straggler: credit SA with fresh DAI, re-run → bridges exactly the new balance, second VAA.
 *
 *   pnpm tsx probes/_probeSweep.ts
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient, http, encodeFunctionData, decodeEventLog, encodeEventTopics,
  getAddress, keccak256, pad, parseAbi, erc20Abi, type Abi, type Hex, type PublicClient,
} from "viem";
import { Binary } from "polkadot-api";
import { acc } from "@galacticcouncil/common";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { PRIME_TEST_EXIT } from "./payloads";

// ── addresses (Moonbeam mainnet) ───────────────────────────────────────────
const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex); // 0x7369626c...2070
const BRIDGE = getAddress("0xb1731c586ca89a23809861c6103f0b96b3f57d92"); // wormhole token bridge
const CORE = getAddress("0xC8e2b0cD52Cf01b0Ce87d389Daa3d414d4cE29f3"); // wormhole core (LogMessagePublished)
const DAI = getAddress("0x06e605775296e851FF43b4dAa541Bb0984E9D6fD"); // DAI GMP — SA holds ~3665 on fork
const BATCH_PRECOMPILE = getAddress("0x0000000000000000000000000000000000000808");
const SWEEPER = getAddress("0x00000000000000000000000000000000005A7EE9"); // chosen deploy addr (above precompile range)
const ART = "/home/mrq/git/whm/contracts/out/MrlSweeper.sol/MrlSweeper.json";

const RECIP_CHAIN = 2; // Ethereum (wormhole chain id)
const RECIPIENT32 = pad("0x1111111111111111111111111111111111111111", { size: 32 }); // TC placeholder (bytes32)
const MAX_UINT = (1n << 256n) - 1n;

// ── abis / selectors ────────────────────────────────────────────────────────
const BATCH_ABI = parseAbi(["function batchAll(address[] to, uint256[] value, bytes[] callData, uint64[] gasLimit)"]);
const SWEEP_ABI = parseAbi(["function sweep(address token, uint16 chain, bytes32 recipient) returns (uint64)"]);
const GETTER_ABI = parseAbi(["function SA() view returns (address)", "function BRIDGE() view returns (address)"]);
const CORE_ABI = [{ type: "event", name: "LogMessagePublished", inputs: [
  { name: "sender", type: "address", indexed: true }, { name: "sequence", type: "uint64" },
  { name: "nonce", type: "uint32" }, { name: "payload", type: "bytes" }, { name: "consistencyLevel", type: "uint8" }] }] as const satisfies Abi;
const LOG_TOPIC = encodeEventTopics({ abi: CORE_ABI, eventName: "LogMessagePublished" })[0]!.toLowerCase();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hx = (x: any): string => x == null ? "" : typeof x === "string" ? x.toLowerCase()
  : typeof x?.asHex === "function" ? x.asHex().toLowerCase()
  : x instanceof Uint8Array ? "0x" + Buffer.from(x).toString("hex") : String(x).toLowerCase();

// ── SCALE compact length codec (values here are always < 2^14 ⇒ 1 or 2 bytes) ─
function compactEncode(n: number): string {
  if (n < 64) return (n << 2).toString(16).padStart(2, "0");
  if (n < 16384) { const v = (n << 2) | 1; return (v & 0xff).toString(16).padStart(2, "0") + (v >> 8).toString(16).padStart(2, "0"); }
  if (n < 1073741824) { const v = (n << 2) | 2; let s = ""; for (let i = 0; i < 4; i++) s += ((v >> (8 * i)) & 0xff).toString(16).padStart(2, "0"); return s; }
  throw new Error("compact too big for this helper");
}
const compactByteLen = (n: number): number => (n < 64 ? 1 : n < 16384 ? 2 : 4);

// ── build the batchAll(input) calldata for [ DAI.approve(sweeper,MAX), sweeper.sweep(DAI,chain,recip) ]
function buildBatchInput(): Hex {
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SWEEPER, MAX_UINT] });
  const sweep = encodeFunctionData({ abi: SWEEP_ABI, functionName: "sweep", args: [DAI, RECIP_CHAIN, RECIPIENT32] });
  return encodeFunctionData({
    abi: BATCH_ABI, functionName: "batchAll",
    args: [[DAI, SWEEPER], [0n, 0n], [approve, sweep], []], // empty gasLimit[] ⇒ forward all gas per subcall
  });
}

/**
 * Rebuild the PolkadotXcm.send envelope by byte-surgery on PRIME_TEST_EXIT: keep the entire outer
 * XCM (dest, WithdrawAsset/BuyExecution/RefundSurplus/DepositAsset, weights, gas_limit=5M, Batch
 * precompile target) and only swap the inner `input` (batchAll calldata), recomputing the two SCALE
 * length prefixes that depend on it (input Vec<u8> len, and the Transact DoubleEncoded inner-call len).
 */
function buildSweepEnvelope(): Hex {
  const full = PRIME_TEST_EXIT.slice(2).toLowerCase();
  // markers (hex string indices; /2 for byte offsets)
  const INNER_START = "6d0000404b4c";        // EthereumXcm(6d).transact(00), V1(00), gas_limit low bytes 40 4b 4c (=5,000,000)
  const TAIL_MARK = "140d01020400010300";     // RefundSurplus(14) + DepositAsset(0d ...) beneficiary=SA
  const SEL = "96e292b8";                      // batchAll selector
  const iInner = full.indexOf(INNER_START);
  const iTail = full.indexOf(TAIL_MARK);
  const iSel = full.indexOf(SEL);
  if (iInner < 0 || iTail < 0 || iSel < 0) throw new Error("marker not found in PRIME template");

  const posInner = iInner / 2, posTail = iTail / 2, posSel = iSel / 2;
  const oldInnerLen = posTail - posInner;                     // bytes of INNER_CALL (EthereumXcm.transact call)
  const bpreLen = compactByteLen(oldInnerLen);                // Transact DoubleEncoded length prefix width
  const oldInputLen = (posTail - 1) - posSel;                 // input = [selector..] up to access_list(00) which is INNER_CALL's last byte
  const inCompactLen = compactByteLen(oldInputLen);
  const posInputCompact = posSel - inCompactLen;             // start of the `input` Vec<u8> compact prefix

  const HEAD = full.slice(0, (posInner - bpreLen) * 2);       // everything up to & incl. requireWeightAtMost (drop old Transact-len prefix)
  const IHEAD = full.slice(posInner * 2, posInputCompact * 2); // 6d00 00 gaslimit action addr value — unchanged
  const TAIL = full.slice(posTail * 2);                       // RefundSurplus + DepositAsset(SA)

  const newInput = buildBatchInput().slice(2);
  const newInputLen = newInput.length / 2;
  const newInnerCall = IHEAD + compactEncode(newInputLen) + newInput + "00"; // + access_list None
  const newInnerLen = newInnerCall.length / 2;
  const rebuilt = HEAD + compactEncode(newInnerLen) + newInnerCall + TAIL;
  return ("0x" + rebuilt) as Hex;
}

// ── deploy the sweeper: patch immutables into runtime bytecode, inject into frontier EVM storage ──
async function deploySweeper(moonbeam: Network, eth: PublicClient) {
  const art = JSON.parse(readFileSync(ART, "utf8"));
  const refs: Record<string, { start: number; length: number }[]> = art.deployedBytecode.immutableReferences;
  const ids = Object.keys(refs); // AST ids, source order: SA (first) then BRIDGE
  const build = (saId: string, brId: string): string => {
    let code = (art.deployedBytecode.object as string).replace(/^0x/, "");
    const put = (offs: { start: number }[], addr: string) => {
      const v = addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
      for (const { start } of offs) code = code.slice(0, start * 2) + v + code.slice(start * 2 + 64);
    };
    put(refs[saId], SA); put(refs[brId], BRIDGE);
    return code;
  };
  const inject = async (code: string) => {
    const codeHex = ("0x" + code) as Hex;
    const codeBytes = Array.from(Buffer.from(code, "hex")); // chopsticks SCALE-encodes the Vec<u8> (adds length prefix)
    await moonbeam.setStorage({
      EVM: {
        AccountCodes: [[[SWEEPER], codeBytes]],
        AccountCodesMetadata: [[[SWEEPER], { size: code.length / 2, hash: keccak256(codeHex) }]],
      },
      System: { Account: [[[SWEEPER], { nonce: 1, providers: 1, data: { free: 0n } }]] },
    });
  };
  // try (id0=SA, id1=BRIDGE); verify via getters; swap if the artifact ordered them the other way.
  await inject(build(ids[0], ids[1]));
  let saGet = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "SA" }) as Hex;
  if (getAddress(saGet) !== SA) { await inject(build(ids[1], ids[0])); saGet = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "SA" }) as Hex; }
  const brGet = await eth.readContract({ address: SWEEPER, abi: GETTER_ABI, functionName: "BRIDGE" }) as Hex;
  const codeOnChain = await eth.getCode({ address: SWEEPER });
  return { saGet, brGet, codeLen: (codeOnChain?.length ?? 2) / 2 - 1 };
}

// ── collect Wormhole core LogMessagePublished across a run's Moonbeam blocks ──
async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}
function coreLogsIn(events: any[]) {
  const out: { topics: Hex[]; data: Hex }[] = [];
  for (const { event } of events) {
    const ev = event as any;
    if (ev.type !== "EVM" || ev.value?.type !== "Log") continue;
    const log = ev.value.value?.log; if (!log || hx(log.address) !== CORE.toLowerCase()) continue;
    const topics = (log.topics ?? []).map((tp: any) => hx(tp) as Hex);
    if (topics[0] === LOG_TOPIC) out.push({ topics, data: hx(log.data) as Hex });
  }
  return out;
}
interface Transfer { amount: bigint; tokenChain: number; toChain: number; recipient: Hex; }
function decodeTransfer(payload: Hex): Transfer {
  const b = payload.slice(2); // wormhole token-bridge Transfer payload
  return {
    amount: BigInt("0x" + b.slice(1 * 2, 33 * 2)),           // normalized to 8dp
    tokenChain: parseInt(b.slice(65 * 2, 67 * 2), 16),
    recipient: ("0x" + b.slice(67 * 2, 99 * 2)) as Hex,
    toChain: parseInt(b.slice(99 * 2, 101 * 2), 16),
  };
}

// ── dispatch one sweep run: Root-dispatch the send envelope, flush HRMP, collect VAAs ──
async function runSweep(hydration: Network, moonbeam: Network, envelope: Hex, debug = false): Promise<Transfer[]> {
  const bytes = Binary.fromHex(envelope);
  const len = bytes.length;
  const hash = (await hydration.chain.head.registry).hash(bytes).toHex() as Hex;
  const when = hydration.chain.head.number + 1;
  await hydration.setStorage({
    Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
    Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
  });
  const hb = await hydration.chain.newBlock();
  if (debug) { const he: any[] = await evAt(hydration, hb.hash); console.log("    [dbg] hyd:", he.map((e) => `${e.event?.type}.${e.event?.value?.type}`).filter((t) => /Scheduler|PolkadotXcm|XcmpQueue/.test(t)).join(" ")); }
  await hydration.chain.newBlock(); // flush HRMP to Moonbeam
  const logs: { topics: Hex[]; data: Hex }[] = [];
  for (let i = 0; i < 6; i++) {
    const b = await moonbeam.chain.newBlock();
    const ev = await evAt(moonbeam, b.hash);
    logs.push(...coreLogsIn(ev));
    if (debug) { const rel = ev.map((e: any) => `${e.event?.type}.${e.event?.value?.type}`).filter((t) => /Ethereum|MessageQueue|XcmpQueue|EVM\.Log|DmpQueue/.test(t)); if (rel.length) console.log(`    [dbg] mb#${b.number}:`, rel.join(" ")); }
  }
  await sleep(300);
  return logs.map((l) => decodeTransfer((decodeEventLog({ abi: CORE_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as any).payload as Hex));
}

const slotKey = (holder: Hex, slot: number): Hex =>
  keccak256(("0x" + pad(holder, { size: 32 }).slice(2) + pad(("0x" + slot.toString(16)) as Hex, { size: 32 }).slice(2)) as Hex);

// ── find the ERC20 `balances` mapping slot for DAI by writing a sentinel to a scratch holder and
//    checking whether balanceOf reflects it — robust to the token's storage-value encoding. ──
async function findBalanceSlot(moonbeam: Network, eth: PublicClient): Promise<number | null> {
  const probe = getAddress("0x000000000000000000000000000000000000bEEF");
  const sentinel = 777n * 10n ** 18n;
  const balProbe = () => eth.readContract({ address: DAI, abi: erc20Abi, functionName: "balanceOf", args: [probe] }) as Promise<bigint>;
  for (let slot = 0; slot < 40; slot++) {
    const key = slotKey(probe, slot);
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[DAI, key], pad(("0x" + sentinel.toString(16)) as Hex, { size: 32 })]] } });
    const got = await balProbe();
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[DAI, key], pad("0x0", { size: 32 })]] } });
    if (got === sentinel) return slot;
  }
  return null;
}
// DAI GMP is a Wormhole-wrapped token: outbound transferTokens BURNS (totalSupply -= amount). A raw
// balance credit must be supply-backed or burn underflows — so find the totalSupply scalar slot too.
async function findScalarSlot(moonbeam: Network, eth: PublicClient, fn: "totalSupply"): Promise<number | null> {
  const sentinel = 999n * 10n ** 18n;
  for (let slot = 0; slot < 40; slot++) {
    const key = pad(("0x" + slot.toString(16)) as Hex, { size: 32 });
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[DAI, key], pad(("0x" + sentinel.toString(16)) as Hex, { size: 32 })]] } });
    const got = await eth.readContract({ address: DAI, abi: erc20Abi, functionName: fn }) as bigint;
    await moonbeam.setStorage({ EVM: { AccountStorages: [[[DAI, key], pad("0x0", { size: 32 })]] } }); // restore to 0? no — restore below
    if (got === sentinel) return slot;
  }
  return null;
}
async function creditSA(moonbeam: Network, balSlot: number, supplySlot: number | null, amount: bigint, supply: bigint) {
  const writes: any[] = [[[DAI, slotKey(SA, balSlot)], pad(("0x" + amount.toString(16)) as Hex, { size: 32 })]];
  if (supplySlot != null) writes.push([[DAI, pad(("0x" + supplySlot.toString(16)) as Hex, { size: 32 })], pad(("0x" + supply.toString(16)) as Hex, { size: 32 })]);
  await moonbeam.setStorage({ EVM: { AccountStorages: writes } });
}

async function main() {
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.moonbeam.port}`) }) as PublicClient;
  const daiBal = () => eth.readContract({ address: DAI, abi: erc20Abi, functionName: "balanceOf", args: [SA] }) as Promise<bigint>;
  const N = 10n ** 18n, NORM = 10n ** 10n; // DAI 18dp; wormhole normalizes to 8dp ⇒ /1e10
  try {
    console.log(`\n════════ MRL sweep probe ════════`);
    console.log(`SA=${SA}  sweeper=${SWEEPER}  DAI=${DAI}  bridge=${BRIDGE}`);

    // 1. seed SA with GLMR for gas
    await moonbeam.setStorage({ System: { Account: [[[SA], { providers: 1, data: { free: 5000n * N } }]] } });

    // 2. deploy sweeper (inject resolved runtime bytecode) + verify getters
    const dep = await deploySweeper(moonbeam, eth);
    const saOk = getAddress(dep.saGet) === SA, brOk = getAddress(dep.brGet) === BRIDGE;
    console.log(`\n── deploy MrlSweeper (bytecode inject) ──`);
    console.log(`  eth_getCode len : ${dep.codeLen} bytes`);
    console.log(`  SA()            : ${dep.saGet}  ${saOk ? "✅" : "❌"}`);
    console.log(`  BRIDGE()        : ${dep.brGet}  ${brOk ? "✅" : "❌"}`);

    // build + structurally self-check the sweep envelope
    const envelope = buildSweepEnvelope();
    const api = hydration.client.getUnsafeApi();
    let decodeOk = false, decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(Binary.fromHex(envelope))).decodedCall;
      const t = dc.value.value.message.value.find((i: any) => i.type === "Transact");
      decodeOk = dc.type === "PolkadotXcm" && dc.value.type === "send" && !!t;
      decodeInfo = `${dc.type}.${dc.value.type}, instrs=${dc.value.value.message.value.map((i: any) => i.type).join("/")}`;
    } catch (e: any) { decodeInfo = "decode failed: " + (e?.message ?? e); }
    console.log(`\n── sweep envelope (${(envelope.length - 2) / 2} bytes) ──`);
    console.log(`  papi self-decode: ${decodeInfo}  ${decodeOk ? "✅" : "❌"}`);

    // 4. SWEEP #1 — full dynamic drain
    const before1 = await daiBal();
    const slot = await findBalanceSlot(moonbeam, eth); // discover DAI balance-mapping slot (write-probe)
    console.log(`\n── SWEEP #1 (full drain) ──`);
    console.log(`  SA DAI before   : ${before1}  (${Number(before1) / 1e18} DAI)`);
    const t1 = await runSweep(hydration, moonbeam, envelope);
    const after1 = await daiBal();
    const expNorm1 = before1 / NORM;
    const v1 = t1[0];
    const drainOk = after1 === 0n;
    const amtOk = !!v1 && v1.amount === expNorm1;
    const chainOk = !!v1 && v1.toChain === RECIP_CHAIN;
    const recipOk = !!v1 && v1.recipient.toLowerCase() === RECIPIENT32.toLowerCase();
    console.log(`  SA DAI after    : ${after1}  ${drainOk ? "✅ drained to 0" : "❌"}`);
    console.log(`  VAAs emitted    : ${t1.length}`);
    console.log(`  VAA amount(8dp) : ${v1?.amount}  expect ${expNorm1}  ${amtOk ? "✅" : "❌"}`);
    console.log(`  recipientChain  : ${v1?.toChain}  expect ${RECIP_CHAIN}  ${chainOk ? "✅" : "❌"}`);
    console.log(`  recipient       : ${v1?.recipient}  ${recipOk ? "✅" : "❌"}`);
    const dust = before1 % NORM; const sweeperDust = await eth.readContract({ address: DAI, abi: erc20Abi, functionName: "balanceOf", args: [SWEEPER] }) as bigint;
    console.log(`  sub-8dp dust    : ${dust} (stranded in sweeper: ${sweeperDust})`);

    // 5. ZERO-BALANCE no-op — re-run on now-empty DAI (bal==0 guard)
    console.log(`\n── ZERO-BALANCE no-op (re-run on empty DAI) ──`);
    const t0 = await runSweep(hydration, moonbeam, envelope);
    const after0 = await daiBal();
    const noopOk = t0.length === 0 && after0 === 0n;
    console.log(`  VAAs emitted    : ${t0.length}  (expect 0)`);
    console.log(`  SA DAI          : ${after0}  ${noopOk ? "✅ no-op, no revert" : "❌"}`);

    // 6. STRAGGLER — credit SA with fresh DAI, re-sweep, expect exactly the new balance bridged
    console.log(`\n── STRAGGLER (credit SA, re-sweep) ──`);
    let stragOk = false, straggler = 0n, v2: Transfer | undefined, after2 = -1n;
    if (slot == null) {
      console.log(`  ⚠️ could not locate DAI balance slot — skipping straggler credit`);
    } else {
      straggler = 4242n * N + 123n; // fresh balance incl. sub-8dp dust to also re-check normalization
      const supplySlot = await findScalarSlot(moonbeam, eth, "totalSupply");
      await creditSA(moonbeam, slot, supplySlot, straggler, straggler + 10n ** 30n); // supply-back the credit so burn can't underflow
      const credited = await daiBal();
      console.log(`  DAI slots       : bal=${slot} supply=${supplySlot}   credited SA: ${credited}`);
      const t2 = await runSweep(hydration, moonbeam, envelope);
      after2 = await daiBal();
      v2 = t2[0];
      const expNorm2 = straggler / NORM;
      stragOk = t2.length === 1 && after2 === 0n && !!v2 && v2.amount === expNorm2;
      console.log(`  VAAs emitted    : ${t2.length}  (expect 1)`);
      console.log(`  VAA amount(8dp) : ${v2?.amount}  expect ${expNorm2}  ${v2?.amount === expNorm2 ? "✅" : "❌"}`);
      console.log(`  SA DAI after    : ${after2}  ${after2 === 0n ? "✅ drained" : "❌"}`);
    }

    // verdict
    const pass1 = saOk && brOk && decodeOk && drainOk && amtOk && chainOk && recipOk;
    console.log(`\n════════ VERDICT ════════`);
    console.log(`  deploy + envelope     : ${saOk && brOk && decodeOk ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`  sweep #1 full drain   : ${pass1 ? "PASS ✅" : "FAIL ❌"}  (SA→0, VAA amount=normalize(bal), chain/recipient ok)`);
    console.log(`  zero-balance no-op    : ${noopOk ? "PASS ✅" : "FAIL ❌"}`);
    console.log(`  straggler re-sweep    : ${stragOk ? "PASS ✅" : slot == null ? "SKIP ⚠️" : "FAIL ❌"}`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
