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
- `common/snowbridge`: the asset table (id, class, Ethereum token, twin) and the twin hubs, shared by
  the probes and `inventory.ts`.
- `contracts/scripts/snowbridge-converter/inventory.ts`: backing reconciliation across Hydration,
  Asset Hub and Ethereum (issuance, SA balance, agent escrow, hub capacity, converter inventory
  against outstanding Snowbridge supply). Works before and after the switch.
- `chopsticks/probes/snowbridgeExit.ts`: call builders (exit XCM, registry, minter, fuse, mint,
  scheduled restore, whitelist wrapper) and a decode check of every proposal against live metadata;
  `snowbridgeFork.ts`: fork specs and enactment helpers.
- `chopsticks/probes/_probeSnowbridgeProposals.ts`: builds the proposals and rehearses them on
  Hydration + Asset Hub + Bridge Hub forks.
- `chopsticks/probes/_probeSnowbridgeExit.ts`: the single-asset variant.
- `chopsticks/probes/_dryRunSnowbridgeTransfer.ts`: decodes a transfer proposal's `calls.inner` and
  replays its messages against live Asset Hub and Bridge Hub (`DryRunApi`).

## Switch

```text
Utility.batch_all
├─ AssetRegistry.update × 20                       Snowbridge location → wh / sb marker
├─ EVMAccounts.set_ntt_minter × rebind             asset id → its NTT spoke
├─ CircuitBreaker.set_asset_category(46, External)
└─ per merge twin
   ├─ AssetRegistry.update(twin, xcm_rate_limit = limit + mint)
   ├─ Currencies.update_balance(converter, twin, + Snowbridge issuance)
   └─ Scheduler.schedule_after(44,400, AssetRegistry.update(twin, xcm_rate_limit = limit))
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
└─ Currencies.update_balance(converter, twin, Δ)   Δ = (issuance − collected) − inventory, if ≠ 0
```

The transfer is built after the switch has enacted, from the live post-switch state: a fresh SA
snapshot and the converter's actual balances. Once Snowbridge is off the SA can only grow, so exact
amounts stay withdrawable, and the Snowbridge supply is frozen, so Δ stays valid between build and
enactment (a conversion moves outstanding supply and inventory by the same amount).

Between the two proposals the converter is live while the backing still sits in the SA: conversions
and NTT exits in that window draw on the hubs' existing escrow. Accepted; if the transfer fails,
pause the converter.

## Constraints

- **Asset Hub barrier.** `AllowTopLevelPaidExecutionFrom` accepts at most 2 assets in the leading
  `WithdrawAsset`. Single-asset messages fit; a batch has to withdraw the DOT fee first, then
  `PayFees`, then the tokens.
- **Snowbridge v2.** One `AccountKey20` beneficiary and at most 8 commands per message. If the
  Ethereum-side unlock reverts, the message is still consumed (`InboundMessageDispatched(success =
  false)`) and the funds stay in the Asset Hub agent, so recipients must be hub managers (plain ERC20
  transfer) or the funder (empty `receive()`). Native ether is paid with a raw `call`;
  `NttManagerWethUnwrap.receive()` would accept and strand it, hence the funder.
- **Deposit limiter.** Root mints go through the circuit breaker's issuance limit (`xcm_rate_limit`
  per 43,200-block period). A period starts at its first deposit and keeps that baseline until it
  ends, so restoring the limit while the mint is still inside its period locks the twin on the next
  deposit (USDT 23's mint is larger than its limit). The switch raises each twin's limit by its mint
  and schedules the restore 44,400 blocks out, after any period holding the mint has closed. The
  raised limit stays live that long; a governance change to the limit in between is overwritten.
- **Destination checks.** A real destination must report the asset's `token()`, LOCKING mode and
  `getPeer(73)` = the Hydration spoke; a real spoke must report the asset precompile and BURNING.
- **Converter checks.** A given `--converter` must be owned by `EMERGENCY_ADMIN`
  (`0xaa7e…aa7e1`), unpaused, paired for all four merges and running this build's implementation
  (runtime code equal up to immutables).
- **Fees.** Each message withdraws 10 DOT from the SA, pays 1 DOT of Asset Hub fees and swaps up to
  the rest for the 0.001 ETH relayer fee; the surplus is refunded. The probe wants the live quote
  covered twice. The DOT spent (2.8 per message in the rehearsal) comes out of the SA's DOT, the
  reserve behind Hydration DOT; the transfer burns nothing on Hydration to match it.

## Running

```sh
cd chopsticks
# rehearsal: switch, then a transfer built on the simulated switch; never submittable
npx tsx probes/_probeSnowbridgeProposals.ts [--spokes spokes.json] [--hubs hubs.json] [--eth-funder 0x…] [--converter 0x…]
# before the switch
npx tsx probes/_probeSnowbridgeProposals.ts --stage switch --final --spokes spokes.json --converter 0x…
# after the switch has enacted
npx tsx probes/_probeSnowbridgeProposals.ts --stage transfer --final --hubs hubs.json --eth-funder 0x… --converter 0x…
npx tsx probes/_dryRunSnowbridgeTransfer.ts
npx tsx probes/_probeSnowbridgeExit.ts --asset 41

cd ../contracts
npx tsx scripts/snowbridge-converter/inventory.ts --converter 0x… [--hubs hubs.json]
forge test --match-path 'test/snowbridge/*'
```

Without `--final`, missing spokes, hubs and funder become placeholders and a converter is deployed on
the fork; the output goes to `chopsticks/probes/snowbridge-{switch,transfer}-proposal.rehearsal.json`
with `submittable: false` and its blockers. With `--final` the probe writes
`snowbridge-{switch,transfer}-proposal.json` only if there are no blockers (placeholders, a
fork-deployed converter, failed destination, spoke, converter or fee checks, any failed rehearsal
check), and exits 1 otherwise. The dry run refuses a proposal that is not submittable.
