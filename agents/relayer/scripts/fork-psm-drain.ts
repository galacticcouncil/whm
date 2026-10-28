/**
 * The drain keeper and the vault watcher against the deployed vault, on an anvil fork of Base.
 *
 * Real contracts throughout: the vault, Circle's USDC with its blacklist, Aave v3 and the Wormhole
 * core. On the fork only: the core's guardian set is one key we hold, a stand-in Hydration emitter
 * is bound if none is yet, and deposits are unpaused by impersonating the vault's guardian. Credits
 * are booked by delivering signed KIND_REDEEM messages through the real `receiveMessage`.
 *
 *   pnpm fork:base                                        # anvil on :8546
 *   pnpm --filter @whm/relayer verify:psm-drain-fork      # RPC=<url> to point elsewhere
 *
 * Exits 1 rather than skipping when the fork is not there.
 */
import {
  concatHex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

import { base } from "../src/chains";
import { baseClients } from "../src/engine/base";
import { receiveMessage } from "../src/engine/hydration";
import { createAlerter } from "../src/engine/notify";
import { createQueue } from "../src/engine/queue";
import logger from "../src/logger";
import { receiverAbi, vaultKeeperAbi } from "../src/apps/psm/abi";
import { GAS_MARGIN_BPS } from "../src/apps/psm/config";
import type { KeeperCtx } from "../src/apps/psm/keepers/common";
import { drainTick, type DrainState } from "../src/apps/psm/keepers/drain";
import { baseWatch, baseWatchTick } from "../src/apps/psm/keepers/watch";

const RPC = process.env.RPC ?? "http://127.0.0.1:8546";
const VAULT = getAddress(process.env.VAULT ?? "0xd5FD74F570343245AFcE4a4C0B24b59179cfdfA7");
const SAFE = getAddress("0xD557AeAf1e0cB3D226BfF3B7a10C2cdA9dA081E7");
const DEPLOYER = getAddress("0x20b588a194d9a3D788985c0C86A1160836a0Aaaa");
const HYDRATION_CHAIN = 73;
const STAND_IN_EMITTER = pad("0xfac1000000000000000000000000000000000001", { size: 32 });

// anvil keys 0 and 1: the keeper/relayer and the depositor. Key 2 signs as the only guardian.
const KEEPER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const DEPOSITOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const GUARDIAN_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as const;

const R1 = getAddress("0x1000000000000000000000000000000000000001");
const R2 = getAddress("0x1000000000000000000000000000000000000002");
const R3 = getAddress("0x1000000000000000000000000000000000000003");
const ORIGIN = getAddress("0x2000000000000000000000000000000000000001");

const ADMIN_ROLE = pad("0x00", { size: 32 });

const vaultAbi = parseAbi([
  "function hasRole(bytes32,address) view returns (bool)",
  "function emitterFrozen() view returns (bool)",
  "function authorizedEmitters(uint16) view returns (bytes32)",
  "function setHydrationEmitter(bytes32)",
  "function setDepositsPaused(bool)",
  "function setPayoutLimit(uint256,uint256)",
  "function deposit(uint256,bytes32) payable returns (uint64)",
  "function receiveMessage(bytes)",
  "function redeemFeeBps() view returns (uint256)",
  "function unpayable(address) view returns (uint256)",
  "function principal() view returns (uint256)",
]);
const coreAbi = parseAbi([
  "function getCurrentGuardianSetIndex() view returns (uint32)",
  "function getGuardianSet(uint32) view returns ((address[] keys, uint32 expirationTime))",
]);
const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function blacklister() view returns (address)",
  "function blacklist(address)",
  "function isBlacklisted(address) view returns (bool)",
]);

let failed = false;
function record(ok: boolean, label: string, detail?: unknown) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}`);
  if (!ok) {
    if (detail !== undefined) console.log("   ", detail);
    failed = true;
  }
}

const pub = createPublicClient({ chain: base, transport: http(RPC), cacheTime: 0 });
const anvil = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });

/** Send as any address: impersonated on the fork, with gas money. */
async function as(from: Address, to: Address, abi: readonly unknown[], functionName: string, args: unknown[]) {
  await anvil("anvil_impersonateAccount", [from]);
  await anvil("anvil_setBalance", [from, numberToHex(10n ** 18n)]);
  const w = createWalletClient({ chain: base, transport: http(RPC), account: from });
  const hash = await w.writeContract({ address: to, abi, functionName, args } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  await anvil("anvil_stopImpersonatingAccount", [from]);
  if (receipt.status !== "success") throw new Error(`${functionName} from ${from} reverted`);
}

const slot = (n: bigint): Hex => pad(numberToHex(n), { size: 32 });

/** guardianSets is the core's slot 2: keys length at the struct base, key data at keccak(base). */
async function swapGuardians(core: Address, index: number, guardian: Address) {
  const baseSlot = BigInt(keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(index), 2n])));
  await anvil("anvil_setStorageAt", [core, slot(baseSlot), slot(1n)]);
  await anvil("anvil_setStorageAt", [core, slot(BigInt(keccak256(slot(baseSlot)))), pad(guardian, { size: 32 })]);
}

/** The 100-byte PSM body: version | kind | recipient | amount | origin | maxFeeBps. */
const psmPayload = (kind: number, recipient: Address, amount: bigint, origin: Address, maxFeeBps = 0xffff): Hex =>
  concatHex([
    "0x01",
    pad(numberToHex(kind), { size: 1 }),
    pad(recipient, { size: 32 }),
    pad(numberToHex(amount), { size: 32 }),
    pad(origin, { size: 32 }),
    pad(numberToHex(maxFeeBps), { size: 2 }),
  ]);

async function signedVaa(index: number, emitter: Hex, sequence: bigint, payload: Hex): Promise<Hex> {
  const body = concatHex([
    pad(numberToHex(Math.floor(Date.now() / 1000)), { size: 4 }),
    pad(numberToHex(0), { size: 4 }),
    pad(numberToHex(HYDRATION_CHAIN), { size: 2 }),
    emitter,
    pad(numberToHex(sequence), { size: 8 }),
    pad(numberToHex(1), { size: 1 }),
    payload,
  ]);
  const { r, s, v } = await sign({ hash: keccak256(keccak256(body)), privateKey: GUARDIAN_KEY });
  return concatHex([
    "0x01",
    pad(numberToHex(index), { size: 4 }),
    "0x01",
    "0x00",
    pad(r, { size: 32 }),
    pad(s, { size: 32 }),
    pad(numberToHex(Number(v! - 27n)), { size: 1 }),
    body,
  ]);
}

async function main() {
  try {
    const chainId = await pub.getChainId();
    if (chainId !== base.id) throw new Error(`chain ${chainId}`);
    const code = await pub.getCode({ address: VAULT });
    if (!code || code === "0x") throw new Error(`no vault code at ${VAULT}`);
  } catch (e) {
    console.error(`fork-psm-drain: no Base fork with the vault at ${RPC} (${(e as Error).message}); start one with pnpm fork:base`);
    process.exit(1);
  }

  const read = <T>(abi: readonly unknown[], address: Address, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const usdc = await read<Address>(vaultKeeperAbi, VAULT, "usdc");
  const aUsdc = await read<Address>(vaultKeeperAbi, VAULT, "aUsdc");
  const core = await read<Address>(vaultKeeperAbi, VAULT, "wormhole");

  // ── fork setup ──
  const guardian = privateKeyToAccount(GUARDIAN_KEY).address;
  const setIndex = await read<number>(coreAbi, core, "getCurrentGuardianSetIndex");
  await swapGuardians(core, setIndex, guardian);
  const set = await read<{ keys: Address[] }>(coreAbi, core, "getGuardianSet", [setIndex]);
  record(set.keys.length === 1 && getAddress(set.keys[0]) === guardian, `setup: guardian set ${setIndex} is one key we hold`);

  let emitter: Hex;
  if (await read<boolean>(vaultAbi, VAULT, "emitterFrozen")) {
    emitter = await read<Hex>(vaultAbi, VAULT, "authorizedEmitters", [HYDRATION_CHAIN]);
  } else {
    const admin = (await read<boolean>(vaultAbi, VAULT, "hasRole", [ADMIN_ROLE, DEPLOYER])) ? DEPLOYER : SAFE;
    await as(admin, VAULT, vaultAbi, "setHydrationEmitter", [STAND_IN_EMITTER]);
    emitter = STAND_IN_EMITTER;
  }
  await as(SAFE, VAULT, vaultAbi, "setDepositsPaused", [false]);

  const depositor = privateKeyToAccount(DEPOSITOR_KEY);
  await as(aUsdc, usdc, usdcAbi, "transfer", [depositor.address, 1_000_000_000n]);
  const dw = createWalletClient({ chain: base, transport: http(RPC), account: depositor });
  await pub.waitForTransactionReceipt({ hash: await dw.writeContract({ address: usdc, abi: usdcAbi, functionName: "approve", args: [VAULT, 1_000_000_000n] }) });
  await pub.waitForTransactionReceipt({
    hash: await dw.writeContract({ address: VAULT, abi: vaultAbi, functionName: "deposit", args: [1_000_000_000n, pad(depositor.address, { size: 32 })] }),
  });
  const principal = await read<bigint>(vaultAbi, VAULT, "principal");
  record(principal >= 1_000_000_000n, `setup: deposited 1,000 USDC, principal ${principal}`);

  // ── the relayer's own stack: one wallet, one queue, for deliveries and the keeper alike ──
  const clients = await baseClients(RPC, KEEPER_KEY);
  const queue = createQueue({ publicClient: clients.publicClient, account: clients.account, warnMultiplier: 1n });
  await queue.init();

  // Credits arrive the way the psm-base app delivers them: queued receiveMessage, gas margin on.
  let seq = BigInt(Date.now());
  const credit = async (recipient: Address, amount: bigint) => {
    const vaa = await signedVaa(setIndex, emitter, seq++, psmPayload(2, recipient, amount, ORIGIN));
    const sent: { hash?: Hex } = {};
    await queue.add({
      label: "credit",
      logger,
      submit: async (n) =>
        (sent.hash = await receiveMessage(clients, receiverAbi, VAULT, Buffer.from(vaa.slice(2), "hex"), n, {
          gasMarginBps: GAS_MARGIN_BPS,
        })),
    });
    const r = await pub.waitForTransactionReceipt({ hash: sent.hash! });
    if (r.status !== "success") throw new Error(`receiveMessage reverted (${sent.hash})`);
    const tx = await pub.getTransaction({ hash: sent.hash! });
    return { gasLimit: tx.gas, gasUsed: r.gasUsed };
  };
  await credit(R1, 100_000_000n);
  await credit(R2, 200_000_000n);
  await credit(R3, 50_000_000n);

  const blacklister = await read<Address>(usdcAbi, usdc, "blacklister");
  await as(blacklister, usdc, usdcAbi, "blacklist", [R2]);
  record(await read<boolean>(usdcAbi, usdc, "isBlacklisted", [R2]), "setup: R2 blacklisted by USDC's own blacklister");
  const raised: { key: string; state: string; message: string }[] = [];
  const inner = createAlerter({ repeatMs: 3_600_000, post: async () => true });
  const ctx: KeeperCtx = {
    clients,
    queue,
    alerter: {
      alert: (key, state, message) => {
        raised.push({ key, state, message });
        inner.alert(key, state, message);
      },
      clear: (key) => inner.clear(key),
    },
    enabled: true,
    log: logger,
    now: Date.now,
  };
  const state: DrainState = {};
  const fee = await read<bigint>(vaultAbi, VAULT, "redeemFeeBps");
  const net = (gross: bigint) => gross - (gross * fee) / 10_000n;
  const bal = (a: Address) => read<bigint>(usdcAbi, usdc, "balanceOf", [a]);

  const [b1, b3] = [await bal(R1), await bal(R3)];
  const out = await drainTick(ctx, VAULT, state);
  record(
    out.kind === "sent" && out.settled === 2 && out.retired === 1,
    "drain: one drain(10) pays R1 and R3 and retires the blacklisted R2 between them",
    out,
  );
  record((await bal(R1)) - b1 === net(100_000_000n) && (await bal(R3)) - b3 === net(50_000_000n), "drain: R1 and R3 received their credits net of the fee");
  record((await read<bigint>(vaultAbi, VAULT, "unpayable", [R2])) === net(200_000_000n), "drain: R2's credit sits in unpayable, still owed");
  record(raised.some((r) => r.key.startsWith("psm:retired:")), "drain: the retirement is alerted", raised.map((r) => r.key));
  record((await drainTick(ctx, VAULT, state)).kind === "empty", "drain: the next tick finds the queue empty");

  // A delivery estimated right after a drain moved the head: headSince was written in the latest
  // block, so a bare estimate prices the next write as unchanged. The margin carries it.
  const late = await credit(R2, 20_000_000n);
  record(
    late.gasLimit * 100n >= late.gasUsed * 115n,
    "delivery: a credit right after a drain lands, its gas limit carrying the PSM margin over what it used",
    late,
  );

  // A blacklisted head: claim() from it names the reason, and drain retires it.
  const before = raised.length;
  const blocked = await drainTick(ctx, VAULT, state);
  record(
    blocked.kind === "sent" && blocked.retired === 1 && raised.slice(before).some((r) => r.key.startsWith("psm:head-blacklisted:")),
    "drain: a blacklisted head is named by claim() (RecipientUnpayable), alerted, and retired",
    { blocked, keys: raised.slice(before).map((r) => r.key) },
  );

  // A head above the payout capacity can never be paid: alerted, nothing sent.
  const admin = (await read<boolean>(vaultAbi, VAULT, "hasRole", [ADMIN_ROLE, DEPLOYER])) ? DEPLOYER : SAFE;
  await as(admin, VAULT, vaultAbi, "setPayoutLimit", [50_000_000n, 86_400n]);
  await credit(R1, 100_000_000n);
  const nonce = queue.nonce;
  const capped = await drainTick(ctx, VAULT, state);
  record(
    capped.kind === "held" && capped.reason === "InsufficientPayoutAllowance" && raised.some((r) => r.key.startsWith("psm:head-above-capacity:")),
    "drain: a head above the payout capacity is decoded from claim(), alerted, and nothing is sent",
    capped,
  );
  record(queue.nonce === nonce, "drain: holding spends no nonce");

  // The watcher on the same vault: a non-zero Wormhole message fee (core slot 7). Its log check reads
  // pre-fork blocks from the fork's upstream, which may refuse eth_getLogs; the loop logs that, and
  // the other checks still run.
  const watch = baseWatch(VAULT);
  await baseWatchTick(ctx, watch).catch(() => {});
  await anvil("anvil_setStorageAt", [core, slot(7n), slot(1n)]);
  await baseWatchTick(ctx, watch).catch(() => {});
  record(raised.some((r) => r.key === "psm:message-fee"), "watch: a non-zero Base message fee is alerted");
  const [idle, supplied] = await Promise.all([bal(VAULT), read<bigint>(usdcAbi, aUsdc, "balanceOf", [VAULT])]);
  const [owedTotal, unpayableTotal, principalNow] = await Promise.all([
    read<bigint>(vaultKeeperAbi, VAULT, "totalOwed"),
    read<bigint>(vaultKeeperAbi, VAULT, "totalUnpayable"),
    read<bigint>(vaultAbi, VAULT, "principal"),
  ]);
  record(
    watch.failed.every((name) => name === "logs") &&
      idle + supplied + 10n >= principalNow + owedTotal + unpayableTotal &&
      !raised.some((r) => r.key === "psm:reserve-short"),
    "watch: the reserve check ran, found the reserve covering what the vault owes, and raised nothing",
    { failed: watch.failed, assets: idle + supplied, liabilities: principalNow + owedTotal + unpayableTotal },
  );
  console.log(`   (vault log reads failed ${watch.logFailures} times against this fork's upstream)`);

  console.log(failed ? "\nfork-psm-drain: FAILED" : "\nfork-psm-drain: all checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("fork-psm-drain:", e);
  process.exit(1);
});
