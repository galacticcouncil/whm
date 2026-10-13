import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Local sandbox RPC. */
export const FORK_RPC = "http://127.0.0.1:3030";

/** Sandbox home — chain data and the root account's key. Reset on every `fork:near`. */
export const FORK_HOME = path.resolve(__dirname, "../../.sandbox");

/** Root account the sandbox creates; every fork account is its sub-account. */
export const FORK_ROOT = "test.near";

/**
 * The fork's single guardian. Dev-only and public on purpose — it lets `forkVaa.ts` sign VAAs the
 * real core's `verify_vaa` accepts, on a core booted with this set.
 */
export const FORK_GUARDIAN_PK =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;

/** What the fork deploys: the mainnet code of both counterparties (`crates/near/sandbox`). */
export const FORK_WASM = path.resolve(__dirname, "../../sandbox/tests/wasm");

/**
 * The root account's secret key, from the sandbox home.
 *
 * @returns `ed25519:…`
 */
export function forkRootKey(): string {
  const file = path.join(FORK_HOME, "validator_key.json");
  return JSON.parse(readFileSync(file, "utf8")).secret_key as string;
}

/**
 * The `near-sandbox` binary: `NEAR_SANDBOX_BIN`, else the one `near-workspaces` downloaded into
 * this crate's `target/` (`pnpm test:sandbox` fetches it).
 *
 * @returns Absolute path to the binary
 */
export function sandboxBinary(): string {
  if (process.env.NEAR_SANDBOX_BIN) return process.env.NEAR_SANDBOX_BIN;

  const build = path.resolve(__dirname, "../../target/debug/build");
  const found: string[] = [];
  for (const dir of safeReaddir(build).filter((d) => d.startsWith("near-sandbox-"))) {
    const root = path.join(build, dir, "out", ".near");
    for (const version of safeReaddir(root)) {
      const bin = path.join(root, version, "near-sandbox");
      if (safeIsFile(bin)) found.push(bin);
    }
  }
  if (found.length === 0) {
    throw new Error(
      "near-sandbox not found — set NEAR_SANDBOX_BIN, or run `pnpm test:sandbox` in crates/near once " +
        "(near-workspaces downloads it; on Apple Silicon use the aarch64 toolchain, see sandbox/README.md)",
    );
  }
  return found.sort().at(-1)!;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function safeIsFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
