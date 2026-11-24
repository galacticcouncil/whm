# ntt-sandbox

End-to-end tests for `ntt-manager` on a NEAR sandbox (`near-workspaces`), against the **deployed
mainnet code** of its two counterparties:

| Fixture                                    | Source (`view_code`, mainnet)   | Code hash                                      | Block       |
| ------------------------------------------ | ------------------------------- | ---------------------------------------------- | ----------- |
| `tests/wasm/contract.wormhole_crypto.near.wasm` | `contract.wormhole_crypto.near` | `JATvoVrWqPSdNNL7iq8a99WYgQdgyCbcjQWdLAzbfJKj` | 216,979,377 |
| `tests/wasm/wrap.near.wasm`                | `wrap.near`                     | `DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1` | 216,979,385 |
| `tests/wasm/intents.near.wasm`             | `intents.near` (v0.4.5, `16d04f6`) | `BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk` | 221,555,639 |

The core is booted with a single test guardian (`boot_wormhole`), so tests sign VAAs the real
`verify_vaa` accepts.

`tests/router.rs` covers `intent-router`: every payload it signs is executed by the real
`intents.near` — signature, NEP-413 digest, versioned nonce, salt, deadline and balances checked by
the verifier itself. `mock-mpc` stands in for `v1.signer`: same methods, a real Ed25519 key per
`(predecessor, path)`, signing at once. `wrap.near` plays both tokens.

## Run

```bash
pnpm run test:sandbox
```

It builds the contract wasm and passes it in through `NTT_WASM`, `ROUTER_WASM` and `MPC_WASM`. The
router and the mock are built with `cargo near build`: near-sdk calls the host's `panic_utf8` only
under `--cfg near`, which `cargo near` sets — a plain `cargo build` wasm aborts with a bare
`unreachable`, and the tests that check error messages fail. For ntt-manager, without it the tests fall back to
`cargo near build` (needs `cargo-near`). One sandbox per test, so they run on one thread.

The sandbox binary ships for linux-x86_64, linux-aarch64 and darwin-arm64 only. On Apple Silicon
with an x86_64 default toolchain (Rosetta), run on the native one:

```bash
rustup target add wasm32-unknown-unknown --toolchain stable-aarch64-apple-darwin
cargo +stable-aarch64-apple-darwin build -p ntt-manager --target wasm32-unknown-unknown --release
NTT_WASM=$PWD/../target/wasm32-unknown-unknown/release/ntt_manager.wasm \
  cargo +stable-aarch64-apple-darwin test -p ntt-sandbox -- --test-threads=1 --nocapture
```

## EVM side

`outbound_locks_and_publishes` prints the payload the core published. Two checks parse it:

- `contracts/test/ntt/NearPayloadTest.sol` — through `NttPayload`, in this repo's forge suite.
- `forge/NearPayload.t.sol` — through the real `TransceiverStructs`, parse and re-encode to the same
  bytes. It needs the NTT sources, so it runs from a copy of `hydration-ntt/evm` (checked at
  `f4871dbe`): copy `src`, `lib` and `foundry.toml`, drop the file into `test/`, then
  `forge test --match-path test/NearPayload.t.sol`.
