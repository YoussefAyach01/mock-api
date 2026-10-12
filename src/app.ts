import { Hono, type Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PLANS, type Config, type Plan } from './config.js';
import type { Db } from './db.js';
import { createKey, findActiveKey, listKeys, revokeKey, type KeyRecord } from './keys.js';
import {
  countCollections,
  countForKey,
  countLive,
  countRecords,
  createCollection,
  createProject,
  createRecord,
  deleteCollection,
  deleteProject,
  deleteRecord,
  findProjectByApiKey,
  getCollection,
  getProject,
  getRecord,
  isProjectId,
  listCollections,
  listRecords,
  updateRecord,
  verifyManageToken,
  type Collection,
  type Project,
} from './projects.js';
import { fakeRecord, validateCollectionSchema, validateRecord } from './schema.js';
import { RateLimiter } from './ratelimit.js';
import { readCapped } from './body.js';

export interface Deps {
  config: Config;
  db: Db;
  now?: () => Date;
}

type ErrStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;
const err = (c: Context, status: ErrStatus, code: string, message: string) =>
  c.json({ error: { code, message } }, status);

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const asset = (name: string) => readFileSync(publicDir + name, 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest();
const safeEqual = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const createBodySchema = z.object({ name: z.string().max(80).optional() }).strict();
const collectionBodySchema = z
  .object({
    name: z.string().min(1).max(60),
    schema: z.unknown(),
    seed: z.number().int().min(0).max(200).optional(),
  })
  .strict();

type Vars = { project: Project };

export function createApp({ config, db, now = () => new Date() }: Deps) {
  const app = new Hono<{ Variables: Vars }>();
  const createLimiter = new RateLimiter(3_600_000);
  const mockLimiterByKey = new RateLimiter();
  const mockLimiterByIp = new RateLimiter();
  const manageLimiter = new RateLimiter();
  const adminLimiter = new RateLimiter();
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/home.js': ['home.js', 'text/javascript; charset=utf-8'],
  };

  const clientIp = (c: Context): string => {
    if (config.TRUST_PROXY === '1') {
      const xff = c.req.header('x-forwarded-for');
      const last = xff?.split(',').pop()?.trim(); // rightmost = added by our own proxy
      if (last) return last.slice(0, 64);
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!c.res.headers.has('Content-Security-Policy')) {
      c.header(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      );
    }
  });

  app.get('/health', (c) => c.json({ ok: true }));
  for (const [path, [file, type]] of Object.entries(files)) {
    app.get(path, (c) => c.body(asset(file), 200, { 'Content-Type': type }));
  }

  const readJson = async (c: Context, limit = 4096): Promise<{ json: unknown } | Response> => {
    const raw = await readCapped(c.req.raw, limit);
    if (!raw) return err(c, 413, 'TOO_LARGE', 'Request body too large.');
    if (!raw.length) return { json: {} };
    try {
      return { json: JSON.parse(raw.toString('utf8')) as unknown };
    } catch {
      return err(c, 400, 'INVALID_JSON', 'Body must be JSON.');
    }
  };

  // --------------------------------------------------------- project admin
  const optionalKey = (c: Context): KeyRecord | null | 'bad' => {
    const k = c.req.header('x-api-key');
    if (!k) return null;
    return findActiveKey(db, k) ?? 'bad';
  };

  app.post('/api/projects', async (c) => {
    const key = optionalKey(c);
    if (key === 'bad') return err(c, 401, 'INVALID_API_KEY', 'Invalid or revoked API key.');
    const plan: Plan = key?.plan ?? 'free';
    const rl = createLimiter.check(key ? `k:${key.id}` : `ip:${clientIp(c)}`, key ? 60 : 10);
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return err(c, 429, 'RATE_LIMITED', 'Too many projects created. Try again later.');
    }
    const body = await readJson(c);
    if (body instanceof Response) return body;
    const parsed = createBodySchema.safeParse(body.json);
    if (!parsed.success)
      return err(c, 400, 'VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid body.');

    const t = now();
    if (countLive(db, t) >= config.MAX_PROJECTS)
      return err(c, 503, 'CAPACITY', 'The service is full right now. Try again later.');
    if (key && countForKey(db, key.id, t) >= PLANS[plan].maxProjects)
      return err(
        c,
        403,
        'PLAN_LIMIT',
        `Your plan allows ${PLANS[plan].maxProjects} live projects.`,
      );

    const { project, manageToken, apiKey } = createProject(db, {
      plan,
      ownerKeyId: key?.id ?? null,
      name: parsed.data.name ?? '',
      now: t,
    });
    return c.json(
      {
        id: project.id,
        manageToken,
        apiKey,
        baseUrl: `${config.PUBLIC_URL}/mock/${project.id}`,
        manageUrl: `${config.PUBLIC_URL}/api/projects/${project.id}`,
        plan: project.plan,
        expiresAt: project.expiresAt,
        limits: PLANS[plan],
      },
      201,
    );
  });

  /** Owner-only guard. Same 404 for unknown id and wrong token: no oracle. */
  const owned = (c: Context): Project | Response => {
    const rl = manageLimiter.check(clientIp(c), 300);
    if (!rl.ok) return err(c, 429, 'RATE_LIMITED', 'Too many requests.');
    const id = c.req.param('id') ?? '';
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m?.[1]) return err(c, 401, 'UNAUTHORIZED', 'Missing manage token.');
    const project = isProjectId(id) ? getProject(db, id, now()) : null;
    if (!project || !verifyManageToken(db, id, m[1]))
      return err(c, 404, 'NOT_FOUND', 'Project not found.');
    return project;
  };

  app.get('/api/projects/:id', (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    return c.json({
      id: p.id,
      plan: p.plan,
      name: p.name,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      collections: listCollections(db, p.id).map((cl) => ({ name: cl.name, schema: cl.schema })),
    });
  });

  app.delete('/api/projects/:id', (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    deleteProject(db, p.id);
    return c.body(null, 204);
  });

  app.post('/api/projects/:id/collections', async (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    const body = await readJson(c, 50_000);
    if (body instanceof Response) return body;
    const parsed = collectionBodySchema.safeParse(body.json);
    if (!parsed.success)
      return err(c, 400, 'VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid body.');
    const schemaResult = validateCollectionSchema(parsed.data.schema);
    if (!schemaResult.ok) return err(c, 400, 'INVALID_SCHEMA', schemaResult.error);
    if (countCollections(db, p.id) >= PLANS[p.plan].maxCollections) {
      return err(
        c,
        403,
        'PLAN_LIMIT',
        `Your plan allows ${PLANS[p.plan].maxCollections} collections per project.`,
      );
    }
    const created = createCollection(db, p.id, parsed.data.name, schemaResult.schema, now());
    if (created === 'duplicate')
      return err(c, 409, 'CONFLICT', 'A collection with that name already exists.');

    const seed = parsed.data.seed ?? 0;
    for (let i = 0; i < seed; i++) createRecord(db, created.id, fakeRecord(created.schema), now());

    return c.json(
      {
        name: created.name,
        schema: created.schema,
        seeded: seed,
        url: `${config.PUBLIC_URL}/mock/${p.id}/${created.name}`,
      },
      201,
    );
  });

  app.delete('/api/projects/:id/collections/:name', (c) => {
    const p = owned(c);
    if (p instanceof Response) return p;
    const ok = deleteCollection(db, p.id, c.req.param('name'));
    return ok ? c.body(null, 204) : err(c, 404, 'NOT_FOUND', 'Collection not found.');
  });

  // ------------------------------------------------------------ admin
  app.use('/admin/*', async (c, next) => {
    const rl = adminLimiter.check(clientIp(c), 30);
    if (!rl.ok) return err(c, 429, 'RATE_LIMITED', 'Too many requests.');
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m?.[1] || !safeEqual(m[1], config.ADMIN_TOKEN))
      return err(c, 401, 'UNAUTHORIZED', 'Admin token required.');
    await next();
  });
  app.post('/admin/keys', async (c) => {
    const parsed = z
      .object({ label: z.string().min(1).max(80), plan: z.enum(['free', 'pro', 'business']) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return err(c, 400, 'VALIDATION', 'label and plan are required.');
    const { key, record } = createKey(db, parsed.data.label, parsed.data.plan);
    return c.json({ key, ...record }, 201);
  });
  app.get('/admin/keys', (c) => c.json({ keys: listKeys(db) }));
  app.delete('/admin/keys/:id', (c) =>
    revokeKey(db, c.req.param('id'))
      ? c.body(null, 204)
      : err(c, 404, 'NOT_FOUND', 'Key not found.'),
  );

  // -------------------------------------------------------- mock REST API
  const findCollection = (c: Context, project: Project): Collection | Response => {
    const name = c.req.param('collection') ?? '';
    const col = getCollection(db, project.id, name);
    return col ?? err(c, 404, 'NOT_FOUND', 'Collection not found.');
  };

  app.use('/mock/:id/*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return c.body(null, 204, CORS);
    const ip = clientIp(c);
    const ipRl = mockLimiterByIp.check(ip, 600);
    if (!ipRl.ok) {
      return err(c, 429, 'RATE_LIMITED', 'Too many requests from this address.');
    }
    const id = c.req.param('id') ?? '';
    const key = c.req.header('x-api-key');
    if (!key) return err(c, 401, 'UNAUTHORIZED', 'x-api-key header required.');
    const project = isProjectId(id) ? findProjectByApiKey(db, key, now()) : null;
    if (!project || project.id !== id) return err(c, 404, 'NOT_FOUND', 'Project not found.');
    const rl = mockLimiterByKey.check(project.id, PLANS[project.plan].requestsPerMin);
    if (!rl.ok) {
      c.header('Retry-After', String(rl.retryAfterSec));
      return err(c, 429, 'RATE_LIMITED', 'Too many requests for this project.');
    }
    c.set('project', project);
    await next();
  });

  app.get('/mock/:id/:collection', (c) => {
    const project = c.get('project') as Project;
    const col = findCollection(c, project);
    if (col instanceof Response) return col;
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .passthrough()
      .safeParse(c.req.query());
    if (!q.success) return err(c, 400, 'VALIDATION', 'Invalid query.');
    const { limit, offset, ...rest } = q.data as { limit: number; offset: number } & Record<
      string,
      string
    >;
    const filters: Record<string, string> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (k in col.schema.properties && typeof v === 'string') filters[k] = v;
    }
    const { items, total } = listRecords(db, col.id, { limit, offset, filters });
    c.header('X-Total-Count', String(total));
    return c.json({
      items: items.map((r) => ({
        id: r.id,
        ...r.data,
        _createdAt: r.createdAt,
        _updatedAt: r.updatedAt,
      })),
      total,
      limit,
      offset,
    });
  });

  app.get('/mock/:id/:collection/:recordId', (c) => {
    const project = c.get('project') as Project;
    const col = findCollection(c, project);
    if (col instanceof Response) return col;
    const r = getRecord(db, col.id, c.req.param('recordId'));
    if (!r) return err(c, 404, 'NOT_FOUND', 'Record not found.');
    return c.json({ id: r.id, ...r.data, _createdAt: r.createdAt, _updatedAt: r.updatedAt });
  });

  app.post('/mock/:id/:collection', async (c) => {
    const project = c.get('project') as Project;
    const col = findCollection(c, project);
    if (col instanceof Response) return col;
    const body = await readJson(c, PLANS[project.plan].maxBodyBytes);
    if (body instanceof Response) return body;
    const errors = validateRecord(col.schema, body.json);
    if (errors.length) return err(c, 400, 'VALIDATION', errors.join('; '));
    if (countRecords(db, col.id) >= PLANS[project.plan].maxRecordsPerCollection) {
      return err(
        c,
        403,
        'PLAN_LIMIT',
        `Your plan allows ${PLANS[project.plan].maxRecordsPerCollection} records per collection.`,
      );
    }
    const r = createRecord(db, col.id, body.json as Record<string, unknown>, now());
    return c.json({ id: r.id, ...r.data, _createdAt: r.createdAt, _updatedAt: r.updatedAt }, 201);
  });

  const putOrPatch = (partial: boolean) => async (c: Context) => {
    const project = c.get('project') as Project;
    const col = findCollection(c, project);
    if (col instanceof Response) return col;
    const existing = getRecord(db, col.id, c.req.param('recordId') ?? '');
    if (!existing) return err(c, 404, 'NOT_FOUND', 'Record not found.');
    const body = await readJson(c, PLANS[project.plan].maxBodyBytes);
    if (body instanceof Response) return body;
    const merged = partial
      ? { ...existing.data, ...(body.json as Record<string, unknown>) }
      : body.json;
    const errors = validateRecord(col.schema, merged, { partial: false });
    if (errors.length) return err(c, 400, 'VALIDATION', errors.join('; '));
    const r = updateRecord(db, col.id, existing.id, merged as Record<string, unknown>, now())!;
    return c.json({ id: r.id, ...r.data, _createdAt: r.createdAt, _updatedAt: r.updatedAt });
  };
  app.put('/mock/:id/:collection/:recordId', putOrPatch(false));
  app.patch('/mock/:id/:collection/:recordId', putOrPatch(true));

  app.delete('/mock/:id/:collection/:recordId', (c) => {
    const project = c.get('project') as Project;
    const col = findCollection(c, project);
    if (col instanceof Response) return col;
    const ok = deleteRecord(db, col.id, c.req.param('recordId'));
    return ok ? c.body(null, 204) : err(c, 404, 'NOT_FOUND', 'Record not found.');
  });

  app.notFound((c) => err(c, 404, 'NOT_FOUND', 'Not found.'));
  app.onError((e, c) => {
    console.error(e);
    return err(c, 500, 'INTERNAL', 'Something went wrong.');
  });
  return app;
}
