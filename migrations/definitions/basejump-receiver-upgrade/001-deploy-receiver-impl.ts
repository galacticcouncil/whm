import type { MigrationStep } from "./types";
import { deployImpl } from "../../actions/basejump-receiver/deployImpl";

const step: MigrationStep = {
  name: "001-deploy-receiver-impl",
  description: "Deploy BasejumpReceiver implementation on Hydration (upgrade is a governance call)",
  action: async (ctx) => {
    const proxy = ctx.env.HYDRATION_RECEIVER as `0x${string}` | undefined;
    if (!proxy || /^0x0+$/.test(proxy)) throw new Error("HYDRATION_RECEIVER is unset or zero");

    const out = await deployImpl({ ...ctx.wallet.hydration, proxy });

    console.log(`\n  Governance call for the proxy owner (${out.proxyOwner}):`);
    console.log(`    to:   ${out.proxyAddress}`);
    console.log(`    data: ${out.upgradeCalldata}`);
    console.log(`    (upgradeToAndCall(${out.implAddress}, 0x); replaces ${out.currentImplAddress})`);
    console.log(`  Build the TC motion: npx tsx chopsticks/probes/_probeBasejumpReceiverUpgrade.ts --impl ${out.implAddress}`);

    return out;
  },
};

export default step;
