import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { instanceRoot, projectRoot, requireInside,selectedInstance } from './paths.mjs';
import {resolveInstance,readLocalJson,identityAt} from './instances.mjs';
import {acquireOfflineLease} from './protection-control.mjs';
import {recordAlive} from './process-records.mjs';

const slash = value => value.split(path.sep).join('/');
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item, 2);

export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function listDataFiles(root, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    const portable = slash(next);
    if (['host.json', 'host.lock', 'host.sock', 'guard.sock', 'operations/guard.json', 'operations/status.json', 'exports'].includes(portable)) continue;
    if (/^dsh-home\/profiles\/[^/]+\/node_modules(?:\/|$)/.test(portable)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Backup cannot silently follow a symbolic link: ${portable}`);
    if (entry.isDirectory()) files.push(...await listDataFiles(root, next));
    else if (entry.isFile()) files.push(next);
  }
  return files.sort();
}

export async function assertOffline(root) {
  for (const name of ['host.json', 'host.lock', 'operations/guard.json']) {
    let owner;
    try { owner = JSON.parse(await fs.readFile(path.join(root, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if(!await recordAlive(owner))continue;
    throw new Error('Stop the instance before backup/export. No live copy was created.');
  }
}

export async function createSnapshot(source, destination, {assertSourceOffline=()=>assertOffline(source),metadataProjectRoot=projectRoot}={}) {
  await assertSourceOffline();
  if (await fs.stat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Snapshot destination already exists');
  await fs.mkdir(path.join(destination, 'runtime'), { recursive: true });
  const files = [];
  for (const relative of await listDataFiles(source)) {
    const original = requireInside(source, path.join(source, relative));
    const target = requireInside(path.join(destination, 'runtime'), path.join(destination, 'runtime', relative));
    const before = await hashFile(original);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(original, target);
    const copied = await hashFile(target);
    const after = await hashFile(original);
    if (before !== after || before !== copied) throw new Error(`Data changed while copying ${relative}; snapshot is incomplete`);
    files.push({ path: slash(relative), bytes: (await fs.stat(target)).size, sha256: copied });
  }
  await assertSourceOffline();
  for (const file of files) if (await hashFile(path.join(source,file.path))!==file.sha256) throw new Error(`Data changed after copying ${file.path}; snapshot is incomplete`);
  const versions = JSON.parse(await fs.readFile(path.join(metadataProjectRoot, 'package.json'), 'utf8'));
  const profilePackage = JSON.parse(await fs.readFile(path.join(source, 'dsh-home', 'profiles', 'web', 'package.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
  const manifest = {
    instance: ['main','test'].map(id=>resolveInstance(metadataProjectRoot,id)).find(d=>d.root.toLowerCase()===path.resolve(source).toLowerCase())?{id:path.resolve(source).toLowerCase()===resolveInstance(metadataProjectRoot,'test').root.toLowerCase()?'test':'main'}:null,
    schema: 'ai-friend-snapshot/1', createdAt: new Date().toISOString(), sourceRoot: source,
    node: process.version, dependencies: versions.dependencies, profileDependencies: profilePackage.dependencies ?? {},
    exclusions: ['host.json', 'host.lock', 'host.sock', 'guard.sock', 'operations/guard.json', 'operations/status.json', 'exports (derived copies)', 'dsh-home/profiles/*/node_modules (reinstall with saved package/lock files)'],
    containsPrivateData: true, files,
  };
  await fs.writeFile(path.join(destination, 'manifest.json'), json(manifest));
  await verifySnapshot(destination);
  return manifest;
}

export async function verifySnapshot(snapshot) {
  const manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'ai-friend-snapshot/1') throw new Error('Unknown backup format');
  const seen = new Set();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error('Duplicate backup path');
    seen.add(file.path);
    const target = requireInside(path.join(snapshot, 'runtime'), path.join(snapshot, 'runtime', file.path));
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || await hashFile(target) !== file.sha256) throw new Error(`Backup integrity failure: ${file.path}`);
  }
  return { verified: true, files: manifest.files.length };
}

export async function exportMemory(snapshot, destination) {
  await verifySnapshot(snapshot);
  const source = path.join(snapshot, 'runtime');
  await fs.mkdir(destination, { recursive: true });
  const records = [];
  let runtime;
  try { runtime = JSON.parse(await fs.readFile(path.join(source, 'memory', 'runtime', 'memories.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (runtime !== undefined) {
    await fs.writeFile(path.join(destination, 'runtime.json'), json(runtime));
    const entries = Array.isArray(runtime) ? runtime : (runtime.entries ?? runtime.memories ?? []);
    for (const entry of entries) {
      const identity = crypto.createHash('sha256').update(JSON.stringify(entry)).digest('hex');
      records.push({ id: `runtime-export:${identity}`, idKind: 'export-derived', backend: 'mnemon-runtime', content: entry.content, original: entry });
    }
  }
  const documentSource = path.join(source, 'memory', 'documents');
  if (await fs.stat(documentSource).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) await fs.cp(documentSource, path.join(destination, 'documents'), { recursive: true, errorOnExist: true });
  const { DatabaseSync } = await import('node:sqlite');
  const nativeDatabases = [];
  for (const relative of await listDataFiles(source)) {
    if (!slash(relative).startsWith('memory/') || path.basename(relative) !== 'mnemon.db') continue;
    const location = path.join(source, relative);
    const database = new DatabaseSync(location, { readOnly: true });
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get();
      if (Object.values(integrity)[0] !== 'ok') throw new Error(`SQLite integrity failure: ${relative}`);
      const schema = database.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
      const tables = {};
      for (const table of schema) {
        const quoted = '"' + table.name.replaceAll('"', '""') + '"';
        const statement = database.prepare(`SELECT * FROM ${quoted}`);
        statement.setReadBigInts(true);
        tables[table.name] = statement.all();
      }
      const exported = { schema: 'ai-friend-native-sqlite-export/1', path: slash(relative), userVersion: database.prepare('PRAGMA user_version').get().user_version, tables, tableDefinitions: schema };
      const name = crypto.createHash('sha256').update(slash(relative)).digest('hex').slice(0, 16) + '.json';
      await fs.mkdir(path.join(destination, 'native'), { recursive: true });
      await fs.writeFile(path.join(destination, 'native', name), json(exported));
      for (const entry of tables.insights ?? []) records.push({ id: `native:${slash(relative)}:${entry.id}`, idKind: 'backend-id', backend: 'mnemon-native', backendPath: slash(relative), backendId: entry.id, content: entry.content, original: entry });
      nativeDatabases.push({ path: slash(relative), export: `native/${name}`, tables: Object.fromEntries(Object.entries(tables).map(([key, value]) => [key, value.length])) });
    } finally { database.close(); }
  }
  await fs.writeFile(path.join(destination, 'memories.jsonl'), records.map(record => JSON.stringify(record, (_key, item) => typeof item === 'bigint' ? item.toString() : item)).join('\n') + (records.length ? '\n' : ''));
  const manifest = {
    schema: 'ai-friend-memory-export/1', createdAt: new Date().toISOString(), sourceSnapshot: path.basename(snapshot), records: records.length, nativeDatabases,
    scope: 'Current local Mnemon Runtime, Documents and Native rows, including tombstones and native metadata present in each database.',
    limitations: ['Not a ready importer for another memory product.', 'Not a full character backup: original sessions, future companion state and credentials remain in the full snapshot.', 'Runtime export IDs are derived from record content; they are not persistent business IDs.', 'Native database fields, including binary vectors, are preserved as JSON; target-specific conversion and reindexing are still required.'],
  };
  await fs.writeFile(path.join(destination, 'manifest.json'), json(manifest));
  return manifest;
}

async function main() {
  const command = process.argv[2];
  if (command === 'verify') { console.log(json(await verifySnapshot(path.resolve(process.argv[3])))); return; }
  if (!['backup', 'export'].includes(command)) throw new Error('Usage: archive.mjs backup|export|verify <snapshot>');
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  if(selectedInstance.id==='test'){const marker=readLocalJson(path.join(instanceRoot,'isolation.json'));if(marker.instance!=='test'||marker.identity!==identityAt(instanceRoot))throw Error('测试备份身份不匹配');}
  const snapshot = path.join(selectedInstance.backupRoot, stamp);
  const lease=await acquireOfflineLease(instanceRoot);let manifest;try{manifest=await createSnapshot(instanceRoot,snapshot,{assertSourceOffline:lease.assertOffline});}finally{await lease.close();}
  if (command === 'backup') { console.log(json({instance:selectedInstance.id,label:selectedInstance.label,snapshot,files:manifest.files.length})); return; }
  const destination = path.join(instanceRoot, 'exports', stamp);
  const exported = await exportMemory(snapshot, destination);
  console.log(json({instance:selectedInstance.id,label:selectedInstance.label,snapshot,exportDirectory:destination,records:exported.records,nativeDatabases:exported.nativeDatabases.length}));
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
