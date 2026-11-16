import { readFileSync } from "node:fs";

import type { ContractArtifact } from "./interfaces";

// ─── Forge artifacts ──────────────────────────────────────────────

const CONTRACTS = new URL("../../contracts/", import.meta.url);

type Built = string | Record<string, { path: string }>;
type Cache = { files: Record<string, { artifacts?: Record<string, Record<string, Built>> }> };

/**
 * The artifact of `name` built under `profile`. A contract compiled under two profiles gets one
 * artifact per profile at paths that depend on build history; forge's cache records which is which.
 */
export function forgeArtifact(name: string, profile = "default"): ContractArtifact {
  const cache = JSON.parse(readFileSync(new URL("cache/solidity-files-cache.json", CONTRACTS), "utf8")) as Cache;
  const paths = new Set<string>();
  for (const { artifacts } of Object.values(cache.files)) {
    for (const built of Object.values(artifacts?.[name] ?? {})) {
      const path = typeof built === "string" ? (profile === "default" ? built : undefined) : built[profile]?.path;
      if (path) paths.add(path);
    }
  }
  if (paths.size !== 1) {
    throw new Error(`${name} (${profile} profile): ${paths.size} artifacts in contracts/cache — run forge build`);
  }
  const [path] = paths;
  return JSON.parse(readFileSync(new URL(`out/${path}`, CONTRACTS), "utf8")) as ContractArtifact;
}
