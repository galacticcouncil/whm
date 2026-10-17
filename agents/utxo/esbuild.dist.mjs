import esbuild from "esbuild";

import { config } from "../../esbuild.config.mjs";
import { multiEntry } from "./esbuild.entries.mjs";

esbuild.build(multiEntry(config)).catch(() => process.exit(1));
