import assert from "node:assert/strict";
import test from "node:test";
import { requireMatch, targets } from "./verify-neckwork.mjs";

const address = `0x${"12".repeat(20)}`;
const tx = `0x${"34".repeat(32)}`;
const state = () => ({
  environment: "prod", migration: "governance-hydration", completedAt: "2026-10-15",
  steps: [
    { name: "001-deploy-dispatcher-implementation", status: "completed", output: { implAddress: address, deployTxHash: tx } },
    { name: "002-deploy-dispatcher-proxy", status: "completed", output: { proxyAddress: address, deployTxHash: tx } },
  ],
});

test("selects both recorded deployments and rejects fork or incomplete state", () => {
  assert.deepEqual(targets(state()).map((target) => target.contract), ["GovernanceDispatcher", "ERC1967Proxy"]);
  assert.throws(() => targets({ ...state(), environment: "fork" }));
  assert.throws(() => targets({ ...state(), completedAt: null }));
  const missing = state();
  missing.steps[1].output.proxyAddress = "";
  assert.throws(() => targets(missing));
});

test("requires a runtime match for the requested chain and address", () => {
  const record = { chainId: "222222", address, runtimeMatch: "match" };
  assert.equal(requireMatch(record, address), record);
  assert.doesNotThrow(() => requireMatch({ ...record, runtimeMatch: "exact_match" }, address));
  for (const change of [
    { runtimeMatch: null, match: "exact_match" }, { runtimeMatch: "unknown" },
    { chainId: "1" }, { address: `0x${"56".repeat(20)}` },
  ]) assert.throws(() => requireMatch({ ...record, ...change }, address));
});
