import esbuild from "esbuild";
import { config } from "../../esbuild.config.mjs";

const plugins = [];
const options = {
  ...config,
  bundle: true,
  sourcemap: true,
  packages: "external",
};

const ctx = await esbuild.context({ ...options, plugins });
await ctx.rebuild();
await ctx.watch();
