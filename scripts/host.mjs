import {createRequire} from 'node:module';
import {ensureQQBridgeRegistration} from './qq-bridge-registration.mjs';
import {requestControl,controlReplyMatches} from './host-control.mjs';
export {requestControl};
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {assertNoPendingUndo} from './protection-control.mjs';
import {assertNoMigration} from './migration-lock.mjs';
import {assertNoUpdate} from './update-lock.mjs';
import { pathToFileURL } from 'node:url';
import { applyEnvironment, controlFile, dshBin, instanceRoot, projectRoot,instanceId } from './paths.mjs';
import {resolveInstance,assertTestSafety} from './instances.mjs';
import {processStamp,recordAlive} from './process-records.mjs';

const action = process.argv[2] ?? 'status';



function readControl(file=controlFile) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function startManagedHost({root=instanceRoot,project=projectRoot,bin=dshBin,port,address}={}) {
  await assertNoUpdate(project);
  await assertNoMigration(project);
  const scoped=resolveInstance(project,path.resolve(root).toLowerCase()===resolveInstance(project,'test').root.toLowerCase()?'test':'main');
  if(instanceId==='test'&&path.resolve(root).toLowerCase()!==scoped.root.toLowerCase())throw Error('测试启动不能指向主实例或任意数据目录');
  port??=scoped.port;address??=scoped.host;
  let readIsolation;
  if(scoped.id==='test'){
    assertTestSafety(scoped);
    if(path.resolve(process.env.DSH_HOME??'').toLowerCase()!==path.resolve(root,'dsh-home').toLowerCase()||path.resolve(process.env.MNEMON_DATA_DIR??'').toLowerCase()!==path.resolve(root,'memory/native-default').toLowerCase())throw Error('测试进程的存储环境不匹配');
    readIsolation=(await import(pathToFileURL(path.join(project,'plugins/test-isolation/src/index.js')))).readIsolation;
  }
  const instanceRoot=root,projectRoot=project,dshBin=bin,controlFile=path.join(root,'host.json');
  let healthReader;try{const require=createRequire(path.join(root,'dsh-home/profiles/web/package.json'));healthReader=(await import(pathToFileURL(require.resolve('@ai-friend/companion-adapter/runtime-health')))).readRuntimeHealth;}catch{}

  await assertNoPendingUndo(instanceRoot);
  const previous = readControl(controlFile);
  if (previous) {
    if(await recordAlive(previous))throw new Error(`Instance owner PID ${previous.pid} is still alive; run Status or Stop first.`);
  }
  for (const directory of ['workspace', 'logs', 'dsh-home', 'memory']) fs.mkdirSync(path.join(instanceRoot, directory), { recursive: true });
  const lockFile = path.join(instanceRoot, 'host.lock');
  if (fs.existsSync(lockFile)) {
    const old = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    if(await recordAlive(old))throw new Error(`Instance lock owner ${old.pid} is still alive.`);
    fs.unlinkSync(lockFile);
  }
  await ensureQQBridgeRegistration({project,profile:path.join(root,'dsh-home/profiles/web')});
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(instanceRoot.toLowerCase()).digest('hex').slice(0, 20);
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\ai-friend-dev-${hash}` : path.join(instanceRoot, 'host.sock');
  const record = { pid: process.pid,...await processStamp(), startedAt: new Date().toISOString(), instanceRoot, projectRoot, pipe, token,instance:scoped.id,url:'http://'+address+':'+port };
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid,bootKey:record.bootKey,processIdentity:record.processIdentity, startedAt: record.startedAt }), { flag: 'wx' });
  let stopping = false;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let input = '';
    let handled = false;
    socket.setTimeout(3000, () => socket.destroy());
    const handleRequest = () => {
      if (handled) return;
      handled = true;
      let message;
      try { message = JSON.parse(input); } catch { socket.end(JSON.stringify({ error: 'Invalid request' })); return; }
      if (message.token !== token) { socket.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      if (message.command === 'status') { socket.end(JSON.stringify({ pid: process.pid, startedAt: record.startedAt, stopping, url: record.url, instanceRoot,projectRoot })); return; }
      if (message.command === 'health') {const health=healthReader?.(instanceRoot)??{available:false,reason:'当前插件未提供健康快照'};if(readIsolation){let valid=true;try{assertTestSafety(scoped);}catch{valid=false;}health.isolation={...readIsolation(instanceRoot),valid};}socket.end(JSON.stringify({pid:process.pid,startedAt:record.startedAt,stopping,instanceRoot,projectRoot,instance:scoped.id,health})); return; }
      if (message.command !== 'stop') { socket.end(JSON.stringify({ error: 'Unknown command' })); return; }
      stopping = true;
      socket.end(JSON.stringify({ accepted: true }));
      setTimeout(() => process.emit('SIGINT'), 50);
    };
    socket.on('data', chunk => {
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (input.includes('\n')) handleRequest();
    });
    socket.on('end', handleRequest);
    socket.on('error', () => { /* A disconnected local control client owns no host work. */ });
  });
  const cleanup = () => {
    for (const file of [controlFile, lockFile]) {
      try { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current.pid === process.pid) fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') process.stderr.write(`Control cleanup failed: ${error.message}\n`); }
    }
  };
  process.once('exit', cleanup);
  await assertNoPendingUndo(instanceRoot);
  process.on('SIGINT', () => { stopping = true; server.close(); });
  process.on('SIGTERM', () => { stopping = true; server.close(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  fs.writeFileSync(controlFile, JSON.stringify(record, null, 2), { mode: 0o600 });
  process.chdir(path.join(instanceRoot, 'workspace'));
  process.argv = [process.execPath, dshBin, 'web', '--host', address, '--port', String(port), '--no-open'];
  try {
    const { runCli } = await import(pathToFileURL(dshBin).href);
    // Stop may arrive while the cold ESM dependency graph is still loading.
    // Never enter DSH after that request: its signal handlers do not exist yet.
    if (stopping) { server.close(); cleanup(); return; }
    await runCli();
    if(!stopping){
      const {connectDev}=await import('./dev-client.mjs');
      const {initializeLocalMemory}=await import('./memory-readiness.mjs');
      try{
        const client=await connectDev({root:instanceRoot,host:address,port});
        const result=await initializeLocalMemory({root:instanceRoot,client,label:scoped.id==='test'?'隔离测试记忆':'陪伴记忆'});
        console.log('Memory initialization: '+result.status+'; existing memories retained.');
      }catch{console.error('Memory initialization did not finish; inspect operations/memory-bootstrap.json. Existing data retained.');}
    }
  } catch (error) {
    server.close();
    cleanup();
    throw error;
  }
}

async function main() {
  if (action === 'start') { applyEnvironment(); await startManagedHost(); return; }
  if (!['status', 'stop'].includes(action)) throw new Error(`Unknown action: ${action}`);
  const record = readControl();
  if (!record) { console.log(JSON.stringify({ running: false, instanceRoot })); return; }
  if(path.resolve(record.instanceRoot??'').toLowerCase()!==instanceRoot.toLowerCase()||path.resolve(record.projectRoot??'').toLowerCase()!==projectRoot.toLowerCase())throw Error('Host 记录不属于所选实例，未发送控制指令');
  if(!await recordAlive(record)){console.log(JSON.stringify({running:false,instanceRoot}));return;}
  let result;
  try { const status=await requestControl(record,'status');if(!controlReplyMatches(record,status,{requireProject:false}))throw Error('Control ownership mismatch');result=action==='status'?status:await requestControl(record,action); }
  catch (error) { throw new Error(`Cannot contact the recorded host (PID ${record.pid}): ${error.message}. No process was terminated.`); }
  if (result.error) throw new Error(result.error);
  if (action === 'status') { console.log(JSON.stringify({ running: true, ...result }, null, 2)); return; }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { process.kill(record.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { console.log(JSON.stringify({ stopped: true })); return; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Graceful stop has not finished after 30 seconds. Backup remains blocked; inspect the logs.');
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
