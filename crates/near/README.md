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
