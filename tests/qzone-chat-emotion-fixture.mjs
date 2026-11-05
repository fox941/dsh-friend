import {fixture as base,bot,owner,alice} from './qq-chat-emotion-fixture.mjs';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const req=createRequire(process.env.FRIEND_ADAPTER_SOURCE+'/index.js'),{spaceCommentHash,spaceCommentFingerprint}=await import(pathToFileURL(req.resolve('@ai-friend/qq-bridge/space-memory-source')));
export {bot,owner,alice};
export async function fixture(t){const f=await base(t),posts=new Map(),state={pageReads:0,offline:false,caption:'今天看见一片慢慢散开的云。'};
 Object.assign(f.platforms.clients,{session:async()=>({account:bot}),zoneGet:async(_s,_u,tid)=>{state.pageReads++;if(state.offline)throw Error('isolated page unavailable');return posts.get(tid);}});
 const m=f.platforms.socialMemory;m.validateSource=(...args)=>f.platforms.spaceMemorySource.validate(...args);f.platforms.qzoneInbox.memory=m;f.platforms.qzoneInbox.memorySource=f.platforms.spaceMemorySource;
 let seq=100;
 function space(body,{tid='post-a',visibility=1,sender=owner,isReply=false,parentCommentId=null,replyToQQ=null,caption=state.caption}={}){
  f.state.clock+=1000;const c={id:String(++seq),authorQQ:sender,nickname:'合成评论者',text:body,textTruncated:false,isReply,parentCommentId,replyToQQ},p=posts.get(tid)??{uin:bot,tid,ugc_right:visibility,content:caption,comments:[],readback:{contentAvailable:true,commentsAvailable:true,commentsAmbiguous:false}};p.ugc_right=visibility;p.comments.push(c);posts.set(tid,p);
  const raw={schema:'qzone-comment-event/1',observedAt:new Date(f.state.clock).toISOString(),postAuthorQQ:bot,postTid:tid,postVisibility:visibility,postExcerpt:p.content,comment:{sequenceId:c.id,authorQQ:sender,nickname:c.nickname,text:body,isReply,parentCommentId,replyToQQ,sourceHash:spaceCommentHash(c)}};
  f.platforms.spaceMemorySource.observePosts([p],bot);
  return f.platforms.store.accept({key:`qzone-comment:${bot}:${tid}:${spaceCommentFingerprint(c)}`,thread:`qzone:${bot}:${bot}:${tid}`,account:bot,sender,kind:'qzone_comment',body,raw});
 }
 function preference(e,content='发言人希望被称呼为“小檐”。'){f.platforms.store.eventState(e.id,'ignored');const job=m.store.enqueue(f.platforms.store.event(e.id),[{action:'add',kind:'preference',content,evidenceQuote:e.body}]);m.store.commit(job,e,[0]);return m.store.notes(e).find(n=>n.event_id===e.id);}
 return {...f,posts,spaceState:state,space,preference,m,async execute(e){return f.run(e.id);},operations:()=>f.platforms.store.db.prepare("SELECT id,status,value_json,dispatched FROM platform_operations WHERE action='qq_space_reply'").all()};}
