import esbuild from "esbuild";
import { writeFileSync } from "fs";
import { config } from "../../esbuild.config.mjs";

esbuild
  .build({
    ...config,
    bundle: true,
    format: "esm",
    packages: "external",
  })
  .then(({ metafile }) => {
    writeFileSync("build-meta.json", JSON.stringify(metafile));
  })
  .catch(() => process.exit(1));
