/**
 * PROBE (NEAR NTT → Hydration): the Hydration half of the NEAR NTT route — a VAA the NEAR
 * `ntt-manager` published, delivered through `WormholeTransceiver.receiveMessage` → `NttManager`
 * (BURNING) → mint of Hydration wNEAR to the recipient.
 *
 * There is no Hydration on Wormhole testnet, so this is how a NEAR **testnet** transfer reaches
 * Hydration: the real testnet VAA — unmodified bytes, real testnet guardian signature — into a
 * Hydration fork. Only the trust root is substituted: the Hydration core's guardian set at the VAA's
 * index becomes the key(s) that signed it, recovered from the VAA itself. The real core's
 * `parseAndVerifyVM` then verifies it for real — header, double-keccak body, ecrecover, quorum. See
 * _probeBasejumpDelivery.ts for the core's storage layout.
 *
 * THE HYDRATION SIDE, DEPLOYED ON THE FORK — the way hydration-ntt deploys a Hydration leg:
 *   - a runtime asset for wNEAR (id FORK_ASSET_ID, 24 dp), its registry entry cloned from asset 43;
 *   - `EVMAccounts.NttMinters[id] = manager` — what `set_ntt_minter` enacts;
 *   - NttManager (BURNING) + WormholeTransceiver from hydration-ntt's compiled artifacts
 *     (`HYDRATION_NTT_OUT`), behind ERC1967 proxies, with the TransceiverStructs library linked —
 *     the DeployWormholeNttBase sequence: initialize, setTransceiver, setOutboundLimit, setThreshold;
 *   - peered with the NEAR emitter.
 * The deployer key is fixed and fresh, so the proxy addresses are deterministic — the NEAR testnet
 * contract is peered with them in advance (migrations/envs/testnet/near-ntt-near.env).
 *
 *   HYDRATION_NTT_OUT=…/hydration-ntt/evm/out npx tsx chopsticks/probes/_probeNearNttDelivery.ts \
 *     --emitter <hex> --sequence <n>                                     # the NEAR testnet VAA
 *   … --vaa <hex>                                                        # any VAA
 *   … --dev                                                              # self-signed, NEAR-shaped
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  concatHex,
  decodeErrorResult,
  decodeFunctionResult,
  parseAbi,
  toHex,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  numberToHex,
  pad,
  recoverAddress,
  sha256,
  stringToHex,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { AccountId, Binary } from "polkadot-api";

import { args } from "@whm/common";

import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { EthClient } from "../lib/eth/client";
import { getTokenBalance } from "../lib/queries";
import { checkIfEthereumExecuted, logEvents, type EventRecord } from "../lib/events";

const { optionalArg } = args;

// ─── Constants ───────────────────────────────────────────────────

const HYDRATION_EVM_CHAIN_ID = 222222;
const NEAR_CHAIN_ID = 15;
const HYDRATION_CHAIN_ID = 73;

/** The REAL deployed core on Hydration. */
const MESSAGE_CORE = "0x3792a6d63c31941B2805181771795D9176fA82A1" as Hex;

/** The fork's wNEAR: the next free asset id at the time of writing, 24 dp like wrap.near. */
const FORK_ASSET_ID = 1355;
const FORK_ASSET_DECIMALS = 24;
/** Registry template — an NTT-minted asset already on Hydration. */
const TEMPLATE_ASSET_ID = 43;
const tokenAddress = (id: number): Hex =>
  `0x00000000000000000000000000000001${id.toString(16).padStart(8, "0")}` as Hex;

/** NEAR-side token decimals the manager is peered at — wNEAR. */
const NEAR_TOKEN_DECIMALS = 24;

/** As the live Hydration legs: 24 h window, finalized. */
const RATE_LIMIT_DURATION = 86_400n;
const CONSISTENCY_LEVEL = 202;
const LIMIT = 10n ** 30n;

/**
 * Fixed, fresh fork deployer — `keccak256("whm near-ntt fork deployer")`, nonce 0 on Hydration — so
 * CREATE addresses are known in advance: library 0, manager impl 1, **manager proxy 2**, init 3,
 * transceiver impl 4, **transceiver proxy 5**.
 */
const DEPLOYER_PK = keccak256(stringToHex("whm near-ntt fork deployer"));
const FORK_NTT_MANAGER = "0x5b1334885320cFd7158760256c7bD0Af58006b09" as Hex;
const FORK_NTT_TRANSCEIVER = "0x5e875F689EA8dd25e11a69cfb6C9f844C4b3B207" as Hex;

/** `--dev` only: the guardian that signs the self-built VAA. */
const DEV_GUARDIAN_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const WETH_ASSET_ID = 20;
const HYDRATION_SS58_PREFIX = 63;
const TESTNET_API = "https://api.testnet.wormholescan.io/api/v1/vaas";

// ─── Artifacts (hydration-ntt) ───────────────────────────────────

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex };
}

function nttArtifacts(): { library: Artifact; manager: Artifact; transceiver: Artifact; proxy: Artifact } {
  const out = process.env.HYDRATION_NTT_OUT;
  if (!out) throw new Error("set HYDRATION_NTT_OUT to hydration-ntt/evm/out (forge build there first)");
  const load = (path: string) => JSON.parse(readFileSync(resolve(out, path), "utf8")) as Artifact;
  return {
    library: load("TransceiverStructs.sol/TransceiverStructs.json"),
    manager: load("NttManager.sol/NttManager.json"),
    transceiver: load("WormholeTransceiver.sol/WormholeTransceiver.json"),
    proxy: load("ERC1967Proxy.sol/ERC1967Proxy.json"),
  };
}

/** Fills every `__$…$__` library placeholder with the deployed library's address. */
const link = (bytecode: Hex, library: Hex): Hex =>
  bytecode.replace(/__\$[0-9a-f]{34}\$__/g, library.slice(2).toLowerCase()) as Hex;

// ─── VAA ─────────────────────────────────────────────────────────

interface ParsedVaa {
  guardianSetIndex: number;
  signatures: Hex[];
  body: Hex;
  emitterChain: number;
  emitter: Hex;
  sequence: bigint;
  recipientManager: Hex;
  /** The NativeTokenTransfer inside the NTT payload. */
  transfer: { decimals: number; amount: bigint; to: Hex; toChain: number };
}

const bytesAt = (hex: Hex, offset: number, length: number): Hex =>
  `0x${hex.slice(2 + offset * 2, 2 + (offset + length) * 2)}` as Hex;
const uintAt = (hex: Hex, offset: number, length: number): bigint => BigInt(bytesAt(hex, offset, length));

/** Header, signatures, body — and the NTT transfer, walked the way TransceiverStructs parses it. */
function parseVaa(vaa: Hex): ParsedVaa {
  const count = Number(uintAt(vaa, 5, 1));
  const signatures = Array.from({ length: count }, (_, i) => {
    const at = 6 + i * 66;
    const v = Number(uintAt(vaa, at + 65, 1)) + 27;
    return concatHex([bytesAt(vaa, at + 1, 32), bytesAt(vaa, at + 33, 32), numberToHex(v, { size: 1 })]);
  });
  const body = `0x${vaa.slice(2 + (6 + count * 66) * 2)}` as Hex;
  const payload = `0x${body.slice(2 + 51 * 2)}` as Hex;
  // TransceiverMessage: prefix(4) source(32) recipient(32) len(2) → NttManagerMessage: id(32) sender(32) len(2) → transfer
  const at = 4 + 32 + 32 + 2 + 32 + 32 + 2;
  return {
    guardianSetIndex: Number(uintAt(vaa, 1, 4)),
    signatures,
    body,
    emitterChain: Number(uintAt(body, 8, 2)),
    emitter: bytesAt(body, 10, 32),
    sequence: uintAt(body, 42, 8),
    recipientManager: bytesAt(payload, 36, 32),
    transfer: {
      decimals: Number(uintAt(payload, at + 4, 1)),
      amount: uintAt(payload, at + 5, 8),
      to: bytesAt(payload, at + 13 + 32, 32),
      toChain: Number(uintAt(payload, at + 13 + 64, 2)),
    },
  };
}

/**
 * `--dev`: a VAA shaped exactly like the NEAR contract's — 1.5 wNEAR at 8 dp to 0x1111…1111, for the
 * fork manager — from `sha256("ntt-near.dev.testnet")`, signed by the dev guardian.
 */
async function devVaa(): Promise<Hex> {
  const emitter = sha256(stringToHex("ntt-near.dev.testnet"));
  const u16 = (n: number) => numberToHex(n, { size: 2 });
  const transfer = concatHex([
    "0x994E5454",
    numberToHex(8, { size: 1 }), // NEAR trims to min(8, 24, 24)
    numberToHex(150_000_000n, { size: 8 }),
    sha256(stringToHex("wrap.testnet")),
    pad("0x1111111111111111111111111111111111111111", { size: 32 }),
    u16(HYDRATION_CHAIN_ID),
  ]);
  const manager = concatHex([
    pad(numberToHex(0)),
    sha256(stringToHex("alice.testnet")),
    u16((transfer.length - 2) / 2),
    transfer,
  ]);
  const payload = concatHex([
    "0x9945FF10",
    emitter,
    pad(FORK_NTT_MANAGER, { size: 32 }),
    u16((manager.length - 2) / 2),
    manager,
    u16(0),
  ]);
  const body = concatHex([
    numberToHex(Math.floor(Date.now() / 1000), { size: 4 }),
    numberToHex(0, { size: 4 }),
    u16(NEAR_CHAIN_ID),
    emitter,
    numberToHex(1, { size: 8 }),
    numberToHex(0, { size: 1 }), // NEAR messages are consistency level 0
    payload,
  ]);
  const sig = await sign({ hash: keccak256(keccak256(body)), privateKey: DEV_GUARDIAN_PK });
  return concatHex([
    "0x01",
    numberToHex(0, { size: 4 }),
    "0x01",
    "0x00",
    sig.r,
    sig.s,
    numberToHex(sig.yParity!, { size: 1 }),
    body,
  ]);
}

/** A testnet VAA from Wormholescan, retried until the guardian has signed it. */
async function testnetVaa(emitter: string, sequence: string): Promise<Hex> {
  const url = `${TESTNET_API}/${NEAR_CHAIN_ID}/${emitter.replace(/^0x/, "")}/${sequence}`;
  for (let attempt = 1; attempt <= 60; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const json = (await res.json()) as { data?: { vaa?: string } };
      if (json.data?.vaa) return `0x${Buffer.from(json.data.vaa, "base64").toString("hex")}` as Hex;
    }
    console.log(`   …waiting for testnet VAA (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`no testnet VAA at ${url}`);
}

async function loadVaa(): Promise<Hex> {
  if (process.argv.includes("--dev")) return devVaa();
  const given = optionalArg("--vaa");
  if (given) {
    return (given.startsWith("0x") ? given : `0x${Buffer.from(given, "base64").toString("hex")}`) as Hex;
  }
  const emitter = optionalArg("--emitter");
  if (emitter) return testnetVaa(emitter, optionalArg("--sequence") ?? "1");
  throw new Error("pass --emitter <hex> --sequence <n>, --vaa <hex>, or --dev");
}

// ─── Fork helpers ────────────────────────────────────────────────

const slotHex = (n: bigint): Hex => pad(numberToHex(n), { size: 32 });

/** Hydration's unbound-H160 → AccountId32 mapping: b"ETH\0" ++ h160 ++ [0u8;8]. */
const truncatedEvmAccount = (h160: Hex): Hex =>
  `0x45544800${h160.slice(2).toLowerCase()}${"00".repeat(8)}` as Hex;
const ss58 = (pubkey: Hex): string => AccountId(HYDRATION_SS58_PREFIX).dec(pubkey);

/**
 * Guardian set `index` on the Hydration core := `guardians`, never expiring. A non-current set is
 * accepted only while `expirationTime > block.timestamp` (Messages.sol), so it is pushed to u32 max.
 */
function guardianSetOverride(index: number, guardians: Hex[]): [[Hex, Hex], Hex][] {
  const base = BigInt(
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(index), 2n])),
  );
  const keys = BigInt(keccak256(slotHex(base)));
  return [
    [[MESSAGE_CORE, slotHex(base)], slotHex(BigInt(guardians.length))],
    [[MESSAGE_CORE, slotHex(base + 1n)], slotHex(0xffffffffn)],
    ...guardians.map((g, i): [[Hex, Hex], Hex] => [
      [MESSAGE_CORE, slotHex(keys + BigInt(i))],
      pad(g, { size: 32 }),
    ]),
  ];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function eventsAt(net: Network, at: string, tries = 12): Promise<EventRecord[]> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return (await net.client.getUnsafeApi().query.System.Events.getValue({ at })) as EventRecord[];
    } catch (e) {
      lastErr = e;
      await sleep(300);
    }
  }
  throw lastErr;
}

/**
 * Dry-runs a call through the runtime's `EthereumRuntimeRPCApi.call` — the revert data the
 * `Ethereum.Executed` event does not carry — and decodes it against the given ABIs.
 */
async function dryRun(net: Network, from: Hex, to: Hex, data: Hex, abis: Abi[] = []): Promise<string> {
  const api = net.client.getUnsafeApi() as unknown as {
    apis: { EthereumRuntimeRPCApi: { call: (...a: unknown[]) => Promise<unknown> } };
  };
  const u256 = (n: bigint) => [n & 0xffffffffffffffffn, (n >> 64n) & 0xffffffffffffffffn, 0n, 0n];
  try {
    const res = (await api.apis.EthereumRuntimeRPCApi.call(
      from, to, Binary.fromHex(data), u256(0n), u256(14_000_000n),
      undefined, undefined, undefined, false, undefined, undefined,
    )) as { value?: { exit_reason?: { type?: string; value?: { type?: string } }; value?: Uint8Array; used_gas?: { standard: bigint[] } } };
    const exit = res.value?.exit_reason;
    const ret = toHex(res.value?.value ?? new Uint8Array());
    const gas = res.value?.used_gas?.standard?.[0];
    let decoded = "";
    for (const abi of abis) {
      try {
        const e = decodeErrorResult({ abi, data: ret });
        decoded = ` ${e.errorName}(${e.args?.map(String).join(", ") ?? ""})`;
        break;
      } catch {}
    }
    return `${exit?.type}/${exit?.value?.type} gas ${gas} ret ${ret.length > 202 ? ret.slice(0, 200) + "…" : ret}${decoded}`;
  } catch (e) {
    return `dry-run failed: ${String(e).slice(0, 300)}`;
  }
}

/** SCALE `CodeMetadata { size: u64, hash: H256 }` of an address's code, as stored. */
async function metadataOf(net: Network, address: Hex): Promise<Hex> {
  const meta = (await net.client.getUnsafeApi().query.EVM.AccountCodesMetadata.getValue(address)) as {
    size: bigint;
    hash: { asHex(): Hex } | Hex;
  };
  const size = numberToHex(meta.size, { size: 8 }).slice(2).match(/../g)!.reverse().join("");
  const hash = typeof meta.hash === "string" ? meta.hash : meta.hash.asHex();
  return `0x${size}${hash.slice(2)}` as Hex;
}

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const art = nttArtifacts();
  const deployer = privateKeyToAccount(DEPLOYER_PK);

  const vaa = await loadVaa();
  const parsed = parseVaa(vaa);
  const digest = keccak256(keccak256(parsed.body));
  const guardians = await Promise.all(
    parsed.signatures.map((signature) => recoverAddress({ hash: digest, signature })),
  );
  if (parsed.emitterChain !== NEAR_CHAIN_ID) {
    throw new Error(`emitter chain ${parsed.emitterChain}, not NEAR (15)`);
  }
  if (parsed.transfer.toChain !== HYDRATION_CHAIN_ID) {
    throw new Error(`transfer to chain ${parsed.transfer.toChain}, not 73`);
  }
  if (parsed.recipientManager.toLowerCase() !== pad(FORK_NTT_MANAGER, { size: 32 }).toLowerCase()) {
    throw new Error(
      `VAA is for manager ${parsed.recipientManager}, not the fork's ${FORK_NTT_MANAGER} — ` +
        "was the NEAR contract peered with it (migrations/envs/testnet/near-ntt-near.env)?",
    );
  }

  const recipient = `0x${parsed.transfer.to.slice(26)}` as Hex;
  // NTT untrims to the token's decimals: up or down, truncating.
  const shift = FORK_ASSET_DECIMALS - parsed.transfer.decimals;
  const expected =
    shift >= 0
      ? parsed.transfer.amount * 10n ** BigInt(shift)
      : parsed.transfer.amount / 10n ** BigInt(-shift);

  console.log(`\n🥢 NEAR NTT → Hydration delivery probe (real core, fork-deployed wNEAR NTT pair)`);
  console.log(`   VAA        15/${parsed.emitter.slice(2)}/${parsed.sequence}  (${(vaa.length - 2) / 2} bytes)`);
  console.log(`   signed by  set ${parsed.guardianSetIndex}: ${guardians.join(", ")}`);
  console.log(`   transfer   ${parsed.transfer.amount} @ ${parsed.transfer.decimals} dp → ${recipient}`);

  // Dwellir, not the default catfish endpoint: the fork reads every storage entry lazily, and this
  // probe touches hundreds (six deploys, a full NTT delivery) — catfish's rate limiter stalls them.
  const nets = await spawnForks([{ ...configs.hydration, endpoint: "wss://hydration-rpc.n.dwellir.com" }]);
  const { hydration } = nets;
  try {
    // NttManager's implementation is ~25 KB — past EthClient's 6M default.
    const client = new EthClient(hydration, deployer, { chainId: HYDRATION_EVM_CHAIN_ID, gas: 14_000_000n });
    const deployerSub = ss58(truncatedEvmAccount(deployer.address));
    const token = tokenAddress(FORK_ASSET_ID);

    // ── the fork's wNEAR asset, its minter, gas for the deployer, the guardian set ──
    const template = (await hydration.client
      .getUnsafeApi()
      .query.AssetRegistry.Assets.getValue(TEMPLATE_ASSET_ID)) as {
      asset_type: { type: string };
      existential_deposit: bigint;
    };
    await hydration.setStorage({
      System: { Account: [[[deployerSub], { providers: 1, data: { free: 1_000_000n * 10n ** 12n } }]] },
      Tokens: { Accounts: [[[deployerSub, WETH_ASSET_ID], { free: 1_000n * 10n ** 18n }]] },
      AssetRegistry: {
        Assets: [
          [
            [FORK_ASSET_ID],
            {
              name: stringToHex("Wrapped NEAR (fork)"),
              asset_type: template.asset_type.type,
              existential_deposit: template.existential_deposit,
              symbol: stringToHex("wNEAR"),
              decimals: FORK_ASSET_DECIMALS,
              xcm_rate_limit: null,
              is_sufficient: true,
            },
          ],
        ],
      },
      EVMAccounts: { NttMinters: [[[FORK_ASSET_ID], FORK_NTT_MANAGER]] },
      EVM: { AccountStorages: guardianSetOverride(parsed.guardianSetIndex, guardians) },
    });
    // Registration puts a 1-byte stub (0x00) at the asset's precompile address — asset 43 carries it —
    // so Solidity's extcodesize check before `mint` (a call with no return data) passes. Without it
    // the manager reverts with empty data. Raw keys: the JSON form of these values does not apply.
    const evm = hydration.client.getUnsafeApi().query.EVM;
    await hydration.setStorage([
      [await evm.AccountCodes.getKey(token), "0x0400"], // Vec<u8> [0x00]
      [await evm.AccountCodesMetadata.getKey(token), await metadataOf(hydration, tokenAddress(TEMPLATE_ASSET_ID))],
    ]);

    // Hydration only lets whitelisted addresses CREATE, as a real deployer is. The entry's value is
    // `()` — empty bytes — which `null` in the JSON form would delete, so it goes in raw.
    const deployerKey = await hydration.client
      .getUnsafeApi()
      .query.EVMAccounts.ContractDeployer.getKey(deployer.address);
    await hydration.setStorage([[deployerKey, "0x"]]);

    console.log(
      `   fork: asset ${FORK_ASSET_ID} wNEAR (${FORK_ASSET_DECIMALS} dp) · NttMinters[${FORK_ASSET_ID}] = manager · ` +
        `guardian set ${parsed.guardianSetIndex} := the VAA's signer(s)`,
    );

    /** Every `Ethereum.Executed` in the block must be `Succeed`, and there must be `n` of them. */
    const sealed = async (label: string, blockHash: string, n: number) => {
      const events = await eventsAt(hydration, blockHash);
      const executed = events.filter(({ event }) => {
        const ev = event as { type: string; value: { type: string } };
        return ev.type === "Ethereum" && ev.value?.type === "Executed";
      });
      const failed = executed.filter(({ event }) => {
        const reason = (event as { value: { value: { exit_reason?: { type?: string } } } }).value.value.exit_reason;
        return reason?.type !== "Succeed";
      });
      if (executed.length !== n || failed.length > 0) {
        logEvents(events);
        throw new Error(`${label}: ${executed.length - failed.length}/${n} txs succeeded`);
      }
    };
    const encode = (abi: Abi, functionName: string, fnArgs: unknown[] = []) =>
      encodeFunctionData({ abi, functionName, args: fnArgs } as never) as Hex;
    const proxyOf = (impl: Hex) =>
      encodeDeployData({ abi: art.proxy.abi, bytecode: art.proxy.bytecode.object, args: [impl, "0x"] } as never) as Hex;

    // ── block 1: the Hydration leg, as DeployWormholeNttBase deploys it ──
    // Signed up front and sealed together — a fork block costs the same fixed time however many txs
    // it holds. Each tx's gas limit is reserved against the 45M block, so they are sized (~25M total).
    const lib = await client.signDeploy(art.library.bytecode.object, 3_000_000n);
    const managerImpl = await client.signDeploy(
      encodeDeployData({
        abi: art.manager.abi,
        bytecode: link(art.manager.bytecode.object, lib.address),
        args: [token, 1, HYDRATION_CHAIN_ID, RATE_LIMIT_DURATION, false], // 1 = BURNING
      } as never) as Hex,
      10_000_000n,
    );
    const manager = await client.signDeploy(proxyOf(managerImpl.address), 1_500_000n);
    const managerInit = await client.signCall(manager.address, encode(art.manager.abi, "initialize"), 1_500_000n);
    const transceiverImpl = await client.signDeploy(
      encodeDeployData({
        abi: art.transceiver.abi,
        bytecode: link(art.transceiver.bytecode.object, lib.address),
        args: [manager.address, MESSAGE_CORE, CONSISTENCY_LEVEL, 0, 0, "0x0000000000000000000000000000000000000000"],
      } as never) as Hex,
      6_000_000n,
    );
    const transceiver = await client.signDeploy(proxyOf(transceiverImpl.address), 1_500_000n);
    const transceiverInit = await client.signCall(transceiver.address, encode(art.transceiver.abi, "initialize"), 1_500_000n);

    if (
      manager.address.toLowerCase() !== FORK_NTT_MANAGER.toLowerCase() ||
      transceiver.address.toLowerCase() !== FORK_NTT_TRANSCEIVER.toLowerCase()
    ) {
      throw new Error(
        `would deploy at ${manager.address} / ${transceiver.address}, not the fixed fork addresses — did the deployer's nonce move?`,
      );
    }

    const deploys = [lib.rawTx, managerImpl.rawTx, manager.rawTx, managerInit, transceiverImpl.rawTx, transceiver.rawTx, transceiverInit];
    await sealed("deploy", (await client.sendBatch(deploys)).blockHash, deploys.length);
    console.log(`   deployed: manager ${manager.address} (BURNING) · transceiver ${transceiver.address}`);

    // ── block 2: configure, and peer with the NEAR emitter — hydration-ntt's side of the wiring ──
    const config = [
      await client.signCall(manager.address, encode(art.manager.abi, "setTransceiver", [transceiver.address]), 1_000_000n),
      await client.signCall(manager.address, encode(art.manager.abi, "setOutboundLimit", [LIMIT]), 1_000_000n),
      await client.signCall(manager.address, encode(art.manager.abi, "setThreshold", [1]), 1_000_000n),
      await client.signCall(
        manager.address,
        encode(art.manager.abi, "setPeer", [NEAR_CHAIN_ID, parsed.emitter, NEAR_TOKEN_DECIMALS, LIMIT]),
        1_000_000n,
      ),
      await client.signCall(
        transceiver.address,
        encode(art.transceiver.abi, "setWormholePeer", [NEAR_CHAIN_ID, parsed.emitter]),
        1_000_000n,
      ),
    ];
    await sealed("configure + peer", (await client.sendBatch(config)).blockHash, config.length);
    console.log(`   configured: threshold 1 · setPeer(15, emitter, ${NEAR_TOKEN_DECIMALS}) · setWormholePeer(15, emitter)`);

    // ── deliver ──
    const recipientSub = ss58(truncatedEvmAccount(recipient));
    const receive = (vaaHex: Hex) =>
      client.call(
        transceiver.address,
        encodeFunctionData({ abi: art.transceiver.abi, functionName: "receiveMessage", args: [vaaHex] } as never) as Hex,
      );

    const before = await getTokenBalance(hydration, recipientSub, FORK_ASSET_ID);
    const delivery = await receive(vaa);
    const deliveryEvents = await eventsAt(hydration, delivery.blockHash);
    const delivered = checkIfEthereumExecuted(deliveryEvents);
    const after = await getTokenBalance(hydration, recipientSub, FORK_ASSET_ID, delivery.blockHash);
    console.log(`\n   receiveMessage  ${delivered ? "✅ Succeed" : "❌ failed"}`);
    if (!delivered) {
      // Walk the chain one layer at a time: core → library → transceiver → manager.
      const errs = [art.transceiver.abi, art.manager.abi, art.library.abi];
      const core = parseAbi(["function parseAndVerifyVM(bytes) view returns ((uint8,uint32,uint32,uint16,bytes32,uint64,uint8,bytes,uint32,(bytes32,bytes32,uint8,uint8)[],bytes32), bool, string)"]);
      console.log(`   why ▸ core.parseAndVerifyVM     ${await dryRun(hydration, deployer.address, MESSAGE_CORE, encodeFunctionData({ abi: core, functionName: "parseAndVerifyVM", args: [vaa] }))}`);
      const payload = `0x${parsed.body.slice(2 + 51 * 2)}` as Hex;
      console.log(`   why ▸ library.parseTransceiver…  ${await dryRun(hydration, deployer.address, lib.address, encode(art.library.abi, "parseTransceiverAndNttManagerMessage", ["0x9945FF10", payload]), errs)}`);
      console.log(`   why ▸ transceiver.receiveMessage ${await dryRun(hydration, deployer.address, transceiver.address, encode(art.transceiver.abi, "receiveMessage", [vaa]), errs)}`);
      // The manager message, exactly as the transceiver hands it over.
      const mm = `0x${payload.slice(2 + (4 + 32 + 32 + 2) * 2, 2 + (4 + 32 + 32 + 2) * 2 + Number(uintAt(payload, 68, 2)) * 2)}` as Hex;
      const managerMessage = { id: bytesAt(mm, 0, 32), sender: bytesAt(mm, 32, 32), payload: `0x${mm.slice(2 + 66 * 2)}` as Hex };
      console.log(`   why ▸ manager.attestationReceived ${await dryRun(hydration, transceiver.address, manager.address, encode(art.manager.abi, "attestationReceived", [NEAR_CHAIN_ID, parsed.emitter, managerMessage]), errs)}`);
      // Views along the inbound path — ours next to the live PRIME manager on the same fork.
      const LIVE_MANAGER = "0xFCaF4aA069C565d25539028970703F01e47D3E0B" as Hex;
      const views: [string, unknown[]][] = [
        ["token", []], ["tokenDecimals", []], ["getMode", []], ["getThreshold", []], ["isPaused", []],
        ["getPeer", [NEAR_CHAIN_ID]], ["getInboundLimitParams", [NEAR_CHAIN_ID]],
        ["getCurrentInboundCapacity", [NEAR_CHAIN_ID]], ["getCurrentOutboundCapacity", []],
      ];
      for (const [fn, a] of views) {
        const ours = await dryRun(hydration, deployer.address, manager.address, encode(art.manager.abi, fn, a), errs);
        const live = await dryRun(hydration, deployer.address, LIVE_MANAGER, encode(art.manager.abi, fn, fn === "getPeer" || fn.includes("Inbound") ? [1] : a), errs);
        console.log(`   view ${fn.padEnd(27)} ours ${ours.slice(0, 110)}\n   ${"".padEnd(32)} live ${live.slice(0, 110)}`);
      }
      const mintAbi = parseAbi(["function mint(address,uint256)"]);
      console.log(`   why ▸ precompile.mint as manager ${await dryRun(hydration, manager.address, token, encodeFunctionData({ abi: mintAbi, functionName: "mint", args: [recipient, expected] }))}`);
      void decodeFunctionResult;
    }
    console.log(`   recipient wNEAR ${before} → ${after}  (Δ ${after - before}, expected +${expected})`);

    const replay = await receive(vaa);
    const replayed = checkIfEthereumExecuted(await eventsAt(hydration, replay.blockHash));
    const afterReplay = await getTokenBalance(hydration, recipientSub, FORK_ASSET_ID, replay.blockHash);
    console.log(
      `   replay          ${replayed ? "❌ SUCCEEDED" : "✅ rejected"}  · recipient ${afterReplay === after ? "✅ unchanged" : "❌ paid twice"}`,
    );

    const pass = delivered && after - before === expected && !replayed && afterReplay === after;
    console.log(
      pass
        ? `\n🥢 ✅ NEAR → HYDRATION WORKS — the real core verified a NEAR-emitted VAA, the wNEAR NTT pair minted.`
        : `\n🥢 ❌ delivery did not behave as expected.`,
    );
    if (!pass) process.exitCode = 1;
  } finally {
    await teardownForks(nets);
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((e) => {
    console.error("PROBE ERROR:", e?.stack ?? e?.message ?? e);
    process.exit(1);
  });
