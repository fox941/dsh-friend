import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshot, exportMemory, verifySnapshot } from '../scripts/archive.mjs';
import { requireInside } from '../scripts/paths.mjs';
import { DatabaseSync } from 'node:sqlite';

test('backup restores stored memory metadata and detects file tampering', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-friend-backup-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await fs.mkdir(path.join(source, 'memory', 'runtime'), { recursive: true });
  const entry = { content: '以前喝咖啡，现在不喝了。', target: 'user', importance: 'critical', created_at: '2026-01-01T00:00:00Z' };
  await fs.writeFile(path.join(source, 'memory', 'runtime', 'memories.json'), JSON.stringify({ entries: [entry] }));
  const snapshot = path.join(temporary, 'snapshot');
  assert.equal((await createSnapshot(source, snapshot)).files.length, 1);
  assert.equal((await verifySnapshot(snapshot)).verified, true);
  const exported = path.join(temporary, 'export');
  assert.equal((await exportMemory(snapshot, exported)).records, 1);
  const record = JSON.parse((await fs.readFile(path.join(exported, 'memories.jsonl'), 'utf8')).trim());
  assert.deepEqual(record.original, entry);
  await fs.writeFile(path.join(snapshot, 'runtime', 'memory', 'runtime', 'memories.json'), '{}');
  await assert.rejects(verifySnapshot(snapshot), /integrity failure/);
});

test('backup refuses a live owner and never accepts an escaping manifest path', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-friend-boundary-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'host.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(createSnapshot(source, path.join(temporary, 'snapshot')), /Stop the instance/);
  assert.throws(() => requireInside(source, path.join(source, '..', 'outside')), /child/);
  assert.throws(() => requireInside(source, source), /child/);
});

test('export retains corrected facts, deletion state and relationships from SQLite', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-friend-native-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const directory = path.join(source, 'memory', 'data', 'test-space');
  await fs.mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path.join(directory, 'mnemon.db'));
  database.exec("CREATE TABLE insights(id TEXT, content TEXT, deleted_at TEXT); CREATE TABLE edges(source TEXT, target TEXT, type TEXT);");
  database.prepare('INSERT INTO insights VALUES (?, ?, ?)').run('old', '以前喝咖啡', '2026-10-01');
  database.prepare('INSERT INTO insights VALUES (?, ?, ?)').run('new', '现在不喝咖啡', null);
  database.prepare('INSERT INTO edges VALUES (?, ?, ?)').run('new', 'old', 'supersedes');
  database.close();
  const snapshot = path.join(temporary, 'snapshot');
  await createSnapshot(source, snapshot);
  const exported = path.join(temporary, 'export');
  const result = await exportMemory(snapshot, exported);
  assert.equal(result.records, 2);
  const raw = JSON.parse(await fs.readFile(path.join(exported, result.nativeDatabases[0].export), 'utf8'));
  assert.equal(raw.tables.insights.find(row => row.id === 'old').deleted_at, '2026-10-01');
  assert.equal(raw.tables.edges[0].type, 'supersedes');
});
