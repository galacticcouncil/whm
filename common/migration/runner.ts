import fs from "node:fs";
import path from "node:path";

import type {
  Migration,
  MigrationConfig,
  MigrationState,
  MigrationStep,
  StepContext,
  StepOutput,
} from "./types";

// ---------------------------------------------------------------------------
// Env file loading
// ---------------------------------------------------------------------------

function loadEnvFile(envsDir: string, environment: string, migration: string): void {
  const filePath = path.join(envsDir, environment, `${migration}.env`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Env file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    const value = raw.replace(/\s+#.*$/, "");
    // Shell env vars take precedence over file values
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Migration loading — auto-discover steps from folder
// ---------------------------------------------------------------------------

async function loadMigration(definitionsDir: string, name: string): Promise<Migration> {
  const migrationDir = path.join(definitionsDir, name);
  if (!fs.existsSync(migrationDir)) {
    throw new Error(
      `Migration folder not found: ${migrationDir}\n` +
        `  Available: ${fs.readdirSync(definitionsDir).join(", ")}`,
    );
  }

  // Load config from index.ts
  const configModule = await import(path.join(migrationDir, "index.ts"));
  const config: MigrationConfig = configModule.default;

  // Auto-discover step files: NNN-*.ts sorted by filename
  const files = fs
    .readdirSync(migrationDir)
    .filter((f) => /^\d+-.+\.ts$/.test(f))
    .sort();

  if (files.length === 0) {
    throw new Error(`No step files found in ${migrationDir}`);
  }

  const steps: MigrationStep[] = [];
  for (const file of files) {
    const stepModule = await import(path.join(migrationDir, file));
    steps.push(stepModule.default);
  }

  const names = steps.map((s) => s.name);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new Error(`Duplicate step name: "${dupe}" in migration "${name}"`);

  return { ...config, steps };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

function stateFilePath(deploymentsDir: string, environment: string, migration: string): string {
  const dir = path.join(deploymentsDir, environment);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${migration}.json`);
}

function loadState(
  deploymentsDir: string,
  environment: string,
  migration: string,
): MigrationState | null {
  const filePath = stateFilePath(deploymentsDir, environment, migration);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function saveState(deploymentsDir: string, state: MigrationState): void {
  const filePath = stateFilePath(deploymentsDir, state.environment, state.migration);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n");
}

function createState(migration: Migration, environment: string): MigrationState {
  return {
    migration: migration.name,
    environment,
    startedAt: new Date().toISOString(),
    completedAt: null,
    steps: migration.steps.map((step) => ({
      name: step.name,
      status: "pending",
      output: null,
      error: null,
      startedAt: null,
      completedAt: null,
    })),
  };
}

function buildStepContext(state: MigrationState, walletCtx: unknown): StepContext {
  const outputs: Record<string, StepOutput> = {};
  for (const step of state.steps) {
    if (step.status === "completed" && step.output) {
      outputs[step.name] = step.output;
    }
  }
  return {
    outputs,
    wallet: walletCtx,
    env: process.env,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunOptions {
  migrationName: string;
  environment: string;
  /** Reset this step and all subsequent steps, then run */
  from?: string;
  /** Pause after completing this step (inclusive) */
  pauseAt?: string;
  /** Directory containing definitions/ and envs/ folders */
  migrationsDir: string;
  /** Directory for state output files */
  deploymentsDir: string;
}

export async function runMigration(options: RunOptions): Promise<void> {
  const { migrationName, environment, from, pauseAt, migrationsDir, deploymentsDir } = options;

  const definitionsDir = path.join(migrationsDir, "definitions");
  const envsDir = path.join(migrationsDir, "envs");

  // Load env file: {migrationsDir}/envs/{environment}/{migration}.env
  loadEnvFile(envsDir, environment, migrationName);

  // Auto-discover and assemble migration from folder
  const migration = await loadMigration(definitionsDir, migrationName);

  // Validate PK env vars are present
  for (const pkVar of migration.pks) {
    if (!process.env[pkVar]) {
      throw new Error(
        `Migration "${migration.name}" requires env var "${pkVar}" (declared in pks). ` +
          `Set it in your shell or root .env file.`,
      );
    }
  }

  // Let the migration build its wallet context from loaded env vars
  const walletCtx = migration.setup(process.env);

  // Load existing state (resume) or create fresh state
  let state = loadState(deploymentsDir, environment, migration.name);

  if (state) {
    console.log(`\nResuming migration: ${migration.name} [${environment}]`);

    // Guard: existing steps must not change, but new steps may be appended
    const existingNames = state.steps.map((s) => s.name);
    const definedNames = migration.steps.map((s) => s.name);

    const existingPrefix = definedNames.slice(0, existingNames.length);
    if (JSON.stringify(existingNames) !== JSON.stringify(existingPrefix)) {
      throw new Error(
        "Migration steps changed since last run. " +
          "Delete the state file to start fresh, or restore the original definition.\n" +
          `  State file: ${stateFilePath(deploymentsDir, environment, migration.name)}`,
      );
    }

    // Append newly added steps to state
    for (let i = existingNames.length; i < definedNames.length; i++) {
      state.steps.push({
        name: definedNames[i],
        status: "pending",
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
      });
      state.completedAt = null;
    }
  } else {
    state = createState(migration, environment);
    console.log(`\nStarting migration: ${migration.name} [${environment}]`);
  }

  // --from: reset target step and everything after it
  if (from) {
    const fromIdx = state.steps.findIndex((s) => s.name === from);
    if (fromIdx === -1) {
      throw new Error(
        `Step "${from}" not found. Available: ${state.steps.map((s) => s.name).join(", ")}`,
      );
    }
    console.log(`Resetting from step: ${from}`);
    for (let i = fromIdx; i < state.steps.length; i++) {
      state.steps[i] = {
        ...state.steps[i],
        status: "pending",
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
      };
    }
    saveState(deploymentsDir, state);
  }

  // Print overview
  console.log(`\nSteps:`);
  for (const stepState of state.steps) {
    const icon = stepState.status === "completed" ? "✓" : stepState.status === "failed" ? "✗" : "○";
    const desc = migration.steps.find((s) => s.name === stepState.name)!.description;
    console.log(`  ${icon} ${stepState.name} — ${desc}`);
  }
  console.log();

  if (pauseAt) {
    const stopIdx = state.steps.findIndex((s) => s.name === pauseAt);
    if (stopIdx === -1) {
      throw new Error(
        `Step "${pauseAt}" not found. Available: ${state.steps.map((s) => s.name).join(", ")}`,
      );
    }
  }

  // Execute steps sequentially
  for (let i = 0; i < migration.steps.length; i++) {
    const step = migration.steps[i];
    const stepState = state.steps[i];

    if (stepState.status === "completed") {
      console.log(`⏭  ${step.name} (completed)`);
      if (pauseAt && step.name === pauseAt) break;
      continue;
    }

    console.log(`▶  ${step.name} — ${step.description}`);
    stepState.startedAt = new Date().toISOString();
    stepState.status = "pending";

    try {
      const ctx = buildStepContext(state, walletCtx);
      const output = await step.action(ctx);

      stepState.status = "completed";
      stepState.output = output;
      stepState.error = null;
      stepState.completedAt = new Date().toISOString();

      console.log(`✓  ${step.name}`);
      for (const [key, value] of Object.entries(output)) {
        console.log(`   ${key}: ${value}`);
      }

      if (pauseAt && step.name === pauseAt) {
        saveState(deploymentsDir, state);
        console.log(`\n⏸  Paused after: ${pauseAt}\n`);
        return;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stepState.status = "failed";
      stepState.error = message;
      saveState(deploymentsDir, state);

      console.error(`\n✗  ${step.name}`);
      console.error(`   Error: ${message}`);
      console.error(`\n   To retry: run the same command again.`);
      if (i + 1 < migration.steps.length) {
        console.error(`   To skip:  --from ${migration.steps[i + 1].name}`);
      }
      process.exit(1);
    }

    // Persist after each step — crash-safe
    saveState(deploymentsDir, state);
  }

  state.completedAt = new Date().toISOString();
  saveState(deploymentsDir, state);

  const filePath = stateFilePath(deploymentsDir, state.environment, state.migration);
  console.log(`\n✓ Migration complete: ${migration.name}`);
  console.log(`  State: ${path.relative(process.cwd(), filePath)}\n`);
}
