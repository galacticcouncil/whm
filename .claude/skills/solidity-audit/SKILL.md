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
         first-principles asymmetry boundary numerical-gap trust-gap flow-gap shared-rules; do
  curl -fsS "$RAW/references/hacking-agents/$a.md" -o "$REFDIR/hacking-agents/$a.md"
done
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

These two cross-chain hops are the highest-value seams in this repo — always brief the agents:

- **Oracle / Basejump / Intents** all flow EVM ↔ Wormhole ↔ Moonbeam `BasejumpProxy` ↔ XCM ↔
  Hydration / Ethereum landing. Dependency contracts worth Reading live under
  `contracts/src/utils/{hydration,moonbeam}`, `contracts/src/utils/{DerivedAccount,XcmV4,ScaleCodec,Blake2b}.sol`,
  and `contracts/src/basejump/{BasejumpProxy,BasejumpCore,Basejump,BasejumpLanding,BasejumpLandingNative}.sol`.
- **Asset-address convention** (a real past finding): `BasejumpLandingNative` forwards the payload
  `sourceAsset` verbatim and treats it as the *destination-chain* ERC20; encoders that hardcode a
  *source-chain* token address (e.g. `MoonbeamConsts.WETH`) cause a delivery mismatch on the dest chain.
- **XCM legs are fire-and-forget**: the `DISPATCH` precompile only confirms the *local* call; a remote
  Moonbeam `Transact` can silently fail and strand funds at the derived MDA with no recovery path.
- Amounts are SCALE-encoded as `uint128` (`HydrationRouter`, `XcmV4.fungible`) — watch truncation seams.

## Procedure

**1 — Scope & banner.** Resolve the in-scope file list. Print a one-line scope summary.

**2 — Build bundles.** `mktemp -d ./.audit-XXXXXX` → `{bundle_dir}` (transient; cleaned at the end).
Write `{bundle_dir}/source.md` = every in-scope file under a `### path` header + fenced block. Then
build `agent-1..12-bundle.md` = `source.md` + `references/senior-auditor-sop.md` +
`references/hacking-agents/<specialty>.md` + `references/hacking-agents/shared-rules.md`. Agent→specialty map:

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
Basejump/XCM/Wormhole runtime behaviour belong in **Leads** unless verified against the dependency source.

**5 — Output & clean.** Write the report to the path the user gave (this repo's convention:
`docs/<feature>/audit-<YYYY-MM-DD>.md`), else print inline. Then `rm -rf {bundle_dir}`.

## Notes

- `references/judging.md` "Do Not Report": linter/gas/naming/NatSpec, admin-by-design, missing events,
  centralization without an exploit path. But fee-on-transfer / rebasing / blacklist behaviours ARE in
  scope for any contract that accepts arbitrary tokens (e.g. `IntentRouter`).
- A documented feature that deterministically reverts is a legitimate availability finding — report it
  even though it is not fund-theft (it failed the prior run's "self-harm" reflex; don't drop it).
- See `docs/nintent/audit-2026-06-09.md` for a worked example of this skill's output.
