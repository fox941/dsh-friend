import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { instanceRoot,webHost,webPort } from './paths.mjs';

export async function latestLaunchUrl(directory,{host=webHost,port=webPort}={}) {
  const names=(await fs.readdir(directory)).filter(name=>name.endsWith('.out.log')&&name!=='runtime-guard.out.log');
  const logs=(await Promise.all(names.map(async name=>({name,mtime:(await fs.stat(path.join(directory,name))).mtimeMs})))).sort((a,b)=>b.mtime-a.mtime||b.name.localeCompare(a.name));
  for (const {name} of logs) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    const match = text.match(/dsh web: (http:\/\/[^\r\n ]*)/);
    if (match) {const url=new URL(match[1]);if(url.hostname===host&&Number(url.port)===port)return match[1];}
  }
  throw new Error('Dev host readiness URL was not found');
}
export async function connectDev() {
  const launchUrl=await latestLaunchUrl(path.join(instanceRoot,'logs'));
  const response = await fetch(launchUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  if (response.status !== 303) throw new Error(`Local authentication failed (${response.status})`);
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error('Local authentication returned no cookie');
  const base = new URL(launchUrl).origin;
  return {
    async page() {
      const page = await fetch(base + '/', { headers: { cookie }, signal: AbortSignal.timeout(10000) });
      if (!page.ok) throw new Error(`Web page failed (${page.status})`);
      return await page.text();
    },
    async rpc(method, args = {}) {
      const response = await fetch(`${base}/api/${method}`, {
        method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
        signal: AbortSignal.timeout(60000),
      });
      const envelope = await response.json();
      if (!response.ok || !envelope.result?.ok) throw new Error(`RPC ${method}: ${JSON.stringify(envelope.result?.error ?? envelope.error ?? envelope)}`);
      return envelope.result.value;
    },
  };
}
