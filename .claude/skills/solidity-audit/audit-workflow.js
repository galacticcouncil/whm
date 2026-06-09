// Reusable workflow script for the `solidity-audit` skill.
// Adapt: BUNDLE (the mktemp bundle dir), the repo-context paragraph, and—if you build fewer than 12
// bundles—the SPECIALTIES list. Then run via the Workflow tool: Workflow({script: <this>}).
// Bundles (agent-1..12-bundle.md + source.md) must already be written into BUNDLE by the skill's
// build-bundles step, each = source.md + senior-auditor-sop.md + <specialty>.md + shared-rules.md
// (the specialty/SOP/shared-rules come from the freshly-fetched $REFDIR — nothing is vendored).
export const meta = {
  name: 'solidity-audit',
  description: 'Pashov-style 12-agent parallel Solidity security audit (fresh upstream refs)',
  phases: [{ title: 'Scan', detail: '12 specialist attacker agents read their bundles in parallel' }],
}

const BUNDLE = '<ABSOLUTE_PATH_TO_BUNDLE_DIR>' // e.g. /Users/.../whm/.audit-abc123

const REPO_CONTEXT =
  'The system is a cross-chain bridge built on Wormhole + Moonbeam XCM. Dependency contracts you MAY Read ' +
  'for context live under contracts/src/utils/{hydration,moonbeam}, contracts/src/utils, and ' +
  'contracts/src/basejump. Highest-value seams: (a) asset-address convention — BasejumpLandingNative ' +
  'forwards the payload sourceAsset verbatim as the DEST-chain ERC20, so hardcoding a SOURCE-chain token ' +
  'address mismatches on the destination; (b) XCM Transact legs are fire-and-forget — the DISPATCH ' +
  'precompile confirms only the local call, a remote Moonbeam leg can fail and strand funds at the derived ' +
  'MDA; (c) amounts are SCALE-encoded as uint128 (HydrationRouter, XcmV4.fungible) — watch truncation.'

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings', 'leads'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['contract', 'function', 'bug_class', 'group_key', 'path', 'proof', 'description', 'fix'],
      properties: { contract: { type: 'string' }, function: { type: 'string' }, bug_class: { type: 'string' },
        group_key: { type: 'string' }, path: { type: 'string' }, proof: { type: 'string' },
        description: { type: 'string' }, fix: { type: 'string' } } } },
    leads: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['contract', 'function', 'bug_class', 'group_key', 'code_smells', 'description'],
      properties: { contract: { type: 'string' }, function: { type: 'string' }, bug_class: { type: 'string' },
        group_key: { type: 'string' }, code_smells: { type: 'string' }, description: { type: 'string' } } } },
  },
}

const SPECIALTIES = [
  { n: 1, kind: 'single', name: 'math-precision' }, { n: 2, kind: 'single', name: 'access-control' },
  { n: 3, kind: 'single', name: 'economic-security' }, { n: 4, kind: 'single', name: 'execution-trace' },
  { n: 5, kind: 'single', name: 'invariant' }, { n: 6, kind: 'single', name: 'periphery' },
  { n: 7, kind: 'single', name: 'first-principles' }, { n: 8, kind: 'single', name: 'asymmetry' },
  { n: 9, kind: 'single', name: 'boundary' }, { n: 10, kind: 'gap', name: 'numerical-gap' },
  { n: 11, kind: 'gap', name: 'trust-gap' }, { n: 12, kind: 'gap', name: 'flow-gap' },
]

const head = (n, what) =>
  `You are an attacker. Your ${what}, mindset, source, and output rules are in your bundle. Read it fully ` +
  `before producing findings.\n\nRead first:\n- ${BUNDLE}/agent-${n}-bundle.md — source + senior-auditor SOP ` +
  `+ specialty + shared rules.\n\nThe bundle contains all in-scope source. Do NOT re-read it for the initial ` +
  `scan; use Read/Grep ONLY for cross-file / out-of-scope context. ${REPO_CONTEXT}\n\nFollow the ` +
  `Feynman/Socratic/Inversion protocol while reasoning. A FINDING needs a concrete unguarded exploitable ` +
  `path WITH proof; otherwise emit a LEAD. Return ONLY the structured object (findings[] + leads[]). ` +
  `group_key = "Contract | function | bug-class".`

const results = await parallel(
  SPECIALTIES.map((s) => () =>
    agent(head(s.n, s.kind === 'single' ? 'specialty' : 'gap-hunter specialty (bugs at the SEAM of multiple lenses)'),
      { label: `agent-${s.n}:${s.name}`, phase: 'Scan', schema: SCHEMA })
      .then((r) => ({ ...s, ...(r || { findings: [], leads: [] }) }))
  )
)
return results
