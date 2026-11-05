import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import {resolveInstance,assertTestSafety} from './instances.mjs';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const selectedInstance = resolveInstance(projectRoot,process.env.AI_FRIEND_INSTANCE??'main');
export const instanceRoot = selectedInstance.root;
export const instanceId=selectedInstance.id;
export const webPort=selectedInstance.port;
export const webHost=selectedInstance.host;
export const nodeDirectory = path.join(projectRoot, '.tools', 'node-v24.22.1-win-x64');
export const dshBin = path.join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
export const pnpmBin = path.join(projectRoot, '.tools', 'package-manager', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs');
export const controlFile = path.join(instanceRoot, 'host.json');

export function applyEnvironment() {
  if(instanceId==='test'){assertTestSafety(selectedInstance);delete process.env.DEEPSEEK_API_KEY;for(const key of Object.keys(process.env))if(/^(BILIBILI_|NAPCAT_|ONEBOT_)/i.test(key))delete process.env[key];}
  process.env.AI_FRIEND_INSTANCE=instanceId;
  process.env.NO_PROXY=[process.env.NO_PROXY??'', '127.0.0.1','127.0.0.2','localhost'].filter(Boolean).join(',');
  const credentials = path.join(instanceRoot, 'credentials.local.json');
  if (fs.existsSync(credentials)) {
    const values = JSON.parse(fs.readFileSync(credentials, 'utf8'));
    if (typeof values.DEEPSEEK_API_KEY !== 'string' || !values.DEEPSEEK_API_KEY.trim()) throw new Error('Invalid local DeepSeek credential configuration');
    process.env.DEEPSEEK_API_KEY = values.DEEPSEEK_API_KEY;
  }
  process.env.DSH_HOME = path.join(instanceRoot, 'dsh-home');
  process.env.MNEMON_DATA_DIR = path.join(instanceRoot, 'memory', 'native-default');
  process.env.MNEMON_MAX_INSIGHTS = '0';
  process.env.PATH = [nodeDirectory, path.join(projectRoot, '.tools', 'package-manager', 'node_modules', '.bin'), path.join(projectRoot, 'node_modules', '.bin'), process.env.PATH ?? ''].join(path.delimiter);
  process.env.npm_config_cache = path.join(projectRoot, '.work', 'npm-cache');
  process.env.npm_config_store_dir = path.join(projectRoot, '.work', 'pnpm-store');
}

export function requireInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path must be a child of the selected root: ${candidate}`);
  }
  return path.resolve(candidate);
}
