import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { actions, nearToYocto, teraToGas } from "near-api-js";
import { privateKeyToAccount } from "viem/accounts";

import { call, checked, wallet } from "@whm/common/near";

import {
  FORK_GUARDIAN_PK,
  FORK_HOME,
  FORK_ROOT,
  FORK_RPC,
  FORK_WASM,
  forkRootKey,
  sandboxBinary,
} from "./fork";

/**
 * Starts a fresh local NEAR sandbox and sets up what `near-ntt` runs against: the mainnet Wormhole
 * core (booted on the fork guardian) and the mainnet `wrap.near` code, plus a funded user. Stays in
 * the foreground until the node exits.
 *
 *   wormhole.test.near   Wormhole core, guardian set 0 = the fork guardian
 *   wrap.test.near       wNEAR (24 dp)
 *   alice.test.near      10 wNEAR, registered
 */
async function main(): Promise<void> {
  const bin = sandboxBinary();
  // The darwin build links liblzma from an arm64 Homebrew path; fall back to the system copy.
  const env = { ...process.env, DYLD_FALLBACK_LIBRARY_PATH: "/usr/lib" };

  rmSync(FORK_HOME, { recursive: true, force: true });
  const init = spawnSync(bin, ["--home", FORK_HOME, "init"], { env, stdio: "ignore" });
  if (init.status !== 0) throw new Error(`near-sandbox init failed (${bin})`);

  // The node logs to stderr, loudly; keep the terminal for the setup summary.
  mkdirSync(FORK_HOME, { recursive: true });
  const log = path.join(FORK_HOME, "node.log");
  console.log(`> ${bin} --home ${FORK_HOME} run    (log: ${log})\n`);
  const node = spawn(bin, ["--home", FORK_HOME, "run"], { env, stdio: ["ignore", "ignore", openSync(log, "a")] });
  node.on("exit", (code) => process.exit(code ?? 0));
  process.on("SIGINT", () => node.kill("SIGINT"));

  await waitForRpc();
  await setup();

  console.log(`\nRPC:          ${FORK_RPC}`);
  console.log(`root:         ${FORK_ROOT}  (key: ${path.join(FORK_HOME, "validator_key.json")})`);
  console.log(`core:         wormhole.test.near  (guardian ${privateKeyToAccount(FORK_GUARDIAN_PK).address})`);
  console.log(`token:        wrap.test.near`);
  console.log(`user:         alice.test.near  (10 wNEAR, same key as root)`);
  console.log(`\nnext:         pnpm migrate:near-ntt-near:fork`);
}

async function setup(): Promise<void> {
  const key = forkRootKey();
  const root = wallet.getWallet(FORK_RPC, FORK_ROOT, key);
  const publicKey = await root.signer.getPublicKey();

  /** Creates `<name>.test.near` with the root key, optionally deploying code. */
  const sub = async (name: string, near: `${number}`, wasm?: string) => {
    const acts = [
      actions.createAccount(),
      actions.transfer(nearToYocto(near)),
      actions.addFullAccessKey(publicKey),
    ];
    if (wasm) acts.push(actions.deployContract(new Uint8Array(readFileSync(path.join(FORK_WASM, wasm)))));
    const id = `${name}.${FORK_ROOT}`;
    checked(`create ${id}`, await root.account.signAndSendTransaction({ receiverId: id, actions: acts, waitUntil: "FINAL" }));
    return wallet.getWallet(FORK_RPC, id, key);
  };

  const core = await sub("wormhole", "20", "contract.wormhole_crypto.near.wasm");
  // `Default` takes the first signer's key as owner; booting is that first call.
  const guardian = privateKeyToAccount(FORK_GUARDIAN_PK).address.slice(2).toLowerCase();
  checked("boot_wormhole", await call(core.account, core.account.accountId, "boot_wormhole", {
    gset: 0,
    addresses: [guardian],
  }));

  const token = await sub("wrap", "20", "wrap.near.wasm");
  checked("wrap new", await call(token.account, token.account.accountId, "new", {}));

  const alice = await sub("alice", "20");
  checked("alice storage", await call(alice.account, token.account.accountId, "storage_deposit", {
    account_id: alice.account.accountId,
    registration_only: true,
  }, { deposit: nearToYocto("0.00125") }));
  checked("alice wrap", await call(alice.account, token.account.accountId, "near_deposit", {}, {
    deposit: nearToYocto("10"),
    gas: teraToGas(30),
  }));
}

async function waitForRpc(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(FORK_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("sandbox RPC did not come up");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
