/**
 * PROBE (WETH NTT — upgrade to NttManagerWithPayload): the TC motion that upgrades the live Hydration
 * WETH NttManager in place to hydration-ntt's `NttManagerWithPayload`, enacted on a Hydration fork,
 * then a `transfer` and a `transferWithPayload` on each route (Ethereum, Robinhood).
 *
 *   technicalCommittee.propose(threshold,
 *     dispatcher.dispatchAsEmergencyAdmin(evm.call(admin, manager, upgrade(impl), ..)))
 *
 * The impl is built with the live immutables (`upgrade` asserts them). The artifact must be a via-IR
 * build — the default one exceeds EIP-170:
 *
 *   cd hydration-ntt/evm && forge build --via-ir --out <dir> src/NttManager/NttManagerWithPayload.sol
 *
 *   npx tsx chopsticks/probes/_probeWethNttPayloadUpgrade.ts --artifact <dir>/NttManagerWithPayload.sol/NttManagerWithPayload.json
 *   npx tsx chopsticks/probes/_probeWethNttPayloadUpgrade.ts --impl <address>
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import {
  bytesToHex,
  createPublicClient,
  decodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  pad,
  parseAbi,
  toEventSelector,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AccountId } from "polkadot-api";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { checkIfEthereumExecuted, findEvmLogs, logEvents, type EventRecord } from "../lib/events";
import { toJson } from "../lib/utils";

/** hydration-ntt ops/tokens/weth/deployment.json — chains.Hydration. */
const MANAGER = "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7" as Hex;
const TRANSCEIVER = "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae" as Hex;
const WETH = "0x0000000000000000000000000000000100000014" as Hex;
const WETH_ASSET_ID = 20;
const EMERGENCY_ADMIN = "0xAA7e0000000000000000000000000000000AA7E1" as Hex;

const ROUTES = { Ethereum: 2, Robinhood: 72 } as const;

const GAS_LIMIT = 500_000n;
const MAX_FEE_PER_GAS = 10_000_000_000n; // 10 gwei, above the base fee
/** Code deposit alone is 200 gas/byte (~4.9M at 24.4 KB); EthClient's 6M default runs out. */
const DEPLOY_GAS = 12_000_000n;

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const AMOUNT = 10n ** 16n; // 0.01 WETH, no dust at 8 trimmed decimals
const PAYLOAD = "0x57484d50deadbeef" as Hex;
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const IMPL = arg("--impl");
const ARTIFACT = arg("--artifact");
if (!IMPL && !ARTIFACT) throw new Error("pass --artifact <via-IR json> or --impl <address>");

const MANAGER_ABI = parseAbi([
  "function upgrade(address newImplementation)",
  "function owner() view returns (address)",
  "function token() view returns (address)",
  "function mode() view returns (uint8)",
  "function chainId() view returns (uint16)",
  "function rateLimitDuration() view returns (uint64)",
  "function nextMessageSequence() view returns (uint64)",
  "function getPeer(uint16) view returns ((bytes32 peerAddress, uint8 tokenDecimals))",
  "function getOutboundLimitParams() view returns ((uint72 limit, uint72 currentCapacity, uint64 lastTxTimestamp))",
  "function getInboundLimitParams(uint16) view returns ((uint72 limit, uint72 currentCapacity, uint64 lastTxTimestamp))",
  "function quoteDeliveryPrice(uint16, bytes) view returns (uint256[], uint256)",
  "function transfer(uint256 amount, uint16 recipientChain, bytes32 recipient) payable returns (uint64)",
  "function transferWithPayload(uint256 amount, uint16 recipientChain, bytes32 recipient, bytes payload) payable returns (uint64)",
]);
const ERC20_ABI = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

const UPGRADED = toEventSelector("Upgraded(address)");
const LOG_MESSAGE_PUBLISHED = toEventSelector("LogMessagePublished(address,uint64,uint32,bytes,uint8)");

// ─── Helpers ─────────────────────────────────────────────────────

const ss58 = (h160: Hex): string =>
  AccountId(63).dec(`0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}`);
const b32 = (h160: Hex): Hex => pad(h160.toLowerCase() as Hex, { size: 32 });
const eq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A `BoundedVec<u8>` storage value — compact(len) ++ bytes, 2-byte mode (64..16383 bytes). */
function boundedBytes(hex: string): string {
  const n = (hex.length - 2) / 2;
  if (n < 64 || n >= 16384) throw new Error(`boundedBytes: ${n} bytes outside the 2-byte compact mode`);
  const v = (n << 2) | 1;
  return `0x${(v & 0xff).toString(16).padStart(2, "0")}${(v >> 8).toString(16).padStart(2, "0")}${hex.slice(2)}`;
}

/** Retry a read through chopsticks' post-block lag. */
async function retry<T>(fn: () => Promise<T>, tries = 12): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(400);
    }
  }
}

const eventsAt = (net: Network, at: string): Promise<EventRecord[]> =>
  retry(() => net.client.getUnsafeApi().query.System.Events.getValue({ at }) as Promise<EventRecord[]>);

type Artifact = {
  abi: Abi;
  bytecode: { object: Hex; linkReferences?: Record<string, Record<string, { start: number; length: number }[]>> };
};
const loadArtifact = (path: string): Artifact => JSON.parse(readFileSync(path, "utf8")) as Artifact;

/**
 * The `additionalPayload` of a WormholeTransceiver message.
 * @param hex prefix(4) src(32) dst(32) u16 ‖ [id(32) sender(32) u16 ‖ NativeTokenTransfer] ‖ …
 * @returns null when the NativeTokenTransfer ends at `toChain` (79 bytes) — no payload attached.
 */
function decodePayload(hex: Hex): Hex | null {
  const b = Buffer.from(hex.slice(2), "hex");
  const m = b.subarray(70, 70 + b.readUInt16BE(68));
  const ntt = m.subarray(66, 66 + m.readUInt16BE(64));
  return ntt.length > 79 ? (`0x${ntt.subarray(81, 81 + ntt.readUInt16BE(79)).toString("hex")}` as Hex) : null;
}

const results: boolean[] = [];
const record = (step: string, ok: boolean, detail = ""): void => {
  results.push(ok);
  console.log(`   ${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const pub = createPublicClient({
      transport: http(hydration.url.replace("ws://", "http://").replace("[::]", "127.0.0.1")),
    });
    const api = hydration.client.getUnsafeApi();
    const meta = (await (hydration.chain.head as never as { meta: Promise<any> }).meta) as any;
    const registry = (await (hydration.chain.head as never as { registry: Promise<any> }).registry) as any;
    const read = <T>(fn: string, args: unknown[] = []) =>
      retry(() => pub.readContract({ address: MANAGER, abi: MANAGER_ABI, functionName: fn as never, args: args as never })) as Promise<T>;
    const implSlot = async (): Promise<Hex> => {
      const raw = await retry(() => api.query.EVM.AccountStorages.getValue(MANAGER, ERC1967_IMPL_SLOT));
      return getAddress(`0x${String(raw).slice(-40)}`);
    };
    const snapshot = async () => ({
      owner: await read<Hex>("owner"),
      outbound: (await read<{ limit: bigint }>("getOutboundLimitParams")).limit,
      ...Object.fromEntries(
        await Promise.all(
          Object.entries(ROUTES).map(async ([name, chain]) => {
            const p = await read<{ peerAddress: Hex; tokenDecimals: number }>("getPeer", [chain]);
            const inbound = (await read<{ limit: bigint }>("getInboundLimitParams", [chain])).limit;
            return [name, `${p.peerAddress}/${p.tokenDecimals}/${inbound}`];
          }),
        ),
      ),
    });

    const account = privateKeyToAccount(DEPLOYER_PK);
    const client = new EthClient(hydration, account, { chainId: 222222 });
    await hydration.setStorage({
      System: { Account: [[[ss58(account.address)], { providers: 1, data: { free: 10n ** 18n } }]] },
      Tokens: { Accounts: [[[ss58(account.address), WETH_ASSET_ID], { free: 10n ** 21n }]] },
      EVMAccounts: { ContractDeployer: [[[account.address], true]] },
    });

    const before = await snapshot();
    const seqBefore = await read<bigint>("nextMessageSequence");
    console.log(`\n── Before (impl ${await implSlot()}) ──\n   ${toJson(before)}`);

    // ── impl: TransceiverStructs is a linked library, deployed first (as forge script does) ──
    let impl: Hex;
    if (IMPL) {
      impl = getAddress(IMPL);
    } else {
      const artifact = loadArtifact(resolve(ARTIFACT!));
      let code = artifact.bytecode.object.slice(2);
      for (const [file, names] of Object.entries(artifact.bytecode.linkReferences ?? {})) {
        for (const [name, refs] of Object.entries(names)) {
          const lib = loadArtifact(resolve(dirname(dirname(resolve(ARTIFACT!))), basename(file), `${name}.json`));
          const { address } = await client.deploy(lib.bytecode.object);
          for (const { start, length } of refs) {
            code = code.slice(0, start * 2) + address.slice(2).toLowerCase() + code.slice((start + length) * 2);
          }
        }
      }
      const duration = await read<bigint>("rateLimitDuration");
      const initCode = encodeDeployData({
        abi: artifact.abi,
        bytecode: `0x${code}`,
        args: [await read("token"), await read("mode"), await read("chainId"), duration, duration === 0n],
      });
      const { address, rawTx } = await client.signDeploy(initCode, DEPLOY_GAS);
      const evs = await eventsAt(hydration, (await client.sendBatch([rawTx])).blockHash);
      if (!checkIfEthereumExecuted(evs)) {
        logEvents(evs);
        throw new Error("impl deploy failed");
      }
      impl = address;
    }

    // ── the motion ──
    const members = (await retry(() => api.query.TechnicalCommittee.Members.getValue())) as unknown[];
    const threshold = Math.ceil(members.length / 2); // TechCommitteeMajority: yes · 2 ≥ n
    const evmInput = encodeFunctionData({ abi: MANAGER_ABI, functionName: "upgrade", args: [impl] });
    const call = meta.tx.dispatcher.dispatchAsEmergencyAdmin(
      meta.tx.evm.call(EMERGENCY_ADMIN, MANAGER, evmInput, 0, GAS_LIMIT, MAX_FEE_PER_GAS, null, null, [], []),
    );
    const bytes = call.toU8a();
    const callHash = registry.hash(bytes).toHex();
    console.log(`\n── Motion: upgrade(${impl}) ──`);
    console.log(`   dispatchAsEmergencyAdmin  ${bytes.length} bytes, hash ${callHash}`);
    console.log(`     ${call.toHex()}`);
    console.log(`   technicalCommittee.propose(${threshold}, <call>, ${bytes.length})`);
    console.log(`     ${meta.tx.technicalCommittee.propose(threshold, call, bytes.length).toHex()}`);

    // ── enact from a TC majority origin, through a preimage (past the 128-byte inline cap) ──
    const head = (await retry(() => api.query.System.Number.getValue())) as number;
    await hydration.setStorage({ Preimage: { PreimageFor: [[[[callHash, bytes.length]], boundedBytes(call.toHex())]] } });
    await hydration.setStorage({
      Scheduler: {
        Agenda: [[[head + 1], [{
          call: { Lookup: { hash: callHash, len: bytes.length } },
          origin: { TechnicalCommittee: { Members: [threshold, members.length] } },
          maybeId: null, priority: 0, maybePeriodic: null,
        }]]],
      },
    });
    const { hash } = await (hydration.chain as unknown as { newBlock: () => Promise<{ hash: string }> }).newBlock();
    const evs = await eventsAt(hydration, hash);
    console.log(`\n── Enacted ──`);
    record("EVM.call executed", evs.some(({ event }) => event.type === "EVM" && event.value.type === "Executed"));
    record("Upgraded from the manager", findEvmLogs(evs, UPGRADED, MANAGER).length === 1);
    record("impl slot is the new impl", eq(await implSlot(), impl));
    record("owner, limits, peers unchanged", toJson(await snapshot()) === toJson(before));
    record("sequence unchanged", (await read<bigint>("nextMessageSequence")) === seqBefore);
    if (results.includes(false)) logEvents(evs);

    // ── send on each route ──
    await client.call(WETH, encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [MANAGER, 10n * AMOUNT] }));
    const recipient = b32(account.address);
    for (const [name, chain] of Object.entries(ROUTES)) {
      const [, price] = await read<[bigint[], bigint]>("quoteDeliveryPrice", [chain, "0x00"]);
      const sends: [string, Hex, Hex | null][] = [
        ["transfer", encodeFunctionData({ abi: MANAGER_ABI, functionName: "transfer", args: [AMOUNT, chain, recipient] }), null],
        ["transferWithPayload", encodeFunctionData({ abi: MANAGER_ABI, functionName: "transferWithPayload", args: [AMOUNT, chain, recipient, PAYLOAD] }), PAYLOAD],
      ];
      console.log(`\n── ${name} (${chain}) ──`);
      for (const [label, data, expected] of sends) {
        const seq = await read<bigint>("nextMessageSequence");
        const evs = await eventsAt(hydration, (await client.call(MANAGER, data, price)).blockHash);
        const msgs = findEvmLogs(evs, LOG_MESSAGE_PUBLISHED).filter((l) => eq(String(l.topics[1]).slice(-40), TRANSCEIVER.slice(2)));
        const payload = msgs.length === 1
          ? decodePayload(decodeAbiParameters([{ type: "uint64" }, { type: "uint32" }, { type: "bytes" }, { type: "uint8" }], bytesToHex(msgs[0].data))[2])
          : undefined;
        record(`${label}: executes, sequence +1`, checkIfEthereumExecuted(evs) && (await read<bigint>("nextMessageSequence")) === seq + 1n);
        record(`${label}: payload ${expected ?? "none"}`, payload === expected, String(payload));
      }
    }

    const failed = results.filter((ok) => !ok).length;
    console.log(`\n🥢 ${failed ? "❌" : "✅"} ${results.length - failed}/${results.length}`);
    if (failed) process.exitCode = 1;
  } finally {
    await teardownForks(nets).catch(() => {});
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
