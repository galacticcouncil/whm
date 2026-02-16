# WHM Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              MONOREPO (pnpm)                                    │
│                                                                                 │
│  ┌──────────┐   ┌──────────────────────────┐   ┌────────────────────────────┐   │
│  │  common/ │   │    platforms/solana/     │   │      platforms/evm/        │   │
│  │          │   │                          │   │                            │   │
│  │  - args  │◄──┤  Anchor Program (Rust)   │   │  Foundry Contracts (Sol)   │──►│
│  │  - utils │   │  TypeScript Scripts      │   │  TypeScript Scripts        │   │
│  └──────────┘   └──────────────────────────┘   └────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════════════
                              CROSS-CHAIN DATA FLOW
═══════════════════════════════════════════════════════════════════════════════════


    SOLANA                       WORMHOLE               MOONBEAM (EVM)                HYDRATION (EVM)
   ─────────                     ─────────              ──────────────               ────────────────

 ┌──────────────────┐
 │  Kamino Scope    │
 │  Oracle          │
 │  (price feeds)   │
 └────────┬─────────┘
          │ read price
          ▼
 ┌───────────────────┐       ┌───────────────┐
 │ Message Emitter   │       │               │
 │ (Anchor Program)  │──────►│   Wormhole    │
 │                   │  VAA  │   Guardians   │
 │ - send_message()  │       │   Network     │
 │ - send_price()    │       │               │
 │                   │       └───────┬───────┘
 │ ABI-encodes:      │               │
 │  action + assetId │               │ signed VAA
 │  + price + ts     │               │
 └───────────────────┘               │
                                     │
                                     └──────────────────────┐
                                                            ▼
                                                  ┌───────────────────────┐
                                                  │  MessageReceiver      │
                                                  │  (UUPS Proxy)         │
                                                  │                       │
                                                  │  - VAA validation     │
                                                  │  - replay protection  │
                                                  │  - emitter auth       │
                                                  └───────────┬───────────┘
                                                              │ inherits
                                                              ▼
                                                  ┌───────────────────────┐
                                                  │  MessageDispatcher    │
                                                  │  (UUPS Proxy)         │
                                                  │                       │
                                                  │  Routes by action:    │
                                                  │  ┌──────────────────┐ │
                                                  │  │ ACTION_PRICE (1) │ │
                                                  │  │ → price handler  │ │
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
                              EVM CONTRACT HIERARCHY
═══════════════════════════════════════════════════════════════════════════════════


 ┌─────────────────────────────────────────────────────────────┐
 │                    MessageReceiver                          │
 │                  (UUPSUpgradeable)                          │
 │                                                             │
 │  Responsibilities:                                          │
 │  - Receive Wormhole relayer messages                        │
 │  - Receive direct VAA submissions                           │
 │  - Validate emitter chain & address                         │
 │  - Prevent VAA replay (hash tracking)                       │
 ├─────────────────────────────────────────────────────────────┤
 │                          │ extends                          │
 │                          ▼                                  │
 │              ┌───────────────────────┐                      │
 │              │  MessageDispatcher    │                      │
 │              │                       │                      │
 │              │  - Decode ABI payload │                      │
 │              │  - Route by action ID │                      │
 │              │  - Store prices       │                      │
 │              │  - Map assetId→oracle │                      │
 │              └───────────┬───────────┘                      │
 │                          │ calls                            │
 │                          ▼                                  │
 │              ┌───────────────────────┐                      │
 │              │  XcmTransactor        │                      │
 │              │                       │                      │
 │              │  - transact(to, data) │                      │
 │              │  - XCM msg assembly   │                      │
 │              │  - Auth: dispatcher   │                      │
 │              └───────────────────────┘                      │
 └─────────────────────────────────────────────────────────────┘


 Utility Libraries:
 ┌────────────────┐  ┌─────────────────┐  ┌──────────────┐
 │  ScaleCodec    │  │ DerivedAccount  │  │   Blake2b    │
 │                │  │                 │  │              │
 │ compact u32    │  │ H160 derivation │  │ blake2b-256  │
 │ compact u128   │  │ from XCM        │  │ for MDA      │
 │ LE u64/u256    │  │ multilocation   │  │ computation  │
 │ Vec<u8>        │  │ (child/sibling) │  │              │
 └────────────────┘  └─────────────────┘  └──────────────┘


═══════════════════════════════════════════════════════════════════════════════════
                            SOLANA PROGRAM STRUCTURE
═══════════════════════════════════════════════════════════════════════════════════


 ┌────────────────────────────────────────────────────────────────┐
 │               message-emitter (Anchor)                         │
 │               ID: BwqNpyPVEYwdy4EbbTCdiWmGNQn9kqf2p47zZcaV7irC │
 │                                                                │
 │  Instructions:                                                 │
 │  ┌───────────────┐  ┌─────────────────────┐  ┌───────────┐     │
 │  │  initialize   │  │ register_price_feed │  │   send    │     │
 │  │               │  │                     │  │           │     │
 │  │ Config acct   │  │ PDA: [price_feed,   │  │ message / │     │
 │  │ (owner)       │  │       asset_id]     │  │ price     │     │
 │  └───────────────┘  └─────────────────────┘  └─────┬─────┘     │
 │                                                    │           │
 │  State:                    Oracle:                 │           │
 │  ┌───────────┐  ┌────────────────────────┐         │           │
 │  │  Config   │  │  Kamino Scope          │◄────────┘           │
 │  │  - owner  │  │  - DatedPrice          │  read price         │
 │  ├───────────┤  │  - normalize to 18 dec │                     │
 │  │ PriceFeed │  └────────────────────────┘                     │
 │  │ - assetId │                                                 │
 │  │ - index   │  Helpers:                                       │
 │  └───────────┘  ┌────────────────────────┐                     │
 │                 │  abi_encode_string()   │                     │
 │                 │  abi_encode_price()    │                     │
 │                 │  (EVM-compatible)      │                     │
 │                 └────────────────────────┘                     │
 └────────────────────────────────────────────────────────────────┘


═══════════════════════════════════════════════════════════════════════════════════
                              ENCODING PIPELINE
═══════════════════════════════════════════════════════════════════════════════════


 Solana (send_price)                Moonbeam                      Hydration

 ┌─────────────┐    Wormhole     ┌──────────────┐   XCM        ┌──────────────┐
 │ ABI encode: │    VAA          │ ABI decode:  │   message    │ SCALE decode │
 │             │ ──────────────► │              │ ────────────►│              │
 │ action (u8) │                 │ action       │              │ evm.call     │
 │ assetId(u32)│                 │ assetId      │  SCALE enc:  │ → setPrice() │
 │ price(u256) │                 │ price        │  - gas limit │              │
 │ timestamp   │                 │ timestamp    │  - fee asset │              │
 └─────────────┘                 └──────────────┘  - call data └──────────────┘
                                                   - dest addr


═══════════════════════════════════════════════════════════════════════════════════
                                    AGENTS (OFF-CHAIN)
═══════════════════════════════════════════════════════════════════════════════════


 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                          Broadcaster                                        │
 │                                                                             │
 │  Periodically triggers price broadcasts on Solana.                          │
 │                                                                             │
 │  ┌─────────┐    send_price()    ┌──────────────────┐    VAA    ┌──────────┐ │
 │  │  Timer  │───────────────────►│ Message Emitter  │─────────► │ Wormhole │ │
 │  └─────────┘                    │ (Solana)         │           └──────────┘ │
 │                                 └──────────────────┘                        │
 └─────────────────────────────────────────────────────────────────────────────┘

 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                          Relayer                                            │
 │                                                                             │
 │  Watches for signed VAAs and submits them to Moonbeam.                      │
 │                                                                             │
 │  ┌──────────┐  poll signed VAA   ┌──────────────────┐ receiveMessage()      │
 │  │ Wormhole │───────────────────►│    VAA Relayer   │──────────────────┐    │
 │  └──────────┘                    └──────────────────┘                  │    │
 │                                                                        ▼    │
 │                                                   ┌───────────────────────┐ │
 │                                                   │ Receiver / Dispatcher │ │
 │                                                   │ (Moonbeam)            │ │
 │                                                   └───────────────────────┘ │
 └─────────────────────────────────────────────────────────────────────────────┘
```
