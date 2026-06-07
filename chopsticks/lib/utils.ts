/** `JSON.stringify` replacer that renders bigints as decimal strings. */
export const bigintReplacer = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;

/** `JSON.stringify` with bigints rendered as decimal strings. */
export const toJson = (value: unknown, space?: number): string =>
  JSON.stringify(value, bigintReplacer, space);
