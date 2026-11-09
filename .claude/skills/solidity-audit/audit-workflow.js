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

// Keep in sync with the "Repo-specific context" section of SKILL.md.
const REPO_CONTEXT =
  'Every corridor is a DIRECT two-chain hop: source EVM -> Wormhole -> destination. There is no Moonbeam ' +
  'and no XCM Transact leg anywhere — an older design had one, it is deleted; do not reason about it. ' +
  'Hydration is EVM-on-Substrate: Wormhole chain id 73, EVM chain id 222222, para id 2034; ERC20s are ' +
  'asset-id precompiles at 0x0100000000 | assetId; the DISPATCH precompile (0x…0401) runs a SCALE-encoded ' +
  'runtime call AS THE CALLING CONTRACT via a raw .call that reports success for the LOCAL dispatch only; ' +
  'recipients are AccountId32 (bytes32); amounts are SCALE-encoded at uint128 width — watch truncation. ' +
  'Wormhole: parseAndVerifyVM checks guardian signatures ONLY, so the caller must check the emitter; ' +
  'relaying is permissionless (any address, any order, any delay); vm.timestamp is the source-block time. ' +
  'NTT v2 is the settlement rail: the 3-arg transfer overload hardcodes shouldQueue=false so a paused rail ' +
  'or rate-limit breach reverts, and _trimTransferAmount REVERTS with TransferAmountHasDust rather than ' +
  'truncating, trimming to 8 decimals. Dependency source you MAY Read: contracts/src/ntt/, ' +
  'contracts/src/utils/, contracts/src/*/interfaces/, contracts/test/, contracts/dependencies/. ' +
  'DESIGN DECISIONS — do NOT report these as findings: consistency level 200 (instant publish is ' +
  'deliberate and reorg exposure is accepted risk, bounded by the NTT outbound rate limit), and 201 ' +
  '(safe) for the Base BasejumpEmitter, whose level is a per-deployment constructor immutable; a ' +
  'permissionless OracleEmitter.send (the caller triggers a read and cannot choose its result); ' +
  'permissionless relaying generally; renouncing receiver ownership as the prod end-state.'

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
