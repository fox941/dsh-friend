import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {readBiliCredentials,activityConfig} from './activity-config.js';
import {accountPolicy} from './bilibili-account-store.js';
import {videoSettingFields,readVideoSettings,writeVideoSettings} from './video-config.js';

const escape=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const shanghaiDay=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date);
const json=value=>{try{return value?JSON.parse(value):null;}catch{return null;}};
const rows=(db,table,where,limit=20)=>{try{if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return [];return db.prepare(`SELECT * FROM ${table} ${where??''} ORDER BY rowid DESC LIMIT ?`).all(limit);}catch{return [];}};
const preview=(text,max=180)=>typeof text==='string'&&text.length>max?text.slice(0,max)+'…':text??null;

/** AI 账号自己的关注列表（只读，需要真实登录）；不读取黑名单或悄悄关注。 */
export async function fetchFollowing(instance,{request=fetch,limit=20,signal}={}){
 const c=await readBiliCredentials(instance);if(!c)return {state:'unconfigured',scope:'尚未登录AI账号；运行Login-Bilibili.cmd后重试'};
 try{
  const response=await request(`https://api.bilibili.com/x/relation/followings?vmid=${encodeURIComponent(c.dedeuserid)}&ps=${Math.min(50,limit)}&order=attention`,{headers:{'user-agent':'Mozilla/5.0','referer':'https://space.bilibili.com/',cookie:`SESSDATA=${c.sessdata}; bili_jct=${c.bili_jct}; DedeUserID=${c.dedeuserid}`},signal:AbortSignal.timeout(12000),...(signal?{signal}:{})});
  if(!response.ok)return {state:'unavailable',reason:'HTTP '+response.status};
  const body=await response.json();
  if(body.code!==0)return {state:body.code===-101?'expired':'unavailable',reason:'code='+Number(body.code)+(typeof body.message==='string'?'：'+body.message:'')};
  const list=(body.data?.list??[]).slice(0,limit).map(item=>({mid:String(item.mid??''),name:String(item.uname??'').slice(0,60),sign:preview(item.sign,120)}));
  return {state:'ready',total:Number.isFinite(body.data?.total)?body.data.total:list.length,list};
 }catch(error){return {state:'unavailable',reason:preview(String(error?.message??error),120)};}
}

/** 今日活动快照：只读打开 companion.sqlite，绝不读取或输出任何凭据字段。 */
export function consoleSnapshot(instance,{day=shanghaiDay()}={}){
 const file=path.join(instance,'companion','companion.sqlite');
 if(!fs.existsSync(file))return {day,generatedAt:new Date().toISOString(),initialized:false,sections:{},scope:'实例尚未初始化'};
 const db=new DatabaseSync(file,{readOnly:true});
 try{
  const activity=rows(db,'activity_runs','WHERE status IS NOT NULL',10).map(r=>{const request=json(r.request_json)??{},decision=json(r.decision_json)??{},result=json(r.result_json)??{};return {id:r.id,day:r.day,trigger:r.trigger,status:r.status,at:r.created_at,summary:preview(result.summary,240),video:request.video??decision?.selectedTarget?.bvid??null,scope:preview(result.scope,200),memoryVerified:result.memory?.verified===true,error:preview(r.error,140),discovery:decision?.discovery?{source:decision.discovery.source,reason:preview(decision.reason,160)}:null};});
  const observations={};
  for(const r of rows(db,'activity_observations','',24)){try{const p=json(r.payload_json)??{};observations[r.id]={title:preview(p.title,140),url:p.url,bvid:p.bvid,page:p.page,scope:preview(p.scope,220),textChars:typeof p.text==='string'?p.text.length:0,at:r.created_at};}catch{}}
  const social=rows(db,'bili_social_turns','',14).map(t=>{const decision=json(t.decision_json)??{};return {id:t.id,threadKey:t.thread_key,status:t.status,at:t.created_at,disposition:decision.disposition??null,summary:preview(decision.summary,200),draft:preview(decision.draft,240)};});
  const outboxes=rows(db,'bili_social_outbox','',14).map(o=>{const receipt=json(o.receipt_json)??{};return {id:o.id,turnId:o.turn_id,status:o.status,platformId:o.platform_id??null,at:o.created_at,body:preview(o.body,220),readBackVerified:receipt.readBackVerified===true,publishedBody:preview(receipt.publishedBody,200),error:preview(o.error,140)};});
  const events=rows(db,'bili_inbox_events','',16).map(e=>{const p=json(e.payload_json)??{};return {id:e.id,kind:e.kind,sender:e.sender,status:e.status,at:e.created_at,text:preview(p.text,180),scope:p.scope?'公开':(e.kind==='private'?'私信':'未知')};});
  const attempts=rows(db,'bili_inbox_attempts','',16).map(a=>({id:a.id,eventId:a.event_id,status:a.status,at:a.created_at,result:json(a.result_json),error:preview(a.error,140)}));
  const accountActions=rows(db,'bili_account_actions','',14).map(a=>({id:a.id,action:a.action,target:a.bvid??a.uid??null,accountUid:a.account_uid??null,status:a.status,at:a.created_at,reason:preview(a.reason,180),undoOf:a.undo_of??null,error:preview(a.error,140)}));
  const platformOps=rows(db,'platform_operations','',14).filter(o=>String(o.action??'').startsWith('bili_')).map(o=>{const args=json(o.args_json)??{},receipt=json(o.receipt_json)??{};return {id:o.id,action:o.action,status:o.status,at:o.created_at,args,dispatched:o.dispatched===1||o.dispatched===true,verified:receipt.verified===true,reason:preview(o.reason,180)};});
  const activityControl=(()=>{try{const r=db.prepare('SELECT automatic,policy_json,updated_at FROM activity_control').get();return r?{automatic:r.automatic===1,policy:json(r.policy_json)??{},at:r.updated_at}:null;}catch{return null;}})();
  const inboxControl=(()=>{try{return db.prepare('SELECT * FROM bili_inbox_control LIMIT 1').get()??null;}catch{return null;}})();
  const socialMeta=(()=>{try{return db.prepare('SELECT key,value FROM bili_social_meta').all();}catch{return [];}})();
  const accountControl=(()=>{try{return db.prepare('SELECT * FROM bili_account_control LIMIT 1').get()??null;}catch{return null;}})();
  const platformPolicy=(()=>{try{return db.prepare('SELECT * FROM platform_meta LIMIT 1').get()??null;}catch{return null;}})();
  const accountDisplay=(()=>{if(!accountControl)return null;const policy=json(accountControl.policy_json)??{};return {policy,revision:accountControl.revision};})();
  const notebookCount=(()=>{try{if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_video_notebooks'").get())return null;return db.prepare('SELECT count(*) n FROM activity_video_notebooks').get().n;}catch{return null;}})();
  const videoSections=(()=>{try{if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='activity_video_sessions'").get())return null;return db.prepare('SELECT count(*) n FROM activity_video_sessions').get().n;}catch{return null;}})();
  return {day,generatedAt:new Date().toISOString(),initialized:true,todayActivity:activity.filter(r=>r.day===day),recentActivity:activity,observations,social,outboxes,events,attempts,accountActions,platformOps,
   config:{activity:activityControl,inbox:inboxControl,socialOutgoing:socialMeta.find(r=>r.key==='outgoing')?.value??'default',account:accountDisplay,platform:platformPolicy,video:readVideoSettings(db).settings,videoNotebooks:notebookCount,videoSessions:videoSections},
   scope:'静态快照：仅展示本插件已实际取得的观察与回执；重新生成请运行 Bilibili-Console.cmd。凭据不出现在本页。'};
 }finally{db.close();}
}

const card=(title,lines)=>`<article><h2>${escape(title)}</h2>${lines.map(([k,v])=>v==null||v===''?'':`<p><b>${escape(k)}</b>：${typeof v==='string'&&v.startsWith('<a ')?v:escape(v)}</p>`).join('')}</article>`;
const section=(id,title,body)=>`<section id="${escape(id)}"><h2>${escape(title)}</h2>${body}</section>`;
const listOrEmpty=(items,empty)=>items.length?items.join(''):`<p><small>${escape(empty)}</small></p>`;

export function consoleHtml(snapshot,following){
 const s=snapshot,videoCards=(s.todayActivity?.length?s.todayActivity:s.recentActivity??[]).map(r=>card((r.day===s.day?'今日':'最近')+'观看 · '+r.status,[
  ['时间',r.at],['触发',r.trigger],['视频',r.video],['理解摘要',r.summary],['实际观察范围',r.scope],['记忆已核验',r.memoryVerified?'是':'否'],['发现来源',r.discovery?r.discovery.source+'（'+r.discovery.reason+'）':null],['错误',r.error]]));
 const socialCards=s.social?.map(t=>{const outbox=s.outboxes?.find(o=>o.turnId===t.id);return card('交流 · '+t.status,[['时间',t.at],['话题',t.threadKey],['判断',t.disposition],['理解',t.summary],['答复草稿',t.draft],outbox?['回复状态',outbox.status+'（读回核验'+(outbox.readBackVerified?'通过':'未完成')+'）']:null,outbox?['已发布内容',outbox.publishedBody??outbox.body]:null,outbox?['平台ID',outbox.platformId]:null,outbox?['错误',outbox.error]:null].filter(Boolean));})??[];
 const eventCards=s.events?.map(e=>{const attempt=s.attempts?.find(a=>a.eventId===e.id);return card('事件 · '+e.kind+' · '+e.status,[['时间',e.at],['发送者',e.sender],['范围',e.scope],['原文',e.text],['处理',attempt?attempt.status:'未处理'],['结果',attempt?.result?JSON.stringify(attempt.result).slice(0,220):null],['错误',attempt?.error]].filter(Boolean));})??[];
 const accountCards=s.accountActions?.map(a=>card('账号操作 · '+a.action+' · '+a.status,[['时间',a.at],['目标',a.target],['账号',a.accountUid],['理由',a.reason],['撤销自',a.undoOf],['错误',a.error]]))??[];
 const platformCards=s.platformOps?.map(o=>card('平台写操作 · '+o.action+' · '+o.status,[['时间',o.at],['参数',JSON.stringify(o.args)],['已提交',o.dispatched?'是':'否'],['读回核验',o.verified?'通过':'未完成'],['理由',o.reason]]))??[];
 const cfg=s.config??{},followingBody=()=>{
  if(!following)return '<p><small>本次未获取关注列表（可用 <code>node scripts/bilibili.mjs console --live</code> 重新生成）。</small></p>';
  if(following.state!=='ready')return `<p><small>关注列表不可用：${escape(following.reason??following.state)}。</small></p>`;
  return `<p>共 ${escape(following.total)} 个关注，显示前 ${escape(following.list.length)} 个：</p><ul>${following.list.map(item=>`<li><b>${escape(item.name)}</b>（UID ${escape(item.mid)}）${item.sign?'：'+escape(item.sign):''}</li>`).join('')}</ul>`;
 };
 const currentValues={
  video:cfg.video??{},
  activity:{automatic:cfg.activity?.automatic===true,policy:cfg.activity?.policy??{}},
  inbox:{enabled:cfg.inbox?cfg.inbox.enabled===1||cfg.inbox.enabled===true:false},
  social:{outgoing:cfg.socialOutgoing==='true'},
  account:cfg.account?.policy??{}
 };
 const formField=(group,field)=>{const current=group==='activity'&&field.key!=='automatic'?currentValues.activity.policy[field.key]:currentValues[group]?.[field.key];const id=`cfg-${group}-${field.key}`;
  if(field.kind==='bool')return `<label for="${id}">${escape(field.label)}</label> <input type="checkbox" id="${id}" data-group="${escape(group)}" data-key="${escape(field.key)}" data-kind="bool" ${current?'checked':''}>`;
  if(field.kind==='int')return `<label for="${id}">${escape(field.label)}（${field.min}–${field.max}）</label> <input type="number" id="${id}" data-group="${escape(group)}" data-key="${escape(field.key)}" data-kind="int" min="${field.min}" max="${field.max}" value="${escape(current??'')}">`;
  return `<label for="${id}">${escape(field.label)}</label> <input type="text" id="${id}" data-group="${escape(group)}" data-key="${escape(field.key)}" data-kind="string" value="${escape(current??'')}">`;};
 const configForm=s.initialized?`<article><h3>修改配置（生成请求 → 应用）</h3><p><small>页面本身不写任何数据：提交会生成一份变更请求文件，保存到 <code>runtime/dev/companion/console/config-request.json</code> 后双击 <code>Bilibili-Config.cmd</code> 校验并应用；每次应用都记入 config-audit.jsonl 审计。</small></p>
  ${configFields.map(group=>`<fieldset><legend>${escape(group.label)}</legend>${group.fields.map(f=>'<div>'+formField(group.group,f)+'</div>').join('')}</fieldset>`).join('')}
  <p><button id="cfg-submit" type="button">生成变更请求</button> <span id="cfg-result"></span></p>
  <pre id="cfg-payload" style="display:none"></pre>
  <script>
  (function(){
   var CURRENT=${JSON.stringify(currentValues).replace(/<\//g,'<\\/')};
   function collect(){
    var changes={};
    document.querySelectorAll('input[data-group]').forEach(function(input){
     var group=input.dataset.group,key=input.dataset.key,kind=input.dataset.kind,current=(CURRENT[group]&&key==='automatic')?CURRENT[group].automatic:(CURRENT[group]&&CURRENT[group].policy)?CURRENT[group].policy[key]:CURRENT[group]?CURRENT[group][key]:undefined;
     if(kind==='bool'){var value=input.checked;if(value!==!!current){changes[group]=changes[group]||{};changes[group][key]=value;}return;}
     var raw=input.value.trim();
     if(kind==='int'){if(raw==='')return;var n=Number(raw);if(n===current)return;changes[group]=changes[group]||{};changes[group][key]=n;return;}
     if(raw===(current??''))return;changes[group]=changes[group]||{};changes[group][key]=raw===''?null:raw;
    });
    return changes;
   }
   function show(text){var el=document.getElementById('cfg-result');el.textContent='';var pre=document.getElementById('cfg-payload');pre.style.display='block';pre.textContent=text;}
   document.getElementById('cfg-submit').addEventListener('click',function(){
    var changes;
    try{changes=collect();}catch(e){alert('读取表单失败：'+e.message);return;}
    if(!Object.keys(changes).length){alert('没有检测到任何修改。');return;}
    var request={schema:'ai-friend-bili-config-request/1',requestedAt:new Date().toISOString(),changes:changes};
    var text=JSON.stringify(request,null,2),done=function(note){show((note||'')+'\\n\\n'+text);};
    if(window.showSaveFilePicker){window.showSaveFilePicker({suggestedName:'config-request.json',types:[{description:'B站配置变更请求',accept:{'application/json':['.json']}}]}).then(function(handle){return handle.createWritable().then(function(w){return w.write(text).then(function(){return w.close();});});}).then(function(){done('请求文件已保存。请确认它位于 runtime/dev/companion/console/config-request.json（否则移动过去），然后双击 Bilibili-Config.cmd 应用。');}).catch(function(e){if(e&&e.name==='AbortError')return;fallback();});}
    else fallback();
    function fallback(){if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){done('请求 JSON 已复制到剪贴板。请把它保存为 runtime/dev/companion/console/config-request.json，然后双击 Bilibili-Config.cmd 应用。');},function(){done('请手动保存以下请求为 config-request.json，然后双击 Bilibili-Config.cmd 应用。');});}else done('请手动保存以下请求为 config-request.json，然后双击 Bilibili-Config.cmd 应用。');}
   });
  })();
  </script></article>`:'';
 return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>B站活动面板 · ${escape(s.day)}</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:1060px;margin:32px auto;padding:0 24px;color:#17212b;background:#f6f7f9}section{margin:26px 0}article{background:white;padding:18px 20px;margin:12px 0;border:1px solid #dde1e8;border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f4f7;padding:12px;border-radius:8px}small{color:#526171}h1,h2,h3{line-height:1.3}b{color:#183e57}nav a{margin-right:14px;color:#155e9c}code{background:#eef1f4;padding:1px 5px;border-radius:4px}fieldset{border:1px solid #dde1e8;border-radius:8px;margin:10px 0}label{margin-right:6px}input[type=number],input[type=text]{width:9em}</style><h1>B站活动面板（${escape(s.day)}）</h1><p>生成于 ${escape(s.generatedAt)} · 这是静态快照：只包含本插件已实际取得的观察与回执，不等于完整看过或发送成功；重新生成请运行 <code>Bilibili-Console.cmd</code>。凭据不出现在本页。</p><nav><a href="#watch">今日观看</a><a href="#social">交流回复</a><a href="#events">私信与事件</a><a href="#account">账号操作</a><a href="#platform">点赞投币动态</a><a href="#config">配置开关</a><a href="#following">关注列表</a></nav>${section('watch','今日观看',listOrEmpty(videoCards,'今日（或近期）没有实际观看记录；目录发现不等于观看。'))}${section('social','交流回复',listOrEmpty(socialCards,'近期没有B站交流回合。'))}${section('events','私信与事件',listOrEmpty(eventCards,'近期没有收到B站事件。'))}${section('account','账号操作（收藏/关注）',listOrEmpty(accountCards,'近期没有账号操作候选或回执。'))}${section('platform','点赞 / 投币 / 动态',listOrEmpty(platformCards,'近期没有平台写操作。'))}${section('config','配置与开关',`<article><p><b>自主观看</b>：${escape(JSON.stringify(cfg.activity??null))}</p><p><b>收件箱</b>：${escape(JSON.stringify(cfg.inbox??null))}</p><p><b>社交回复开关</b>：${escape(cfg.socialOutgoing??'default')}</p><p><b>账号操作</b>：${escape(JSON.stringify(cfg.account??null))}</p><p><b>平台策略</b>：${escape(JSON.stringify(cfg.platform??null))}</p><p><b>视频笔记/观看会话累计</b>：${escape(String(cfg.videoNotebooks??'—'))} / ${escape(String(cfg.videoSessions??'—'))}</p><small>修改方式：提交下方表单生成请求文件后用 <code>Bilibili-Config.cmd</code> 应用；也可继续用 <code>friend_activity_control</code>、<code>friend_bilibili_inbox_control</code>、<code>friend_bilibili_social_control</code>、<code>friend_bilibili_account_control</code>。</small></article>`+configForm)}${section('following','关注列表',followingBody())}<details><summary>原始数据（JSON）</summary><pre>${escape(JSON.stringify({...s,following},null,2))}</pre></details></html>`;
}

/** 生成并写出控制台页；live=true 时附带关注列表真实读取。 */
export async function writeBilibiliConsole(instance,{day,live=true,request=fetch,signal}={}){
 const snapshot=consoleSnapshot(instance,{day});
 const following=live?await fetchFollowing(instance,{request,signal}):null;
 const folder=path.join(instance,'companion','console');
 await fs.promises.mkdir(folder,{recursive:true});
 const file=path.join(folder,'bilibili-console.html');
 const stat=await fs.promises.lstat(file).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
 if(stat?.isSymbolicLink())throw new Error('控制台文件不允许是符号链接');
 await fs.promises.writeFile(file,consoleHtml(snapshot,following));
 return {file,snapshot,following};
}

// ---------- 受控配置写通道 ----------
// 白名单字段与在线 control() 工具的授权范围一致；页面表单只生成请求文件，
// 应用必须经 Bilibili-Config.cmd 校验后写入并记审计，页面本身没有任何写入口。

export const configRequestSchema='ai-friend-bili-config-request/1';
export const configFields=[
 {group:'video',label:'视频观察与采样',fields:videoSettingFields},
 {group:'activity',label:'自主观看',fields:[
  {key:'automatic',kind:'bool',label:'自动探索开关'},
  {key:'dailyLimit',kind:'int',min:1,max:10,label:'自动探索次数/日'},
  {key:'decisionDailyLimit',kind:'int',min:1,max:24,label:'自动决策次数/日'},
  {key:'cooldownMinutes',kind:'int',min:10,max:1440,label:'自动冷却（分钟）'},
  {key:'manualDailyLimit',kind:'int',min:1,max:30,label:'手动任务次数/日'},
  {key:'manualCooldownSeconds',kind:'int',min:5,max:600,label:'手动冷却（秒）'}]},
 {group:'inbox',label:'收件箱',fields:[
  {key:'enabled',kind:'bool',label:'事件接收开关'}]},
 {group:'social',label:'社交回复',fields:[
  {key:'outgoing',kind:'bool',label:'实际回复发送'}]},
 {group:'account',label:'账号操作',fields:[
  {key:'enabled',kind:'bool',label:'账号操作开关'},
  {key:'autonomous',kind:'bool',label:'自主提案'},
  {key:'dailyLimit',kind:'int',min:1,max:60,label:'每日写入上限'},
  {key:'cooldownSeconds',kind:'int',min:5,max:3600,label:'写入间隔（秒）'},
  {key:'folderId',kind:'string',optional:true,label:'收藏夹ID（留空=默认）'}]}
];

function normalizeChanges(changes){
 const invalid=message=>{const error=new Error(message);error.requestInvalid=true;return error;};
 if(!changes||typeof changes!=='object'||Array.isArray(changes))throw invalid('变更请求缺少 changes 对象');
 const problems=[],normalized={};
 const byGroup=new Map(configFields.map(g=>[g.group,g]));
 for(const [group,fields] of Object.entries(changes)){
  const definition=byGroup.get(group);
  if(!definition){problems.push('未知分组 '+group);continue;}
   if(!fields||typeof fields!=='object'||Array.isArray(fields)){problems.push(group+' 的变更不是对象');continue;}
  for(const [key,value] of Object.entries(fields)){
   const field=definition.fields.find(f=>f.key===key);
   if(!field){problems.push(group+' 不支持字段 '+key);continue;}
   if(field.kind==='bool'){if(typeof value!=='boolean'){problems.push(group+'.'+key+' 必须是布尔值');continue;}normalized[group]??={};normalized[group][key]=value;}
   else if(field.kind==='int'){
    const number=Number(value);
    if(!Number.isSafeInteger(number)||number<field.min||number>field.max){problems.push(group+'.'+key+' 必须是 '+field.min+'–'+field.max+' 的整数');continue;}
    normalized[group]??={};normalized[group][key]=number;
   }else if(field.kind==='string'){
    if(value!=null&&(typeof value!=='string'||value.length>80)){problems.push(group+'.'+key+' 必须是80字符以内的字符串或留空');continue;}
    normalized[group]??={};normalized[group][key]=typeof value==='string'&&value.trim()?value.trim():null;
   }
  }
 }
 if(problems.length)throw invalid('变更请求未通过白名单校验：'+problems.join('；'));
 if(!Object.keys(normalized).length)throw invalid('变更请求没有任何字段');
 return normalized;
}

/** 校验并应用请求文件中的白名单配置变更；单事务，全部成功或全部不写。 */
export function applyConfigRequest(instance,request,{sourceFile=null,beforeApply,recordApplied}={}){
 if(!request||request.schema!==configRequestSchema){const error=new Error('变更请求格式或版本不符，期望 '+configRequestSchema);error.requestInvalid=true;throw error;}
 const normalized=normalizeChanges(request.changes),file=path.join(instance,'companion','companion.sqlite');
 if(!fs.existsSync(file)){const error=new Error('实例尚未初始化');error.requestInvalid=true;throw error;}
 const db=new DatabaseSync(file,{timeout:5000}),applied=[],at=new Date().toISOString();
 try{
  db.exec('BEGIN IMMEDIATE');
  try{
   beforeApply?.(db);
   const activity=normalized.activity;
   if(activity){
    if(activity.automatic!==undefined){db.prepare('UPDATE activity_control SET automatic=?,updated_at=?').run(activity.automatic?1:0,at);applied.push({group:'activity',key:'automatic',value:activity.automatic});}
    const policyKeys=Object.keys(activity).filter(k=>k!=='automatic');
    if(policyKeys.length){
     const current=db.prepare('SELECT policy_json FROM activity_control').get(),merged=activityConfig({...(json(current?.policy_json)??{}),...Object.fromEntries(policyKeys.map(k=>[k,activity[k]]))});
     db.prepare('UPDATE activity_control SET policy_json=?,updated_at=?').run(JSON.stringify(merged),at);
     for(const k of policyKeys)applied.push({group:'activity',key:k,value:merged[k]});
    }
   }
   if(normalized.inbox?.enabled!==undefined){
    const enabled=normalized.inbox.enabled;
    db.prepare('UPDATE bili_inbox_control SET enabled=?,next_poll_at=0,updated_at=?').run(enabled?1:0,at);
    applied.push({group:'inbox',key:'enabled',value:enabled});
   }
   if(normalized.social?.outgoing!==undefined){
    db.prepare("INSERT INTO bili_social_meta VALUES('outgoing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(normalized.social.outgoing?'true':'false');
    applied.push({group:'social',key:'outgoing',value:normalized.social.outgoing});
   }
   const account=normalized.account;
   if(account){
    const current=db.prepare('SELECT policy_json,revision FROM bili_account_control').get(),policy=accountPolicy({...json(current?.policy_json)??{},...account});
    db.prepare('UPDATE bili_account_control SET policy_json=?,revision=revision+1').run(JSON.stringify(policy));
    for(const [k,v] of Object.entries(account))applied.push({group:'account',key:k,value:v});
   }
   if(normalized.video){const saved=writeVideoSettings(db,normalized.video,at);for(const key of Object.keys(normalized.video))applied.push({group:'video',key,value:saved.settings[key]});}
   recordApplied?.(db,{applied,at});
   db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
 }finally{db.close();}
 const audit={at,source:request.source==='web-ui'?'web-ui':'console-request',...(sourceFile?{requestFile:path.basename(sourceFile)}:{}),requestedAt:request.requestedAt??null,changes:normalized,applied};
 try{
  const auditFile=path.join(instance,'companion','console','config-audit.jsonl');
  fs.mkdirSync(path.dirname(auditFile),{recursive:true});
  fs.appendFileSync(auditFile,JSON.stringify(audit)+'\n');
 }catch{}
 return {applied,at};
}

