# NEAR

NEAR contracts. Currently one: `ntt-manager`, a native NTT harness — NttManager and Wormhole
transceiver in one contract, LOCKING, one deployment per token. Design:
[docs/near-ntt/spec.md](../../docs/near-ntt/spec.md).

## Prerequisites

- Rust toolchain (`cargo`) with the `wasm32-unknown-unknown` target
- `cargo-near` — builds the wasm NEAR's runtime accepts (it lowers the post-MVP wasm features newer
  Rust emits by default)

```bash
rustup target add wasm32-unknown-unknown
cargo install --locked cargo-near
```

## Build

```bash
pnpm run build
```

## Test

```bash
pnpm run test
```

End-to-end, on a NEAR sandbox against the deployed mainnet Wormhole core and `wrap.near`:

```bash
pnpm run test:sandbox
```

See [`sandbox/README.md`](sandbox/README.md) — including the Apple Silicon note.

Codec tests run against real NTT VAAs in
[`contracts/ntt-manager/tests/fixtures/vaas.json`](contracts/ntt-manager/tests/fixtures/vaas.json),
encoded by the deployed EVM `NttManager`s — the bytes the NEAR contract must produce and accept.

## Scripts

[`scripts/ntt-manager/`](scripts/ntt-manager/) — `RPC_NEAR` from env (or root `.env`), signer from
`--account` / `--pk`:

| Script        | Does                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| `transfer.ts` | NEAR → Hydration: `ft_transfer_call`; prints the Wormholescan VAA URL       |
| `complete.ts` | Hydration → NEAR: redeem by `--vaa`, or `--emitter` + `--sequence` (Wormholescan) |
| `claim.ts`    | pay out the signer's `claimable` balance                                    |
| `status.ts`   | owner, peer, capacities; `--account` claimable; `--digest` executed / queued |

```bash
npx tsx crates/near/scripts/ntt-manager/transfer.ts --contract ntt-zec.<parent>.near \
  --token zec.omft.near --amount 100000000 --recipient 0x… --account <you>.near --pk ed25519:…
npx tsx crates/near/scripts/ntt-manager/complete.ts --contract ntt-zec.<parent>.near \
  --emitter <hydration transceiver> --sequence <n> --account <you>.near --pk ed25519:…
```

Deployment: `pnpm migrate:near-ntt-zec` / `pnpm migrate:near-ntt-near` — NEAR side only, see
`migrations/definitions/near-ntt-*/index.ts`. Build the wasm with `pnpm run build` (`cargo near`)
first: a plain `cargo build` artifact loses every panic message.

## Local fork

A NEAR sandbox set up for `near-ntt`, the way `pnpm fork:solana` is for the oracle:

```bash
pnpm fork:near                        # sandbox on :3030 — mainnet core (dev guardian) + wrap.near, alice with 10 wNEAR
pnpm migrate:near-ntt-near:fork       # the real migration; PK_NEAR from the sandbox key

export RPC_NEAR=http://127.0.0.1:3030
PK=$(npx tsx crates/near/scripts/getForkKey.ts)
S=crates/near/scripts/ntt-manager

npx tsx $S/transfer.ts --contract ntt-near.test.near --token wrap.test.near \
  --amount 2000000000000000000000000 --recipient 0x1111111111111111111111111111111111111111 \
  --account alice.test.near --pk "$PK"

VAA=$(npx tsx $S/forkVaa.ts --contract ntt-near.test.near --recipient bob.test.near --amount 100000000 --sequence 1)
npx tsx $S/complete.ts --contract ntt-near.test.near --vaa "$VAA" --recipient bob.test.near \
  --account test.near --pk "$PK"

npx tsx $S/status.ts --contract ntt-near.test.near --account bob.test.near
```

- The sandbox binary comes from `pnpm test:sandbox` (near-workspaces downloads it into `target/`), or
  set `NEAR_SANDBOX_BIN`. Home is `crates/near/.sandbox`, reset on every run; node log in
  `.sandbox/node.log`.
- `forkVaa.ts` signs as the fork guardian — a Hydration-shaped NTT VAA the real core accepts. Fork
  only; nothing Hydration-side runs locally.
- The fork env builds nothing: build the wasm first (`NTT_WASM` in `migrations/envs/fork/near-ntt-near.env`).
- wNEAR-shaped (24 dp) only — `zec.omft.near`'s code has no known init. An 8-dp fork needs a test FT.
