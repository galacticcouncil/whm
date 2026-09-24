# NEAR NTT

A native NTT harness for NEAR: ZEC (`zec.omft.near`) and NEAR (`wrap.near`) move **NEAR ↔ Hydration
in one hop** over Wormhole. NEAR is the hub — the token is **locked** here — and Hydration burns and
mints through a stock EVM NttManager.

One contract, `ntt-manager`: NttManager and Wormhole transceiver in one, LOCKING, one deployment per
token. Its wire format is byte-for-byte EVM NTT, so the Hydration side is unmodified.

Design: [docs/near-ntt/spec.md](../../docs/near-ntt/spec.md) · pre-implementation checks:
[verify.md](../../docs/near-ntt/verify.md) · build log: [progress.md](../../docs/near-ntt/progress.md).

## Layout

```
contracts/ntt-manager/     the contract (near-sdk 5)
  src/messages.rs          NTT wire format — TransceiverMessage / NttManagerMessage / NativeTokenTransfer
  src/outbound.rs          NEAR → peer: ft_on_transfer → publish_message → on_published
  src/inbound.rs           peer → NEAR: complete → verify_vaa → on_verified → pay out
  src/payout.rs            every ft_transfer out of custody; claimable on failure
  src/rate_limit.rs        24 h linear-refill limiter
  src/trimmed.rs           8-decimal trimming, with dust
  src/vaa.rs               VAA body parser
  tests/fixtures/          real mainnet NTT VAAs — golden vectors
sandbox/                   end-to-end tests on a NEAR sandbox (near-workspaces)
  tests/wasm/              mainnet code of the Wormhole core and wrap.near
  forge/                   EVM check: a NEAR-published payload through the real TransceiverStructs
scripts/ntt-manager/       user scripts + local fork
```

Deployment is [`migrations/definitions/near-ntt-{zec,near}`](../../migrations/definitions/) — NEAR
side only; the Hydration manager + transceiver are deployed and peered back from hydration-ntt.

## Prerequisites

- Rust toolchain (`cargo`) with the `wasm32-unknown-unknown` target
- `cargo-near` — for deployable builds. A plain `cargo build` wasm runs, but near-sdk outside
  `cfg(near)` aborts on panic with no message: every refusal surfaces as a bare `unreachable` trap

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked cargo-near
```

## Build

```bash
pnpm run build                        # cargo near build → target/near/ntt_manager.wasm
```

## Test

```bash
pnpm run test                         # unit tests
pnpm run test:sandbox                 # end-to-end on a NEAR sandbox
```

The unit tests round-trip real NTT VAAs encoded by the deployed EVM `NttManager`s
([`tests/fixtures/vaas.json`](contracts/ntt-manager/tests/fixtures/vaas.json)) — the bytes this
contract must produce and accept. The sandbox suite runs against the **deployed mainnet code** of the
Wormhole core and `wrap.near`: real promise chains, real `verify_vaa` against a test guardian, real
NEP-141 storage and transfers. See [`sandbox/README.md`](sandbox/README.md), including the Apple
Silicon note.

## Local fork

A NEAR sandbox set up for `near-ntt`, the way `pnpm fork:solana` is for the oracle:

```bash
pnpm fork:near                        # :3030 — mainnet core (dev guardian) + wrap.near, alice with 10 wNEAR
pnpm migrate:near-ntt-near:fork       # the real migration; PK_NEAR from the sandbox key

export RPC_NEAR=http://127.0.0.1:3030
PK=$(npx tsx crates/near/scripts/getForkKey.ts)
S=crates/near/scripts/ntt-manager

# NEAR → Hydration
npx tsx $S/transfer.ts --contract ntt-near.test.near --token wrap.test.near \
  --amount 2000000000000000000000000 --recipient 0x1111111111111111111111111111111111111111 \
  --account alice.test.near --pk "$PK"

# Hydration → NEAR, with a VAA signed by the fork guardian
VAA=$(npx tsx $S/forkVaa.ts --contract ntt-near.test.near --recipient bob.test.near --amount 100000000 --sequence 1)
npx tsx $S/complete.ts --contract ntt-near.test.near --vaa "$VAA" --recipient bob.test.near \
  --account test.near --pk "$PK"

npx tsx $S/status.ts --contract ntt-near.test.near --account bob.test.near
```

- The sandbox binary comes from `pnpm test:sandbox` (near-workspaces downloads it into `target/`),
  or set `NEAR_SANDBOX_BIN`. Home is `crates/near/.sandbox`, reset on every run; node log in
  `.sandbox/node.log`.
- `forkVaa.ts` signs as the fork guardian — a Hydration-shaped NTT VAA the real core accepts. Fork
  only; nothing Hydration-side runs locally.
- The fork migration builds nothing: build the wasm first (`NTT_WASM` in
  `migrations/envs/fork/near-ntt-near.env`).
- wNEAR-shaped (24 dp) only — `zec.omft.near`'s code has no known init. An 8-dp fork needs a test FT.

## Deploy

```bash
pnpm run build                        # cargo near — always, for mainnet
pnpm migrate:near-ntt-zec             # or :near — PK_NEAR, env in migrations/envs/prod/near-ntt-*.env
```

`001` deploy (create + fund + deploy + init in one transaction) · `002` register emitter on the core ·
`003` register storage on the token · `004` peer with the Hydration manager + transceiver · `005`
transfer ownership. Before it: the Hydration manager + transceiver from hydration-ntt, their
addresses in the env. After it: hydration-ntt peers them back with `001`'s emitter, the
`set_ntt_minter` referendum, an `ntt` relayer route (NEAR → Hydration), and — after the canary —
removing the contract account's full-access keys. Details in
[`migrations/definitions/near-ntt-zec/index.ts`](../../migrations/definitions/near-ntt-zec/index.ts).

## Scripts

[`scripts/ntt-manager/`](scripts/ntt-manager/) — `RPC_NEAR` from env (or root `.env`), signer from
`--account` / `--pk`. Hydration → NEAR is redeemed by the user; there is no NEAR relayer.

| Script         | Does                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| `transfer.ts`  | NEAR → Hydration: `ft_transfer_call`; prints the Wormholescan VAA URL             |
| `complete.ts`  | Hydration → NEAR: redeem by `--vaa`, or `--emitter` + `--sequence` (Wormholescan) |
| `claim.ts`     | pay out the signer's `claimable` balance                                          |
| `status.ts`    | owner, peer, capacities; `--account` claimable; `--digest` executed / queued      |
| `runSandbox.ts`| the local fork (`pnpm fork:near`)                                                 |
| `forkVaa.ts`   | fork only: a Hydration → NEAR VAA signed by the fork guardian                     |

```bash
npx tsx crates/near/scripts/ntt-manager/transfer.ts --contract ntt-zec.<parent>.near \
  --token zec.omft.near --amount 100000000 --recipient 0x… --account <you>.near --pk ed25519:…
npx tsx crates/near/scripts/ntt-manager/complete.ts --contract ntt-zec.<parent>.near \
  --emitter <hydration transceiver> --sequence <n> --account <you>.near --pk ed25519:…
```
