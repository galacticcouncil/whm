import type { MigrationStep } from "./types";
import { deployImpl } from "../../actions/basejump-landing/deployImpl";

const step: MigrationStep = {
  name: "001-deploy-landing-impl",
  description: "Deploy BasejumpLanding implementation on Hydration (upgrade is a governance call)",
  action: async (ctx) => {
    const proxy = ctx.env.HYDRATION_LANDING as `0x${string}` | undefined;
    if (!proxy || /^0x0+$/.test(proxy)) throw new Error("HYDRATION_LANDING is unset or zero");
    const receiver = ctx.env.HYDRATION_RECEIVER as `0x${string}` | undefined;
    if (!receiver || /^0x0+$/.test(receiver)) throw new Error("HYDRATION_RECEIVER is unset or zero");

    const out = await deployImpl({ ...ctx.wallet.hydration, proxy, receiver });

    console.log(`\n  Governance call for the proxy owner (${out.proxyOwner}):`);
    console.log(`    to:   ${out.proxyAddress}`);
    console.log(`    data: ${out.upgradeCalldata}`);
    console.log(`    (upgradeToAndCall(${out.implAddress}, 0x); replaces ${out.currentImplAddress})`);
    console.log(`  Build the TC motion: npx tsx chopsticks/probes/_probeBasejumpLandingUpgrade.ts --impl ${out.implAddress}`);

    return out;
  },
};

export default step;
