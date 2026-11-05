import {hash} from './validation.js';
import {spaceCommentHash} from '@ai-friend/qq-bridge/space-memory-source';
/** Bounded page context; current comment remains the sole new quoted event. */
export async function spaceEmotionContext(event,cache){
 const post=await cache.get('post:'+event.account+':'+event.raw.postTid);
 if(!post||String(post.uin)!==event.account||post.tid!==event.raw.postTid||post.ugc_right!==event.raw.postVisibility||typeof post.content!=='string')throw Error('空间语境原件不可核验');
 const base={account:event.account,postAuthorQQ:event.raw.postAuthorQQ,postTid:event.raw.postTid,visibility:event.raw.postVisibility,actualPageRead:true,notCurrentSenderQuote:true},context=[{role:'context',content:post.content.slice(0,1200)||'【原说说未提供文字正文】',source:{...base,kind:'qq_space_post_context',textHash:hash(post.content),truncated:post.content.length>1200}}];
 if(event.raw.comment.isReply&&event.raw.comment.parentCommentId){const matches=post.comments.filter(c=>c.id===event.raw.comment.parentCommentId),parent=matches.length===1&&matches[0].textTruncated!==true?matches[0]:null;
  if(parent&&typeof parent.text==='string')context.push({role:'context',content:parent.text.slice(0,700),source:{...base,kind:'qq_space_parent_context',authorQQ:parent.authorQQ,sequenceId:parent.id,sourceHash:spaceCommentHash(parent),truncated:parent.text.length>700}});
  else context.push({role:'context',content:'【被回复的上级评论不在当前可核验的预览中，不猜测正文】',source:{...base,kind:'qq_space_parent_unavailable'}});
 }
 return context;
}
