import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
const scripts=process.env.FRIEND_REPAIR_SCRIPT_SOURCE??path.resolve(import.meta.dirname,'../scripts');
const {latestLaunchUrl}=await import(pathToFileURL(scripts+'/dev-client.mjs'));
test('initialization uses the newest URL in an appended log and respects instance endpoint',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'friend-launch-url-'));t.after(async()=>{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true});});
 await fs.writeFile(path.join(dir,'host.out.log'),'dsh web: http://127.0.0.1:3199/?token=old\ndsh web: http://127.0.0.1:3199/?token=new\ndsh web: http://127.0.0.2:3081/?token=test');
 assert.equal(await latestLaunchUrl(dir,{host:'127.0.0.1',port:3199}),'http://127.0.0.1:3199/?token=new');
 assert.equal(await latestLaunchUrl(dir,{host:'127.0.0.2',port:3081}),'http://127.0.0.2:3081/?token=test');
 await assert.rejects(latestLaunchUrl(dir,{host:'127.0.0.1',port:9999}),/not found/);
});
