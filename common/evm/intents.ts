import {
  bytesToHex,
  concatHex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  numberToHex,
  parseAbi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

/** Hydration's dispatch precompile — runs a SCALE-encoded runtime call as the EVM caller. */
export const DISPATCH = "0x0000000000000000000000000000000000000401";

/** WETH on Hydration: what every ICE trade an order comes from must buy. */
export const WETH_ASSET_ID = 20;

/** WETH's ERC20 precompile: `0x0100000000 | 20` — what `dispatch` pulls. */
export const WETH = "0x0000000000000000000000000000000100000014";

/** `Intent` is pallet 98 in Hydration's runtime; `submit_intent` its call 0. */
const INTENT_PALLET = 98;
const SUBMIT_INTENT = 0;

/** ICE's limit on a forward's `data`. */
export const MAX_FORWARD_DATA = 512;

/** The intents v2 dispatcher, as far as building an order reads it. */
export const DISPATCHER_ABI = parseAbi([
  "struct Quote { address owner; bytes32 quoteId; uint16 maxSlippageBps; uint8 maxFillMultiplier; uint128 minOutPerIn; uint128 minDelivery; uint64 deadline; uint8 recipientKind; address refundTo; string destinationAsset; string recipient; }",
  "function computeTerms(Quote terms) pure returns (bytes)",
  "function computeAuthPath(Quote terms) pure returns (bytes32)",
  "function outPerIn(string destinationAsset) view returns (uint128)",
  "function dispatch(uint256 amount, address depositAddress, uint256 maxRelayFee, Quote terms) returns (uint64)",
]);

/** The terms of one action, as the dispatcher takes them. */
export interface Terms {
  owner: Hex;
  quoteId: Hex;
  maxSlippageBps: number;
  maxFillMultiplier: number;
  minOutPerIn: bigint;
  minDelivery: bigint;
  /** Unix seconds. */
  deadline: bigint;
  /** 0 = withdraw to `recipient` on its chain; 1 = `recipient` is a NEAR intents account. */
  recipientKind: number;
  refundTo: Hex;
  destinationAsset: string;
  recipient: string;
}

/**
 * The terms' encoding and their `auth_path`, read from the dispatcher itself — the bytes the router
 * hashes into the account it signs for — and checked against each other.
 *
 * @param client Hydration public client
 * @param dispatcher The dispatcher
 * @param terms The terms
 * @returns The encoded terms and their `auth_path`
 */
export async function encodeTerms(
  client: PublicClient,
  dispatcher: Hex,
  terms: Terms,
): Promise<{ encoded: Hex; authPath: Hex }> {
  const read = <T>(functionName: "computeTerms" | "computeAuthPath") =>
    client.readContract({ address: dispatcher, abi: DISPATCHER_ABI, functionName, args: [terms] }) as Promise<T>;
  const [encoded, authPath] = await Promise.all([read<Hex>("computeTerms"), read<Hex>("computeAuthPath")]);
  if (keccak256(encoded) !== authPath) throw new Error("computeAuthPath is not keccak256(computeTerms)");
  return { encoded, authPath };
}

/**
 * About what an order of `weth` buys: less the relay ceiling, at the dispatcher's rate, less the
 * terms' slippage. The rail's delivery price comes off too, so it is an upper estimate.
 *
 * @param weth WETH one order bridges, wei
 * @param maxRelayFee The relay ceiling, wei
 * @param outPerIn The dispatcher's rate, destination units per 1e18 wei
 * @param slippageBps The terms' `maxSlippageBps`
 * @returns Destination units
 */
export function estimateOut(weth: bigint, maxRelayFee: bigint, outPerIn: bigint, slippageBps: number): bigint {
  const eth = weth > maxRelayFee ? weth - maxRelayFee : 0n;
  return (((eth * outPerIn) / 10n ** 18n) * (10_000n - BigInt(slippageBps))) / 10_000n;
}

/**
 * What `execute` decodes an order from — the ICE intent's forward data:
 * `abi.encode(depositAddress, maxRelayFee, terms)`.
 *
 * @param depositAddress Where the forwarder deposits on Ethereum
 * @param maxRelayFee The relay ceiling, wei
 * @param terms The encoded terms
 * @returns The forward data
 * @throws When it exceeds ICE's limit
 */
export function forwardData(depositAddress: Hex, maxRelayFee: bigint, terms: Hex): Hex {
  const data = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [depositAddress, maxRelayFee, terms],
  );
  if (hexToBytes(data).length > MAX_FORWARD_DATA) {
    throw new Error(`forward data is ${hexToBytes(data).length} bytes, ICE allows ${MAX_FORWARD_DATA}`);
  }
  return data;
}

/**
 * The relay ceiling the SDK commits an order to: the quoter's estimate of the Ethereum delivery, with
 * headroom.
 *
 * @param quoter The quoter's base url
 * @param marginBps Headroom over the estimate, bps
 * @returns The ceiling, wei
 */
export async function relayFeeCeiling(quoter: string, marginBps = 2000): Promise<bigint> {
  const res = await fetch(`${quoter}/relay-fee?chain=ethereum&marginBps=${marginBps}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`quoter ${res.status}: ${await res.text()}`);
  return BigInt(((await res.json()) as { feeRequested: string }).feeRequested);
}

/** A swap: sell exactly `amountIn`, for at least `amountOut` — never partially. */
export interface SwapIntent {
  kind: "swap";
  assetIn: number;
  assetOut: number;
  amountIn: bigint;
  amountOut: bigint;
}

/** A DCA: `amountIn` every `period` blocks, each for at least `amountOut` and within `slippage` of the oracle. */
export interface DcaIntent {
  kind: "dca";
  assetIn: number;
  assetOut: number;
  /** Per trade. */
  amountIn: bigint;
  /** Per trade, the hard floor. */
  amountOut: bigint;
  /** Parts per million, against ICE's oracle — at most 50%. */
  slippagePpm: number;
  /** Total to sell; none for a rolling DCA. */
  budget?: bigint;
  /** Blocks between trades. */
  period: number;
}

/** An ICE intent, and the contract its resolution is forwarded to. */
export interface IntentInput {
  data: SwapIntent | DcaIntent;
  /** Unix ms. A swap may have one; a DCA must not. */
  deadline?: bigint;
  forward?: { contract: Hex; data: Hex };
}

const u8 = (n: number): Hex => numberToHex(n, { size: 1 });
/** SCALE integers are little-endian. */
const le = (n: bigint | number, bytes: number): Hex =>
  bytesToHex(hexToBytes(numberToHex(BigInt(n), { size: bytes })).reverse());
const option = (value: Hex | undefined): Hex => (value === undefined ? "0x00" : concatHex(["0x01", value]));

/** SCALE compact length. */
function compact(n: number): Hex {
  if (n < 1 << 6) return le(n << 2, 1);
  if (n < 1 << 14) return le((n << 2) | 1, 2);
  if (n < 1 << 30) return le((n << 2) | 2, 4);
  throw new Error(`compact: ${n} too large`);
}

/**
 * `Intent.submit_intent(intent)`, SCALE-encoded as Hydration's runtime defines it:
 *
 * ```
 * IntentInput { data: Swap(SwapParams) | Dca(DcaParams) | MatchFirstSwap, deadline: Option<u64>,
 *               on_resolved: Option<Forward { contract: [u8; 20], data: Vec<u8> }> }
 * ```
 *
 * @param intent The intent
 * @returns The call, for the dispatch precompile
 */
export function encodeSubmitIntent(intent: IntentInput): Hex {
  const d = intent.data;
  const data =
    d.kind === "swap"
      ? concatHex(["0x00", le(d.assetIn, 4), le(d.assetOut, 4), le(d.amountIn, 16), le(d.amountOut, 16), "0x00"])
      : concatHex([
          "0x01",
          le(d.assetIn, 4),
          le(d.assetOut, 4),
          le(d.amountIn, 16),
          le(d.amountOut, 16),
          le(d.slippagePpm, 4),
          option(d.budget === undefined ? undefined : le(d.budget, 16)),
          le(d.period, 4),
        ]);
  const forward = intent.forward
    ? concatHex(["0x00", intent.forward.contract, compact(hexToBytes(intent.forward.data).length), intent.forward.data])
    : undefined;
  return concatHex([
    u8(INTENT_PALLET),
    u8(SUBMIT_INTENT),
    data,
    option(intent.deadline === undefined ? undefined : le(intent.deadline, 8)),
    option(forward),
  ]);
}

/**
 * Submit an ICE intent from an EVM account, through the dispatch precompile: the intent is the
 * account's, and the runtime calls its forward as that account.
 *
 * @param wallet Hydration wallet
 * @param intent The intent
 * @returns The transaction hash, once it succeeded
 * @throws When the dispatch reverts — the runtime refused the intent
 */
export async function submitIntent(
  wallet: { publicClient: PublicClient; walletClient: WalletClient },
  intent: IntentInput,
): Promise<Hex> {
  const { publicClient, walletClient } = wallet;
  const hash = await walletClient.sendTransaction({
    account: walletClient.account!,
    chain: walletClient.chain,
    to: DISPATCH,
    data: encodeSubmitIntent(intent),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`submit_intent reverted in ${hash}`);
  return hash;
}
