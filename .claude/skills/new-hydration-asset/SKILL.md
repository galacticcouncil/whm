---
name: new-hydration-asset
description: Register a new Hydration runtime asset for an NTT burning leg (the currencies precompile token), the fast way — permissionless `assetRegistry.register_external` for the Wormhole location, then a TC-majority `assetRegistry.update` for metadata, then `set_ntt_minter` at go-live. Builds the location, checks it, encodes and dry-runs every call with polkadot-api against live Hydration. Trigger on "register asset on Hydration", "create Hydration asset for <token>", "asset registry for NTT", "register_external", or `/new-hydration-asset <tokens>`.
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

### Step 4: TC `update` motion

**Ids:** once the registration is on-chain, take each id from `AssetRegistry.LocationAssets.getValue(loc)`,
never from the expected-id table. Before that, use the expected ids, and regenerate the motion if any id
moved.

1. Per token: `AssetRegistry.update({ asset_id, name: Binary.fromText(name), asset_type: Enum('Token'),
existential_deposit, xcm_rate_limit, is_sufficient: true, symbol: Binary.fromText(sym), decimals,
location: undefined })`, all in one `Utility.batch_all`. Leave `location` unset (`None`); TC can't
   set it anyway.
2. Names must be unique (`AssetRegistry.AssetIds.getValue(Binary.fromText(name))` returns `undefined`)
   and between `MinStringLimit` (3) and `StringLimit` (32) bytes.
3. Motion: `TechnicalCommittee.propose({ threshold, proposal: batch.decodedCall, length_bound })`
   - `threshold = ceil(members / 2)` for TC majority, where members =
     `TechnicalCommittee.Members.getValue().length`. For 7 members that's 4.
   - `length_bound` = the byte length of the encoded batch.
   - Proposal hash = `Blake2256(batch bytes)` (`@polkadot-api/substrate-bindings`). Members vote on
     this hash.
4. **Dry-run** (verified method; it also works _before_ the assets exist): run a Root-origin
   `DryRunApi.dry_run_call` of
   ```
   Utility.batch_all[
     Utility.dispatch_as(system.Signed(<any account>), <register_external batch>),
     Utility.dispatch_as(TechnicalCommittee.Members(threshold, members), <update batch>) ]
   ```
   Check `execution_result.success`, **both** `Utility.DispatchedAs` results `success: true`
   (`dispatch_as` doesn't fail the outer call on an inner error), and one `AssetRegistry.Updated` per
   token with `asset_type: Token`, `is_sufficient: true`, and the right name, symbol, decimals, ED and
   rate limit.
5. Output: the update batch hex, its hash, the `propose` call hex, `length_bound`, and a per-token
   table of values.

**Ordering rule:** the TC `update` must be enacted **before** `set_ntt_minter`, so the asset is a
sufficient `Token` before anyone holds a balance. Changing External → Token and insufficient →
sufficient is only clean while supply is zero.

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

TC `update` motion for those ids (TC 7 members, threshold 4). The whole register → update
sequence dry-ran OK via Root `dispatch_as`. ED ≈ $0.01 at HYPE $87.50, SPY $765.61, ZEC $1,483.98,
NEAR $4.82. The `xcm_rate_limit` values were _proposed_ (≈ $45k per day for HYPE/SPY, and a ≈ $5k
canary for the unaudited NEAR contract); TC can raise them later with another `update`.

| id      | name                   | symbol | dec | ED (raw)               | xcm_rate_limit |
| ------- | ---------------------- | ------ | --- | ---------------------- | -------------- |
| 1001355 | Hyperliquid (Wormhole) | HYPE   | 18  | 114285714285714        | 500 HYPE       |
| 1001356 | SPY (Wormhole)         | SPY    | 18  | 13061480386097         | 60 SPY         |
| 1001357 | Zcash (Wormhole)       | ZEC    | 8   | 674                    | 3 ZEC          |
| 1001358 | NEAR (Wormhole)        | NEAR   | 24  | 2074688796680497925311 | 1,000 NEAR     |

- update batch hash: `0x3fd18baafc6d25090f902d3b10035d7cd1bbbe9e8737ff5ca3594e4250bac1e1`, `length_bound` 288
- `propose` call:
  ```
  0x1902100d021033018b470f00015848797065726c69717569642028576f726d686f6c652901000192246737f1670000000000000000000001000050efe2d6e41a1b00000000000000010101104859504501120033018c470f0001385350592028576f726d686f6c6529010001310ee61ce10b00000000000000000000010000703b1bd2aa4003000000000000000101010c53505901120033018d470f0001405a636173682028576f726d686f6c6529010001a20200000000000000000000000000000100a3e1110000000000000000000000000101010c5a454301080033018e470f00013c4e4541522028576f726d686f6c6529010001bf0cb49768441778700000000000000001000000e83c80d09f3c2e3b0300000000010101104e4541520118008104
  ```

Re-check `NextAssetId` (or, after registration, `LocationAssets`) before reusing any of this hex. If
another asset got registered first, the ids are stale and both batches must be regenerated.
