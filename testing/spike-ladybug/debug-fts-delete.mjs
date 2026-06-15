import ldb from '@ladybugdb/core';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const dir = mkdtempSync(join(tmpdir(), 'fts-del-'));
const db = new ldb.Database(join(dir, 'test.lbug'));
const conn = new ldb.Connection(db);

await conn.query('INSTALL fts; LOAD fts;');
await conn.query(`CREATE NODE TABLE IF NOT EXISTS P(
  pk STRING PRIMARY KEY, corpus_id STRING, passage_id STRING, document_id STRING, text STRING
)`);
await conn.query('CALL CREATE_FTS_INDEX("P", "pfi", ["text"])');

let ps = await conn.prepare(`CREATE (n:P {pk:$pk, corpus_id:$cid, passage_id:$pid, document_id:$did, text:$text})`);
await conn.execute(ps, {pk:'c:p1', cid:'c', pid:'p1', did:'doc-1', text:'Einstein developed relativity'});
await conn.execute(ps, {pk:'c:p2', cid:'c', pid:'p2', did:'doc-2', text:'Newton discovered gravity'});

// Search
let ps2 = await conn.prepare(`CALL QUERY_FTS_INDEX("P", "pfi", $q) RETURN node.passage_id AS pid, score`);
let r = await conn.execute(ps2, {q:'Einstein'});
console.log('Before delete:', (await r.getAll()).map(x=>`${x.pid}:${x.score}`));

// Delete p1
let psd = await conn.prepare(`MATCH (n:P {pk: $pk}) DELETE n`);
await conn.execute(psd, {pk:'c:p1'});

// Search again
ps2 = await conn.prepare(`CALL QUERY_FTS_INDEX("P", "pfi", $q) RETURN node.passage_id AS pid, score`);
r = await conn.execute(ps2, {q:'Einstein'});
console.log('After delete:', (await r.getAll()).map(x=>`${x.pid}:${x.score}`));

// Drop + recreate FTS
try { await conn.query('CALL DROP_FTS_INDEX("P", "pfi")'); } catch(e) { console.log(e.message); }
await conn.query('CALL CREATE_FTS_INDEX("P", "pfi", ["text"])');

ps2 = await conn.prepare(`CALL QUERY_FTS_INDEX("P", "pfi", $q) RETURN node.passage_id AS pid, score`);
r = await conn.execute(ps2, {q:'Einstein'});
console.log('After FTS rebuild:', (await r.getAll()).map(x=>`${x.pid}:${x.score}`));

await conn.close();
db.close();
rmSync(dir, {recursive:true, force:true});
