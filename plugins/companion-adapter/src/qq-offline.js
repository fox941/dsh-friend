import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {qqConfigFile,qqId,qqSettings,readQQSettings} from './qq-config.js';
export {readQQSettings} from './qq-config.js';
async function safeDirectory(directory){
  let ancestor=directory;while(!existsSync(ancestor)){const parent=path.dirname(ancestor);if(parent===ancestor)throw new Error('配置目录无有效父目录');ancestor=parent;}
  if(path.resolve(await fs.realpath(ancestor)).toLowerCase()!==path.resolve(ancestor).toLowerCase())throw new Error('QQ配置目录不能经过链接');
  await fs.mkdir(directory,{recursive:true});
  if(path.resolve(await fs.realpath(directory)).toLowerCase()!==path.resolve(directory).toLowerCase())throw new Error('QQ配置目录不能经过链接');
}
async function atomic(file,value){
  const stat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(stat&&!stat.isFile())throw new Error('QQ配置目标不是普通文件');
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temp,file);}finally{await fs.unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
function binding(instance){
  const file=path.join(instance,'companion/companion.sqlite');let db;
  if(!existsSync(file))return null;
  try{db=new DatabaseSync(file,{readOnly:true});return db.prepare("SELECT 1 FROM sqlite_master WHERE name='qq_bindings'").get()?db.prepare('SELECT * FROM qq_bindings WHERE active=1').get():null;}
  finally{db?.close();}
}
export async function configureQQ(instance,options,{assertOffline}={}){
  if(typeof assertOffline!=='function')throw new Error('QQ绑定必须通过停机配置入口');await assertOffline();
  const ownerQQ=qqId(options.ownerQQ,'主用户QQ号'),botQQ=qqId(options.botQQ,'AI的QQ号'),previous=await readQQSettings(instance),saved=binding(instance);
  if(previous.configured&&(previous.ownerQQ!==ownerQQ||previous.botQQ!==botQQ)||saved&&(saved.owner_qq!==ownerQQ||saved.bot_qq!==botQQ||previous.configured&&saved.id!==previous.bindingId))throw new Error('已有QQ绑定，不能自动更换角色所属账号');
  const port=options.port??3001,webPort=options.webPort??6099;
  if(![port,webPort].every(value=>Number.isSafeInteger(value)&&value>=1024&&value<=65535)||port===webPort)throw new Error('QQ端口需为不同的1024–65535整数');
  const config=qqSettings({schema:'ai-friend-qq/1',enabled:options.enabled??true,bindingId:previous.bindingId??saved?.id??crypto.randomUUID(),ownerQQ,botQQ,url:'ws://127.0.0.1:'+port,accessToken:previous.accessToken??crypto.randomBytes(32).toString('hex'),...(previous.configured?Object.fromEntries(['callTimeoutMs','turnTimeoutMs','maxPending','dailyMessages','perMinute','maxDeferSeconds','deferTtlSeconds'].map(key=>[key,previous[key]])):{} )});
  const {configured,...local}=config,folder=path.dirname(qqConfigFile(instance)),napcat=path.join(folder,'napcat'),directory=path.join(napcat,'config');
  await safeDirectory(folder);await safeDirectory(directory);await assertOffline();
  // Publish disabled first. Interrupted multi-file configuration cannot leave a partially enabled bridge.
  await atomic(qqConfigFile(instance),{schema:'ai-friend-qq/1',...local,enabled:false});
  const webFile=path.join(directory,'webui.json');let web;
  try{if(!(await fs.lstat(webFile)).isFile())throw new Error('WebUI配置不是普通文件');web=JSON.parse(await fs.readFile(webFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const token=typeof web?.token==='string'&&web.token.length>=32?web.token:crypto.randomBytes(32).toString('hex');
  await atomic(webFile,{host:'127.0.0.1',port:webPort,token,loginRate:10,autoLoginAccount:botQQ,disableWebUI:false,accessControlMode:'none',ipWhitelist:[],ipBlacklist:[]});
  const network={httpServers:[],httpSseServers:[],httpClients:[],websocketServers:[],websocketClients:[],plugins:[]};
  const base={network,musicSignUrl:'',enableLocalFile2Url:false,parseMultMsg:false,imageDownloadProxy:''};
  await atomic(path.join(directory,'onebot11.json'),base);
  await atomic(path.join(directory,'onebot11_'+botQQ+'.json'),{...base,network:{...network,websocketServers:[{name:'AI Friend private text',enable:true,host:'127.0.0.1',port,messagePostFormat:'array',reportSelfMessage:false,token:config.accessToken,enableForcePushEvent:false,debug:false,heartInterval:30000}]}});
  await atomic(path.join(directory,'napcat.json'),{fileLog:false,consoleLog:true,fileLogLevel:'error',consoleLogLevel:'error',packetBackend:'auto',enableLocalFile2Url:false});
  await assertOffline();await atomic(qqConfigFile(instance),{schema:'ai-friend-qq/1',...local});
  return {configured:true,enabled:config.enabled,ownerQQ,botQQ,port,webPort,workdir:napcat};
}
export async function qqLocalStatus(instance){
  const config=await readQQSettings(instance),saved=binding(instance);
  return {configured:config.configured,enabled:config.enabled,ownerQQ:config.ownerQQ??null,botQQ:config.botQQ??null,sessionId:saved?.session_id??null,realQQLoginVerified:false,note:'本地配置不代表已经登录；实时连接状态请查看 friend_qq_status。'};
}
