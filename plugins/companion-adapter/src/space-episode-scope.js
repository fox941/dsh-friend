/** Platform-local root comment identifiers are scoped to one post and viewer. */
export function spaceEpisodeBranch(event){
 if(event?.kind!=='qzone_comment')return null;
 const c=event.raw?.comment,root=c?.isReply?c.parentCommentId:c?.sequenceId;
 return typeof root==='string'&&/^[-\w]{1,128}$/.test(root)&&(!c.isReply||root!==c.sequenceId)?root:null;
}
export function sameEpisodeScope(current,previous){
 if(!current||!previous||current.kind!==previous.kind||current.account!==previous.account||current.sender!==previous.sender||current.thread_key!==previous.thread_key)return false;
 return current.kind!=='qzone_comment'||Boolean(spaceEpisodeBranch(current)&&spaceEpisodeBranch(current)===spaceEpisodeBranch(previous)&&current.raw.postVisibility===previous.raw.postVisibility);
}
