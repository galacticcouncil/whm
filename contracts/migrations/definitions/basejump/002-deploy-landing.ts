import type { MigrationStep } from "../../types";

const step: MigrationStep = {
  name: "deploy-landing",
  description: "Deploy BasejumpLanding variant UUPS proxy",
  action: async (ctx) => {
    const action = ctx.env.LANDING_DEPLOY_ACTION;
    if (!action) {
      console.log("  ⚠️  No landing deploy");
      return {};
    }

    const { deploy } = await import(`../../actions/basejumpLanding/${action}`);

    return await deploy({
      ...ctx.wallet,
    });
  },
};

export default step;
