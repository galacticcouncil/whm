# Snowbridge → NTT

## Abstract

Hydration holds 20 Ethereum assets bridged over Snowbridge. Each is an ORML `Token` backed 1:1 by
Hydration's sovereign account (SA) on Asset Hub, `13cKp89Uh2yWgTG28JA1QEvPUMjEPKejqkjHKf9zqLiFKjH6`.
This moves them onto Wormhole NTT the way the Moonbeam MRL exit did: retire the Snowbridge route,
switch the assets to NTT, then move the whole frozen backing from the SA over Snowbridge v2 into the
NTT hub escrows on Ethereum.

Two whitelisted governance proposals (`Whitelist.dispatch_whitelisted_call_with_preimage`):

- **switch**: Snowbridge off and NTT on for every asset; the backing stays frozen in the SA.
- **transfer**: the frozen backing goes to the hubs, one Snowbridge message per hub.

## Asset classes

| class | assets | switch | transfer |
|---|---|---|---|
| rebind | tBTC, apyUSD, ETH, wstETH, PAXG, TRAC, AAVE, LINK, SKY, LDO, ENA, sUSDe | location → `wh` provenance, `set_ntt_minter(id, spoke)` | → its new hub (ETH → `WethHubFunder`) |
| merge | Snowbridge USDC, USDT, WETH, WBTC | location → `sb` marker, converter inventory minted | → existing hub 21 / 23 / 20 / 19 |
| retire | LBTC, CFG, sUSDS, sUSDat | location → `sb` marker | stays in the SA |

Rebind assets keep their asset id, balances and venues. Merge assets convert 1:1 into the NTT asset
that already exists for the same token.

## Components

- `contracts/src/snowbridge/SnowbridgeConverter.sol`: one-way 1:1 conversion of a Snowbridge asset
  into its NTT twin on Hydration (both currency precompiles), out of inventory minted by governance at
  the switch. Pairs must have equal decimals. Owner or pauser can pause; only the owner resumes.
- `contracts/src/snowbridge/WethHubFunder.sol`: Snowbridge recipient for native ETH. `receive()` is
  empty; a permissionless `fund()` wraps the balance and sends the WETH to one NTT hub fixed at
  deployment. No owner.
- `contracts/scripts/snowbridge-converter/inventory.ts`: backing reconciliation across Hydration,
  Asset Hub and Ethereum (issuance, SA balance, agent escrow, hub capacity, converter inventory).
- `chopsticks/probes/snowbridgeExit.ts`: call builders (exit XCM, registry, minter, fuse, mint,
  whitelist wrapper); `snowbridgeFork.ts`: fork specs and enactment helpers.
- `chopsticks/probes/_probeSnowbridgeProposals.ts`: builds both proposals and rehearses them on
  Hydration + Asset Hub + Bridge Hub forks.
- `chopsticks/probes/_probeSnowbridgeExit.ts`: the single-asset variant.
- `chopsticks/probes/_dryRunSnowbridgeTransfer.ts`: replays the transfer proposal against live
  Asset Hub and Bridge Hub (`DryRunApi`).

## Switch

```text
Utility.batch_all
├─ AssetRegistry.update × 20                       Snowbridge location → wh / sb marker
├─ EVMAccounts.set_ntt_minter × rebind             asset id → its NTT spoke
├─ CircuitBreaker.set_asset_category(46, External)
└─ per merge twin
   ├─ AssetRegistry.update(twin, xcm_rate_limit = limit + mint)
   └─ Currencies.update_balance(converter, twin, + Snowbridge issuance)
```

## Transfer

```text
Utility.batch_all
├─ PolkadotXcm.send(Asset Hub) × destination       executes as the SA
│  ├─ WithdrawAsset(DOT + asset) · PayFees(DOT)
│  ├─ SetAppendix(RefundSurplus, DepositAsset → SA)
│  ├─ ExchangeAsset(DOT → ETH relayer fee)
│  └─ InitiateTransfer(Ethereum, ReserveWithdraw asset, preserve_origin)
│     └─ Gateway UnlockNativeToken → hub manager (escrow donation) or WethHubFunder
├─ Currencies.update_balance(converter, twin, ±Δ)  only if Snowbridge issuance moved
└─ AssetRegistry.update(twin, xcm_rate_limit = original)
```

Build the transfer after the switch has enacted, from a fresh SA snapshot. Once Snowbridge is off,
the SA can only grow, so exact amounts stay withdrawable.

## Constraints

- **Asset Hub barrier.** `AllowTopLevelPaidExecutionFrom` accepts at most 2 assets in the leading
  `WithdrawAsset`. Single-asset messages fit; a batch has to withdraw the DOT fee first, then
  `PayFees`, then the tokens.
- **Snowbridge v2.** One `AccountKey20` beneficiary and at most 8 commands per message. If the
  Ethereum-side unlock reverts, the message is still consumed (`InboundMessageDispatched(success =
  false)`) and the funds stay in the Asset Hub agent, so recipients must be hub managers (plain ERC20
  transfer) or the funder (empty `receive()`). Native ether is paid with a raw `call`;
  `NttManagerWethUnwrap.receive()` would accept and strand it, hence the funder.
- **Deposit limiter.** Root mints go through the circuit breaker's per-period issuance limit
  (`xcm_rate_limit`). Over the limit the excess is reserved and the asset locked for minting, so the
  switch raises each twin's limit by its mint and the transfer restores it.
- **Recipient checks.** The probe refuses a real destination unless its `token()`, LOCKING mode and
  `getPeer(73)` match the Hydration spoke.

## Running

```sh
cd chopsticks
npx tsx probes/_probeSnowbridgeProposals.ts --spokes spokes.json --hubs hubs.json --eth-funder 0x… --converter 0x…
npx tsx probes/_dryRunSnowbridgeTransfer.ts
npx tsx probes/_probeSnowbridgeExit.ts --asset 41

cd ../contracts
npx tsx scripts/snowbridge-converter/inventory.ts --converter 0x…
forge test --match-path 'test/snowbridge/*'
```

Without `--spokes`, `--hubs`, `--eth-funder` and `--converter`, the probe uses placeholder
addresses and deploys a converter on the fork. Proposal calldata is written to
`chopsticks/probes/snowbridge-{switch,transfer}-proposal.json`.
