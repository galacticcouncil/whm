export function optionalArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;

  const value = process.argv[idx + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

export function requiredArg(flag: string): string {
  const value = optionalArg(flag);
  if (!value) {
    throw new Error(`Missing required argument ${flag}.`);
  }
  return value;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}
