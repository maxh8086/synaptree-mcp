import neo4j from 'neo4j-driver';
import { ROOT_LABEL, INDEX_NAMES, EMBEDDING_DIMS, NODE_LABELS, assertLabel, assertEdge } from './constants.js';

import { SCHEMA_ROOT, SCHEMA_LABELS, SCHEMA_EDGES } from './schema-graph.js';

const BATCH = 500;
const chunks = (a, n = BATCH) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, (i + 1) * n));
const num = (v) => (neo4j.isInt(v) ? v.toNumber() : v);
const plain = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, num(v)]));

export class Db {
  constructor(cfg) {
    const { uri, username, password, database } = cfg.db;
    this.database = database || 'neo4j';
    this.driver = neo4j.driver(uri, username ? neo4j.auth.basic(username, password) : undefined);
  }

  async run(cypher, params = {}, { write = false } = {}) {
    const s = this.driver.session({ database: this.database, defaultAccessMode: write ? neo4j.session.WRITE : neo4j.session.READ });
    try { return (await s.run(cypher, params)).records.map((r) => plain(r.toObject())); } finally { await s.close(); }
  }

  async init() {
    const w = (q) => this.run(q, {}, { write: true });
    await w(`CREATE CONSTRAINT ${INDEX_NAMES.constraint ?? 'unique_code_entity'} IF NOT EXISTS FOR (n:${ROOT_LABEL}) REQUIRE (n.user_id, n.repo_name, n.qualified_name) IS UNIQUE`);
    await w(`CREATE INDEX code_file_idx IF NOT EXISTS FOR (n:${ROOT_LABEL}) ON (n.user_id, n.repo_name, n.file_path)`);
    await w(`CREATE INDEX code_name_idx IF NOT EXISTS FOR (n:${ROOT_LABEL}) ON (n.user_id, n.repo_name, n.name)`);
    await w(`CREATE FULLTEXT INDEX ${INDEX_NAMES.fulltext ?? 'code_fulltext_idx'} IF NOT EXISTS FOR (n:${ROOT_LABEL}) ON EACH [n.name, n.qualified_name, n.signature, n.docstring]`);
    await w(`CREATE VECTOR INDEX ${INDEX_NAMES.vector ?? 'code_embedding_idx'} IF NOT EXISTS FOR (n:${ROOT_LABEL}) ON (n.embedding) OPTIONS {indexConfig: {\`vector.dimensions\`: ${EMBEDDING_DIMS}, \`vector.similarity_function\`: 'cosine'}}`);
  }

  async ping() { await this.run('RETURN 1 AS ok'); return true; }

  // Atomic per-file purge + re-index: one write transaction removes the old nodes, writes the new ones.
  async replaceFile(t, file, nodes, edges) {
    const s = this.driver.session({ database: this.database });
    try {
      await s.executeWrite(async (tx) => {
        await tx.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r, file_path:$f}) DETACH DELETE n`, { u: t.user_id, r: t.repo_name, f: file });
        await this._writeNodes(tx, t, nodes);
        await this._writeEdges(tx, t, edges);
      });
    } finally { await s.close(); }
  }

  async _writeNodes(tx, t, nodes) {
    const by = new Map();
    for (const n of nodes) { assertLabel(n.label); (by.get(n.label) ?? by.set(n.label, []).get(n.label)).push(n); }
    for (const [label, list] of by) {
      for (const part of chunks(list)) {
        await tx.run(
          `UNWIND $rows AS row MERGE (n:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:row.qualified_name})
           SET n:${label}, n += row`,
          { u: t.user_id, r: t.repo_name, rows: part.map((x) => ({ ...x, user_id: t.user_id, repo_name: t.repo_name })) });
      }
    }
  }

  async _writeEdges(tx, t, edges) {
    const by = new Map();
    for (const e of edges) { assertEdge(e.type); (by.get(e.type) ?? by.set(e.type, []).get(e.type)).push(e); }
    for (const [type, list] of by) {
      for (const part of chunks(list)) {
        await tx.run(
          `UNWIND $rows AS row
           MATCH (a:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:row.from})
           MATCH (b:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:row.to})
           MERGE (a)-[e:${type}]->(b) SET e.line = row.line, e.ambiguous = row.ambiguous`,
          { u: t.user_id, r: t.repo_name, rows: part.map((e) => ({ from: e.from, to: e.to, line: e.line ?? null, ambiguous: e.ambiguous ?? false })) });
      }
    }
  }

  // DB-schema snapshot (tables/collections, columns, REFERENCES) under repo_name "db:<connection>".
  // One transaction: the previous snapshot is replaced, never merged. Writes go to the synaptree index only.
  async replaceSchema(t, nodes, edges) {
    const s = this.driver.session({ database: this.database });
    try {
      await s.executeWrite(async (tx) => {
        await tx.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) DETACH DELETE n`, { u: t.user_id, r: t.repo_name });
        const by = new Map();
        for (const n of nodes) {
          if (!SCHEMA_LABELS.includes(n.label)) throw new Error(`Unknown schema label: ${n.label}`);
          (by.get(n.label) ?? by.set(n.label, []).get(n.label)).push(n);
        }
        for (const [label, list] of by) {
          for (const part of chunks(list)) {
            await tx.run(
              `UNWIND $rows AS row MERGE (n:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:row.qualified_name})
               SET n:${label}:${SCHEMA_ROOT}, n += row`,
              { u: t.user_id, r: t.repo_name, rows: part.map(({ label: _l, ...x }) => ({ ...x, user_id: t.user_id, repo_name: t.repo_name })) });
          }
        }
        const eby = new Map();
        for (const e of edges) {
          if (!SCHEMA_EDGES.includes(e.type)) throw new Error(`Unknown schema edge: ${e.type}`);
          (eby.get(e.type) ?? eby.set(e.type, []).get(e.type)).push(e);
        }
        for (const [type, list] of eby) {
          for (const part of chunks(list)) {
            await tx.run(
              `UNWIND $rows AS row
               MATCH (a:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:row.from})
               MATCH (b:${ROOT_LABEL} {user_id:$u, repo_name:$r, qualified_name:row.to})
               MERGE (a)-[e:${type}]->(b)
               SET e.name = row.name, e.from_columns = row.from_columns, e.to_columns = row.to_columns, e.cardinality = row.cardinality, e.origin = row.origin`,
              { u: t.user_id, r: t.repo_name, rows: part.map((e) => ({ from: e.from, to: e.to, name: e.name ?? null, from_columns: e.from_columns ?? null, to_columns: e.to_columns ?? null, cardinality: e.cardinality ?? null, origin: e.origin ?? null })) });
          }
        }
      });
    } finally { await s.close(); }
  }

  // Removes one saved schema snapshot from the synaptree index only; the source database is never touched.
  async deleteSchema(t) {
    const s = this.driver.session({ database: this.database });
    try {
      await s.executeWrite((tx) => tx.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) DETACH DELETE n`, { u: t.user_id, r: t.repo_name }));
    } finally { await s.close(); }
  }

  async readSchema(t) {
    const tables = await this.run(
      `MATCH (n:${SCHEMA_ROOT}:Table {user_id:$u, repo_name:$r}) RETURN properties(n) AS p ORDER BY n.name`, { u: t.user_id, r: t.repo_name });
    const cols = await this.run(
      `MATCH (c:${SCHEMA_ROOT}:Column {user_id:$u, repo_name:$r}) RETURN properties(c) AS p ORDER BY c.qualified_name`, { u: t.user_id, r: t.repo_name });
    const rels = await this.run(
      `MATCH (a:${SCHEMA_ROOT}:Table {user_id:$u, repo_name:$r})-[e:REFERENCES]->(b:${SCHEMA_ROOT}:Table)
       RETURN a.qualified_name AS from, b.qualified_name AS to, properties(e) AS p`, { u: t.user_id, r: t.repo_name });
    return { tables: tables.map((x) => x.p), columns: cols.map((x) => x.p), relationships: rels };
  }

  async listSchemas(t) {
    return this.run(
      `MATCH (n:${SCHEMA_ROOT}:Table {user_id:$u}) RETURN n.repo_name AS repo_name, count(n) AS tables, max(n.saved_at) AS saved_at, max(n.source_kind) AS source_kind, max(n.nosql) AS nosql`,
      { u: t.user_id });
  }

  async importGraph(t, nodes, edges) {
    const s = this.driver.session({ database: this.database });
    try { await s.executeWrite(async (tx) => { await this._writeNodes(tx, t, nodes); await this._writeEdges(tx, t, edges); }); } finally { await s.close(); }
  }

  async writeEdges(t, edges) {
    const s = this.driver.session({ database: this.database });
    try { await s.executeWrite((tx) => this._writeEdges(tx, t, edges)); } finally { await s.close(); }
  }

  async deleteFile(t, file) {
    return this.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r, file_path:$f}) DETACH DELETE n`, { u: t.user_id, r: t.repo_name, f: file }, { write: true });
  }

  // Structural nodes (Project/Folder) have no file_path, so remove them only when nothing else references the repo.
  async purgeProject(t) {
    const [{ c }] = await this.run(`MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) RETURN count(n) AS c`, { u: t.user_id, r: t.repo_name });
    for (;;) {
      const [{ d }] = await this.run(
        `MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) WITH n LIMIT 5000 DETACH DELETE n RETURN count(*) AS d`,
        { u: t.user_id, r: t.repo_name }, { write: true });
      if (!d) break;
    }
    return c;
  }

  // Remove Folder nodes whose qualified_name is not in `keep` (their files were deleted or renamed away).
  async pruneFolders(t, keep) {
    return this.run(
      `MATCH (n:Folder {user_id:$u, repo_name:$r}) WHERE NOT n.qualified_name IN $keep DETACH DELETE n`,
      { u: t.user_id, r: t.repo_name, keep: [...keep] }, { write: true });
  }

  async fileHashes(t) {
    const rows = await this.run(`MATCH (f:File {user_id:$u, repo_name:$r}) RETURN f.file_path AS p, f.sha256 AS h`, { u: t.user_id, r: t.repo_name });
    return new Map(rows.map((x) => [x.p, x.h]));
  }

  async nameIndex(t) {
    return this.run(
      `MATCH (n:${ROOT_LABEL} {user_id:$u, repo_name:$r}) WHERE NOT n:File AND NOT n:Folder AND NOT n:Project
       RETURN n.qualified_name AS qualified_name, n.name AS name, n.file_path AS file_path, labels(n) AS labels`,
      { u: t.user_id, r: t.repo_name })
      .then((rows) => rows.map((x) => ({ ...x, label: x.labels.find((l) => NODE_LABELS.includes(l)) ?? 'Function', owner: x.qualified_name.split('.').slice(-2, -1)[0] })));
  }

  async close() { await this.driver.close(); }
}

export { chunks, BATCH };
