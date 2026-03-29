import path from "node:path";

import * as args from "../utils/args";
import { runMigration } from "./runner";

export async function run(): Promise<void> {
  const migrationName = args.requiredArg("--migration");
  const environment = args.requiredArg("--env");
  const privateKey = args.requiredArg("--pk");
  const from = args.optionalArg("--from");
  const pauseAt = args.optionalArg("--pause-at");
  const migrationsDir = path.resolve("migrations");
  const deploymentsDir = path.resolve("deployments");

  await runMigration({
    migrationName,
    environment,
    privateKey,
    from: from ?? undefined,
    pauseAt: pauseAt ?? undefined,
    migrationsDir,
    deploymentsDir,
  });
}
