import esbuild from "esbuild";
import { config } from "../../esbuild.config.mjs";

esbuild
  .build({
    ...config,
    format: "cjs",
    bundle: true,
  })
  .catch(() => process.exit(1));
