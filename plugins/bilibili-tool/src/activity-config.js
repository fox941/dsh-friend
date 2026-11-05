import fs from 'node:fs/promises';import path from 'node:path';

export const accountUploadHelp='请使用ownerLatest或明确UID的投稿目录；关键词搜索不能确认哪条是你的投稿。也可以提供具体BV号或完整视频链接。';
export function requiresAccountUploadLookup(request,quote=''){
 if(request.video||request.watchItemId||request.discovery?.source==='creator'&&request.discovery.selection==='latest')return false;
 return /(?:最新|最近|新发|新投|刚发|刚投)/.test(quote)&&/(?:我.{0,12}(?:账号|主页|空间|投稿|上传)|我(?:发|投)|(?:账号|主页|空间).{0,16}(?:投稿|上传))/.test(quote);
}
export const activityDirectory=instance=>path.join(instance,'channels/bilibili');
export function activityConfig(config={}){
  if(!config||typeof config!=='object'||Array.isArray(config))throw new Error('活动配置必须为对象');
  for(const name of ['enabled','automatic'])if(config[name]!==undefined&&typeof config[name]!=='boolean')throw new Error('活动开关必须为布尔值');
  const bounded=(name,fallback,min,max)=>{const value=config[name]??fallback;if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('活动预算超出范围');return value;};
  return {enabled:config.enabled??true,automatic:config.automatic??false,dailyLimit:bounded('dailyLimit',6,1,10),decisionDailyLimit:bounded('decisionDailyLimit',12,1,24),manualDailyLimit:bounded('manualDailyLimit',30,1,30),manualCooldownSeconds:bounded('manualCooldownSeconds',30,5,600),cooldownMinutes:bounded('cooldownMinutes',60,10,1440),idleSeconds:bounded('idleSeconds',120,1,1800),timeoutMs:bounded('timeoutMs',300000,10000,600000),quietStart:23,quietEnd:8};
}
export async function readBiliCredentials(instance){const file=path.join(activityDirectory(instance),'credentials.local.json'),stat=await fs.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});if(!stat)return null;
 if(!stat.isFile()||stat.size>16384||path.resolve(await fs.realpath(file)).toLowerCase()!==path.resolve(file).toLowerCase())throw new Error('B站凭据路径或大小异常');
 const c=JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,''));for(const name of ['sessdata','bili_jct','dedeuserid'])if(typeof c[name]!=='string'||!c[name]||c[name].length>4096||/[\r\n]/.test(c[name]))throw new Error('B站凭据字段无效');if(!/^\d+$/.test(c.dedeuserid))throw new Error('B站账号字段无效');if(c.expiresAt&&c.expiresAt<Date.now())throw new Error('B站登录已过期，请重新扫码');return c;
}
export function biliId(input){if(typeof input!=='string')throw new Error('需要BV号或B站视频链接');let value=input.trim(),page=1;if(/^https:\/\//.test(value)){const url=new URL(value);if(!['www.bilibili.com','bilibili.com'].includes(url.hostname)||url.username||url.password||url.port||!/^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname))throw new Error('只接收完整的B站视频链接或BV号');page=Number(url.searchParams.get('p')??1);value=url.pathname.split('/')[2];}if(!/^BV[0-9A-Za-z]{10}$/.test(value)||!Number.isSafeInteger(page)||page<1||page>100)throw new Error('BV号或分P无效');return {bvid:value,page};}
