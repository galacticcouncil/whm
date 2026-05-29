# EVM Oracle Emitter Schema

```
═══════════════════════════════════════════════════════════════════════════════════
                           CROSS-CHAIN DATA FLOW (ETHEREUM SOURCE)
═══════════════════════════════════════════════════════════════════════════════════


   ETHEREUM                       WORMHOLE               MOONBEAM (EVM)                HYDRATION (EVM)
  ──────────                     ─────────              ──────────────               ────────────────

┌──────────────────┐
│  wstETH          │
│  0x7f39…2Ca0     │
│  stEthPerToken() │
└────────┬─────────┘
         │ staticcall
         │ (uint256 18-dec)
         ▼
┌───────────────────┐       ┌───────────────┐
│  OracleEmitter    │       │               │
│  (UUPS Proxy)     │──────►│   Wormhole    │
│                   │  VAA  │   Guardians   │
│ - send(assetId)   │       │   Network     │
│ - feeds[assetId]  │       │               │
│ - registerFeed()  │       └───────┬───────┘
│                   │               │
│ ABI-encodes:      │               │ signed VAA
│  action + assetId │               │ (chainId = 2)
│  + price + ts     │               │
└───────────────────┘               │
         ▲                          │
         │ staticcall               └──────────────────────┐
         │ (uint256 18-dec)                                ▼
┌────────┴─────────┐                              ┌───────────────────────┐
│  apyUSD          │                              │  MessageReceiver      │
│  0x38ee…8a6a     │                              │  (UUPS Proxy)         │
│  convertToAssets │                              │                       │
│  (1e18)          │                              │  - VAA validation     │
└──────────────────┘                              │  - replay protection  │
                                                  │  - emitter auth       │
                                                  │    (chainId=2 → addr) │
                                                  └───────────┬───────────┘
                                                              │ inherits
                                                              ▼
                                                  ┌───────────────────────┐
                                                  │  MessageDispatcher    │
                                                  │  (UUPS Proxy)         │
                                                  │                       │
                                                  │  Routes by action:    │
                                                  │  ┌──────────────────┐ │
                                                  │  │ ACTION_RATE (2)  │ │
                                                  │  │ → rate handler   │ │
                                                  │  └────────┬─────────┘ │
                                                  └───────────┼───────────┘
                                                              │ calls
                                                              ▼
                                                  ┌───────────────────────┐       ┌────────────────────┐
                                                  │  XcmTransactor        │       │                    │
                                                  │  (UUPS Proxy)         │       │  Hydration         │
                                                  │                       │  XCM  │  Parachain         │
                                                  │  - SCALE encoding     │──────►│                    │
                                                  │  - XCM precompile     │       │  evm.call →        │
                                                  │    (0x0817)           │       │  Oracle.setPrice() │
                                                  │  - derived H160 addr  │       │                    │
                                                  └───────────────────────┘       └────────────────────┘


═══════════════════════════════════════════════════════════════════════════════════
                           ORACLEEMITTER CONTRACT STRUCTURE
═══════════════════════════════════════════════════════════════════════════════════


┌─────────────────────────────────────────────────────────────────────────────┐
│                       OracleEmitter (UUPSUpgradeable)                       │
│                                                                             │
│  Storage:                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  wormhole          IWormhole       — Wormhole core bridge           │    │
│  │  nonce             uint32          — global publish nonce           │    │
│  │  owner             address         — admin                          │    │
│  │  feeds             mapping(bytes32 ⇒ Feed)                          │    │
│  │                                                                     │    │
│  │  struct Feed {                                                      │    │
│  │    address source;       // wstETH, apyUSD vault, …                 │    │
│  │    bytes   call;         // full calldata for staticcall            │    │
│  │  }                                                                  │    │
│  │                                                                     │    │
│  │  // action is hard-coded to 2 (RATE) in send(); sources must        │    │
│  │  // return 18-decimal uint256 natively (no normalisation).          │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Functions:                                                                 │
│  ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐     │
│  │  initialize        │  │  registerFeed      │  │  send              │     │
│  │  (Wormhole core)   │  │  (admin)           │  │  (permissionless,  │     │
│  │                    │  │                    │  │   payable)         │     │
│  └────────────────────┘  └────────────────────┘  └─────────┬──────────┘     │
│                                                            │                │
│                          ┌─────────────────────────────────┘                │
│                          ▼                                                  │
│             ┌────────────────────────────┐                                  │
│             │  _readSource(feed)         │                                  │
│             │  staticcall + decode       │                                  │
│             │  uint256 (18-dec native)   │                                  │
│             └─────────────┬──────────────┘                                  │
│                           │                                                 │
│                           ▼                                                 │
│             ┌────────────────────────────┐                                  │
│             │  abi.encode(               │                                  │
│             │    ACTION_RATE_UPDATE = 2, │                                  │
│             │    assetId, rate, ts)      │                                  │
│             └─────────────┬──────────────┘                                  │
│                           │                                                 │
│                           ▼                                                 │
│             ┌────────────────────────────┐                                  │
│             │  wormhole.publishMessage   │                                  │
│             │  (nonce, payload, 200)     │                                  │
│             └────────────────────────────┘                                  │
└─────────────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════════════
                                ENCODING PIPELINE
═══════════════════════════════════════════════════════════════════════════════════


  Ethereum (send)                  Moonbeam                       Hydration

  ┌─────────────┐    Wormhole    ┌──────────────┐   XCM         ┌──────────────┐
  │ ABI encode: │    VAA         │ ABI decode:  │   message     │ SCALE decode │
  │             │ ──────────────►│              │ ─────────────►│              │
  │ action = 2  │                │ action       │               │ evm.call     │
  │ assetId(b32)│                │ assetId      │   SCALE enc:  │ → setPrice() │
  │ rate (u256) │                │ rate         │   - gas limit │              │
  │  18-dec     │                │  ÷ 1e10      │   - fee asset │              │
  │ timestamp   │                │  → 8-dec     │   - call data └──────────────┘
  └─────────────┘                └──────────────┘   - dest addr
                                                    (Hydration
                                                     oracle EVM
                                                     contract)


═══════════════════════════════════════════════════════════════════════════════════
                              FEED REGISTRATION FORMAT
═══════════════════════════════════════════════════════════════════════════════════


  registerFeed(assetId, source, call)

  Action is hard-coded to ACTION_RATE_UPDATE (2) in send().
  Source must return uint256 at 18 decimals natively.


  wstETH (rate)
  ─────────────
    assetId = keccak256("WSTETH")
    source  = 0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0
    call    = abi.encodeWithSelector(0x035faf82)          // stEthPerToken()

  apyUSD (rate)
  ─────────────
    assetId = keccak256("APYUSD")
    source  = 0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A
    call    = abi.encodeCall(IERC4626.convertToAssets, (1e18))


═══════════════════════════════════════════════════════════════════════════════════
                          AGENT (OFF-CHAIN) — FUTURE STATE
═══════════════════════════════════════════════════════════════════════════════════


┌─────────────────────────────────────────────────────────────────────────────┐
│                      broadcaster (extended)                                 │
│                                                                             │
│  Same orchestration loop, two chain adapters.                               │
│                                                                             │
│  ┌─────────┐                       ┌──────────────────┐                     │
│  │  Timer  │──┬───── solana ──────►│ Solana emitter   │──► Wormhole         │
│  └─────────┘  │     adapter        │ (Anchor program) │                     │
│               │                    └──────────────────┘                     │
│               │                                                             │
│               └───── ethereum ────►┌──────────────────┐                     │
│                     adapter        │ OracleEmitter    │──► Wormhole         │
│                                    │ (Solidity proxy) │                     │
│                                    └──────────────────┘                     │
│                                                                             │
│  Both adapters share:                                                       │
│   - thresholds.json (per-assetId change threshold)                          │
│   - full-refresh interval                                                   │
│   - change-detect → send                                                    │
│   - state.json (last value, sentAt)                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```
