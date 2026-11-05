import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyEnvironment, instanceRoot, projectRoot } from './paths.mjs';
import {requireMain} from './instances.mjs';

requireMain('共享工具和主配置初始化；测试配置请用 Setup-Test');
applyEnvironment();
const dshRequire = createRequire(await fs.realpath(path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')));
const yaml = dshRequire('js-yaml');
const profile = path.join(instanceRoot, 'dsh-home', 'profiles', 'web');
const patchFile = path.join(profile, 'cordis.patch.yml');
const nativeRequire = createRequire(await fs.realpath(path.join(projectRoot, 'node_modules', '@mnemon-dev', 'mnemon', 'package.json')));
const nativeBinary = nativeRequire.resolve('@mnemon-dev/mnemon-win32-x64/bin/mnemon.exe');
const projectNative = path.join(projectRoot, '.tools', 'mnemon-0.2.13', 'mnemon.exe');
await fs.mkdir(path.dirname(projectNative), { recursive: true });
await fs.copyFile(nativeBinary, projectNative);
await fs.mkdir(profile, { recursive: true });
const current = await fs.readFile(patchFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]'; throw error; });
const patches = yaml.load(current) ?? [];
if (!Array.isArray(patches)) throw new Error('Profile overrides must be a patch list');
const marker = path.join(instanceRoot, 'bootstrap.json');
try {
  await fs.access(marker);
  console.log('Existing instance configuration retained. Reconfigure paths explicitly when migrating.');
  process.exit(0);
} catch (error) { if (error.code !== 'ENOENT') throw error; }

function override(id, values) {
  let row = patches.find(item => item.id === id);
  if (!row) { row = { id }; patches.push(row); }
  Object.assign(row, values);
}

override('system-prompt', { config: { includeHarnessIdentity: false, personaPrefix: '', personaSuffix: '' } });
override('agent-preset-registry', { config: { default: 'companion' } });
override('agent-default-model', { config: { provider: 'deepseek-official', model: 'deepseek-flash' } });
patches.push({ insert: [{
  id: 'preset-companion', name: '@deepseek-ai/dsh-agent-preset', config: {
    id: 'companion', name: '陪伴（空白起点）', description: '空白起点、本地记忆、自我成长与可恢复的夜间增量整理。', order: 0,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: '', suffix: '' } },
      { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
      { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true }, config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      ] },
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    ],
  },
}] });
override('mnemon-bundle', { disabled: false });
override('mnemon', { disabled: false, config: {
  storageScope: 'custom', dataDir: path.join(instanceRoot, 'memory'), runtimeUserScope: 'storage',
  cliPath: projectNative,
  routingGuidance: true, lifecycleEnabled: true, recallMode: 'guided', writebackMode: 'guided',
  tabEnabled: true, writeEnabled: true, syncEnabled: false, remoteAccess: 'trusted-host',
  persistenceStrategy: { mode: 'manual', providerId: 'mnemon-native', rules: { allowedProviderIds: ['mnemon-native'], dataBoundary: 'local-only', requiredCapabilities: [], preference: 'balanced' } },
  timeoutMs: 10000, defaultRecallLimit: 10,
  embedding: { enabled: false },
  idleReview: { enabled: false, maxPerSession: 0 },
  skills: { evolution: false, allowCreate: false, allowUpdate: false, autoBacktest: false, hints: false, sidebar: false },
  memoryView: { strategyTypeId: 'default-three-tier' },
} });
override('mnemon-source-skills', { disabled: true });
override('mnemon-source-memory-spaces', { config: { providers: [{ use: 'dsh-mnemon-provider-mnemon-native', instanceId: 'mnemon-native' }] } });
await fs.writeFile(patchFile, yaml.dump(patches, { lineWidth: 120, noRefs: true }), { mode: 0o600 });
await fs.mkdir(path.join(instanceRoot, 'workspace'), { recursive: true });
await fs.writeFile(marker, JSON.stringify({ schema: 'ai-friend-bootstrap/1', createdAt: new Date().toISOString(), dsh: '0.2.1-rc.3', mnemon: '0.5.36', native: '0.2.13', preset: 'companion', configuredRoot: instanceRoot }, null, 2));
console.log('Dev profile configured: blank personal description, local Native, official Idle Review and skill evolution disabled.');
