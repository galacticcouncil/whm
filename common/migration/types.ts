/** Structured output from a migration step — flat key-value pairs */
export type StepOutput = Record<string, string>;

/** Context passed to each step's action function */
export interface StepContext<W = unknown> {
  /** Outputs from all previously completed steps, keyed by step name */
  outputs: Record<string, StepOutput>;
  /** Wallet context — typically a map of chain → wallet for multi-chain migrations */
  wallet: W;
  /** Process environment variables (loaded from env file + shell) */
  env: NodeJS.ProcessEnv;
}

/** A single migration step — exported as default from each NNN-*.ts file */
export interface MigrationStep<W = unknown> {
  /** Unique name within the migration (used as key in state file) */
  name: string;
  /** Human-readable description shown during execution */
  description: string;
  /** The action to execute — receives context, returns structured output */
  action: (ctx: StepContext<W>) => Promise<StepOutput>;
}

/** Migration config — exported as default from each migration's index.ts */
export interface MigrationConfig<W = unknown> {
  /** Unique identifier matching the folder name, e.g. "basejump-base" */
  name: string;
  /** Human-readable description */
  description: string;
  /**
   * Env vars holding deployer private keys this migration needs.
   * The runner validates these are present in process.env before invoking setup().
   * E.g. ["PK_LANDING", "PK_PROXY", "PK"] for a multi-chain basejump migration.
   */
  pks: string[];
  /**
   * Create wallet context from the loaded env vars.
   * PKs are read from process.env using keys declared in `pks`.
   * Called once before step execution.
   */
  setup: (env: NodeJS.ProcessEnv) => W;
}

/** Full migration = config + auto-discovered steps (assembled by runner) */
export interface Migration<W = unknown> extends MigrationConfig<W> {
  steps: MigrationStep<W>[];
}

// -- Persisted state types --

export interface StepState {
  name: string;
  status: "pending" | "completed" | "failed";
  output: StepOutput | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface MigrationState {
  migration: string;
  environment: string;
  startedAt: string;
  completedAt: string | null;
  steps: StepState[];
}
