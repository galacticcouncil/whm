import { encodeFunctionData, getAddress, pad, parseAbi } from "viem";

import type { MigrationStep } from "./types";

const EMITTER_ABI = parseAbi([
  "function owner() view returns (address)",
  "function landing() view returns (bytes32)",
  "function nttManagerFor(address) view returns (address)",
  "function assetFee(address) view returns (uint256)",
  "function CONSISTENCY_LEVEL() view returns (uint8)",
  "function setLanding(bytes32)",
]);
const ZERO32 = `0x${"00".repeat(32)}`;
/** The Base fast path's consistency level (safe). A literal, as in step 001: no env value reaches it. */
const BASE_FAST_PATH_CONSISTENCY = 201;

/**
 * Sends nothing. Records the Base TC Safe call that ARMS the emitter: `setLanding(pad(landing))`.
 * It is the last act of the switch-on and must not be executed before all of these hold:
 *   - the landing maps Base EURC to asset 44 and authorizes this run's receiver (the TC motion),
 *   - the landing holds the EURC float (the Treasury referendum),
 *   - the superseded Base senders 0x9c00…c4d2 and 0xf5b9…529b read landingDest() = 0,
 *   - the relayer's basejump route for Base is filled and deployed.
 * It also refuses unless the emitter reports CONSISTENCY_LEVEL() = 201 (safe), a literal here and in
 * step 001, never an env value: the level is the implementation's, so an upgrade between 001 and now
 * could have changed it.
 * Before it, `bridgeViaWormhole` reverts `LandingNotSet` before pulling any token.
 */
const step: MigrationStep = {
  name: "011-record-arm-call@emitter",
  description: "Record the Base TC Safe call that arms the emitter, the last switch-on step (no transaction)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };
    const { publicClient } = ctx.wallet.base;

    const emitter = getAddress(ctx.outputs["001-deploy-emitter"].proxyAddress);
    const safe = getAddress(required("BASE_TC_SAFE"));
    const asset = getAddress(required("EURC_SOURCE_ASSET"));
    const manager = getAddress(required("EURC_NTT_MANAGER"));
    const fee = BigInt(required("EURC_FEE_AMOUNT"));
    // Same env value step 007 gave the receiver: invariant 1 by construction.
    const landing = pad(getAddress(required("HYDRATION_LANDING")).toLowerCase() as `0x${string}`, { size: 32 });

    const read = (
      functionName: "owner" | "landing" | "nttManagerFor" | "assetFee" | "CONSISTENCY_LEVEL",
      args: readonly unknown[] = [],
    ) =>
      publicClient.readContract({ address: emitter, abi: EMITTER_ABI, functionName, args } as never) as Promise<unknown>;

    const owner = getAddress((await read("owner")) as string);
    const current = ((await read("landing")) as string).toLowerCase();
    const route = getAddress((await read("nttManagerFor", [asset])) as string);
    const assetFee = (await read("assetFee", [asset])) as bigint;
    const level = Number(await read("CONSISTENCY_LEVEL"));

    if (owner !== safe) throw new Error(`emitter owner ${owner}, expected the Base TC Safe ${safe}`);
    if (current !== ZERO32) throw new Error(`emitter already armed (landing ${current})`);
    if (route !== manager) throw new Error(`emitter settles EURC via ${route}, expected ${manager}`);
    if (assetFee !== fee) throw new Error(`emitter EURC fee ${assetFee}, expected ${fee}`);
    if (level !== BASE_FAST_PATH_CONSISTENCY) {
      throw new Error(`emitter publishes at consistency ${level}, expected ${BASE_FAST_PATH_CONSISTENCY} (safe)`);
    }

    const data = encodeFunctionData({ abi: EMITTER_ABI, functionName: "setLanding", args: [landing] });

    console.log(`\n  LAST switch-on step — Base TC Safe ${safe} transaction:`);
    console.log(`    to:    ${emitter}`);
    console.log(`    value: 0`);
    console.log(`    data:  ${data}   (setLanding(${landing}))`);
    console.log(`  Only after: the TC motion has mapped Base EURC and authorized the receiver, the float is in`);
    console.log(`  the landing, 0x9c00…c4d2 and 0xf5b9…529b read landingDest() = 0, and the relayer route is live.`);
    console.log(`  Disarm again at any time with setLanding(0x00…00).`);

    return { safe, emitter, value: "0", armCalldata: data, landing, consistencyLevel: String(level) };
  },
};

export default step;
