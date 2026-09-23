# NEAR NTT — Progress

Implementation log for [spec.md](spec.md), one entry per stage. Branch: `feat/near-ntt`.

| Stage | Scope                                                        | Status      |
| ----- | ------------------------------------------------------------ | ----------- |
| 1     | Spec, pre-implementation checks, crate scaffold, codec       | done        |
| 2     | Outbound — `ft_on_transfer` → `publish_message` → callback   | in progress |
| 3     | Inbound — `complete` → `verify_vaa` → unlock, claimable      | —           |
| 4     | `near-workspaces` tests against the real Wormhole NEAR core  | —           |
| 5     | Migration (`near-ntt`), NEAR wallet in `@whm/common`, relayer route | —    |
| 6     | Mainnet canary under launch caps                             | —           |

## Stage 1 — spec, checks, scaffold

**Docs**

- [../near/](../near/) — the Omni → Solana → NTT corridor, kept as the fallback.
- [spec.md](spec.md) — NEAR as a LOCKING hub, Hydration BURNING; manager + transceiver in one
  contract per token; `sha256(account_id)` addressing with no registry; fail-closed outbound;
  claimable fallback inbound; single-hub rule against the fallback.
- [verify.md](verify.md) — mainnet and source checks: `message_fee` 0, Governor does not apply,
  0.00125 NEAR token registration, NEAR core on guardian set 7. Open: a live non-Portal NEAR emitter,
  gas profile.

**Crate** — [`crates/near`](../../crates/near/) (`@whm/crates-near`, in `pnpm-workspace.yaml`),
contract `ntt-manager`, `near-sdk` 5.29:

| Module          | State                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `messages.rs`   | `TransceiverMessage` / `NttManagerMessage` / `NativeTokenTransfer` codec, digest, sequence id |
| `trimmed.rs`    | `TrimmedAmount` trim / untrim with dust, per `TrimmedAmount.sol`             |
| `vaa.rs`        | VAA body parser                                                              |
| `rate_limit.rs` | 24 h linear-refill limiter, per `RateLimiter.sol`                            |
| `lib.rs`        | state, `new`, admin (`set_peer`, limits, pause, ownership), views; transfer entrypoints stubbed |

**Tests** — `cargo test -p ntt-manager`: 22 passing. The codec round-trips two real mainnet VAAs
encoded by the deployed EVM `NttManager`s (Ethereum → Hydration USDC, Hydration → Solana PRIME)
byte-for-byte, and checks their fields against the known manager and token addresses. Release wasm
builds (275 KB before `wasm-opt`).
