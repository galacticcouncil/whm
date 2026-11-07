import { encodeFunctionData, getAddress, pad, parseAbi } from "viem";

import type { MigrationStep } from "./types";

const LANDING_ABI = parseAbi([
  "function owner() view returns (address)",
  "function destAssetFor(address) view returns (address)",
  "function authorizedBridges(address) view returns (bool)",
  "function setDestAsset(address,address)",
  "function setAuthorizedBridge(address,bool)",
]);

const MANAGER_ABI = parseAbi([
  "function token() view returns (address)",
  "function getPeer(uint16) view returns ((bytes32 peerAddress, uint8 tokenDecimals))",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Sends nothing. Records the two landing calls the TC motion carries, built from this run's own
 * receiver (005) so no address is copied by hand, and refuses if the landing is not in the state
 * the motion expects.
 */
const step: MigrationStep = {
  name: "010-record-eurc-route@landing",
  description: "Record the landing calls for the TC motion that opens the corridor (no transaction)",
  action: async (ctx) => {
    const required = (k: string) => {
      if (!ctx.env[k]) throw new Error(`Missing ${k}`);
      return ctx.env[k] as string;
    };
    const { publicClient } = ctx.wallet.hydration;

    const landing = getAddress(required("HYDRATION_LANDING"));
    const sourceAsset = getAddress(required("EURC_SOURCE_ASSET"));
    const destAsset = getAddress(required("EURC_DEST_ASSET"));
    const receiver = getAddress(ctx.outputs["005-deploy-receiver"].proxyAddress);
    const hydrationManager = getAddress(required("EURC_NTT_MANAGER_HYDRATION"));
    const baseManager = getAddress(required("EURC_NTT_MANAGER"));

    // The destination asset is not taken on trust from env: it must be what the settlement leg
    // actually delivers, i.e. the token of the Hydration manager that peers with the Base one.
    const token = getAddress(
      (await publicClient.readContract({ address: hydrationManager, abi: MANAGER_ABI, functionName: "token" })) as string,
    );
    const peer = (await publicClient.readContract({
      address: hydrationManager,
      abi: MANAGER_ABI,
      functionName: "getPeer",
      args: [Number(required("WORMHOLE_ID_BASE"))],
    })) as { peerAddress: string };
    if (token !== destAsset) {
      throw new Error(`EURC_DEST_ASSET ${destAsset} is not the Hydration EURC manager's token() ${token}`);
    }
    if (peer.peerAddress.toLowerCase() !== pad(baseManager, { size: 32 }).toLowerCase()) {
      throw new Error(`Hydration manager ${hydrationManager} peers with ${peer.peerAddress}, not ${baseManager}`);
    }

    const read = (functionName: "owner" | "destAssetFor" | "authorizedBridges", args: readonly unknown[] = []) =>
      publicClient.readContract({ address: landing, abi: LANDING_ABI, functionName, args } as never) as Promise<unknown>;

    const owner = getAddress((await read("owner")) as string);
    const currentDest = getAddress((await read("destAssetFor", [sourceAsset])) as string);
    const authorized = (await read("authorizedBridges", [receiver])) as boolean;

    // Any other mapping means the landing changed since this migration was written: stop, do not
    // hand the TC a motion that overwrites a route nobody reviewed.
    if (currentDest !== ZERO && currentDest !== destAsset) {
      throw new Error(`landing maps ${sourceAsset} to ${currentDest}, expected ${ZERO} or ${destAsset}`);
    }

    const setDestAssetCalldata = encodeFunctionData({
      abi: LANDING_ABI,
      functionName: "setDestAsset",
      args: [sourceAsset, destAsset],
    });
    const setAuthorizedBridgeCalldata = encodeFunctionData({
      abi: LANDING_ABI,
      functionName: "setAuthorizedBridge",
      args: [receiver, true],
    });

    console.log(`\n  TC motion for the landing owner (${owner}), to = ${landing}, in this order:`);
    console.log(`    1. setDestAsset(${sourceAsset}, ${destAsset})  current=${currentDest}`);
    console.log(`       data: ${setDestAssetCalldata}`);
    console.log(`    2. setAuthorizedBridge(${receiver}, true)  current=${authorized}`);
    console.log(`       data: ${setAuthorizedBridgeCalldata}`);
    console.log(`  Build and enact it on a fork: npx tsx chopsticks/probes/_probeBasejumpBaseGoLive.ts --receiver ${receiver}`);

    return {
      landing,
      landingOwner: owner,
      receiver,
      sourceAsset,
      destAsset,
      destAssetBefore: currentDest,
      receiverAuthorizedBefore: String(authorized),
      setDestAssetCalldata,
      setAuthorizedBridgeCalldata,
    };
  },
};

export default step;
