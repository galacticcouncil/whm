---
name: near-audit
description: Parallelized security audit of NEAR smart contracts in Rust — built for the NEAR NTT harness (crates/near/contracts/ntt-manager), reusable for any NEAR contract here. Pashov's attacker lenses and gates, NEAR's near-contract-audit checklist, Trail of Bits' spec-to-code / variant / dimensional / fp-check skills, prior NTT and Wormhole-NEAR audit findings — all fetched fresh — plus a NEAR platform primer that replaces the EVM mental model. Trigger on "audit the NEAR contract", "near audit", or `/near-audit [paths]`. Spawns 8 agents via the Workflow tool, deduplicates + gates findings, writes a report.
---

# NEAR Contract Security Audit (always fetch fresh)

`/solidity-audit`'s method, rebuilt for NEAR Rust. **Do not point `/solidity-audit` at `.rs` files**: its
lenses are sound but its examples and shared rules assume the EVM — one atomic transaction, synchronous
reentrancy, ERC-20 quirks — and on NEAR the dominant bug class is the opposite: **nothing is atomic across
receipts.** This skill keeps the lenses and swaps the platform model (see [NEAR primer](#near-primer)).

Reference material is **not vendored** — it is fetched fresh into a temp dir every run.

## Step 0 — fetch references into a temp dir

```sh
REFDIR=$(mktemp -d ./.near-audit-ref-XXXXXX)
mkdir -p "$REFDIR"/{pashov,near,tob,ntt}

# pashov solidity-auditor — lenses, SOP, gates, report format (platform-neutral reasoning)
P=https://raw.githubusercontent.com/pashov/skills/main/solidity-auditor
for f in judging report-formatting senior-auditor-sop; do curl -fsS "$P/references/$f.md" -o "$REFDIR/pashov/$f.md"; done
for a in math-precision access-control economic-security execution-trace invariant periphery \
         first-principles asymmetry boundary numerical-gap trust-gap flow-gap shared-rules; do
  n=$a; [ "$a" = shared-rules ] || n="$a-agent"
  curl -fsS "$P/references/hacking-agents/$n.md" -o "$REFDIR/pashov/$a.md"
done

# NEAR — official agent skills
N=https://raw.githubusercontent.com/near/agent-skills/HEAD/skills
curl -fsS "$N/near-contract-audit/SKILL.md" -o "$REFDIR/near/near-contract-audit.md"
for s in high medium low; do curl -fsS "$N/near-contract-audit/references/$s-severity.md" -o "$REFDIR/near/$s-severity.md"; done
for r in xcc-promise-chaining security-storage-checks upgrade-migration state-collections; do
  curl -fsS "$N/near-smart-contracts/rules/$r.md" -o "$REFDIR/near/$r.md"
done

# Trail of Bits skills
T=https://raw.githubusercontent.com/trailofbits/skills/HEAD/plugins
for s in spec-to-code-compliance variant-analysis dimensional-analysis fp-check \
         audit-context-building entry-point-analyzer rust-review; do
  curl -fsS "$T/$s/skills/$s/SKILL.md" -o "$REFDIR/tob/$s.md"
done

# Wormhole NTT docs (LLM-oriented pages from wormhole.com/docs/llms.txt) — the behaviour to match
W=https://wormhole.com/docs/ai/pages/products-token-transfers-native-token-transfers
for p in concepts-architecture concepts-transfer-flow concepts-security configuration-access-control \
         configuration-rate-limiting; do
  curl -fsS "$W-$p.md" -o "$REFDIR/ntt/$p.md"
done
```

If any fetch fails, retry once (this network drops briefly), then tell the user which reference is
missing and stop — do not improvise lens prompts or checklists from memory. Skim each fetched `SKILL.md`
for drift against the roles below.

**Prior audits (local, not fetched)** — the Wormhole-specific knowledge. No Wormhole or NTT audit
skill exists anywhere; these reports are the substitute. Default locations, override via args:

| Set | Default path | Files |
| --- | --- | --- |
| NTT EVM | `../../gc/hydration-ntt/audits/evm/` | Cyfrin 2024-04, Cantina 2024-04, Cyfrin v1.1.0 diff |
| NTT Solana | `../../gc/hydration-ntt/audits/solana/` | OtterSec 2024-03, Neodyme 2024-04, OtterSec token-ext, OtterSec NTT v3 (2025-04, 2025-05) |
| Wormhole NEAR core | `../wormhole/audits/near/` | OtterSec 2022-09, Hacken 2022-10 |

(relative to the repo root). If a set is missing, ask for its path; the audit can run without it, but
say so in the report.

## Inputs

- **Args = paths** → audit exactly those `.rs` files or directories.
- **No args** → `crates/near/contracts/ntt-manager/src/*.rs`.
- Exclude `#[cfg(test)]` modules from findings (agents may read them — they document intended
  behaviour), and `crates/near/sandbox/`.

## NEAR primer

Give this to **every** agent. It replaces the EVM assumptions baked into pashov's lens examples.

- **Receipts, not transactions.** A cross-contract call is a new receipt in a later block. There is no
  atomicity across receipts and **no rollback**: a panic reverts only its own receipt. Any state written
  before a `Promise` is already committed when the callback runs — or fails.
- **Callbacks.** `.then(Self::ext(..).cb())` runs whether the previous receipt succeeded or failed; the
  callback reads `#[callback_result]` / `is_promise_success()`. A callback must be `#[private]`. If a
  callback **returns a promise**, whoever waits on it (a `.then` after it, or a token's resolver) reads
  the *returned chain's* outcome, not the callback's.
- **NEP-141 `ft_transfer_call`** → receiver's `ft_on_transfer` returns *unused amount*; the token's
  `ft_resolve_transfer` refunds that amount — and refunds **everything** if `ft_on_transfer`'s returned
  value/promise **failed**. A panic in `ft_on_transfer` = full refund.
- **NEP-145 storage.** An account must be registered (`storage_deposit`) to hold a token; registration
  deposits are paid in NEAR by whoever calls. A contract pays for its own state out of its own balance
  (storage staking); running out of balance fails every state-writing call.
- **Deposits.** `attached_deposit` lands in the contract when the receipt starts; if the receipt fails
  it is refunded to the predecessor, *not* the original caller two hops back. A deposit forwarded to a
  callback and then refunded goes back to the contract.
- **Gas.** Static gas is reserved per promise up front; unused prepaid gas is refunded minus a penalty.
  300 TGas per transaction. A callback that runs out of gas fails like any panic.
- **Upgrades are access keys.** Any full-access key on the contract account can redeploy it. There is no
  proxy; "immutable" means no full-access keys.
- **Views.** `&self` methods can be called as free views unless they touch prohibited host functions.

## Repo context (NEAR NTT)

Give this to every agent. Full design: `docs/near-ntt/spec.md`; checks: `docs/near-ntt/verify.md`;
history, including both bugs already found and fixed: `docs/near-ntt/progress.md`.

- `ntt-manager` is an NTT **manager and Wormhole transceiver in one contract**, LOCKING, one deployment
  per token (`zec.omft.near`, `wrap.near`). Peer: a stock EVM NTT v2 NttManager (BURNING) + WormholeTransceiver
  on Hydration (Wormhole chain 73). Wire format is byte-for-byte EVM `TransceiverStructs`.
- NEAR addresses on the wire are `sha256(account_id)`; the Wormhole core on NEAR
  (`contract.wormhole_crypto.near`) sets the emitter to `sha256(predecessor)`. `verify_vaa` checks
  signatures and the guardian set only — the contract parses and checks everything else itself.
- **Outbound:** `ft_on_transfer` locks and returns the dust **immediately**; publishing is a **detached**
  promise whose callback refunds on failure (via `pay_out`, claimable on failure).
- **Inbound:** `complete(vaa, account_id)` → joint `verify_vaa` + `storage_balance_of` → `on_verified`
  (consumes the digest, pays out detached, refunds excess deposit) → `on_complete_settled` (refunds the
  whole deposit iff `on_verified` failed).
- Reference sources agents MAY Read: the Wormhole NEAR core and token bridge
  (`../wormhole/near/contracts/`), EVM NTT (`../../gc/hydration-ntt/evm/src/`), the sandbox suite
  (`crates/near/sandbox/tests/sandbox.rs`).

**Known bugs, already fixed — seeds for variant analysis, do not re-report them:**

1. *Returned promise → token refund.* `ft_on_transfer` once returned `publish.then(on_published)`; a
   failed callback after a successful publish made the token refund in full → double spend. Root cause:
   **a value the token resolves on was a promise chain whose tail could fail after an irreversible step.**
2. *Refunder reads a downstream chain.* `on_verified` once returned its pay-out promise, so
   `on_complete_settled` read the pay-out's outcome and refunded the deposit a second time. Root cause:
   **a success/failure check reading the outcome of a chain it was not meant to judge.**
3. *Contract-paid storage via a deposit-less path* (outbound queue): anyone could drain the contract's
   NEAR. Fixed by removing the queue. Root cause: **state growth on a path with no attached deposit.**

**Design decisions — do not report as findings:** manager + transceiver in one contract; no outbound
queue (over-limit reverts); users self-redeem inbound (no NEAR relayer); LOCKING only; one-step
`transfer_ownership`; `registration_deposit` and `core` fixed at init; a failed recipient
`storage_deposit` leaving its 0.00125 NEAR in the contract (documented residual); single owner, no
separate pauser.

## Agents (8)

| # | Role | Lenses / refs in its bundle |
| --- | --- | --- |
| 0 | **Prior-findings extractor** | the local audit PDFs → `prior-findings.md`: one row per finding — source, class, root cause, *applies to ntt-manager? where to check* |
| 1 | **Async & receipt gaps** | pashov flow-gap, execution-trace, periphery · near `xcc-promise-chaining` · ToB `variant-analysis`, seeded with the 3 known bugs |
| 2 | **Cross-chain message integrity** | pashov trust-gap, first-principles · ToB `spec-to-code-compliance` against `docs/near-ntt/spec.md` · NTT architecture / transfer-flow / security docs |
| 3 | **Value accounting** | pashov invariant, math-precision, numerical-gap · ToB `dimensional-analysis` (24 / 18 / 8 / 6 dp, yocto, TGas) · NTT rate-limiting doc |
| 4 | **Storage & deposit economics** | pashov economic-security, asymmetry · near `security-storage-checks`, `state-collections`, `low-severity` |
| 5 | **Access control, init, upgrade + NEAR detectors** | pashov access-control · near `near-contract-audit` + `high` / `medium` severity, `upgrade-migration` · ToB `entry-point-analyzer`, `audit-context-building` · NTT access-control doc |
| 6 | **Gas, DoS, boundaries + prior-findings regression** | pashov boundary · ToB `rust-review` (panic-DoS) · `prior-findings.md` from agent 0, every applicable row checked |
| 7 | **Verifier** | ToB `fp-check` · pashov `judging` — every candidate finding: TRUE / FALSE POSITIVE with evidence |

Agents 0–5 run in parallel; 6 waits for 0; 7 runs on everything 1–6 returned. Every reviewer gets the
senior-auditor SOP and shared rules, the NEAR primer, and the repo context.

## Procedure

**1 — Scope.** Resolve the file list; print a one-line summary (files, lines).

**2 — Build bundles.** `mktemp -d ./.near-audit-XXXXXX` → `{bundle}`. Write:

- `{bundle}/source.md` — every in-scope file under `### path` + a fenced block.
- `{bundle}/context.md` — the NEAR primer + repo context sections of this skill, verbatim.
- `{bundle}/agent-N-bundle.md` for N = 1..6 — `source.md` + `context.md` + `pashov/senior-auditor-sop.md`
  + `pashov/shared-rules.md` + that agent's refs from the table above.
- `{bundle}/agent-0-bundle.md` — the PDF paths, the output format, and `context.md` (so it can judge
  applicability). Agent 0 writes `{bundle}/prior-findings.md` itself.
- `{bundle}/agent-7-bundle.md` — `tob/fp-check.md` + `pashov/judging.md` + `context.md`; the candidate
  findings are passed in its prompt.

**3 — Fan out via the `Workflow` tool** (this skill's invocation is the multi-agent opt-in). Adapt and
run [`audit-workflow.js`](audit-workflow.js): set `BUNDLE`; keep the schema. Each reviewer returns
`{findings[], leads[]}` — a FINDING needs a concrete path with proof, else it is a LEAD. Pick the
agent `model` to match the orchestrator, or ask.

**4 — Dedup, gate, report.** Dedup by `group_key` (never across different functions). Keep only what
the verifier marks TRUE POSITIVE, plus leads worth a human look. Cross-chain claims that depend on EVM
NTT or the Wormhole NEAR core must be checked against their source before they are findings. Format per
`pashov/report-formatting.md`; add a **Prior findings** section: every applicable row from
`prior-findings.md` with its verdict (holds / not applicable / finding #n).

**5 — Output & clean.** Write the report to `docs/near-ntt/audit-<YYYY-MM-DD>.md` (the path the user
gives takes precedence). `*audit*.md` is gitignored in this repo — existing audits are force-added; tell
the user, don't `git add -f` yourself. Clean both temp dirs with `find <dir> -type f -delete` and
`find <dir> -type d -empty -delete` (`rm -rf` is blocked here).

## Notes

- A deterministically failing documented feature is an availability finding — report it.
- "Admin can …" is not a finding unless an unprivileged path reaches it; key custody is a lead.
- The previous two real bugs were **refund semantics across receipts**, not arithmetic. Weight agent 1
  accordingly; if budget is tight, run agents 0, 1, 2, 6, 7 first.
