# NEAR NTT — Progress

Implementation log for [spec.md](spec.md), one entry per stage. Branch: `feat/near-ntt`.

| Stage | Scope                                                        | Status      |
| ----- | ------------------------------------------------------------ | ----------- |
| 1     | Spec, pre-implementation checks, crate scaffold, codec       | done        |
| 2     | Outbound — `ft_on_transfer` → `publish_message` → callback   | done        |
| 3     | Inbound — `complete` → `verify_vaa` → unlock                 | done        |
| 4     | `near-workspaces` tests against the real Wormhole NEAR core  | done        |
| 4b    | Drop the outbound queue — over-limit reverts                 | done        |
| 5     | Migration (`near-ntt-*`, NEAR side), `@whm/common/near`, scripts | done      |
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

## Stage 3 — inbound

`complete(vaa, account_id)` → joint `verify_vaa` + `storage_balance_of` → `on_verified` →
`on_complete_settled`.

| Module        | Added                                                                                   |
| ------------- | --------------------------------------------------------------------------------------- |
| `inbound.rs`  | `complete`, `on_verified`, `on_complete_settled`, `release_inbound`, `get_queued_inbound`; `inbound_of` — parse + check against config |
| `payout.rs`   | `pay_out(.., register)` — optional `storage_deposit(registration_only)` before `ft_transfer`; `storage_deposit` / `storage_balance_of` on the token interface |
| `outbound.rs` | `verify_vaa` on the core interface                                                      |
| `lib.rs`      | `inbound_queue`; `registration_deposit` as an init parameter (`storage_balance_bounds().min`) |

- **Checks, twice.** The same `inbound_of` runs in `complete` on unverified bytes (fail fast; a
  panic returns the deposit) and in `on_verified` on the verified ones: peer for the emitter chain,
  emitter = peer transceiver, source manager = peer manager, recipient manager = `sha256(self)`,
  `toChain` 15, `sha256(account_id) == to`, amount non-zero. Replay by NTT digest, checked in both.
- **Deposit.** `complete` requires `registration_deposit + 0.005 NEAR`; `on_verified` measures the
  real storage cost, adds the registration if the recipient is unregistered, refunds the rest. The
  refunder (`on_complete_settled`, the token bridge's pattern) returns everything if `on_verified`
  failed — VAA unconsumed, retryable.
- **Over the limit** → `inbound_queue` for 24 h, recipient registered now; `release_inbound` pays out.
- Events: `transfer_received`, `transfer_queued_inbound`.
- Gas: `verify_vaa` 30 TGas (as the token bridge), storage view 5, `on_verified` 15 + 30 for a
  registering pay-out, refunder 5 — `complete` requires 85 TGas free.

**Bug found and fixed while testing:** `on_verified` first *returned* its pay-out promise, so the
refunder read the outcome of the whole pay-out chain. A failed registration downstream of a consumed
VAA looked like a failed `on_verified`, and the deposit was refunded a second time — a repeatable
drain of the contract's NEAR. `on_verified` now returns nothing and detaches its promises. Spec
updated (Inbound).

**Residual:** a failed `storage_deposit` sends its 0.00125 NEAR back to the contract, not to the
caller; the transfer lands in `claimable`.

**Tests** — 55 passing (18 new): the pre-check rejects each forged field (emitter, chain, source
manager, recipient manager, target chain, recipient, deposit); a failed verification consumes
nothing; a verified VAA consumes the digest and the limit and backflows outbound; replay refused
before and after verification; a new message id is a new transfer; over-limit queues and releases
at 24 h, not before; NEAR untrims 8 → 24; an unregistered recipient needs the registration in the
deposit. Test VAAs are built with the codec and carry no signatures — only the core would reject
them. Release wasm 491 KB before `wasm-opt`.

## Stage 4 — sandbox and EVM compatibility

New crate [`crates/near/sandbox`](../../crates/near/sandbox/) (`ntt-sandbox`, tests only) — kept
apart so `near-workspaces` stays out of the contract's unit tests. It runs against the **deployed
mainnet code** of `contract.wormhole_crypto.near` and `wrap.near` (fetched with `view_code`, hashes
in its README), with the core booted on a single test guardian.

| Test                                   | Proves                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `outbound_locks_and_publishes`         | real lock + publish; core event emitter = `sha256(ntt)`; payload decodes; 1 yocto dust refunded |
| `failed_publish_refunds_the_sender`    | unregistered emitter → sender refunded, limit restored, `transfer_failed`         |
| `inbound_verifies_registers_and_pays`  | real `verify_vaa`; unregistered recipient registered and paid; replay refused; deposit accounting |
| `forged_signature_consumes_nothing`    | wrong guardian → nothing executed, deposit refunded                               |
| `failed_unlock_is_claimable`           | empty custody → `claimable`; `claim` pays once custody exists                     |

Gas: 6–19 TGas burnt per flow — [verify.md §6](verify.md#6-gas-profile--619-tgas-burnt-far-under-300).

**EVM direction.** The payload the NEAR contract published through the real core, parsed and
re-encoded by the real `TransceiverStructs` (`hydration-ntt` at `f4871dbe`) — identical bytes at all
three layers. Kept as `sandbox/forge/NearPayload.t.sol` (runs from a copy of `hydration-ntt/evm`),
plus an in-repo regression through `NttPayload`: `contracts/test/ntt/NearPayloadTest.sol`.

**Notes**

- The plain `cargo build --target wasm32-unknown-unknown` output deploys on the sandbox's nearcore
  (2.13.4) — `cargo-near` is not needed for tests; `NTT_WASM` passes the prebuilt file. Mainnet
  deploys should still go through `cargo near build` for a reproducible, `wasm-opt`'d artifact.
- The sandbox binary has no darwin-x86_64 build; on Apple Silicon under a Rosetta toolchain, run on
  `stable-aarch64-apple-darwin` (README).
- NEAR charges a penalty on unused prepaid gas, so deposit-accounting assertions measure against
  burnt gas plus that penalty, after the refund receipts land.

**Tests** — 55 unit (`pnpm test`), 5 sandbox (`pnpm test:sandbox`), 1 forge in `contracts`.

## Stage 4b — no outbound queue

NEAR → Hydration over the outbound limit now **reverts**: `ft_on_transfer` panics
`TransferExceedsRateLimit` and the token refunds the whole amount. `should_queue` is gone from
`msg`.

**Why.** Found in review after stage 4: a queued outbound entry (~200 bytes) is storage the contract
pays for from its own NEAR, because `ft_on_transfer` cannot take a deposit. With capacity exhausted,
anyone could queue 1e-8 ZEC transfers and drain that balance — and a contract out of NEAR for
storage fails every state-writing call. Dropping the queue removes the vector and the code. The
inbound queue stays: `complete`'s deposit pays for its entries.

Removed: `outbound_queue`, `release_outbound` / `on_released`, `cancel_outbound`,
`get_queued_outbound`, `OutboundTransfer.locked_at`, events `transfer_queued` / `release_failed` /
`transfer_cancelled`.

**Tests** — 51 unit (the 4 queue tests removed); sandbox 6 — new `over_the_limit_reverts_and_refunds`:
limit lowered to 1 wNEAR, 2 sent, sender refunded in full, nothing locked, no publish, capacity
untouched (6 TGas).

## Pre-stage 5 — emitter check settled

[verify.md §3](verify.md#3-guardians-sign-a-non-portal-emitter--yes) marked settled: the NEAR
watcher is emitter-agnostic in source, and the latest Portal VAA from NEAR carries 17 signatures
from guardian set 7 — quorum (13) observes NEAR. Kept
[`crates/near/scripts/check-emitter.sh`](../../crates/near/scripts/check-emitter.sh) as an optional
live check (plain account, register + publish + poll Wormholescan); its decoder was exercised
against that Portal VAA.

## Stage 5 — migration, common, scripts

**Scope decisions**

- **No NEAR relayer.** Users redeem Hydration → NEAR themselves (`complete`), as on every other
  destination; we do not fund NEAR transactions. NEAR → Hydration gets an `ntt` route in the
  existing relayer once the Hydration addresses exist.
- **NEAR side only.** The Hydration manager + transceiver are deployed and peered back to NEAR from
  hydration-ntt. whm reads their addresses from env and outputs the NEAR emitter.
- **One migration per token** — `near-ntt-zec`, `near-ntt-near` — sharing `migrations/actions/near-ntt/`.

| Added                                   | What                                                                  |
| --------------------------------------- | --------------------------------------------------------------------- |
| `common/near` (`@whm/common/near`)      | `wallet.getWallet`; `call`, `view`, `events`, `receiptFailures`, `checked`, `accountHash` — on `near-api-js` 7.3 (root dependency) |
| `migrations/actions/near-ntt/`          | `deployNtt` (create + fund + key + deploy + init, one tx; decimals and registration read from the token), `registerEmitter`, `registerStorage`, `setPeer`, `transferOwnership` |
| `migrations/definitions/near-ntt-{zec,near}/` | 001 deploy · 002 register emitter @core · 003 register storage @token · 004 set peer @ntt · 005 transfer ownership @ntt |
| `migrations/envs/prod/near-ntt-*.env`   | canary limits (10 ZEC, 1,000 NEAR / 24 h); Hydration addresses and new owner left to fill |
| `sh/migrate-near-ntt-*.sh`, `pnpm migrate:near-ntt-*` | `PK_NEAR` only                                           |
| `crates/near/scripts/ntt-manager/`      | `transfer`, `complete`, `claim`, `status`                             |

**Smoke test** — local NEAR sandbox (nearcore 2.13.4) with the mainnet core and `wrap.near` wasm, core
booted on a test guardian. Temporary setup files removed after.

- `pnpm migrate:near-ntt-near` through the real runner and `sh` wrapper — all five steps ✓; state
  file with `ntt-near.test.near`, emitter, 24 decimals and 0.00125 NEAR read from the token.
- `transfer.ts` — 1.5 wNEAR + 1 yocto: locked 1.5, dust back, `transfer_sent`, Wormhole seq 1.
- `complete.ts` — Hydration-shaped VAA signed by the test guardian, to an unregistered
  `bob.test.near`: verified, registered, paid 1.5 wNEAR. Replay refused; `status.ts` shows the digest
  executed and nothing claimable. `claim.ts` — nothing to claim.

**Found:** the plain `cargo build` wasm aborts on panic without a message (near-sdk falls back to
pure-Rust panics outside `cfg(near)`) — the replay surfaced as `unreachable`, not `AlreadyExecuted`.
Deploys must use `cargo near build`; `NTT_WASM` points at its output. Spec build notes updated.

**Open before running on mainnet:** `cargo-near` installed for the build; Hydration manager +
transceiver from hydration-ntt; the NEAR custodian for `NTT_NEW_OWNER`; the `ntt` relayer route;
`set_ntt_minter` referendum.

## Stage 5b — local fork

`pnpm fork:near` (`sh/fork-near.sh` → `crates/near/scripts/ntt-manager/runSandbox.ts`), the NEAR
counterpart of `fork:solana`: a fresh sandbox on :3030 with the mainnet core (booted on a dev
guardian, `fork.ts`) and `wrap.near` code, `alice.test.near` holding 10 wNEAR. Node log in
`crates/near/.sandbox/node.log` (gitignored).

- `migrations/envs/fork/near-ntt-near.env` + `pnpm migrate:near-ntt-near:fork` — `PK_NEAR` read from
  the sandbox by `crates/near/scripts/getForkKey.ts`, as the Solana fork does.
- `forkVaa.ts` — a Hydration → NEAR NTT VAA signed by the fork guardian, for `complete.ts --vaa`.

Run end to end as a user would: fork up → migration (5/5) → `transfer.ts` (2 wNEAR locked, published) →
`forkVaa.ts` + `complete.ts` (1 wNEAR to an unregistered `bob.test.near`) → `status.ts`. The stage 5
smoke test's throwaway setup is now this.

## Stage 5c — Hydration half on a chopsticks fork, testnet context

There is no Hydration on Wormhole testnet (zero chain-73 VAAs on testnet Wormholescan), so a NEAR
testnet transfer reaches Hydration through
[`chopsticks/probes/_probeNearNttDelivery.ts`](../../chopsticks/probes/_probeNearNttDelivery.ts): the
real VAA into a Hydration fork, with only the trust root substituted — the core's guardian set at the
VAA's index becomes the signer(s) recovered from the VAA itself.

The Hydration leg is deployed on the fork the way hydration-ntt deploys one (`DeployWormholeNttBase`):
a wNEAR runtime asset (id 1355, 24 dp, registry cloned from asset 43), `EVMAccounts.NttMinters[1355]`,
NttManager (BURNING) + WormholeTransceiver from hydration-ntt's artifacts behind ERC1967 proxies with
`TransceiverStructs` linked. A fixed, fresh deployer (`keccak256("whm near-ntt fork deployer")`)
makes the addresses deterministic — manager `0x5b13…6b09`, transceiver `0x5e87…B207` — so the NEAR
testnet contract is peered with them in advance (`migrations/envs/testnet/near-ntt-near.env`).

**Result (`--dev`, a NEAR-shaped VAA signed by a dev guardian):** the real core verified it, the pair
minted exactly 1.5 wNEAR (1.5e24) to the recipient, the replay was rejected.

**Fork-setup findings** (none in the design — all in reproducing registration by storage):

- `EVMAccounts.ContractDeployer` whitelist: Hydration refuses `CREATE` from unlisted addresses.
- Registration also puts a 1-byte code stub (`0x00`) at the asset's precompile address. NttManager's
  `INttToken(token).mint(...)` returns nothing, so Solidity checks `extcodesize > 0` first and reverts
  with **empty data** without it — found by dry-running each layer (core → library → transceiver →
  manager) through `EthereumRuntimeRPCApi.call`.
- Both need raw storage keys: the JSON form of `()` / `Vec<u8>` values does not apply.

**Speed:** chopsticks costs ~64 s per block after a ~3 min first block, and the probe first built one
block per tx (14 → ~17 min). `EthClient.signDeploy` / `signCall` / `sendBatch` (+ `sendRawEthTxs`)
seal many txs in one block, sized per tx against the 45M block gas: 4 blocks, ~6.5 min. The fork uses
Dwellir — catfish's rate limiter stalls lazy storage reads. Opt-in `CHOPSTICKS_DB` + `CHOPSTICKS_BLOCK`
(`lib/network.ts`) cache fetched state for reruns pinned to one block.

**Testnet context:** `migrations/envs/testnet/near-ntt-near.env`, `pnpm migrate:near-ntt-near:testnet` —
the real testnet core (`wormhole.wormhole.testnet`, guardian set 0) and `wrap.testnet`.
`deployments/testnet/` is gitignored, like `lark/`.

## Stage 5d — NEAR → Hydration with a real testnet transfer

| Step | Result |
| ---- | ------ |
| `cargo near build` | 247 KB (`target/near/ntt_manager/ntt_manager.wasm` — env paths corrected) |
| Testnet account | `whm-ntt-0bugdc.testnet`, faucet-funded; key in `crates/near/.testnet/` (gitignored) |
| `pnpm migrate:near-ntt-near:testnet` | 5/5 on the real testnet core and `wrap.testnet`; `ntt-near.whm-ntt-0bugdc.testnet`, emitter `34831e4d…7213`, peered with the fork wNEAR pair |
| `transfer.ts` | 0.5 wNEAR locked, `transfer_sent`, Wormhole sequence 1 |
| Testnet guardian | signed `15/34831e4d…7213/1` (`0x13947Bd4…C638`, set 0) — verify.md §3 confirmed live |
| `_probeNearNttDelivery.ts --emitter … --sequence 1` | the unmodified testnet VAA verified by the real Hydration core on a fork; the wNEAR pair minted exactly 0.5 wNEAR (5e23); replay rejected |

`transfer.ts` now prints the testnet Wormholescan URL when `RPC_NEAR` is testnet. Commands:
[crates/near/README.md § Testnet](../../crates/near/README.md#testnet).

Hydration → NEAR on testnet is not possible — nothing signs Hydration VAAs there — and stays covered
by the sandbox suite and the local fork (`forkVaa.ts`).
