import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { hashKey } from '../src/keys.js';

const ADMIN = 'a'.repeat(32);
const config = {
  PORT: 3610,
  ADMIN_TOKEN: ADMIN,
  DB_PATH: ':memory:',
  PUBLIC_URL: 'http://x',
  TRUST_PROXY: '0' as const,
  MAX_PROJECTS: 5000,
};

function setup(over: Partial<typeof config> = {}) {
  let t = new Date('2026-09-20T10:00:00Z').getTime();
  const clock = { advance: (ms: number) => (t += ms) };
  const db = openDb(':memory:');
  const app = createApp({ config: { ...config, ...over }, db, now: () => new Date(t) });
  return { db, app, clock };
}
type App = ReturnType<typeof setup>['app'];
interface Created {
  id: string;
  manageToken: string;
  apiKey: string;
  baseUrl: string;
  manageUrl: string;
}
async function createProject(app: App, body: unknown = {}, headers: Record<string, string> = {}) {
  const r = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Created & { error?: { code: string } } };
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const apiKey = (k: string) => ({ 'x-api-key': k });

const todoSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 140 },
    done: { type: 'boolean' },
  },
  required: ['title'],
};

async function withCollection(app: App, name = 'todos', schema: unknown = todoSchema) {
  const { json: p } = await createProject(app);
  const r = await app.request(`${p.manageUrl.replace('http://x', '')}/collections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(p.manageToken) },
    body: JSON.stringify({ name, schema }),
  });
  return { p, col: (await r.json()) as { name: string; url: string }, status: r.status };
}

describe('smoke', () => {
  it('serves health and the landing page', async () => {
    const { app } = setup();
    expect((await app.request('/health')).status).toBe(200);
    expect((await app.request('/')).status).toBe(200);
  });
});

describe('project + collection creation', () => {
  it('creates a project with a manage token and api key', async () => {
    const { app } = setup();
    const { status, json } = await createProject(app, { name: 'demo' });
    expect(status).toBe(201);
    expect(json.manageToken).toMatch(/^mkmt_/);
    expect(json.apiKey).toMatch(/^mkapi_/);
  });

  it('rejects an unknown body field', async () => {
    const { app } = setup();
    expect((await createProject(app, { evil: 1 })).status).toBe(400);
  });

  it('creates a collection from a JSON schema and rejects an invalid one', async () => {
    const { app } = setup();
    const { col, status } = await withCollection(app);
    expect(status).toBe(201);
    expect(col.name).toBe('todos');

    const { p } = await withCollection(app, 'a');
    const bad = await app.request(`/api/projects/${p.id}/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(p.manageToken) },
      body: JSON.stringify({ name: 'bad', schema: { type: 'string' } }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects a duplicate collection name', async () => {
    const { app } = setup();
    const { p } = await withCollection(app, 'todos');
    const dup = await app.request(`/api/projects/${p.id}/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(p.manageToken) },
      body: JSON.stringify({ name: 'todos', schema: todoSchema }),
    });
    expect(dup.status).toBe(409);
  });

  it('can seed fake records at creation time', async () => {
    const { app } = setup();
    const { json: p } = await createProject(app);
    const r = await app.request(`/api/projects/${p.id}/collections`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(p.manageToken) },
      body: JSON.stringify({ name: 'todos', schema: todoSchema, seed: 5 }),
    });
    expect((await r.json()).seeded).toBe(5);
    const list = await app.request(`/mock/${p.id}/todos`, { headers: apiKey(p.apiKey) });
    expect(((await list.json()) as { total: number }).total).toBe(5);
  });
});

describe('mock CRUD', () => {
  it('requires an api key, rejects a project id mismatch', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    expect((await app.request(`/mock/${p.id}/todos`)).status).toBe(401);
    const { json: other } = await createProject(app);
    expect(
      (await app.request(`/mock/${p.id}/todos`, { headers: apiKey(other.apiKey) })).status,
    ).toBe(404);
  });

  it('full CRUD lifecycle', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    const h = { 'content-type': 'application/json', ...apiKey(p.apiKey) };

    const create = await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ title: 'buy milk' }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; title: string };
    expect(created.title).toBe('buy milk');

    const got = await app.request(`/mock/${p.id}/todos/${created.id}`, {
      headers: apiKey(p.apiKey),
    });
    expect(got.status).toBe(200);

    const patched = await app.request(`/mock/${p.id}/todos/${created.id}`, {
      method: 'PATCH',
      headers: h,
      body: JSON.stringify({ done: true }),
    });
    expect(patched.status).toBe(200);

    const put = await app.request(`/mock/${p.id}/todos/${created.id}`, {
      method: 'PUT',
      headers: h,
      body: JSON.stringify({ title: 'replaced' }),
    });
    expect(put.status).toBe(200);
    expect(((await put.json()) as { done?: boolean }).done).toBeUndefined();

    const list = await app.request(`/mock/${p.id}/todos`, { headers: apiKey(p.apiKey) });
    expect(((await list.json()) as { total: number }).total).toBe(1);

    const del = await app.request(`/mock/${p.id}/todos/${created.id}`, {
      method: 'DELETE',
      headers: apiKey(p.apiKey),
    });
    expect(del.status).toBe(204);
    expect(
      (await app.request(`/mock/${p.id}/todos/${created.id}`, { headers: apiKey(p.apiKey) }))
        .status,
    ).toBe(404);
  });

  it('rejects writes that violate the schema', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    const h = { 'content-type': 'application/json', ...apiKey(p.apiKey) };
    const noTitle = await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ done: true }),
    });
    expect(noTitle.status).toBe(400);
    const extra = await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ title: 'x', evil: 1 }),
    });
    expect(extra.status).toBe(400);
  });

  it('filters by a query param matching a schema field', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    const h = { 'content-type': 'application/json', ...apiKey(p.apiKey) };
    await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ title: 'a', done: true }),
    });
    await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ title: 'b', done: false }),
    });
    const r = await app.request(`/mock/${p.id}/todos?done=true`, { headers: apiKey(p.apiKey) });
    const body = (await r.json()) as { items: { title: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.title).toBe('a');
  });

  it('paginates with limit/offset and reports X-Total-Count', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    const h = { 'content-type': 'application/json', ...apiKey(p.apiKey) };
    for (let i = 0; i < 5; i++) {
      await app.request(`/mock/${p.id}/todos`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ title: `t${i}` }),
      });
    }
    const r = await app.request(`/mock/${p.id}/todos?limit=2&offset=1`, {
      headers: apiKey(p.apiKey),
    });
    const body = (await r.json()) as {
      items: unknown[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(r.headers.get('x-total-count')).toBe('5');
  });

  it('a collection in another project is not reachable through this one', async () => {
    const { app } = setup();
    const { p: a } = await withCollection(app, 'todos');
    const { p: b } = await withCollection(app, 'todos');
    const h = { 'content-type': 'application/json', ...apiKey(a.apiKey) };
    await app.request(`/mock/${a.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ title: 'a-secret' }),
    });
    const r = await app.request(`/mock/${b.id}/todos`, { headers: apiKey(b.apiKey) });
    expect(((await r.json()) as { total: number }).total).toBe(0);
  });

  it('enforces the per-collection record cap for the plan', async () => {
    const { app, db } = setup();
    const { p } = await withCollection(app);
    const h = { 'content-type': 'application/json', ...apiKey(p.apiKey) };
    db.prepare("UPDATE projects SET plan = 'free'").run();
    // free plan cap is 500; shrink by seeding close to the limit directly in storage to keep this test fast.
    const colRow = db.prepare('SELECT id FROM collections WHERE name = ?').get('todos') as {
      id: string;
    };
    const stmt = db.prepare(
      'INSERT INTO records (id, collection_id, seq, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (let i = 0; i < 500; i++) {
      stmt.run(
        `seed-${i}`,
        colRow.id,
        i + 1,
        JSON.stringify({ title: `t${i}` }),
        '2026-09-20T10:00:00Z',
        '2026-09-20T10:00:00Z',
      );
    }
    const r = await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ title: 'over' }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: { code: string } };
    expect(body.error.code).toBe('PLAN_LIMIT');
  });

  it('rejects an oversized body', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    const big = 'x'.repeat(30_000);
    const r = await app.request(`/mock/${p.id}/todos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...apiKey(p.apiKey) },
      body: JSON.stringify({ title: big }),
    });
    expect(r.status).toBe(413);
  });
});

describe('project lifecycle and admin', () => {
  it('owner can read and delete; manage token is required', async () => {
    const { app } = setup();
    const { p } = await withCollection(app);
    const get = await app.request(`/api/projects/${p.id}`, { headers: auth(p.manageToken) });
    expect(get.status).toBe(200);
    expect((await app.request(`/api/projects/${p.id}`)).status).toBe(401);
    const del = await app.request(`/api/projects/${p.id}`, {
      method: 'DELETE',
      headers: auth(p.manageToken),
    });
    expect(del.status).toBe(204);
    expect((await app.request(`/mock/${p.id}/todos`, { headers: apiKey(p.apiKey) })).status).toBe(
      404,
    );
  });

  it('projects expire after their plan TTL', async () => {
    const { app, clock } = setup();
    const { p } = await withCollection(app);
    clock.advance(15 * 86_400_000);
    expect((await app.request(`/mock/${p.id}/todos`, { headers: apiKey(p.apiKey) })).status).toBe(
      404,
    );
    expect(
      (await app.request(`/api/projects/${p.id}`, { headers: auth(p.manageToken) })).status,
    ).toBe(404);
  });

  it('admin can issue, list and revoke keys; stores only hashes', async () => {
    const { app, db } = setup();
    const r = await app.request('/admin/keys', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'pro user', plan: 'pro' }),
    });
    expect(r.status).toBe(201);
    const k = (await r.json()) as { key: string; id: string };
    const row = db.prepare('SELECT key_hash FROM api_keys').get() as { key_hash: string };
    expect(row.key_hash).toBe(hashKey(k.key));
    expect(JSON.stringify(row)).not.toContain(k.key);

    const { json: upgraded } = await createProject(app, {}, apiKey(k.key));
    expect(upgraded).toHaveProperty('plan', 'pro');

    await app.request(`/admin/keys/${k.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect((await createProject(app, {}, apiKey(k.key))).status).toBe(401);
  });

  it('admin endpoints need the admin token', async () => {
    const { app } = setup();
    expect((await app.request('/admin/keys')).status).toBe(401);
    expect((await app.request('/admin/keys', { headers: auth(ADMIN) })).status).toBe(200);
  });

  it('never leaks internals on errors', async () => {
    const { app } = setup();
    const r = await app.request('/mock/x/todos', { headers: apiKey('nope') });
    expect(JSON.stringify(await r.json())).not.toMatch(/sqlite|stack|node_modules/i);
  });

  it('rate limits anonymous project creation per IP', async () => {
    const { app } = setup();
    let limited = 0;
    for (let n = 0; n < 12; n++) if ((await createProject(app)).status === 429) limited++;
    expect(limited).toBe(2);
  });

  it('enforces the global capacity ceiling', async () => {
    const { app } = setup({ MAX_PROJECTS: 2 });
    expect((await createProject(app)).status).toBe(201);
    expect((await createProject(app)).status).toBe(201);
    expect((await createProject(app)).status).toBe(503);
  });
});
