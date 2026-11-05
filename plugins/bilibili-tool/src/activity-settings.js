import {BilibiliWorkbenchView} from './workbench-view.js';
const invalid=()=>Object.assign(Error('活动配置只允许修改已列出的浏览额度和冷却'),{status:400});
/** Shares the original configuration transaction, version and command receipts. */
export class ActivitySettings {
 constructor(controller){this.c=controller;this.view=new BilibiliWorkbenchView(controller,{sourceFile:'activity-console'});}
 read(){
  const s=this.view.settings(),group=s.fields.find(g=>g.group==='activity');
  return {available:true,editable:typeof this.c.writeEnabled==='function'&&this.c.writeEnabled(),revision:s.revision,values:{activity:s.values.activity},fields:[{...group,label:'B站浏览与探索',fields:group.fields.map(f=>({...f,label:f.key==='decisionDailyLimit'?'自动活动准入次数/日':f.key==='manualDailyLimit'?'用户要求观看次数/日':f.label,help:f.key==='decisionDailyLimit'?'仅限制B站自动活动准入，不是全部全局行为选择次数。':f.key==='dailyLimit'?'观看阶段前预留额度，不等于成功看完的视频数。':f.key==='cooldownMinutes'?'两次自动活动开始之间的最短间隔，不代表每次观看时长。':f.key==='manualCooldownSeconds'?'两次用户要求观看的任务开始之间的最短间隔，单位为秒。':undefined}))}],notice:'沿用同一份B站活动配置。保存后后续准入采用新值，等待资源的事项可重新考虑，具体何时行动仍由她决定。'};
 }
 configure(command){
  const changes=command?.changes;
  if(command?.kind!=='settings'||!changes||typeof changes!=='object'||Array.isArray(changes)||Object.keys(changes).some(k=>k!=='activity')||!changes.activity||typeof changes.activity!=='object'||Array.isArray(changes.activity))throw invalid();
  const allowed=new Set(this.read().fields[0].fields.map(f=>f.key));if(Object.keys(changes.activity).some(k=>!allowed.has(k)))throw invalid();
  return this.view.command(command);
 }
}
