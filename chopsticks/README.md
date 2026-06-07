# @whm/chopsticks

Thin harness for spawning [chopsticks](https://github.com/galacticcouncil/chopsticks) forks of
Hydration / Moonbeam and driving them from TypeScript (papi) — fund accounts, build blocks, read
state/events, and **execute EVM transactions against the fork**.

```ts
import { spawnForks, teardownForks, EthClient, getEventsAt } from "@whm/chopsticks";
```

- **`spawnForks` / `teardownForks`** — fork chains (keyed by `spec.key`), wire HRMP, tear down.
- **`configs`** — fork presets (`hydration`, `moonbeam`).
- **`Network.setStorage`** — `dev_setStorage` (bigints auto-stringified) — fund/seed accounts.
- **`truncatedEvmAccount`** — H160 → Hydration's `b"ETH\0" ++ h160 ++ [0;8]` substrate account.
- **`EthClient`** — viem-signed eth wallet over a fork: `deploy` / `call` (see below).
- **`sendRawEthTx`** — submit one signed eth tx as `pallet_ethereum::transact`.
- **`getEventsAt` / `atBlock`** — read a block's events / any state at an explicit hash (race-free).
- **`getEvmExecution`** — a tx's `Ethereum.Executed` outcome (`ok` / `exitReason` / `from` / `to`).
- **`getTokenBalance` / `getAccountCode`** — Tokens free balance / deployed EVM bytecode, at a block.

See [EVM on a Hydration](#evm-on-a-hydration) below.

---

## EVM on a Hydration

### Usage

To deploy or call an EVM contract on the fork, **sign a real Ethereum tx with viem and submit it as
`pallet_ethereum::transact`** via `sendRawEthTx(net, rawTx)`. That's the external/papi equivalent of
the gc-chopsticks `eth_sendRawTransaction` (commit `f8cd0a7`).

```ts
const account = privateKeyToAccount(PK); // a real secp256k1 key
const client = new EthClient(hydration, account, { chainId: 222222 });

const { address, res } = await client.deploy(bytecode); // CREATE
await client.call(address, calldata); // contract call (auto-nonce)
const code = await getAccountCode(hydration, address, res.blockHash); // verify

// …or submit a pre-signed raw tx directly:
const { blockHash } = await sendRawEthTx(hydration, rawTx);
```

### Why not the obvious approaches

- **Not substrate `EVM.call` / `EVM.create2`.** Submitting `pallet_evm` extrinsics signed by a papi
  signer fails `InvalidTransaction::BadProof` under `mock-signature-host` (it waves through the
  _substrate_ signature check, but the dispatch path still rejects it). `EVM.create2` also isn't how
  Hydration deploys — there's no historical `EVM.Created` on chain.
- **Not viem `deployContract` against the fork's eth RPC.** gc-chopsticks `2.0.0` serves a
  **read-only** eth RPC (`eth_call`, `eth_getCode`, `eth_getBalance`, `eth_estimateGas`, …) — there is
  **no `eth_sendRawTransaction`** and no receipt method, so viem can't submit. (Commit `f8cd0a7` adds
  it natively; once published, viem `deployContract` would work directly.)
- **So:** the only write path is a substrate extrinsic, and the mainnet-faithful one is
  `pallet_ethereum::transact` — a **self-contained** extrinsic carrying the real signed eth tx.

### How it works

It's self-contained: the substrate extrinsic is **unsigned (v4)** — there is no substrate signer.
Authentication is the **embedded eth ECDSA signature**: the runtime runs **`ecrecover`** over the
tx's `(v, r, s)` to derive the EVM sender (`msg.sender`/`from`). Consequences:

- The eth signature must be **real** — we sign with viem's private key. `mock-signature-host` is
  irrelevant here (it only touches substrate sig verification, which a self-contained extrinsic has
  none of).
- `r`/`s` must be **32-byte padded**. viem's `parseTransaction` returns them as _minimal_ hex; an
  unpadded `s` makes `ecrecover` return a **different** address → the contract deploys from/at the
  wrong place. `sendRawEthTx` pads them.

### Gotchas

- **`dev_newBlock` hangs, rebuilding the same block forever.** The RPC can't prune a self-contained
  tx by hash. Submit via in-process `chain.newBlock({transactions})` (what `sendRawEthTx` does),
  which builds exactly one block and returns it.
- **Events / `getCode` read empty or from a neighbouring block.** Reading `latest`/`head` races the
  sealer. Read at the exact returned `blockHash` via `getEventsAt` / `atBlock` (retry through papi WS
  lag).
- **Recovered `from` ≠ your key; deploy lands at the wrong address.** Unpadded `r`/`s` — pad to 32
  bytes (handled in `sendRawEthTx`).
- **`eth_getTransactionCount` returns a huge number.** `account_basic` field-order mis-decode on
  `2.0.0` — track nonce manually (`EthClient` does; don't read it back).
- **Deploy seems gated?** It isn't — no `EVMAccounts.ContractDeployer` whitelist is needed on the
  fork; any key deploys.
- **`BadProof` on every extrinsic.** You're on the substrate `EVM.call` path — use `sendRawEthTx`.
- **Block mode stays Manual** (the default): inject each tx with `chain.newBlock` for a deterministic
  block hash. Instant mode + manual `newBlock` fight and deadlock.

### Toolchain

- **papi `^2.x`** + **`@galacticcouncil/descriptors` `^2.4.0`** (2.4.0 exposes `Ethereum.transact` /
  `EVM` in the typed api; older descriptors → `BadProof` / "Incompatible runtime entry").
- Two `packageExtensions` in [`pnpm-workspace.yaml`](../pnpm-workspace.yaml) to make
  `@galacticcouncil/chopsticks@2.0.0` installable: alias `@acala-network/chopsticks-db` → the gc db
  package, and declare `@polkadot-api/json-rpc-provider@0.2.0` on `json-rpc-provider-proxy@0.4.0`.

### Terms

- **ecrecover** — recovers the signer's address from an ECDSA signature `(v, r, s)`; an eth tx has no
  `from`, so the sender is always recovered this way (`v` is the recovery id picking the right key).
- **Self-contained extrinsic** — a substrate extrinsic with no substrate signature; authed by data
  inside the call. `pallet_ethereum::transact` is one — the embedded eth sig (via `ecrecover`) is the auth.
- **Bare-unsigned extrinsic** — extrinsic format v4 with no signature payload (leading byte `0x04`);
  produced by `tx.getBareTx()`, what we broadcast for `transact`.
- **mock-signature-host** — chopsticks mode that bypasses _substrate_ sig verification (submit as any
  origin). Doesn't touch EVM `ecrecover`, so it can't fake an eth sender.
- **TransactionV3** — Frontier's eth-tx enum (`Legacy` | `EIP2930` | `EIP1559` | `EIP7702`); the
  `Ethereum.transact` argument, built from a viem-parsed tx in `buildTransactionV3`.
- **Truncated EVM account** — Hydration's H160→AccountId32 mapping `b"ETH\0" ++ h160 ++ [0u8;8]` for
  an unbound address (the origin + where balances live).
- **DISPATCH precompile (`0x0401`)** — Hydration EVM precompile that runs a SCALE-encoded runtime call
  as the EVM caller (Solidity → substrate pallets / XCM).
- **Block mode** — Manual seals only on `dev_newBlock` (deterministic, what we use); Instant auto-seals
  on submit (deadlocks with self-contained txs + manual `newBlock`).
