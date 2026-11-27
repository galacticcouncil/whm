/**
 * A refusal no resend changes: the contract declined to sign (`BelowMinimum`, `CoinDoesNotFit`,
 * `UnknownCoin`…), or the relayed delegate's receipts failed — its nonce is then spent, and the same
 * delegate cannot land. Anything else — a timeout, an RPC error — never reached a decision.
 */
export class Refused extends Error {}
