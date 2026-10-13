// Reusable workflow script for the `near-audit` skill.
// Adapt BUNDLE (the mktemp bundle dir). Bundles must already exist — the skill's build-bundles step
// writes agent-0..7-bundle.md, source.md and context.md from the freshly fetched references.
// Then run via the Workflow tool: Workflow({script: <this>}).
export const meta = {
  name: 'near-audit',
  description: 'NEAR Rust contract audit: prior-findings extraction, 6 specialist reviewers, 1 verifier',
  phases: [
    { title: 'Scan', detail: 'prior-findings extractor + 6 specialist reviewers read their bundles' },
    { title: 'Verify', detail: 'fp-check every candidate finding' },
  ],
}

const BUNDLE = '<ABSOLUTE_PATH_TO_BUNDLE_DIR>' // e.g. /Users/.../whm/.near-audit-abc123

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings', 'leads'],
  properties: {
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['file', 'function', 'bug_class', 'group_key', 'path', 'proof', 'description', 'fix'],
      properties: { file: { type: 'string' }, function: { type: 'string' }, bug_class: { type: 'string' },
        group_key: { type: 'string' }, path: { type: 'string' }, proof: { type: 'string' },
        description: { type: 'string' }, fix: { type: 'string' } } } },
    leads: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['file', 'function', 'bug_class', 'group_key', 'code_smells', 'description'],
      properties: { file: { type: 'string' }, function: { type: 'string' }, bug_class: { type: 'string' },
        group_key: { type: 'string' }, code_smells: { type: 'string' }, description: { type: 'string' } } } },
  },
}

const PRIOR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rows'],
  properties: { rows: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['source', 'finding', 'bug_class', 'root_cause', 'applies', 'where_to_check'],
    properties: { source: { type: 'string' }, finding: { type: 'string' }, bug_class: { type: 'string' },
      root_cause: { type: 'string' }, applies: { type: 'string', enum: ['yes', 'maybe', 'no'] },
      where_to_check: { type: 'string' } } } } },
}

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false,
    required: ['group_key', 'verdict', 'evidence', 'severity'],
    properties: { group_key: { type: 'string' }, verdict: { type: 'string', enum: ['TRUE_POSITIVE', 'FALSE_POSITIVE', 'LEAD'] },
      evidence: { type: 'string' }, severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] } } } } },
}

const REVIEWERS = [
  { n: 1, name: 'async-receipt-gaps' },
  { n: 2, name: 'cross-chain-integrity' },
  { n: 3, name: 'value-accounting' },
  { n: 4, name: 'storage-deposit-economics' },
  { n: 5, name: 'access-control-and-near-detectors' },
]

const reviewer = (n, extra = '') =>
  `You are an attacker auditing a NEAR smart contract written in Rust. Your role, lenses, references, ` +
  `the in-scope source, the NEAR platform primer and the repo context are all in your bundle. Read it ` +
  `fully first.\n\nRead first:\n- ${BUNDLE}/agent-${n}-bundle.md\n\n` +
  `The primer REPLACES any EVM assumption in the lens examples: nothing is atomic across receipts, a ` +
  `callback's failure does not unwind earlier receipts, and a token resolves refunds on the promise it is ` +
  `returned. Do NOT re-read in-scope files for the initial pass; Read/Grep only for cross-file or ` +
  `reference context (Wormhole NEAR core, EVM NTT, sandbox tests). ${extra}\n\nFollow the ` +
  `Feynman/Socratic/Inversion protocol. A FINDING needs a concrete, unguarded, exploitable path WITH proof ` +
  `(receipt-by-receipt for async issues); otherwise emit a LEAD. Do not report the design decisions or the ` +
  `three known, fixed bugs listed in the context. group_key = "file | function | bug-class". Return ONLY ` +
  `the structured object.`

// Phase 1: prior-findings extraction in parallel with reviewers 1–5.
const [prior, ...early] = await parallel([
  () => agent(
    `You extract prior audit findings into a regression checklist for a NEAR NTT port. Read ` +
    `${BUNDLE}/agent-0-bundle.md for the PDF paths, the port's design and the output format. Read every ` +
    `listed PDF's findings sections (use the pages parameter; large PDFs in chunks). One row per finding: ` +
    `source (report + finding id), the finding, bug_class, root_cause, whether it applies to the NEAR ` +
    `contract (yes / maybe / no — judge the root cause, not the language), and where_to_check (file / ` +
    `function in the NEAR contract). Then write the same rows as a markdown table to ` +
    `${BUNDLE}/prior-findings.md. Return ONLY the structured object.`,
    { label: 'agent-0:prior-findings', phase: 'Scan', schema: PRIOR_SCHEMA }),
  ...REVIEWERS.map((r) => () =>
    agent(reviewer(r.n), { label: `agent-${r.n}:${r.name}`, phase: 'Scan', schema: FINDINGS_SCHEMA })
      .then((x) => ({ ...r, ...(x || { findings: [], leads: [] }) }))),
])

// Reviewer 6 needs the prior-findings checklist.
const regression = await agent(
  reviewer(6, `Also read ${BUNDLE}/prior-findings.md: check EVERY row marked yes or maybe against the ` +
    `contract and report each that holds as a finding (cite the source row), in addition to your own ` +
    `gas / DoS / boundary hunt.`),
  { label: 'agent-6:gas-dos-boundaries+regression', phase: 'Scan', schema: FINDINGS_SCHEMA })

const reviews = [...early, { n: 6, name: 'gas-dos-boundaries+regression', ...(regression || { findings: [], leads: [] }) }]
const candidates = reviews.flatMap((r) => (r.findings || []).map((f) => ({ ...f, from: r.name })))

// Phase 2: one batched verifier over every candidate finding.
const verdicts = candidates.length === 0 ? { verdicts: [] } : await agent(
  `You verify suspected vulnerabilities in a NEAR Rust contract. Read ${BUNDLE}/agent-7-bundle.md ` +
  `(fp-check method, judging gates, NEAR primer, repo context) and the in-scope source it points to. For ` +
  `EACH candidate below, try to disprove it: trace it receipt by receipt against the actual code (and the ` +
  `Wormhole NEAR core / EVM NTT source where it depends on them). Verdict TRUE_POSITIVE only with ` +
  `concrete evidence; FALSE_POSITIVE with the reason; LEAD if plausible but unproven. Assign severity.\n\n` +
  `Candidates:\n${JSON.stringify(candidates, null, 2)}\n\nReturn ONLY the structured object.`,
  { label: 'agent-7:verifier', phase: 'Verify', schema: VERDICT_SCHEMA })

return { prior, reviews, verdicts }
