# NEAR NTT — Progress

Implementation log for [spec.md](spec.md), one entry per stage. Branch: `feat/near-ntt`.

| Stage | Scope                                                        | Status      |
| ----- | ------------------------------------------------------------ | ----------- |
| 1     | Spec, pre-implementation checks, crate scaffold, codec       | done        |
| 2     | Outbound — `ft_on_transfer` → `publish_message` → callback   | done        |
| 3     | Inbound — `complete` → `verify_vaa` → unlock                 | —           |
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

## Stage 2 — outbound

**Design change: publishing is detached from `ft_on_transfer`.** The spec first had
`ft_on_transfer` return `publish_message.then(on_published)`, refunding a failed publish through the
unused amount. That is a double spend: if the publish succeeds and `on_published` then fails, the
token's `ft_resolve_transfer` refunds the full amount while the guardians sign the message and
Hydration mints. Now `ft_on_transfer` locks and returns the dust immediately, and publishing is a
separate promise whose callback refunds through `ft_transfer`. Spec updated (Outbound, invariants 1
and 3).

| Module        | Added                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `outbound.rs` | `ft_on_transfer`, `on_published`, `release_outbound` / `on_released`, `cancel_outbound`, `get_queued_outbound`; payload encoding |
| `payout.rs`   | `pay_out` (`ft_transfer` → `on_paid`, claimable on failure), `claim`                    |
| `rate_limit.rs` | `debit` — undoes a backflow when a publish fails                                      |
| `lib.rs`      | `outbound_queue`, `peer` / `inbound_limit` helpers, NEP-297 `emit` (`whm-ntt`)          |

- Every rejection in `ft_on_transfer` panics, so the token refunds the whole amount: wrong token,
  paused, bad `msg`, unknown peer, zero after trim, over the limit without `should_queue`, not enough
  gas for publish + callback + refund.
- Queued transfers get their `id` when locked; release after 24 h is permissionless, a failed
  release re-queues, cancel is sender-only with 1 yocto.
- Events: `transfer_sent` (with `wormhole_sequence`), `transfer_queued`, `transfer_failed`,
  `release_failed`, `transfer_cancelled`, `payout_failed`.
- Gas reserved: publish 20 TGas, `on_published` 10 + 20 for the refund, pay-out 10 + 10.

**Tests** — 37 passing (15 new): lock + dust (ZEC exact, NEAR 24 → 8 returns 1 yocto), every refund
path, queue delay and release, failed release re-queues, cancel auth, publish success keeps the
limit consumed, publish failure restores it and refunds, and the encoded payload parsed back layer by
layer with the manager, sender, token and recipient hashes checked. Release wasm 425 KB before
`wasm-opt`.

Not yet exercised: real promise execution — the unit tests call callbacks directly. Stage 4 runs the
chain against the real core wasm.
