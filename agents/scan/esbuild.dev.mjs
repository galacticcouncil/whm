import esbuild from "esbuild";
import { spawn } from "node:child_process";
import { config } from "../../esbuild.config.mjs";

const options = {
  ...config,
  bundle: true,
  sourcemap: true,
  packages: "external",
};

const ctx = await esbuild.context(options);
await ctx.rebuild();
await ctx.watch();

spawn("node", ["--watch", "--env-file=.env", config.outfile], {
  stdio: "inherit",
});
