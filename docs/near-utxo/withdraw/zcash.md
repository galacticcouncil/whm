# Zcash — UTXO withdraw

ZEC from Hydration to a Zcash transparent address. What is specific to Zcash; the flow, the contracts
and the bots are chain-agnostic ([spec.md](spec.md), [schema.md](schema.md)).

**[V]** verified in code, on chain or by a live call; **[I]** inferred.

## Constants

| Name                       | Value                                                                |
| -------------------------- | -------------------------------------------------------------------- |
| Emitter                    | `ZecUtxoEmitter` `0xb3e365a6241683d5d4ef2701de6bedc16dcc259e` (block 15,901,846; `utxo-emitter-zec`) |
| ZEC NttManager, Hydration  | `0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC` (BURNING)               |
| ZEC token, Hydration       | `0x00000000000000000000000000000001000f478D` (asset 1,001,357, 8 dp) |
| ZEC transceiver, Hydration | `0x0dd43A80C6F96019B8f5699Df1890DFa33BdDE85`                         |
| ZEC NTT manager, NEAR      | `ntt-zec.hydration-whm.near`                                         |
| `UtxoWithdraw`             | `withdraw-zec.hydration-whm.near`, `chain: Zcash`                    |
| Token on NEAR              | `zec.omft.near` (8 dp)                                               |
| Connector                  | `zcash-connector.bridge.near` (version `0.9.7-rc.3`, commit `d2140eca`) |
| `MIN_WITHDRAW`             | 100,000 zat — the connector's `min_withdraw_amount`                  |
| `fee`                      | 10,000 zat ([Fee](#fee))                                             |
| `FEE` (miner)              | 10,000 zat — ZIP-317 for 1 input, ≤ 2 outputs is always 2 × 5,000    |

**[V]** the ZEC manager is BURNING and its token 8 dp, so no trim dust to NEAR's 8 dp;
`quoteDeliveryPrice(15, 0x00)` = 0.

## Addresses

```
terms   = Zcash transparent address, t1… (P2PKH) or t3… (P2SH), mainnet base58check
check   = base58check, 22 bytes, version 0x1cb8 (t1) or 0x1cbd (t3)
path    = "zcash:v1:" + address                        exact string; base58 is case-sensitive
```

**Golden vector** (contract unit tests, checked by both agents at startup):
`t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua` → key `FhYNkYjdaYj6tAymcRFyRgH8jQNbW5VARJHtvGdEvD3N` →
`A = da66533e90179ebb2e9e546afd4410e36f76e8a8b4ec0376b4e2a8825f802e11`.

- **Transparent only.** The deployed connector also carries Orchard (shielded) support through
  `chain_specific_data` **[V in code]**, which needs an Orchard bundle built off-chain; that is a later
  `zcash:v2` path prefix, with its own accounts.

## Emitter

`ZecUtxoEmitter.send(uint256 amount, bytes22 zcashAddress, bytes32 nearAccount)` — the generic `send`
([schema § 3](schema.md#3-the-emitter-hydration)) with the destination decoded:

- `zcashAddress` is the 2-byte version and 20-byte hash — no checksum to get wrong, so any value with
  a valid version is a payable address; `send` checks the version is `0x1cb8` or `0x1cbd`.
- It logs `destination = abi.encodePacked(zcashAddress)`, 22 bytes; readers re-encode it base58check.
- `refuel(zecIn, minNearOut, account)`, `setZecNttManager`.

## Connector

**[V]** live `zcash-connector.bridge.near` config, 2026-10-16:

|                       |                                                       |
| --------------------- | ----------------------------------------------------- |
| Minimum withdrawal    | 100,000 zat (0.001 ZEC)                               |
| Bridge withdraw fee   | 10,000 zat flat (0.0001 ZEC)                          |
| Zcash fee range       | 5,000 – 1,000,000 zat; ZIP-317 minimum checked per tx |
| Inputs per withdrawal | ≤ 25                                                  |
| Pending tx timeout    | 86,400 s, then RBF or operator cancel                 |
| Signing               | trusted relayer only (`omni-relayer.bridge.near`)     |

- **The coin set [V 2026-10-16]** is 1,020 coins holding 145,222 ZEC: median 82 ZEC, largest 8,480
  ZEC, then 495, 491, 360, 350. One coin covers any withdrawal up to 8,480 ZEC; a larger one cannot
  be built and waits. `passive_management_upper_limit` is 6,000 coins — far above today's set.
- **Paging it** is ~50 `get_utxos_paged` views (20 per page, ~17 s) — a paid NEAR RPC keeps the
  relayer clear of 429s.

**Worked example** (a live connector coin): `A` holds 0.5 ZEC; the coin `959b…c099:0` holds
7,002,606,605 zat.

|                                  | zat                                                 |
| -------------------------------- | --------------------------------------------------- |
| `amount` = balance(A)            | 50,000,000                                          |
| bridge fee, `max(0, 10,000)`     | 10,000                                              |
| miner fee, `FEE`                 | 10,000                                              |
| user output → the user's address | 49,980,000                                          |
| change → Omni's change address   | 7,002,606,605 − 49,980,000 − 10,000 = 6,952,616,605 |

## Fee

The worst-case NEAR cost of a withdrawal is ≈ 0.0097 NEAR ([spec § Sizing the
fee](spec.md#sizing-the-fee)). At NEAR $5.05 / ZEC $1,156 (CoinGecko, 2026-10-17) that is ≈ $0.049
≈ 4,200 zat. `fee` = **10,000 zat** (≈ $0.116 ≈ 0.023 NEAR) covers it ~2.4× and matches Omni's flat
bridge fee; the smallest `send` is then 110,000 zat.

What the user's ZEC pays, at NEAR ≈ $5.30 and ZEC ≈ $1,237 (CoinGecko, 2026-10-16):

| Cost                                              | Amount       | USD     |
| ------------------------------------------------- | ------------ | ------- |
| Hydration — `fee`                                 | 0.0001 ZEC   | ≈ $0.12 |
| Zcash side — bridge fee 0.0001 + miner fee 0.0001 | ≈ 0.0002 ZEC | ≈ $0.25 |

The Zcash side is what matters: ~$0.25 per withdrawal from the user's amount, about 20% of the 0.001
ZEC minimum (~$1.24) and 0.2% of 0.1 ZEC.

## Verified live

- **Mainnet canary, 2026-10-16.** 0.001 ZEC: Hydration NTT transfer to `sha256(A)` → `ntt-zec.complete`
  → `withdraw-zec.withdraw` → Omni. Zcash tx
  `a63e6119df0bd73e6160515d8f4abe15327e29df21f637245ef334d8c784ae34` (block 3,520,026): 80,000 zat to
  `t1XVScGC…`, 99,910,000 zat change to Omni; connector record: 10,000 bridge fee, 10,000 miner fee.
  Omni's relayer signed 12 s after the request. The connector parsed and accepted our `Withdraw`
  message.
- **Gas.** `withdraw_gas` = 200 TGas carries the connector's `ft_on_transfer` and its 100 TGas
  callback; `withdraw` burns 20.8 TGas end to end on mainnet. `ntt-zec.complete`: 24.1 TGas burnt,
  from two mainnet completes.
- **`derived_public_key` as a cross-contract call** — on testnet and mainnet.
- **Testnet** (`ZcashTestnet`, `withdraw-zec.whm-ntt-0bugdc.testnet`): `claim` signed by the real
  `v1.signer-prod.testnet`, relayed, executed by the connector as `A`; `withdraw` reads and the
  `BelowMinimum` stop; `upgrade` + `migrate` on a keyless contract.
- Omni's relayer signs a pending withdrawal from any account, `A` included, and pays its own NEAR gas.
- **Bots live, 2026-10-17** — `ntt-near` and the `utxo` relayer on `relayer.hydration-whm.near`, one
  key each. `ntt-near` replayed the ZEC transceiver's 10 earlier VAAs and skipped every one (no
  `WithdrawRequested` — they predate the emitter); the relayer read the emitter from its deployment
  block and follows finalized blocks.
- **First withdrawal through the bots, 2026-10-17.** Settlement 9: `ntt-near` completed it for
  `A = 0e713a…7c30` (`4K1jXZ…5psq`); the relayer stored the record 18:00:34, created `A` 18:00:58,
  withdrew and relayed 18:01:31 (`9cVz8S…ssscVAY`, coin `91de70…4f3c:1`). Connector: 100,000 zat in,
  10,000 bridge + 10,000 miner fee, 80,000 to `t1dbk2kN…yhncw` — Zcash tx
  `09f0c1e949773794237a9f3bca8e70e3e3d9e8ec7e089ffb38508aa5d8c331b5`, signed 13 s after the request.
  ~70 s Hydration → Zcash mempool. NEAR spent by the bots: ≈ 0.0139 NEAR (first to an `A`).

## Open

1. **Hand `ZecUtxoEmitter` to the TC** — deployed 2026-10-17 with steps 001–004; the deployer still
   owns it. Set `HYDRATION_EMERGENCY_ADMIN` and re-run `utxo-emitter-zec` for step 005.
2. **Ownership handover** — `WITHDRAW_NEW_OWNER=hydration.sputnik-dao.near`, re-run
   `utxo-withdraw-zec` (keys deleted, DAO accepts).
