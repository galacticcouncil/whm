/**
 * What is deployed where, one object per protocol, keyed by chain. Addresses only — where indexing
 * starts belongs to a watch entry, in watch.ts.
 *
 * Only the corridors actually running are listed.
 */

/**
 * The Wormhole cores. NEAR's, Solana's and Sui's are only ever read through our own accounts — on
 * Sui, the package its events are typed by.
 */
export const WORMHOLE_CORE = {
  hydration: "0x3792a6d63c31941B2805181771795D9176fA82A1",
  ethereum: "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B",
  base: "0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6",
  hyperevm: "0x7C0faFc4384551f063e05aee704ab943b8B53aB3",
  robinhood: "0x141fBa8AD5D61bdaB45A047cF60b5Ad9784987FB",
  near: "contract.wormhole_crypto.near",
  solana: "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",
  sui: "0x5306f64e312b581766351c07af79c72fcb1cd25147157fdc2f8ad76de9a3fb6a",
} as const;

/** A token's NTT leg on an EVM chain. */
export interface EvmLeg {
  manager: string;
  transceiver: string;
}

/** On Solana: the manager program, which is its own transceiver, and the emitter PDA it publishes as. */
export interface SolanaLeg {
  program: string;
  emitter: string;
}

/** On Sui: the manager's shared state, and the emitter cap its transceiver publishes as. */
export interface SuiLeg {
  state: string;
  emitter: string;
}

/** A token's leg on any chain — a NEAR leg is its account. */
export type NttLeg = EvmLeg | SolanaLeg | SuiLeg | string;

/**
 * NTT corridors, one per token, keyed by chain — from hydration-ntt's ops/tokens/<token>/deployment.json.
 * The home chain locks, Hydration burns. NEAR's legs are one account each, manager and transceiver in
 * one.
 */
export const NTT = {
  weth: {
    hydration: {
      manager: "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7",
      transceiver: "0x8acce9CA511d5D7213F8C3f813B8916087cd00ae",
    },
    ethereum: {
      manager: "0x283B14B5Dd352e32154Df014EA96834F395E04b6",
      transceiver: "0xbA0Cd32131b8206AF4feB79A1A3aaF0AEfe18b48",
    },
    robinhood: {
      manager: "0xB1A2ABCbC1FA276212f6eD239645161DeeA9861a",
      transceiver: "0x1352881a04cb9f9f5fB8442bc925e99EC15D3642",
    },
  },
  usdc: {
    hydration: {
      manager: "0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC",
      transceiver: "0x0d7488B39AA64468a709eC3b3d354DeFE539eD97",
    },
    ethereum: {
      manager: "0x447b2c7485A3d6813F8197E605b10BcCD8dd8398",
      transceiver: "0xA108BD5dBc6CE665aEbB6895351e0609c76F8EFc",
    },
  },
  usdt: {
    hydration: {
      manager: "0x5E6C488103b47F804824AE15861638af4C436795",
      transceiver: "0xd2a16B736F32Df7C0DE72838837656FE0f85Ac0F",
    },
    ethereum: {
      manager: "0x9fbd9F16cE7Fa17097E91cc36DC1B7b47aDCa9De",
      transceiver: "0x45c566f6595CF93e639E77cc1bbE57A8D27901c2",
    },
  },
  dai: {
    hydration: {
      manager: "0xcFd576F88C90844AEBF45378Fd09931281D8b14d",
      transceiver: "0xe8660CA48f6f4D98BC48DB7Dd07C1a8E555801eA",
    },
    ethereum: {
      manager: "0x804F123f75cCa0A9c0Cba341F82f4A4DA86a5259",
      transceiver: "0x99673a01C5779Ebf59399B4B228c1825c0113571",
    },
  },
  wbtc: {
    hydration: {
      manager: "0x6BFca089916c045b0Ca4A09B655aF9F926189993",
      transceiver: "0x9a8a1ab288f6749Ce5626DEE1B5d59441BdC187F",
    },
    ethereum: {
      manager: "0x081b76AC3cFb65DCe93961d66cea44A74EC8Ef28",
      transceiver: "0x3FE8fBB8505c8dB2264f6Ebc5559c7C2b2647218",
    },
  },
  susds: {
    hydration: {
      manager: "0x1973E7044d9A7C7bB2d6ea1693A296a9e4B7E448",
      transceiver: "0x68Ecadd7934D4FcFEABAfB209C95D379B96400cb",
    },
    ethereum: {
      manager: "0x5085A4863f89eC9553F70187EE73B5aAe0fd14b5",
      transceiver: "0x7C236d237BEbBE1b7902131B31b7b3270005a810",
    },
  },
  eurc: {
    hydration: {
      manager: "0x8dd1286A29dF5a2785FB638d6fB1598144Cfbc4C",
      transceiver: "0x2e84fac378D67Dc2e11026fB4919E80263a87375",
    },
    base: {
      manager: "0xD1dc3517732c98502b5c1ba2389AcA9E9016d89a",
      transceiver: "0xa84b362290b0CFdB55e877dfc633284091e0B3F7",
    },
  },
  hdx: {
    hydration: {
      manager: "0x16Ac5B8d9078ed4cf5A522F907fd9dDb6C8841f1",
      transceiver: "0xdDE268D8B89834f6EF213002651D0586Ced646b9",
    },
    robinhood: {
      manager: "0xf1a5fE4252D9a1C39b0Fb9DE1F19049ee57ED188",
      transceiver: "0x97Cd0d08c376005d09afcC47fa9ce0C384fbA406",
    },
  },
  hollar: {
    hydration: {
      manager: "0x4188f147eec68921C1ee2d72898a263722a76844",
      transceiver: "0xE1d75C3c712BC61eBE892312F3455A67EC5D4799",
    },
    robinhood: {
      manager: "0xE58D508743DD36368946D5A72A7dcD7cE960cE12",
      transceiver: "0x27afd50e83379a53458446E9d5F4a557B5f55c19",
    },
  },
  spy: {
    hydration: {
      manager: "0x4382cC762FdbB90d756FF5F2f099a76281f1A2aF",
      transceiver: "0x9fAF16E590352B61ab5542af2560D54Fc62E97aA",
    },
    robinhood: {
      manager: "0x963835C20884dE59E6988030eB49D4D0eA24a26d",
      transceiver: "0x283B14B5Dd352e32154Df014EA96834F395E04b6",
    },
  },
  hype: {
    hydration: {
      manager: "0x76FA328577Ee8A0E1872eD182c1bcd0A2dB47750",
      transceiver: "0xe74f52D5816174D070Dc7DC0ef8cC80dd6eFc160",
    },
    hyperevm: {
      manager: "0xdcDd08BFB7b3B9381149A852Ba5F69Bd5d87676f",
      transceiver: "0xe3eD8E1217AB419123D54E2F0850BC736b595D68",
    },
  },
  near: {
    hydration: {
      manager: "0x374E5239a2342Be6Bf31B410EC03984D03A8b7dE",
      transceiver: "0xc74BcE0b4bC1b06D6e31d8EfAf55e7e148f281d1",
    },
    near: "ntt-near.hydration-whm.near",
  },
  zec: {
    hydration: {
      manager: "0xe20cED5f5798cD4FeBc7aE182309b9f51345e0cC",
      transceiver: "0x0dd43A80C6F96019B8f5699Df1890DFa33BdDE85",
    },
    near: "ntt-zec.hydration-whm.near",
  },
  sol: {
    hydration: {
      manager: "0x9e200C0f28D92D296b201D96C8269d3CAFFfA9FF",
      transceiver: "0x2F04AcF249091425d51e67EeA3C3161ccE283202",
    },
    solana: {
      program: "DiGxk55uAQNVzzg2FucPgdrQ4azb5SDvWQvzpzJD3o7J",
      emitter: "5J12e7mMcbbN3VkCrUPfZp2bDHMH3t1rKvxGcwuN53wx",
    },
  },
  jitosol: {
    hydration: {
      manager: "0xcE73C15B9ED02413066DE5B904A36F8e8f9B5331",
      transceiver: "0xF38D9C3bA6999Dc331b32B416083Fd7e02D17B04",
    },
    solana: {
      program: "9HFvXujdkXubvmf93gyzkH1g3VPowDrmp85sWsfdcBTh",
      emitter: "HgxvrPomT84AxgxknddAcC1iW9ysqHxmeoiKNZmQcovs",
    },
  },
  prime: {
    hydration: {
      manager: "0xFCaF4aA069C565d25539028970703F01e47D3E0B",
      transceiver: "0x4e7b1E55D2354d4Dc6ABD876096Dc201de0541D1",
    },
    solana: {
      program: "4T5m5NtRVewiCVzP2mnfeUoMYRqncfkrS21X2dhVCNRT",
      emitter: "GiTY93vtrK4jZZchrxdV9r28JByRs7Ary2rsTPyPabJc",
    },
  },
  sui: {
    hydration: {
      manager: "0x978443f00cAB6b09445140321EC73a221ebFF5F8",
      transceiver: "0xA224D6f4e0E276b34D91bfE6c3A5fE6838322AF7",
    },
    sui: {
      state: "0xa0bc45e0384140dc125f273eda89cad1434f5dee430726cf6364bdcceba1e9a3",
      emitter: "0x25437da9f99dfab32c1a275663f51cd5c99eb867ab4d1f630e3799c5e68215da",
    },
  },
} as const;

/** Every token's leg on a chain. */
export function nttLegs(chain: string): NttLeg[] {
  return Object.values(NTT).flatMap((t) => {
    const leg = (t as Record<string, NttLeg>)[chain];
    return leg ? [leg] : [];
  });
}

/**
 * Intents: placed on Hydration, forwarded on Ethereum. The emitter's Wormhole messages are the
 * forwarding instructions, and its sequence counts intents alone, from zero — unlike the NTT
 * manager's, which every corridor riding that token shares.
 */
export const INTENT = {
  emitter: "0x98f1ebC9dcC8Ab7bA54D83C98500e9e313F793f2",
  receiver: "0x2173F6ecE25768e7EFc5199f70f8783d88Ba63c8",
} as const;

/**
 * Basejump: the emitter on Ethereum (deployments/prod/basejump-ethereum.json), paid out of the
 * landing pool on Hydration. Several independent landings merge into one view, so both are lists.
 */
export const BASEJUMP = {
  emitter: ["0xa72e2bf29c840eb93adbb9ee1aa41580f01c9944"],
  landing: ["0x70e9b12c3b19cb5f0e59984a5866278ab69df976"],
} as const;

/**
 * UTXO coins through Omni: the coin's emitter on Hydration a withdrawal leaves by; our `UtxoWithdraw`
 * on NEAR, which signs each withdrawal for the account derived from its destination; and Omni's
 * connector on NEAR, which a deposit is proven, minted and handed to the coin's NTT manager on.
 */
export const UTXO = {
  zec: {
    emitter: "0xb3e365a6241683d5d4ef2701de6bedc16dcc259e",
    withdraw: "withdraw-zec.hydration-whm.near",
    connector: "zcash-connector.bridge.near",
  },
} as const;

/** Where a relay's updates land: the `OracleReceiver` on the destination chain. */
export interface OracleReceiver {
  chain: string;
  address: string;
}

/**
 * Oracle relays, keyed by the source chain (deployments/prod/oracle-relay-<chain>.json): the emitter
 * publishing each update, and the receiver writing it into the destination's oracles. Solana's
 * emitter is a program publishing as its emitter PDA.
 */
export const ORACLE = {
  ethereum: {
    emitter: "0xfbf682642a6a28760e717b637f12d014bd5db4b9",
    receiver: { chain: "hydration", address: "0x6913770466fed4dbc24337cd7f1ae92af4321083" },
  },
  solana: {
    program: "2knjvgqZKtU3nV1r9RaLshS9JYWMerZ1ysSFcDyTVsdn",
    emitter: "3FVzVAw85CaMEN8aLXi1qQN3GDGL45SbFFvb4DMZjwJ2",
    receiver: { chain: "hydration", address: "0x582e2fac5af62dc024396b5e7f549c72273a69c3" },
  },
  robinhood: {
    emitter: "0x9fbd9f16ce7fa17097e91cc36dc1b7b47adca9de",
    receiver: { chain: "hydration", address: "0x3b6e3469d8e64e306f235838e0fdf7b4d60a39ce" },
  },
  hydration: {
    emitter: "0x3f5cc44141a52529323f9be42dbb98fda7c1d066",
    receiver: { chain: "robinhood", address: "0x060f1ef6bb1c7ab31d2bbc3d2ae47e590952b958" },
  },
} as const;
