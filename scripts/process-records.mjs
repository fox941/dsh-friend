import fs from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import crypto from 'node:crypto';
const execute=promisify(execFile);let boot;
// Boot timestamps may move with clock corrections. A different hash is a hint,
// never evidence that a live PID or an exclusive maintenance lock has exited.
export function fromPreviousBoot(record,current){return typeof record?.bootKey==='string'&&/^[a-f0-9]{64}$/.test(record.bootKey)&&typeof current==='string'&&/^[a-f0-9]{64}$/.test(current)&&record.bootKey!==current;}
export function currentBootKey(){return boot??= (async()=>{try{
 if(process.platform==='win32'){
  const script="$ErrorActionPreference='Stop'; $g=(Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography' -Name MachineGuid).MachineGuid; $b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks; $h=[Security.Cryptography.SHA256]::Create(); try {([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($g+'|'+$b)))).Replace('-','').ToLowerInvariant()} finally {$h.Dispose()}";
  const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:15000});const value=r.stdout.trim();return /^[a-f0-9]{64}$/.test(value)?value:null;
 }
 if(process.platform==='linux')return crypto.createHash('sha256').update((await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim()).digest('hex');return null;
 }catch{return null;}})();}
function validPid(pid){if(!Number.isSafeInteger(pid)||pid<1)throw Error('进程运行记录无效');}
function exists(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;if(e.code==='EPERM')return true;throw e;}}
export function validProcessIdentity(value){return Boolean(value&&typeof value==='object'&&(value.kind==='win32-filetime'&&typeof value.value==='string'&&/^[0-9]{15,20}$/.test(value.value)||value.kind==='linux-starttime'&&typeof value.value==='string'&&/^[a-f0-9]{64}$/.test(value.value)));}
/** OS creation identity, not the wall-clock time when our JSON was written. */
export async function readProcessIdentity(pid){
 validPid(pid);
 try{
  if(process.platform==='win32'){
   const script="$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById("+pid+"); try {$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString([Globalization.CultureInfo]::InvariantCulture)} finally {$p.Dispose()}";
   const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:16384}),value=r.stdout.trim();return /^[0-9]{15,20}$/.test(value)?{kind:'win32-filetime',value}:null;
  }
  if(process.platform==='linux'){
   const stat=await fs.readFile('/proc/'+pid+'/stat','utf8'),ticks=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/)[19],id=(await fs.readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
   if(/^\d+$/.test(ticks)&&/^[a-f0-9-]{36}$/i.test(id))return {kind:'linux-starttime',value:crypto.createHash('sha256').update(id+'|'+ticks).digest('hex')};
  }
 }catch{}
 return null;
}
let selfIdentity;
export async function processStamp(){return {bootKey:await currentBootKey(),processIdentity:await(selfIdentity??=readProcessIdentity(process.pid))};}
export async function inspectProcessRecord(record,{pidExists=exists,readIdentity=readProcessIdentity}={}){
 validPid(record?.pid);
 if(!await pidExists(record.pid))return {state:'dead',proof:'pid_absent'};
 const saved=record.processIdentity;
 if(!validProcessIdentity(saved))return {state:'unknown',proof:'legacy_or_missing_creation_identity'};
 let actual;try{actual=await readIdentity(record.pid);}catch{return {state:'unknown',proof:'creation_identity_unavailable'};}
 // Query failures/unsupported formats remain blocking; they cannot release locks.
 if(!validProcessIdentity(actual)||actual.kind!==saved.kind)return {state:'unknown',proof:'creation_identity_unavailable'};
 if(actual.value!==saved.value)return {state:'reused',proof:'creation_identity_changed'};
 // Close the process-exit race after reading the OS creation identity.
 if(!await pidExists(record.pid))return {state:'dead',proof:'pid_absent'};
 return {state:'running',proof:'creation_identity_matches'};
}
export async function recordAlive(record,options){const result=await inspectProcessRecord(record,options);return !['dead','reused'].includes(result.state);}
