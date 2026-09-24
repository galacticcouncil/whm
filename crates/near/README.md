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
