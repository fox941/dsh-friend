const table=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const states={queued:'等待模型选择',reviewing:'执行前核验',sending:'正在提交',accepted:'平台受理，自动核验待确认',confirmed:'自动核验通过',observed:'原件下已观察到匹配评论，提交归属未确认',unconfirmed:'已提交，自动核验未确认',unknown:'提交结果不明，不自动重发',failed:'执行失败',rejected:'已拒绝',cancelled:'已取消',unsupported:'接口未支持',noop:'无需重复执行'};
export function platformResultView(db,op){
 if(!op)return null;
 let feedback={state:'not_collected',label:'未形成结果回报候选'};
 if(table(db,'proactive_items')){
  const item=db.prepare('SELECT id,status,intent_id,attempt_id FROM proactive_items WHERE source_key=?').get('requested-qq-operation:'+op.id);
  if(item){const intent=item.intent_id&&table(db,'attention_intents')?db.prepare('SELECT status,wake_json,result_json FROM attention_intents WHERE id=?').get(item.intent_id):null,attempt=item.attempt_id&&table(db,'proactive_attempts')?db.prepare('SELECT status,platform_id,error FROM proactive_attempts WHERE id=?').get(item.attempt_id):null;
   const result=intent?.result_json?JSON.parse(intent.result_json):null;
   let state=item.status==='candidate'?(intent?.status==='waiting'?'deferred':'awaiting_model'):item.status;
   if(state==='sent'&&(!attempt?.platform_id||attempt.status!=='sent'))state='unknown';
   feedback={state,label:({awaiting_model:'等待模型决定是否回应',deferred:'模型已暂缓，等待重新考虑',silent:'模型选择不发',sent:'平台确认通知已发送，不代表已读',unknown:'通知发送结果不明，不自动重发',prepared:'准备发送，尚未送达',sending:'正在发送',rejected:'出站审核未通过',expired:'来源过期',cancelled:'已取消',duplicate:'相同结果已处理'})[state]??state,itemId:item.id,intentId:item.intent_id,wake:intent?.wake_json?JSON.parse(intent.wake_json):null,reason:typeof result?.reason==='string'?result.reason.slice(0,500):null,platformId:state==='sent'?attempt.platform_id:null};
  }
 }
 const relationLabel=({pending_approval:'申请等待对方审核',not_observed:'尚未观察到申请状态，不代表被拒绝',peer_agreed_not_membership_confirmed:'对方同意，好友名单尚待确认',membership_not_observed:'尚未在关系名单确认',tracking_expired:'跟踪窗口结束，结果未确认',unavailable:'关系读取暂不可用'})[op.relationship?.status];
 return {id:op.id,action:op.action,status:op.status,label:relationLabel??(op.status==='accepted'&&op.receipt?.submitted&&!op.receipt.apiAccepted?'已尝试提交，等待状态核验':states[op.status]??op.status),dispatched:op.dispatched===true,apiAccepted:op.receipt?.apiAccepted===true,platformId:op.receipt?.platformId??null,requested:op.args??{},automaticVerification:op.verification??null,receiptDiagnostics:op.receiptDiagnostics??op.receipt?.diagnostics??null,manualConfirmation:null,relationship:op.relationship??null,error:op.error??null,feedback,boundary:'提交、自动核验、通知送达分别记录；manualConfirmation=null表示此运行记录没有人工确认原件，不否认其他地方的人工验收。未确认不等于操作失败，也不自动重发。'};
}
