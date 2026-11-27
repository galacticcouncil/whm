/**
 * A refusal that will not change on a resend: the router declined to sign, the verifier failed the
 * payload's receipts, or 1Click rejected it. Anything else — a timeout, an RPC or HTTP 5xx — never
 * reached a decision.
 */
export class Refused extends Error {}
