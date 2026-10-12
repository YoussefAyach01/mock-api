import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.js';
import { PLANS, type Plan } from './config.js';
import type { CollectionSchema } from './schema.js';

export interface Project {
  id: string;
  plan: Plan;
  ownerKeyId: string | null;
  name: string;
  createdAt: string;
  expiresAt: string;
}

export interface Collection {
  id: string;
  projectId: string;
  name: string;
  schema: CollectionSchema;
  createdAt: string;
}

export interface Record_ {
  id: string;
  seq: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest();
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const isProjectId = (s: string) => ID_RE.test(s);

interface ProjectRow {
  id: string;
  plan: Plan;
  owner_key_id: string | null;
  name: string;
  created_at: string;
  expires_at: string;
}
const toProject = (r: ProjectRow): Project => ({
  id: r.id,
  plan: r.plan,
  ownerKeyId: r.owner_key_id,
  name: r.name,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

export function countLive(db: Db, now: Date): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE expires_at > ?')
    .get(now.toISOString()) as { n: number };
  return r.n;
}

export function countForKey(db: Db, keyId: string, now: Date): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_key_id = ? AND expires_at > ?')
    .get(keyId, now.toISOString()) as { n: number };
  return r.n;
}

/** Returns the manage token and consumer API key ONCE; only their hashes are stored. */
export function createProject(
  db: Db,
  opts: { plan: Plan; ownerKeyId: string | null; name: string; now: Date },
): { project: Project; manageToken: string; apiKey: string } {
  const id = randomBytes(16).toString('base64url');
  const manageToken = `mkmt_${randomBytes(32).toString('base64url')}`;
  const apiKey = `mkapi_${randomBytes(32).toString('base64url')}`;
  const expires = new Date(opts.now.getTime() + PLANS[opts.plan].ttlDays * 86_400_000);
  db.prepare(
    `INSERT INTO projects (id, manage_hash, api_key_hash, owner_key_id, plan, name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sha(manageToken).toString('hex'),
    sha(apiKey).toString('hex'),
    opts.ownerKeyId,
    opts.plan,
    opts.name,
    opts.now.toISOString(),
    expires.toISOString(),
  );
  return { project: getProject(db, id, opts.now)!, manageToken, apiKey };
}

/** Returns null for unknown OR expired projects (indistinguishable to callers). */
export function getProject(db: Db, id: string, now: Date): Project | null {
  if (!isProjectId(id)) return null;
  const r = db
    .prepare('SELECT * FROM projects WHERE id = ? AND expires_at > ?')
    .get(id, now.toISOString()) as unknown as ProjectRow | undefined;
  return r ? toProject(r) : null;
}

export function verifyManageToken(db: Db, id: string, token: string): boolean {
  if (!isProjectId(id)) return false;
  const r = db.prepare('SELECT manage_hash FROM projects WHERE id = ?').get(id) as
    { manage_hash: string } | undefined;
  const presented = sha(token);
  const stored = r ? Buffer.from(r.manage_hash, 'hex') : Buffer.alloc(32);
  return timingSafeEqual(presented, stored) && !!r;
}

/** Looks a project up by its consumer API key (used by the public /mock/* routes). */
export function findProjectByApiKey(db: Db, apiKey: string, now: Date): Project | null {
  const r = db
    .prepare('SELECT * FROM projects WHERE api_key_hash = ? AND expires_at > ?')
    .get(sha(apiKey).toString('hex'), now.toISOString()) as unknown as ProjectRow | undefined;
  return r ? toProject(r) : null;
}

export function deleteProject(db: Db, id: string): boolean {
  return Number(db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) > 0;
}

export function purgeExpired(db: Db, now: Date): number {
  return Number(
    db.prepare('DELETE FROM projects WHERE expires_at <= ?').run(now.toISOString()).changes,
  );
}

// ------------------------------------------------------------- collections

interface CollectionRow {
  id: string;
  project_id: string;
  name: string;
  schema_json: string;
  created_at: string;
}
const toCollection = (r: CollectionRow): Collection => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  schema: JSON.parse(r.schema_json) as CollectionSchema,
  createdAt: r.created_at,
});

export function countCollections(db: Db, projectId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM collections WHERE project_id = ?')
    .get(projectId) as { n: number };
  return r.n;
}

export function createCollection(
  db: Db,
  projectId: string,
  name: string,
  schema: CollectionSchema,
  now: Date,
): Collection | 'duplicate' {
  const id = randomUUID();
  try {
    db.prepare(
      'INSERT INTO collections (id, project_id, name, schema_json, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(id, projectId, name, JSON.stringify(schema), now.toISOString());
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) return 'duplicate';
    throw e;
  }
  return getCollection(db, projectId, name)!;
}

export function getCollection(db: Db, projectId: string, name: string): Collection | null {
  const r = db
    .prepare('SELECT * FROM collections WHERE project_id = ? AND name = ?')
    .get(projectId, name) as unknown as CollectionRow | undefined;
  return r ? toCollection(r) : null;
}

export function listCollections(db: Db, projectId: string): Collection[] {
  const rows = db
    .prepare('SELECT * FROM collections WHERE project_id = ? ORDER BY created_at')
    .all(projectId) as unknown as CollectionRow[];
  return rows.map(toCollection);
}

export function deleteCollection(db: Db, projectId: string, name: string): boolean {
  return (
    Number(
      db.prepare('DELETE FROM collections WHERE project_id = ? AND name = ?').run(projectId, name)
        .changes,
    ) > 0
  );
}

// ----------------------------------------------------------------- records

interface RecordRow {
  id: string;
  seq: number;
  data_json: string;
  created_at: string;
  updated_at: string;
}
const toRecord = (r: RecordRow): Record_ => ({
  id: r.id,
  seq: r.seq,
  data: JSON.parse(r.data_json) as Record<string, unknown>,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function countRecords(db: Db, collectionId: string): number {
  const r = db
    .prepare('SELECT COUNT(*) AS n FROM records WHERE collection_id = ?')
    .get(collectionId) as { n: number };
  return r.n;
}

export function createRecord(
  db: Db,
  collectionId: string,
  data: Record<string, unknown>,
  now: Date,
): Record_ {
  const id = randomUUID();
  const seqRow = db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM records WHERE collection_id = ?')
    .get(collectionId) as { next: number };
  db.prepare(
    'INSERT INTO records (id, collection_id, seq, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, collectionId, seqRow.next, JSON.stringify(data), now.toISOString(), now.toISOString());
  return getRecord(db, collectionId, id)!;
}

export function getRecord(db: Db, collectionId: string, id: string): Record_ | null {
  const r = db
    .prepare('SELECT * FROM records WHERE collection_id = ? AND id = ?')
    .get(collectionId, id) as unknown as RecordRow | undefined;
  return r ? toRecord(r) : null;
}

export interface ListOpts {
  limit: number;
  offset: number;
  filters: Record<string, string>;
}

export function listRecords(
  db: Db,
  collectionId: string,
  opts: ListOpts,
): { items: Record_[]; total: number } {
  const rows = db
    .prepare('SELECT * FROM records WHERE collection_id = ? ORDER BY seq')
    .all(collectionId) as unknown as RecordRow[];
  let items = rows.map(toRecord);
  const filterKeys = Object.keys(opts.filters);
  if (filterKeys.length) {
    items = items.filter((it) =>
      filterKeys.every((k) => String(it.data[k] ?? '') === opts.filters[k]),
    );
  }
  const total = items.length;
  return { items: items.slice(opts.offset, opts.offset + opts.limit), total };
}

export function updateRecord(
  db: Db,
  collectionId: string,
  id: string,
  data: Record<string, unknown>,
  now: Date,
): Record_ | null {
  const res = db
    .prepare('UPDATE records SET data_json = ?, updated_at = ? WHERE collection_id = ? AND id = ?')
    .run(JSON.stringify(data), now.toISOString(), collectionId, id);
  return Number(res.changes) > 0 ? getRecord(db, collectionId, id) : null;
}

export function deleteRecord(db: Db, collectionId: string, id: string): boolean {
  return (
    Number(
      db.prepare('DELETE FROM records WHERE collection_id = ? AND id = ?').run(collectionId, id)
        .changes,
    ) > 0
  );
}
