---
name: new-hydration-asset
description: Register a new Hydration runtime asset for an NTT burning leg (the currencies precompile token), the fast way — permissionless `assetRegistry.register_external` for the Wormhole location, then a TC-majority `assetRegistry.update` for metadata, then `set_ntt_minter` at go-live. Builds the location, checks it, encodes and dry-runs every call with polkadot-api against live Hydration. Trigger on "register asset on Hydration", "create Hydration asset for <token>", "asset registry for NTT", "register_external", or `/hydration-ntt-asset <tokens>`.
---

# Hydration runtime asset for an NTT burning leg

When Hydration is the **spoke** of an NTT route (source chain locks, Hydration mints and burns), the
Hydration token is a runtime asset, not an ERC-20 contract. Its ERC-20 view is the currencies
precompile `0x00000000000000000000000000000001` followed by the asset id as 4 hex bytes (id 1001355 →
`0x…01000f478b`). The NttManager's `mint`/`burn` reach the runtime through that precompile.

Why a runtime asset (`Token`) and not an ERC-20 (`Erc20` type, like HOLLAR): runtime assets get
Hydration's circuit breakers (the `xcm_rate_limit` mint fuse, withdrawal limits). An ERC-20 is only
protected by the NTT rate limits.

## Hard rules

- **polkadot-api (papi) only.** Never `@polkadot/api`. Generate descriptors with
  `npx papi add hydration -w <wss>`.
- **RPC is Dwellir** (`wss://hydration-rpc.n.dwellir.com`), never `rpc.hydradx.cloud`.
- **Encode and dry-run only.** This skill prints call data; it never signs or submits. The user submits.
- **One custody per token.** A Hydration asset is fed by exactly one NTT hub. Never register a second
  asset or peer a second hub (e.g. Omni-ZEC on Solana _and_ native NEAR NTT) against the same token.
- **Register before the Hydration manager deploys.** The manager's token address is an immutable
  constructor arg, so the asset id must exist first.

## Origins (Hydration runtime, verified against `hydration-node` master)

| Call                                            | Origin                                      | Meaning                                                                                       |
| ----------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `assetRegistry.register`                        | `Root \| GeneralAdmin`                      | referendum only; not used here                                                                |
| `assetRegistry.register_external(location)`     | **any signed account**                      | immediate; creates `External`, `ED = 1`, `is_sufficient = false`, no name, symbol or decimals |
| `assetRegistry.update(...)`                     | `Root \| TC majority \| GeneralAdmin`       | TC majority is enough for everything this skill sets                                          |
| `EVMAccounts.set_ntt_minter(asset_id, manager)` | `Root \| GeneralAdmin` (`ControllerOrigin`) | go-live; fastest route is TC whitelist + `whitelisted_caller` referendum                      |

A TC motion can't call `register_external`, because that needs a signed origin; a normal account
submits it. What TC majority can do in `update`:

- `asset_type` → `Token` ✅
- name, symbol, ED, `xcm_rate_limit` ✅
- `is_sufficient` false → true ✅ (true → false is forbidden)
- `decimals` ✅ only while unset (after that, Root/GeneralAdmin only)
- `location` ❌ Root/GeneralAdmin only (not needed, because `register_external` already set it)

## Location format (identical for every existing NTT asset)

```
{ parents: 0, interior: X3[
    GeneralKey { length: 2,  data: 0x7768 ++ 30 zero bytes },      // "wh"
    GeneralIndex(<Wormhole chain id of the hub>),
    GeneralKey { length: 32, data: <32-byte Wormhole universal address of the hub token> } ] }
```

| Hub platform | Universal address of the token                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| EVM          | 20-byte address left-padded to 32 (lowercase hex)                                                            |
| Solana       | the mint pubkey's 32 bytes                                                                                   |
| NEAR         | `sha256(token_account_id)`, the same digest the NEAR NTT contract emits as `NativeTokenTransfer.sourceToken` |
| Sui          | the token's Wormhole universal address as NTT emits it (see the live SUI asset for the example)              |

Chain ids seen so far: Solana 1, Ethereum 2, NEAR 15, Sui 21, Base 30, HyperEVM 47, Robinhood 72.
Take them from `@wormhole-foundation/sdk-base` `constants/chains`, not from memory.

**Always use the hub token NTT actually locks**: WHYPE (`0x5555…5555`) for HYPE, `wrap.near` for NEAR,
`zec.omft.near` for ZEC. Use the locked token even when the manager variant unwraps to the native
asset.

## Conventions (match the live registry)

| Field                 | Value                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `asset_type`          | `Token`                                                                   |
| `is_sufficient`       | `true`                                                                    |
| `decimals`            | the hub token's decimals (NTT trims to 8 on the wire regardless)          |
| `existential_deposit` | ≈ **$0.01** of the token, in raw units, at registration time              |
| `name`                | `"<Name> (Wormhole)"` (a few exceptions exist, e.g. jitoSOL, PRIME)       |
| `symbol`              | the hub symbol                                                            |
| `xcm_rate_limit`      | daily mint fuse, sized with the NTT limits; ask the user, never invent it |

Reference entries: WETH id 20, SOL id 1000752, SUI id 1000753. Dump them with
`AssetRegistry.Assets` + `AssetRegistry.AssetLocations` when in doubt.

## Procedure

### Step 1: collect inputs

For each token: hub chain, hub token (address, mint or account id), decimals (read on-chain), name,
symbol, ED, `xcm_rate_limit`. Batch the questions into one message. Read decimals and symbol from the
hub chain yourself (`cast call … 'decimals()(uint8)'`, the NEAR `ft_metadata` view) instead of asking.

### Step 2: build and check locations (papi script in a temp dir)

1. **Encoding sanity check:** build WETH's location the same way (chain 2,
   `0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` padded) and confirm
   `AssetRegistry.LocationAssets.getValue(loc) === 20`. If it isn't, the encoding is wrong. Stop.
2. For each new location, `LocationAssets.getValue(loc)` must be `undefined`. If it isn't, the asset
   already exists: report the id and stop.
3. Expected ids: `1_000_000 + AssetRegistry.NextAssetId`, then +1 for each call in batch order.

papi version notes: in v3, `GeneralKey.data` is a plain `SizedHex<32>` string and the WS provider is
`polkadot-api/ws`. In v2, wrap hex with `FixedSizeBinary.fromHex(...)`. Check `package.json`.

```js
const wh = XcmV3Junction.GeneralKey({ length: 2, data: "0x7768" + "00".repeat(30) });
const loc = (chain, key32) => ({
  parents: 0,
  interior: XcmV3Junctions.X3([
    wh,
    XcmV3Junction.GeneralIndex(BigInt(chain)),
    XcmV3Junction.GeneralKey({ length: 32, data: key32 }),
  ]),
});
```

### Step 3: encode and dry-run `register_external`

- `Utility.batch_all({ calls: locs.map(l => AssetRegistry.register_external({ location: l }).decodedCall) })`
- Print the call hex (`getEncodedData()`).
- Dry-run: `api.apis.DryRunApi.dry_run_call(Enum('system', Enum('Signed', <any funded account>)), batch.decodedCall, 5)`.
  It needs `execution_result.success`, plus one `AssetRegistry.LocationSet` and one
  `AssetRegistry.Registered` (type `External`) per token, with the expected ids.
- Hand the hex to the user. Tell them that `register_external` is permissionless, so a concurrent
  registration can shift the ids: the **real** ids come from the `Registered` events after submission.

### Step 4: TC `update` batch (after the real ids are known)

- Per token: `AssetRegistry.update({ asset_id, name, asset_type: Token, existential_deposit,
xcm_rate_limit, is_sufficient: true, symbol, decimals, location: undefined })`, all in one `batch_all`.
- Dry-run it with a TC-majority origin (`Enum('TechnicalCommittee', Enum('Members', [n, m]))` with
  `n/m ≥ 1/2`, checking the origin variant names in the descriptors). Then read back the expected
  `Updated` events.
- Output: the call hex plus call hash, for the TC motion.

### Step 5: precompile check

After the TC update, the precompile `0x…01<id hex>` must answer `symbol()` and `decimals()` over
Hydration EVM (`cast call`). Registration also puts a 1-byte code stub at that address. Without it,
the NttManager's `mint` reverts with empty data, because Solidity checks `extcodesize`.

### Step 6: go-live (hand-off, not done by this skill)

Deploy the Hydration manager (burning, `token = precompile`), peer it, set NTT limits. Then a
referendum dispatches `EVMAccounts.set_ntt_minter(id, manager)` for all tokens in one `batch_all`.
The DAI go-live used `whitelist.dispatch_whitelisted_call_with_preimage`, Chopsticks-verified.
`set_ntt_minter` is the go-live switch: until it's enacted the Hydration side is inert in both
directions.

## Output format

For each batch: a table (token → location key → expected id → precompile), the call hex, the call
hash, and the dry-run result with its events. Keep scripts in a temp dir; never commit them.

## Worked example (2026-09-28, dry-run OK against live state)

HYPE (47, WHYPE), SPY (72, `0x117cc2133c37B721F49dE2A7a74833232B3B4C0C`), ZEC (15,
`sha256("zec.omft.near")` = `0x3174446b…ef0f`), NEAR (15, `sha256("wrap.near")` = `0xb55c490b…d3c0`):
expected ids 1001355–1001358. `register_external` batch:

```
0x0d0210330400030602776800000000000000000000000000000000000000000000000000000000000005bc0620000000000000000000000000555555555555555555555555555555555555555533040003060277680000000000000000000000000000000000000000000000000000000000000521010620000000000000000000000000117cc2133c37b721f49de2a7a74833232b3b4c0c3304000306027768000000000000000000000000000000000000000000000000000000000000053c06203174446b8cc98197d6f2c9e504d6d229f0adb00d2b7566af0e54a84a876fef0f3304000306027768000000000000000000000000000000000000000000000000000000000000053c0620b55c490bafb82aeb4b950fa479341c1b5fbfa814f8253b6acdf8426b7cd9d3c0
```

Decimals for the TC update: HYPE 18, SPY 18, ZEC 8, NEAR 24. Re-check `NextAssetId` before reusing
this hex; if another asset got registered first, the ids are stale.
