import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const api = "https://hydration-explorer.neckwork.net/api/";

export function targets(state) {
  if (state.environment !== "prod" || state.migration !== "governance-hydration" || !state.completedAt) {
    throw new Error("Expected completed production governance-hydration deployment");
  }
  return [
    ["001-deploy-dispatcher-implementation", "implAddress", "GovernanceDispatcher"],
    ["002-deploy-dispatcher-proxy", "proxyAddress", "ERC1967Proxy"],
  ].map(([name, field, contract]) => {
    const step = state.steps.find((step) => step.name === name);
    const address = step?.output?.[field];
    const tx = step?.output?.deployTxHash;
    if (step?.status !== "completed" || !/^0x[\da-f]{40}$/i.test(address ?? "") || !/^0x[\da-f]{64}$/i.test(tx ?? "")) {
      throw new Error(`Missing completed deployment: ${name}`);
    }
    return { address, tx, contract };
  });
}

export function requireMatch(record, address) {
  if (String(record.chainId) !== "222222" || record.address?.toLowerCase() !== address.toLowerCase()
    || !["match", "exact_match"].includes(record.runtimeMatch)) {
    throw new Error(`Neckwork did not confirm a runtime source match for ${address}`);
  }
  return record;
}

export async function verify() {
  const state = JSON.parse(readFileSync(resolve(root, "deployments/prod/governance-hydration.json"), "utf8"));
  const evidence = [];
  for (const { address, tx, contract } of targets(state)) {
    const artifact = JSON.parse(readFileSync(resolve(root, `contracts/out/${contract}.sol/${contract}.json`), "utf8"));
    const metadata = typeof artifact.metadata === "string" ? JSON.parse(artifact.metadata) : artifact.metadata;
    const compilationTarget = Object.entries(metadata.settings.compilationTarget);
    if (compilationTarget.length !== 1 || compilationTarget[0][1] !== contract) {
      throw new Error(`Unexpected compilation target for ${contract}`);
    }
    execFileSync("forge", [
      "verify-contract", address, `${compilationTarget[0][0]}:${contract}`,
      "--compiler-version", metadata.compiler.version,
      "--chain", "222222", "--verifier", "sourcify", "--verifier-url", api,
      "--creation-transaction-hash", tx, "--watch",
    ], { cwd: resolve(root, "contracts"), stdio: "inherit", timeout: 300_000 });
    const url = `${api}v2/contract/222222/${address}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Neckwork lookup failed: HTTP ${response.status}`);
    const record = requireMatch(await response.json(), address);
    evidence.push({ contract, address, deploymentTransaction: tx, url, ...record, checkedAt: new Date().toISOString() });
    const directory = resolve(root, "deployments/prod/verification");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `governance-hydration-${contract}.json`), JSON.stringify(evidence.at(-1), null, 2) + "\n");
    console.log(`${contract}: ${record.runtimeMatch} (${url})`);
  }
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
