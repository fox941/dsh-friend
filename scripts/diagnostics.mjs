import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {instanceRoot} from './paths.mjs';
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const hours=value('--hours')===undefined?24:Number(value('--hours')),intentId=value('--intent')??null;
const file=path.join(instanceRoot,'companion/companion.sqlite');
if(!fs.existsSync(file)){console.log('诊断尚未初始化。');process.exit(0);}
const require=createRequire(path.join(instanceRoot,'dsh-home/profiles/web/package.json'));
const {readDiagnostics}=await import(pathToFileURL(require.resolve('@ai-friend/companion-adapter/diagnostics')));
const db=new DatabaseSync(file,{readOnly:true});let result;
try{result=readDiagnostics(db,{hours,intentId});}finally{db.close();}
if(args.includes('--json'))console.log(JSON.stringify(result,null,2));
else if(result.status!=='read')console.log(result.notice);
else{
  const labels={selection:'行为选择',expression:'交流生成',emotion:'情绪审核',reflection:'自主反思',growth:'成长审核',memory:'记忆审核',activity:'浏览活动',session_other:'其他会话调用'};
  console.log(`AI Friend 运行诊断 · 最近 ${hours} 小时\n开始采集：${result.window.collectionStartedAt}\n${result.window.historicalCoveragePartial?'所选时段未完整覆盖，统计仅含已留存记录。':'统计覆盖已留存的采集记录。'}`);
  for(const c of result.costs)console.log(`${labels[c.stage]??c.stage}：${c.calls} 次；tokens ${c.totalTokens??'未知'}（${c.usageSamples}/${c.calls} 次有用量）；耗时中位数 ${c.latency.p50Ms??'未知'} ms，P95 ${c.latency.p95Ms??'未知'} ms`);
  if(!result.costs.length)console.log('尚无模型调用样本，不推断历史用量为零。');
  console.log(`未完事项样本：${result.behaviour.unfinished?.length??0}；需查看线索：${result.findings.length}`);
  for(const f of result.findings)console.log(`- ${f.meaning}${f.intentId?' ['+f.intentId+']':''}`);
  console.log(result.scope);
}
