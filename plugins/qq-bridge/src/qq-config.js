import fs from 'node:fs/promises';import path from 'node:path';
export const qqConfigFile=instance=>path.join(instance,'channels','qq','config.local.json');
export function qqId(value,label='QQ号'){
  const id=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
  if(typeof id!=='string'||!/^\d{5,12}$/.test(id)||id.startsWith('0'))throw new Error(`${label}格式不正确`);return id;
}
export function qqSettings(input={}){
  if(input===null||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['schema','enabled','bindingId','ownerQQ','botQQ','url','accessToken','callTimeoutMs','turnTimeoutMs','maxPending','dailyMessages','perMinute','maxDeferSeconds','deferTtlSeconds'].includes(key)))throw new Error('QQ配置包含未知字段');
  if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new Error('QQ启用开关必须是布尔值');
  if(input.schema!==undefined&&input.schema!=='ai-friend-qq/1')throw new Error('不支持的QQ配置版本');
  const enabled=input.enabled??false;
  if(!input.ownerQQ&&!input.botQQ&&!enabled)return {enabled:false,configured:false};
  const ownerQQ=qqId(input.ownerQQ,'主用户QQ号'),botQQ=qqId(input.botQQ,'AI的QQ号');if(ownerQQ===botQQ)throw new Error('主用户与AI需要不同QQ账号');
  if(typeof input.bindingId!=='string'||!/^[a-f0-9-]{36}$/i.test(input.bindingId))throw new Error('缺少QQ绑定标识，请使用配置命令生成');
  const url=new URL(input.url??'ws://127.0.0.1:3001');
  if(url.protocol!=='ws:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new Error('首版QQ只连接本机经过认证的OneBot WebSocket');
  if(typeof input.accessToken!=='string'||input.accessToken.length<32||input.accessToken.length>256||/[\r\n]/.test(input.accessToken))throw new Error('QQ连接需要至少32字符的本地访问令牌');
  const integer=(key,fallback,min,max)=>{const value=input[key]??fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('QQ运行限额超出范围');return value;};
  return {configured:true,enabled,bindingId:input.bindingId,ownerQQ,botQQ,url:url.href,accessToken:input.accessToken,callTimeoutMs:integer('callTimeoutMs',10000,1000,30000),turnTimeoutMs:integer('turnTimeoutMs',180000,10000,300000),maxPending:integer('maxPending',20,1,100),dailyMessages:integer('dailyMessages',300,1,2000),perMinute:integer('perMinute',20,1,120),maxDeferSeconds:integer('maxDeferSeconds',300,5,300),deferTtlSeconds:integer('deferTtlSeconds',60,10,300)};
}
export async function readQQSettings(instance){
  const file=qqConfigFile(instance),stat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return qqSettings();
  if(stat.isSymbolicLink()||stat.size>16384||path.resolve(await fs.realpath(file)).toLowerCase()!==path.resolve(file).toLowerCase())throw new Error('QQ本地配置路径或大小不符合要求');
  return qqSettings(JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'')));
}
