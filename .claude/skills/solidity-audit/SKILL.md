---
name: solidity-audit
description: Parallelized smart-contract security audit (pashov solidity-auditor methodology; always fetches the latest upstream refs fresh into a temp dir — needs network, nothing vendored). Trigger on "audit", "security review this contract", "review for security", or a `/solidity-audit <file...>` invocation. Spawns 12 specialist attacker agents via the Workflow tool, deduplicates + gates findings, writes a report. Default scope = changed/affected .sol files; or pass explicit filenames.
---

# Smart Contract Security Audit (always fetch fresh)

You are the orchestrator of a parallelized Solidity security audit using the
[pashov solidity-auditor](https://github.com/pashov/skills/tree/main/solidity-auditor) methodology:
12 specialist attacker agents, a senior-auditor mental-tool protocol, four validation gates, and a
fixed report format. **No reference material is vendored** — fetch the latest upstream fresh into a
temp dir every run. They're just markdown files; always use the newest.

## Step 0 — fetch upstream refs into a temp dir

```sh
RAW=https://raw.githubusercontent.com/pashov/skills/main/solidity-auditor
REFDIR=$(mktemp -d ./.audit-ref-XXXXXX)         # fresh upstream snapshot for THIS run; cleaned at the end
mkdir -p "$REFDIR/hacking-agents"
for f in judging report-formatting senior-auditor-sop; do
  curl -fsS "$RAW/references/$f.md" -o "$REFDIR/$f.md"
done
for a in math-precision access-control economic-security execution-trace invariant periphery \
         first-principles asymmetry boundary numerical-gap trust-gap flow-gap; do
  curl -fsS "$RAW/references/hacking-agents/$a-agent.md" -o "$REFDIR/hacking-agents/$a-agent.md"
done
curl -fsS "$RAW/references/hacking-agents/shared-rules.md" -o "$REFDIR/hacking-agents/shared-rules.md"
curl -fsS "$RAW/SKILL.md" -o "$REFDIR/UPSTREAM_SKILL.md"   # authoritative orchestration
```

If a fetch fails (offline), tell the user the audit needs network for the upstream refs and stop — do
not improvise the agent prompts from memory. Skim `UPSTREAM_SKILL.md`: if the agent roster, gap-hunter
list, or report format changed since this wrapper was written, follow the **upstream** shape and note
the drift. Use `$REFDIR` wherever the steps below say `references/`. Clean `$REFDIR` at the end.

## Inputs

- **`$ARGUMENTS` = filenames** → audit exactly those `.sol` files.
- **No args** → audit the in-scope `.sol` files touched by the current branch diff
  (`git diff --name-only master...HEAD -- '*.sol'`), else ask the user which feature/dir to scope.
- **Exclude** `interfaces/`, `lib/`, `mocks/`, `test/`, `*.t.sol`, `*Test*.sol`, `*Mock*.sol` from the
  *in-scope set* — but agents MAY `Read` those (and dependency contracts) for cross-file context.

## Repo-specific context to give every agent

Every corridor here is a **direct two-chain hop**: source EVM → Wormhole → destination. There is no
Moonbeam and no XCM `Transact` leg anywhere — an older design had one, it is deleted, and agents must
not reason about it.

- **Hydration** is EVM-on-Substrate: Wormhole chain id 73, EVM chain id 222222, para id 2034. ERC20s
  are asset-id precompiles at `0x0100000000 | assetId`. The `DISPATCH` precompile (`0x…0401`) executes
  a SCALE-encoded runtime call **as the calling contract**, via a raw low-level `.call` that reports
  success for the local dispatch only. Recipients are `AccountId32` (bytes32), not addresses. Amounts
  are SCALE-encoded at `uint128` width (`ScaleCodec`, `HydrationRouter`) — watch truncation seams.
- **Wormhole**: `parseAndVerifyVM` checks guardian signatures and nothing else — the emitter check is
  the caller's job. Relaying is **permissionless**: anyone can submit any VAA to any receiver, in any
  order, at any delay. `vm.timestamp` is the source-block time. Consistency 200 = instant publish;
  **200 is deliberate across this repo** and reorg exposure is accepted risk, not a finding. The one
  exception is deliberate too: `BasejumpEmitter` takes its level per deployment (constructor
  immutable, 200 or 201), and the Base EURC emitter publishes at 201 (safe).
- **NTT v2 is the settlement rail.** The 3-arg `transfer` overload hardcodes `shouldQueue = false`, so
  a paused rail or rate-limit breach reverts instead of queueing. `NttManager._trimTransferAmount`
  **reverts** with `TransferAmountHasDust` rather than truncating, and trims to 8 decimals — so any
  amount not exactly representable at 8dp fails. The outbound rate limit is also what bounds
  worst-case pool drain.
- Dependency source worth Reading: `contracts/src/ntt/`, `contracts/src/utils/`,
  `contracts/src/utils/hydration/`, `contracts/src/*/interfaces/`, `contracts/test/`, and
  `contracts/dependencies/` for the pinned `wormhole-solidity-sdk` / OZ.

**Design decisions — do not report these as findings:** consistency level 200 (and 201 for the Base `BasejumpEmitter`); a permissionless
`OracleEmitter.send` (the caller triggers a read and cannot choose its result); permissionless
relaying generally; renouncing receiver ownership as the prod end-state.

## Procedure

**1 — Scope & banner.** Resolve the in-scope file list. Print a one-line scope summary.

**2 — Build bundles.** `mktemp -d ./.audit-XXXXXX` → `{bundle_dir}` (transient; cleaned at the end).
Write `{bundle_dir}/source.md` = every in-scope file under a `### path` header + fenced block. Then
build `agent-1..12-bundle.md` = `source.md` + `references/senior-auditor-sop.md` +
`references/hacking-agents/<specialty>-agent.md` + `references/hacking-agents/shared-rules.md`. Agent→specialty map:

| N | specialty | N | specialty |
|---|---|---|---|
| 1 | math-precision | 7 | first-principles |
| 2 | access-control | 8 | asymmetry |
| 3 | economic-security | 9 | boundary |
| 4 | execution-trace | 10 | numerical-gap *(gap-hunter)* |
| 5 | invariant | 11 | trust-gap *(gap-hunter)* |
| 6 | periphery | 12 | flow-gap *(gap-hunter)* |

**3 — Fan out via the `Workflow` tool** (this is the multi-agent opt-in; the skill invocation authorizes it).
One `parallel()` of 12 agents, each pointed at its bundle, returning a structured `{findings[], leads[]}`
object (schema: `contract, function, bug_class, group_key, path, proof, description, fix` for findings;
`…, code_smells, description` for leads). Agents 1–9 use the single-specialty prompt, 10–12 the
gap-hunter prompt (both in the upstream SKILL; the operative instruction is: *read your bundle fully,
follow the Feynman/Socratic/Inversion protocol, a FINDING needs concrete proof else emit a LEAD, do not
re-read in-scope files, Read only for cross-file/out-of-scope context*). A working script lives at
`audit-workflow.js` (skill root) — adapt `BUNDLE`, the file list, and the repo-context paragraph, then
`Workflow({script: ...})`. Pick agent `model` to match the orchestrator (Opus → `opus`, etc.) or ask.

**4 — Dedup, gate, report.** While agents run, Read the dependency contracts yourself so you can gate
cross-chain claims. On completion: dedup by `group_key` (NEVER merge across different `function:`),
preserve every distinct mechanism + distinct fix (Option A/B), then run each finding through the four
gates in `references/judging.md` (`UNCERTAIN = ALLOWS`; admin-only harm REJECTED unless an unprivileged
amplifier is named). Promote leads per the rules there. Format per `references/report-formatting.md`
(sort by confidence; below-threshold = description only). Cross-chain findings that depend on
NTT/Wormhole runtime behaviour belong in **Leads** unless verified against the dependency source
(fetch it from the commit pinned in `contracts/src/ntt/interfaces/INttManager.sol` — it is not vendored).

**5 — Output & clean.** Write the report to the path the user gave (this repo's convention:
`docs/<feature>/audit-<YYYY-MM-DD>.md`), else print inline. Then clean the temp dirs with `find <dir> -type f -delete` (`rm -rf` is blocked here).

## Notes

- `references/judging.md` "Do Not Report": linter/gas/naming/NatSpec, admin-by-design, missing events,
  centralization without an exploit path. But fee-on-transfer / rebasing / blacklist behaviours ARE in
  scope for any contract that accepts arbitrary tokens (e.g. `IntentRouter`).
- A documented feature that deterministically reverts is a legitimate availability finding — report it
  even though it is not fund-theft (it failed the prior run's "self-harm" reflex; don't drop it).
- See `docs/basejump/audit-2026-08-23.md` and `docs/oracle/audit-2026-08-23.md` for worked
  examples of this skill's output.
