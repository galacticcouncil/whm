/**
 * PROBE (PSM redeem leg): burn real HOLLAR through HollarBaseFacilitator on a chopsticks fork.
 *
 * Why this exists: the redeem leg cannot be exercised on an anvil fork. HOLLAR's `transferFrom`
 * resolves its allowance through a Hydration runtime precompile, and anvil has no runtime, so the
 * staticcall lands on a codeless address, returns empty, and the whole call reverts. `transfer`,
 * `approve`, `mint` and `burn` all work there; only the allowance path does not — and `redeem` is
 * the one function that needs it. Chopsticks runs the real runtime, so it works here.
 *
 * What is real: the HOLLAR GHO contract, its facilitator bucket arithmetic, the allowance path,
 * and the burn. What is stood in for: Wormhole verification (a permissive core is deployed and the
 * facilitator is pointed at it), and the bucket grant (written straight into pallet_evm storage,
 * because the real grant is a technical-committee call).
 *
 *   npx tsx chopsticks/probes/_probePsmRedeem.ts
 */
import {
  createPublicClient,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { configs } from "../lib/configs";
import { EthClient } from "../lib/eth";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { getAccountCode, getEventsAt } from "../lib/queries";
import { toJson } from "../lib/utils";

import facilitatorJson from "../../contracts/out-psm/HollarBaseFacilitator.sol/HollarBaseFacilitator.json";
import proxyJson from "../../contracts/out-psm/ERC1967Proxy.sol/ERC1967Proxy.json";
import forkWormholeJson from "../../contracts/out-psm/ForkWormhole.sol/ForkWormhole.json";

// ─── Real Hydration ──────────────────────────────────────────────

/** The GHO contract, not the asset-222 precompile. The precompile answers symbol()/decimals() and
 *  then reverts "unknown selector" on everything a facilitator needs. */
const HOLLAR = getAddress("0x531a654d1696ed52e7275a8cede955e82620f99a");

/** pallet_evm's facilitators mapping base slot, located by matching a live facilitator's
 *  (capacity, level) against storage. Struct packs capacity low, level high. */
const FACILITATORS_SLOT = 8n;

const BASE_CHAIN = 30;
const HYDRATION_CHAIN_ID = 222222;
const SCALE = 10n ** 12n;

const BUCKET_CAPACITY = 250_000n * 10n ** 18n;
const MINT_USDC = 10_000n * 10n ** 6n;
const REDEEM_USDC = 5_000n * 10n ** 6n;

/** anvil account 0 — a real secp256k1 key, funded below. */
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Stands in for the Base vault as the authorized emitter. */
const VAULT_EMITTER = pad("0xb188bbe12220699cc25e5856786729e231512340", { size: 32 });

const UNLIMITED = 2n ** 256n - 1n;

/** Asset 20 = WETH, what pallet_evm charges gas in on Hydration. */
const WETH_ASSET_ID = 20;

const hollarAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function getFacilitatorBucket(address) view returns (uint256,uint256)",
]);

const facilitatorAbi = parseAbi([
  "function initializeFacilitator(address,address,uint8,uint16,address,address)",
  "function setBaseEmitter(bytes32)",
  "function setLimits(uint256,uint256,uint256)",
  "function setPaused(bool,bool)",
  "function receiveMessage(bytes)",
  "function redeem(uint256,address) payable returns (uint64)",
  "function outstanding() view returns (uint256)",
  "function maxRedeemable() view returns (uint256)",
  "function scale() view returns (uint256)",
]);

// ─── Helpers ─────────────────────────────────────────────────────

/** Hydration maps an H160 to `b"ETH\0" ++ h160 ++ [0u8; 8]`. That account pays the EVM gas. */
function truncatedEvmAccount(h160: Hex): Hex {
  return `0x45544800${h160.slice(2)}${"00".repeat(8)}` as Hex;
}

/** The 66-byte PSM body: version | kind | recipient | amount. */
function psmPayload(kind: number, recipient: Hex, amount: bigint): Hex {
  return `0x01${kind.toString(16).padStart(2, "0")}${pad(recipient, { size: 32 }).slice(2)}${pad(
    `0x${amount.toString(16)}`,
    { size: 32 },
  ).slice(2)}` as Hex;
}

/** What ForkWormhole decodes: abi.encode(emitterChainId, emitterAddress, payload). */
function vaa(emitterChain: number, emitter: Hex, payload: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "uint16" }, { type: "bytes32" }, { type: "bytes" }],
    [emitterChain, emitter, payload],
  );
}

function bucketSlot(facilitator: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [facilitator, FACILITATORS_SLOT]),
  );
}

interface EvmLog {
  address: string;
  topics: string[];
  /** papi hands bytes back as Uint8Array, a Binary, or already-hex depending on the codec. */
  data: unknown;
}

/** Normalise whatever papi returned for a bytes field into hex. */
function toHex(raw: unknown): Hex {
  if (typeof raw === "string") return raw as Hex;
  if (raw instanceof Uint8Array) return `0x${Buffer.from(raw).toString("hex")}`;
  const asHex = (raw as { asHex?: () => string })?.asHex;
  if (typeof asHex === "function") return asHex.call(raw) as Hex;
  const asBytes = (raw as { asBytes?: () => Uint8Array })?.asBytes;
  if (typeof asBytes === "function") return `0x${Buffer.from(asBytes.call(raw)).toString("hex")}`;
  throw new Error(`unrecognised bytes shape: ${Object.prototype.toString.call(raw)}`);
}

const fmt = (v: bigint, dp: number) => (Number(v) / 10 ** dp).toLocaleString();

// ─── Probe ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const nets = await spawnForks([configs.hydration]);
  const net: Network = nets.hydration;
  const eth = createPublicClient({
    transport: http(`http://127.0.0.1:${configs.hydration.port}`),
  }) as PublicClient;

  try {
    const account = privateKeyToAccount(PK);
    const me = account.address;
    console.log(`\n🥢 Hydration fork at ${net.url}`);
    console.log(`   signer ${me}`);

    // 1 ── fund the EVM account for gas.
    //
    // NOT pallet-balances HDX. Hydration's pallet_evm Currency is
    // `WethCurrency = CurrencyAdapter<Runtime, WethAssetId>`, so gas is charged against
    // `Tokens.Accounts[<substrate>, 20]` (asset 20 = WETH). Funding System.Account leaves
    // eth_getBalance at zero and the transact extrinsic is dropped before it ever executes —
    // the block comes back holding nothing but inherents.
    await net.setStorage({
      Tokens: {
        Accounts: [[[truncatedEvmAccount(me), WETH_ASSET_ID], { free: 100n * 10n ** 18n }]],
      },
    });
    // (eth_getBalance reads pallet-balances and stays 0 here — chopsticks 2.0.0 does not surface
    //  the WETH-backed EVM balance. Gas still works; don't use it as the funding check.)
    console.log("   funded signer with WETH (asset 20) for gas");

        // Hydration charges the MAX of execution gas, PoV gas, and storage-growth gas at 366
    // gas/byte — so a deploy is storage-growth-dominated and a limit borrowed from another chain
    // silently OOGs. The block ceiling is ~15M (366 * 40 KB), so sit just under it.
    const client = new EthClient(net, account, { chainId: HYDRATION_CHAIN_ID, gas: 13_000_000n });

    /** Deploy and refuse to continue if no runtime code landed — a failed deploy still burns the
     *  nonce, so the next CREATE address shifts and the failure cascades silently. */
    const deployChecked = async (label: string, initCode: Hex): Promise<Hex> => {
      const { address, res } = await client.deploy(initCode);
      const code = await getAccountCode(net, address, res.blockHash);
      const size = (code.length - 2) / 2;
      console.log(`   ${label.padEnd(23)} ${address}  (${size} bytes)`);
      if (size === 0) {
        const evs = await getEventsAt(net, res.blockHash);
        for (const e of evs) console.log("     ", toJson(e.event).slice(0, 300));
        throw new Error(`${label} deployed no code`);
      }
      return address;
    };

    // 2 ── deploy a permissive core, then the facilitator behind a proxy
    const core = await deployChecked("ForkWormhole", forkWormholeJson.bytecode.object as Hex);
    const impl = await deployChecked("Facilitator impl", facilitatorJson.bytecode.object as Hex);
    const initData = encodeFunctionData({
      abi: facilitatorAbi,
      functionName: "initializeFacilitator",
      args: [core, HOLLAR, 6, BASE_CHAIN, me, me],
    });
    const proxyInit = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes" }],
      [impl, initData],
    );
    const facilitator = await deployChecked(
      "Facilitator proxy",
      `${proxyJson.bytecode.object}${proxyInit.slice(2)}` as Hex,
    );

    const scale = await eth.readContract({
      address: facilitator,
      abi: facilitatorAbi,
      functionName: "scale",
    });
    console.log(`   scale read off real HOLLAR: ${scale}  ${scale === SCALE ? "✓" : "✗"}`);

    // 3 ── wire it
    for (const data of [
      encodeFunctionData({ abi: facilitatorAbi, functionName: "setBaseEmitter", args: [VAULT_EMITTER] }),
      encodeFunctionData({
        abi: facilitatorAbi,
        functionName: "setLimits",
        args: [UNLIMITED, UNLIMITED, 0n],
      }),
      encodeFunctionData({ abi: facilitatorAbi, functionName: "setPaused", args: [false, false] }),
    ]) {
      await client.call(facilitator, data);
    }
    console.log("   emitter bound, limits set, unpaused");

    // 4 ── grant the bucket by writing pallet_evm storage (the real grant is a TC call)
    await net.setStorage({
      EVM: {
        AccountStorages: [
          [[HOLLAR, bucketSlot(facilitator)], pad(`0x${BUCKET_CAPACITY.toString(16)}`, { size: 32 })],
        ],
      },
    });
    const [cap, lvl0] = await eth.readContract({
      address: HOLLAR,
      abi: hollarAbi,
      functionName: "getFacilitatorBucket",
      args: [facilitator],
    });
    console.log(`   bucket granted: capacity ${fmt(cap, 18)} HOLLAR, level ${fmt(lvl0, 18)}`);

    // 5 ── mint leg (also gives us HOLLAR to redeem)
    await client.call(
      facilitator,
      encodeFunctionData({
        abi: facilitatorAbi,
        functionName: "receiveMessage",
        args: [vaa(BASE_CHAIN, VAULT_EMITTER, psmPayload(1, me, MINT_USDC))],
      }),
    );
    const minted = await eth.readContract({
      address: HOLLAR,
      abi: hollarAbi,
      functionName: "balanceOf",
      args: [me],
    });
    console.log(`\n   MINT  → ${fmt(minted, 18)} HOLLAR minted on the real token`);

    // 6 ── the leg anvil cannot run: approve + transferFrom + burn through the precompile path
    await client.call(
      HOLLAR,
      encodeFunctionData({ abi: hollarAbi, functionName: "approve", args: [facilitator, minted] }),
    );
    console.log("   approve on real HOLLAR ok");

    const res = await client.call(
      facilitator,
      encodeFunctionData({
        abi: facilitatorAbi,
        functionName: "redeem",
        args: [REDEEM_USDC, me],
      }),
    );

    const after = await eth.readContract({
      address: HOLLAR,
      abi: hollarAbi,
      functionName: "balanceOf",
      args: [me],
    });
    const [, lvl] = await eth.readContract({
      address: HOLLAR,
      abi: hollarAbi,
      functionName: "getFacilitatorBucket",
      args: [facilitator],
    });

    const burned = minted - after;
    console.log(`\n   REDEEM → burned ${fmt(burned, 18)} HOLLAR (block ${res.blockNumber})`);
    console.log(`            bucket level now ${fmt(lvl, 18)} HOLLAR`);

    const expectBurn = REDEEM_USDC * SCALE;
    const ok = burned === expectBurn && lvl === MINT_USDC * SCALE - expectBurn;
    console.log(`\n   ${ok ? "✅ REDEEM LEG WORKS on the real runtime" : "❌ mismatch"}`);
    if (!ok) {
      console.log(`      expected burn ${expectBurn}, got ${burned}`);
      process.exitCode = 1;
    }

    // 7 ── the outbound message, read from substrate events.
    //      gc-chopsticks 2.0.0 serves a read-only eth RPC subset with no eth_getLogs, so the EVM
    //      log has to come off the block's EVM.Log events instead.
    const events = await getEventsAt(net, res.blockHash);
    const evmLogs = events
      .map((e) => e.event as { type: string; value: { type: string; value?: { log?: EvmLog } } })
      .filter((e) => e.type === "EVM" && e.value.type === "Log")
      .map((e) => e.value.value?.log)
      .filter((l): l is EvmLog => Boolean(l));

    const published = evmLogs.find(
      (l) => l.address.toLowerCase() === core.toLowerCase(),
    );
    if (!published) {
      console.log("   ⚠ no LogMessagePublished found in the redeem block");
      return;
    }

    // Decode the event properly rather than slicing off the tail: `payload` is a dynamic `bytes`,
    // so ABI pads it from 66 to 96 and appends `consistencyLevel` after the offset word. Taking the
    // last 66 bytes therefore starts 30 bytes into the body and reads the recipient as the kind.
    const [, , payload, consistency] = decodeAbiParameters(
      [{ type: "uint64" }, { type: "uint32" }, { type: "bytes" }, { type: "uint8" }],
      toHex(published.data),
    );
    const body = payload as Hex;
    const kind = parseInt(body.slice(4, 6), 16);
    const bytes = (body.length - 2) / 2;
    console.log(`   consistency ${consistency} (200 = publish immediately)`);
    console.log(`   published: kind ${kind} (2 = redeem), ${bytes} bytes`);
    console.log(`   ${kind === 2 && bytes === 66 ? "✅ outbound wire format correct" : "❌ wire mismatch"}`);
  } finally {
    await teardownForks(nets);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
