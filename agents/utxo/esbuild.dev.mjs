import esbuild from "esbuild";
import { spawn } from "node:child_process";

import { config } from "../../esbuild.config.mjs";
import { entryPoints, multiEntry } from "./esbuild.entries.mjs";

// `pnpm dev <app>` — every app is still built, only one is run.
const app = process.argv[2];
if (!app || !(`${app}/app` in entryPoints)) {
  const names = Object.keys(entryPoints).map((e) => e.replace("/app", ""));
  console.error(`Usage: pnpm dev <${names.join("|")}>`);
  process.exit(1);
}

const ctx = await esbuild.context(multiEntry(config));
await ctx.rebuild();
await ctx.watch();

spawn("node", ["--watch", "--env-file=.env", `dist/${app}/app.js`], {
  stdio: "inherit",
});
