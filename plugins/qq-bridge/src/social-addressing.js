const segments=event=>event.raw?.message??[];
const mentions=event=>segments(event).filter(s=>s.type==='at').map(s=>String(s.data?.qq??'')).slice(0,20);
const occurred=event=>Number.isSafeInteger(event.raw?.time)&&event.raw.time>0?event.raw.time*1000:Date.parse(event.created_at);
export function socialAddressing(store,event,{selfName=null}={}){
 const validName=typeof selfName==='string'&&selfName.trim().length>=2&&selfName.length<=80?selfName:null;
 const direct=mentions(event),out={mentionsSelf:direct.includes(String(event.account)),mentionsAll:direct.includes('all'),previousAtOnly:null,observedSelfName:validName,nameTextMatch:Boolean(validName&&event.body.includes(validName)),recentConversation:null,recentGroup:[],boundary:'昵称字面匹配和近期对话是语境线索，不证明语义指向，不强制回复或改变情绪'};
 if(event.kind!=='group')return out;
 const ordinal=store.db.prepare('SELECT rowid AS n FROM platform_events WHERE id=?').get(event.id)?.n;if(!ordinal)return out;
 const now=occurred(event);if(!Number.isFinite(now))return out;
 const groupRows=store.db.prepare('SELECT rowid AS n,id FROM platform_events WHERE account=? AND thread_key=? AND id<>? ORDER BY rowid DESC LIMIT 32').all(event.account,event.thread_key,event.id);
 const recent=groupRows.map(r=>({ordinal:r.n,event:store.event(r.id)})).filter(r=>r.event&&!['withdrawn','cancelled','failed','expired'].includes(r.event.status)&&Number.isFinite(occurred(r.event))&&now-occurred(r.event)>=0&&now-occurred(r.event)<=300000&&(occurred(r.event)<now||r.ordinal<ordinal)).sort((a,b)=>occurred(b.event)-occurred(a.event)||b.ordinal-a.ordinal);
 const sent=e=>e.status==='sent'&&e.receipt?.apiAccepted===true&&e.receipt.platformId&&typeof e.reply==='string';
 const conversation=recent.find(r=>r.event.sender===event.sender&&sent(r.event))?.event;
 if(conversation)out.recentConversation={eventId:conversation.id,senderQQ:conversation.sender,userText:conversation.body.slice(0,300),actualAIReply:conversation.reply.slice(0,500),replyPlatformId:conversation.receipt.platformId,secondsBefore:Math.floor((now-occurred(conversation))/1000)};
 out.recentGroup=recent.slice(0,3).map(({event:e})=>({eventId:e.id,senderQQ:e.sender,text:e.body.slice(0,300),actualAIReply:sent(e)?e.reply.slice(0,300):null}));
 if(out.mentionsSelf||out.mentionsAll)return out;
 // Native message time permits a missing, authenticated history item to be
 // restored after its actual follow-up without inventing a new incoming text.
 const rows=store.db.prepare('SELECT rowid AS n,id FROM platform_events WHERE account=? AND thread_key=? AND sender=? AND id<>? ORDER BY rowid DESC LIMIT 32').all(event.account,event.thread_key,event.sender,event.id);
 const prior=rows.map(r=>({ordinal:r.n,event:store.event(r.id)})).filter(r=>r.event&&Number.isFinite(occurred(r.event))&&now-occurred(r.event)>=0&&now-occurred(r.event)<=90000&&(occurred(r.event)<now||r.ordinal<ordinal)).sort((a,b)=>occurred(b.event)-occurred(a.event)||b.ordinal-a.ordinal)[0]?.event;
 if(!prior||['withdrawn','cancelled','failed','expired'].includes(prior.status))return out;
 const raw=segments(prior),text=raw.filter(s=>s.type==='text').map(s=>String(s.data?.text??'')).join(''),at=mentions(prior);
 if(text.trim()||!raw.length||raw.some(s=>!['at','text'].includes(s.type))||!at.includes(String(event.account))&&!at.includes('all'))return out;
 out.previousAtOnly={eventId:prior.id,platformMessageId:String(prior.raw.message_id),senderQQ:prior.sender,thread:prior.thread_key,mentionsSelf:at.includes(String(event.account)),mentionsAll:at.includes('all'),secondsBefore:Math.floor((now-occurred(prior))/1000),boundary:'先前真实@消息的上下文线索；当前正文仍没有@，不强制回应或授予权限'};
 return out;
}
