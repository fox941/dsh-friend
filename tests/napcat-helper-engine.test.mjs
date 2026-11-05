import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {compileHelperEngine,installHelperEngine} from '../scripts/napcat-helper-engine.mjs';
const worker='return OL.endsWith(".mjs") ? xe.join(oE, "napcat.mjs") : xe.join(oE, "napcat.js");';
const source=Buffer.from('const allowed=new Set([\n  "napcat-plugin-qce"\n]), gge = ["sensitive"];\nconst reject=()=>true;\nfunction entry(){'+worker+'}');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const expectedDigest=hash(source);
test('helper compatibility adds only our explicit plugin and preserves all other policy code',()=>{
  const result=compileHelperEngine(source,expectedDigest).toString();
  assert.equal(result.replace(',\n  "ai-friend-social-helper"','').replace('return OL;',worker),source.toString());
  assert.ok(result.includes('return OL;'));
});
test('unknown original engine is refused before transformation',()=>{
  assert.throws(()=>compileHelperEngine(source),/pinned/);
  assert.throws(()=>compileHelperEngine(Buffer.concat([source,Buffer.from('changed')]),expectedDigest),/pinned/);
});
test('missing or duplicated whitelist anchors fail closed',()=>{
  for(const bytes of [Buffer.from('no anchor'),Buffer.concat([source,source])])assert.throws(()=>compileHelperEngine(bytes,hash(bytes)),/anchor/);
});
test('compatibility installs a separate deterministic entry and leaves original engine untouched',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'friend-helper-engine-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.writeFile(dir+'/napcat.mjs',source);const first=await installHelperEngine(dir,{expectedDigest}),second=await installHelperEngine(dir,{expectedDigest});
  assert.deepEqual(first,second);assert.deepEqual(await fs.readFile(dir+'/napcat.mjs'),source);
  assert.equal(first.entry,'napcat.ai-friend.mjs');assert.equal(first.originalPreserved,true);
  await fs.writeFile(dir+'/napcat.ai-friend.mjs','unexpected');await assert.rejects(()=>installHelperEngine(dir,{expectedDigest}),/preserved/);
  assert.equal(await fs.readFile(dir+'/napcat.ai-friend.mjs','utf8'),'unexpected');
});
