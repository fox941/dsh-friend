import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const project = path.resolve(import.meta.dirname, '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'friend-qq-node # '));
  t.after(async () => {
    const actual = await fs.realpath(root);
    const temporary = await fs.realpath(os.tmpdir());
    assert.ok(actual.startsWith(temporary + path.sep));
    assert.ok(path.basename(actual).startsWith('friend-qq-node # '));
    await fs.rm(actual, {recursive: true, force: true});
  });
  const scripts = path.join(root, 'scripts');
  const backend = path.join(root, '.tools/napcat-node-v4.18.41');
  const engine = path.join(root, '.tools/napcat-v4.18.41/napcat.ai-friend.mjs');
  await fs.mkdir(scripts);
  await fs.mkdir(backend, {recursive: true});
  await fs.mkdir(path.dirname(engine), {recursive: true});
  for (const file of ['node.exe', 'wrapper.node', 'package.json', 'config.json', 'QQNT.dll']) {
    await fs.writeFile(path.join(backend, file), '{}');
  }
  for (const file of ['qq-node-entry.cjs', 'Setup-QQ-Node.ps1']) {
    await fs.copyFile(path.join(project, 'scripts', file), path.join(scripts, file));
  }
  return {root, scripts, backend, engine};
}

function runInstaller(scripts) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(scripts, 'Setup-QQ-Node.ps1'),
  ], {encoding: 'utf8', timeout: 15000, windowsHide: true});
}

test('tracked bootstrap resolves the current project and forwards quick-login arguments', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.engine, 'console.log(JSON.stringify({wrapper:process.env.NAPCAT_WRAPPER_PATH,package:process.env.NAPCAT_QQ_PACKAGE_INFO_PATH,config:process.env.NAPCAT_QQ_VERSION_CONFIG_PATH,pipe:process.env.NAPCAT_DISABLE_PIPE,args:process.argv.slice(2)}));');
  const result = spawnSync(process.execPath, [path.join(f.scripts, 'qq-node-entry.cjs'), '-q', '987654321'], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.wrapper, path.join(f.backend, 'wrapper.node'));
  assert.equal(value.package, path.join(f.backend, 'package.json'));
  assert.equal(value.config, path.join(f.backend, 'config.json'));
  assert.equal(value.pipe, '1');
  assert.deepEqual(value.args, ['-q', '987654321']);
});

test('missing native dependency fails before importing the engine', async t => {
  const f = await fixture(t);
  const marker = path.join(f.root, 'engine-entered');
  await fs.unlink(path.join(f.backend, 'wrapper.node'));
  await fs.writeFile(f.engine, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)}, 'entered');`);
  const result = spawnSync(process.execPath, [path.join(f.scripts, 'qq-node-entry.cjs')], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  await assert.rejects(fs.stat(marker), {code: 'ENOENT'});
});

test('engine startup failure returns a failed process', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.engine, "throw new Error('synthetic engine failure');");
  const result = spawnSync(process.execPath, [path.join(f.scripts, 'qq-node-entry.cjs')], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic engine failure/);
});

test('existing complete component installation is idempotent', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);
  const result = runInstaller(f.scripts);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already installed/);
  assert.equal(await fs.readFile(path.join(f.backend, 'wrapper.node'), 'utf8'), '{}');
});

test('incomplete existing installation is preserved without downloading', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.backend, 'wrapper.node'));
  const result = runInstaller(f.scripts);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Downloading/);
  assert.equal(await fs.readFile(path.join(f.backend, 'node.exe'), 'utf8'), '{}');
});

test('corrupt cached archive is rejected before extraction', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);
  await fs.rm(f.backend, {recursive: true});
  const downloads = path.join(f.root, '.work/downloads');
  await fs.mkdir(downloads, {recursive: true});
  const archive = path.join(downloads, 'NapCat.Shell.Windows.Node-v4.18.41.zip');
  await fs.writeFile(archive, 'synthetic corrupt archive');
  const result = runInstaller(f.scripts);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SHA256 verification/);
  assert.equal(await fs.readFile(archive, 'utf8'), 'synthetic corrupt archive');
  await assert.rejects(fs.stat(f.backend), {code: 'ENOENT'});
});

test('QQ launch and setup scripts parse in Windows PowerShell', {skip: process.platform !== 'win32'}, () => {
  for (const file of ['QQ.ps1', 'Setup-QQ-Node.ps1']) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '$taskTokens=$null; $taskErrors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:AI_FRIEND_QQ_TEST_SCRIPT,[ref]$taskTokens,[ref]$taskErrors); if($taskErrors.Count){$taskErrors|Out-String|Write-Error;exit 1}',
    ], {
      env: {...process.env, AI_FRIEND_QQ_TEST_SCRIPT: path.join(project, 'scripts', file)},
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
  }
});
