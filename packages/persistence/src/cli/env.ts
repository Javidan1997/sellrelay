export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable ${name} (see .env.example)`);
    process.exit(2);
  }
  return v;
}
