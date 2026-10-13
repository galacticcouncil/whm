import type { Address } from "viem";

import { WORMHOLE } from "../../chains";
import type { ChainId } from "../../types";

export interface NttRoute {
  token: string;
  /** Where the transfer originates. */
  sourceChain: ChainId;
  /**
   * Origin transceiver, as the Wormhole emitter. Solana routes give the NTT program address —
   * relayer-engine derives the emitter PDA before subscribing. NEAR routes give the emitter itself,
   * `sha256(account_id)` as 32-byte hex.
   */
  sourceEmitter: string;
  /** Destination NttManager on Hydration — what the settlement must be addressed to. */
  manager: Address;
  /** Destination transceiver on Hydration — what we submit the VAA to. */
  transceiver: Address;
}

/**
 * Mainnet routes, from native-token-transfers/ops/tokens/&#42;/deployment.json.
 */
export const ROUTES: NttRoute[] = [
  {
    token: "DAI",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0x99673a01C5779Ebf59399B4B228c1825c0113571",
    manager: "0xcFd576F88C90844AEBF45378Fd09931281D8b14d",
    transceiver: "0xe8660CA48f6f4D98BC48DB7Dd07C1a8E555801eA",
  },
  {
    token: "WBTC",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0x3FE8fBB8505c8dB2264f6Ebc5559c7C2b2647218",
    manager: "0x6BFca089916c045b0Ca4A09B655aF9F926189993",
    transceiver: "0x9a8a1ab288f6749Ce5626DEE1B5d59441BdC187F",
  },
  {
    token: "WETH",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0xbA0Cd32131b8206AF4feB79A1A3aaF0AEfe18b48",
    manager: "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7",
    transceiver: "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae",
  },
  {
    token: "USDC",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0xA108BD5dBc6CE665aEbB6895351e0609c76F8EFc",
    manager: "0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC",
    transceiver: "0x0d7488B39AA64468a709eC3b3d354DeFE539eD97",
  },
  {
    token: "USDT",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0x45c566f6595CF93e639E77cc1bbE57A8D27901c2",
    manager: "0x5E6C488103b47F804824AE15861638af4C436795",
    transceiver: "0xd2a16B736F32Df7C0DE72838837656FE0f85Ac0F",
  },
  {
    token: "sUSDS",
    sourceChain: WORMHOLE.ethereum,
    sourceEmitter: "0x7C236d237BEbBE1b7902131B31b7b3270005a810",
    manager: "0x1973E7044d9A7C7bB2d6ea1693A296a9e4B7E448",
    transceiver: "0x68Ecadd7934D4FcFEABAfB209C95D379B96400cb",
  },
  {
    token: "EURC",
    sourceChain: WORMHOLE.base,
    sourceEmitter: "0xa84b362290b0CFdB55e877dfc633284091e0B3F7",
    manager: "0x8dd1286A29dF5a2785FB638d6fB1598144Cfbc4C",
    transceiver: "0x2e84fac378D67Dc2e11026fB4919E80263a87375",
  },
  {
    token: "SOL",
    sourceChain: WORMHOLE.solana,
    sourceEmitter: "DiGxk55uAQNVzzg2FucPgdrQ4azb5SDvWQvzpzJD3o7J",
    manager: "0x9e200C0f28D92D296b201D96C8269d3CAFFfA9FF",
    transceiver: "0x2F04AcF249091425d51e67EeA3C3161ccE283202",
  },
  {
    token: "jitoSOL",
    sourceChain: WORMHOLE.solana,
    sourceEmitter: "9HFvXujdkXubvmf93gyzkH1g3VPowDrmp85sWsfdcBTh",
    manager: "0xcE73C15B9ED02413066DE5B904A36F8e8f9B5331",
    transceiver: "0xF38D9C3bA6999Dc331b32B416083Fd7e02D17B04",
  },
  {
    token: "PRIME",
    sourceChain: WORMHOLE.solana,
    sourceEmitter: "4T5m5NtRVewiCVzP2mnfeUoMYRqncfkrS21X2dhVCNRT",
    manager: "0xFCaF4aA069C565d25539028970703F01e47D3E0B",
    transceiver: "0x4e7b1E55D2354d4Dc6ABD876096Dc201de0541D1",
  },
  {
    token: "SUI",
    sourceChain: WORMHOLE.sui,
    // Sui VAAs use the EmitterCap id from the deployment manifest, not a contract address.
    sourceEmitter: "0x6afb4a6a9c4e5b6eeed568381ce95a79590f0c17ab8d0c59295826f2775bf832",
    manager: "0x978443f00cAB6b09445140321EC73a221ebFF5F8",
    transceiver: "0xA224D6f4e0E276b34D91bfE6c3A5fE6838322AF7",
  },
  {
    token: "NEAR",
    sourceChain: WORMHOLE.near,
    // ntt-near.hydration-whm.near — deployments/prod/near-ntt-near.json.
    sourceEmitter: "0xd473056b88c2062503ea1425bdea8e87609e3d499b3b4d1809e440df2d7cb9e3",
    manager: "0x374E5239a2342Be6Bf31B410EC03984D03A8b7dE",
    transceiver: "0xc74BcE0b4bC1b06D6e31d8EfAf55e7e148f281d1",
  },
  {
    token: "ZEC",
    sourceChain: WORMHOLE.near,
    // ntt-zec.hydration-whm.near — deployments/prod/near-ntt-zec.json.
    sourceEmitter: "0xca4092420316d55cfbb9a479ca23fdf0f5a0864a80c755b46e071c834fbf3976",
    manager: "0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC",
    transceiver: "0x0dd43A80C6F96019B8f5699Df1890DFa33BdDE85",
  },
];
