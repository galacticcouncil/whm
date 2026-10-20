import { pool } from "./db";

const USAGE = `usage:
  node admin.js cursors [chain]                     every cursor, and how far each has got
  node admin.js rewind <chain> <block> [cursor...]  re-scan from <block>; no cursor = all on the chain
  node admin.js rebuild <reader>                    empty a reader's tables and replay the store

A rewind re-reads the chain: events already stored are skipped, new ones reach every reader. A
rebuild re-applies the store to one reader — for a new leg or changed flow logic over old events.
Both are requests the running ingest or reader applies at its next tick; nothing needs stopping.`;

/**
 * File a rewind or a rebuild for the running processes to apply, or list the cursors.
 *
 * @param argv The arguments after the script.
 */
async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;

  if (cmd === "cursors") {
    const r = await pool.query(
      `SELECT chain, role AS cursor, block_number FROM cursors
        WHERE $1::text IS NULL OR chain = $1 ORDER BY chain, role`,
      [args[0] ?? null],
    );
    console.table(r.rows);
    return;
  }

  if (cmd === "rewind" && args.length >= 2) {
    const [chain, block, ...cursors] = args;
    if (!/^\d+$/.test(block)) throw new Error(`not a block number: ${block}`);
    for (const cursor of cursors.length ? cursors : ["*"]) {
      await pool.query(
        `INSERT INTO rewinds (chain, cursor, block_number) VALUES ($1, $2, $3)
         ON CONFLICT (chain, cursor) DO UPDATE
           SET block_number = LEAST(rewinds.block_number, EXCLUDED.block_number), requested_at = NOW()`,
        [chain, cursor, block],
      );
      console.log(`rewind ${chain}/${cursor} to ${block} — applied at ingest's next tick`);
    }
    return;
  }

  if (cmd === "rebuild" && args.length === 1) {
    await pool.query(
      `INSERT INTO rebuilds (reader) VALUES ($1) ON CONFLICT (reader) DO UPDATE SET requested_at = NOW()`,
      [args[0]],
    );
    console.log(`rebuild ${args[0]} — applied at its next drain`);
    return;
  }

  console.log(USAGE);
  process.exitCode = 1;
}

main(process.argv.slice(2))
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
