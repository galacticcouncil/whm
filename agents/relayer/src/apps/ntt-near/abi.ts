/**
 * Every UTXO emitter logs `WithdrawRequested(uint64 indexed sequence, bytes32 indexed nearAccount,
 * …)` beside each settlement — the address type after them differs per coin, so only the two
 * indexed topics are read. `sequence` is the NTT manager's, the key the two share; `nearAccount` is
 * the derived account's key, whose lowercase hex is its account id.
 */
export const SEQUENCE_TOPIC = 1;
export const NEAR_ACCOUNT_TOPIC = 2;
