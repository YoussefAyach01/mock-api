import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3610),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 chars'),
  DB_PATH: z.string().default('./data/mock-api.db'),
  PUBLIC_URL: z.string().default('http://localhost:3610'),
  /** Set to "1" only behind a reverse proxy you control: then X-Forwarded-For is used for client IPs. */
  TRUST_PROXY: z.enum(['0', '1']).default('0'),
  /** Hard ceiling on live projects so anonymous creation cannot fill the disk. */
  MAX_PROJECTS: z.coerce.number().int().min(1).default(5000),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return schema.parse(env);
}

/** "free" is also what anonymous (no admin-issued API key) users get at project-creation time. */
export const PLANS = {
  free: {
    ttlDays: 14,
    maxCollections: 5,
    maxRecordsPerCollection: 500,
    maxBodyBytes: 20_000,
    requestsPerMin: 120,
    maxProjects: 3,
  },
  pro: {
    ttlDays: 90,
    maxCollections: 30,
    maxRecordsPerCollection: 10_000,
    maxBodyBytes: 100_000,
    requestsPerMin: 1_200,
    maxProjects: 30,
  },
  business: {
    ttlDays: 365,
    maxCollections: 200,
    maxRecordsPerCollection: 100_000,
    maxBodyBytes: 500_000,
    requestsPerMin: 6_000,
    maxProjects: 300,
  },
} as const;
export type Plan = keyof typeof PLANS;
