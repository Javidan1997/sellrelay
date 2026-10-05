import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  DEPLOY_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
  API_PORT: z.coerce.number().int().default(8080),
  API_HOST: z.string().default('0.0.0.0'),
  INTERNAL_METRICS_PORT: z.coerce.number().int().default(9464),
  DATABASE_URL_API: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  SHELL_PROXY_SECRET: z.string().default(''),
  PRIVACY_HASH_KEY: z.string().min(16).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
});

export type ApiConfig = z.infer<typeof schema> & { corsOrigins: string[] };

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    corsOrigins: parsed.CORS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
