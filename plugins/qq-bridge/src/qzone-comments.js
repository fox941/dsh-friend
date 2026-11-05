import {createHash} from 'node:crypto';
import {commentReceiptDiagnostics,commentHTTPDiagnostics,saveCommentDiagnostics} from './qzone-comment-receipt.js';
const validId=v=>typeof v==='string'&&/^[-\w]{1,128}$/.test(v),validQQ=v=>typeof v==='string'&&/^[1-9]\d{4,11}$/.test(v);
export const commentText=v=>typeof v==='string'?v.normalize('NFC').replace(/\r\n?/g,'\n').replaceAll('\u00a0',' ').trim():'';
// feeds3 HTML omits paragraph breaks; keep every other character significant.
export const sameSpaceReplyText=(expected,actual)=>typeof expected==='string'&&typeof actual==='string'&&commentText(expected)!==''&&commentText(expected).replaceAll('\n','')===commentText(actual).replaceAll('\n','');
export function normalizeComments(rows){return (rows??[]).slice(0,50).filter(c=>validId(c.commentid)&&validQQ(c.uin)&&typeof c.content==='string').map(c=>({id:c.commentid,authorQQ:c.uin,nickname:String(c.name??'').slice(0,100),text:c.content.slice(0,2000),textTruncated:c.content.length>2000,isReply:c.is_reply===true,parentCommentId:validId(c.parent_comment_id)?c.parent_comment_id:null,replyToQQ:validQQ(c.reply_to_uin)?c.reply_to_uin:null,createdTime:Number.isSafeInteger(c.createtime)&&c.createtime>0?c.createtime:null}));}
export function mergeQzonePost(old,next){
 if(!old)return next;const score=v=>Number(v.readback.contentAvailable)+Number(v.readback.imageCountAvailable)+Number(v.readback.visibilityAvailable),base=score(next)>score(old)?next:old;
 const map=new Map();let ambiguous=old.readback.commentsAmbiguous===true||next.readback.commentsAmbiguous===true;
 if(old.readback.contentAvailable&&next.readback.contentAvailable&&old.content!==next.content)ambiguous=true;
 if(old.ugc_right!==null&&next.ugc_right!==null&&old.ugc_right!==next.ugc_right)ambiguous=true;
 for(const c of [...(old.comments??[]),...(next.comments??[])]){const prior=map.get(c.id);if(prior&&(prior.authorQQ!==c.authorQQ||prior.text!==c.text||prior.isReply!==c.isReply))ambiguous=true;else map.set(c.id,c);}
 const comments=[...map.values()].slice(0,50);return {...base,comments,readback:{...base.readback,commentsAvailable:!ambiguous&&(old.readback.commentsAvailable||next.readback.commentsAvailable),commentsAmbiguous:ambiguous,commentsComplete:false,commentsLimit:50}};
}
const postHash=p=>createHash('sha256').update(JSON.stringify({uin:String(p.uin),tid:p.tid,content:p.content,right:p.ugc_right})).digest('hex');
function checkedPost(post,userId,tid){if(String(post?.uin)!==userId||post?.tid!==tid||post.readback?.contentAvailable!==true||post.readback?.commentsAvailable!==true||post.readback?.commentsAmbiguous===true||!Array.isArray(post.comments))throw Error('未取得归属明确的说说与评论预览，未发表评论');}
export async function prepareSpaceComment(client,op,signal){
 const a=op.args??{},userId=String(a.userId??''),tid=a.tid,text=a.text;
 if(!validQQ(userId)||!validId(tid)||typeof text!=='string'||!text.trim()||text.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw Error('空间评论需要准确QQ号、说说tid及1–1000字正文');
 if(a.commentId!==undefined||a.replyUin!==undefined||a.replyToCommentId!==undefined)throw Error('本入口只发表说说根评论，不能冒充回复某条评论');
 const session=await client.session(signal),post=await client.zoneGet(session,userId,tid,{comments:true});checkedPost(post,userId,tid);
 const duplicate=post.comments.find(c=>c.authorQQ===op.account&&!c.isReply&&!c.textTruncated&&commentText(c.text)===commentText(text));
 return {account:op.account,session,target:{userId,tid,text},state:{observation:{viewerQQ:op.account,postAuthorQQ:userId,ownedByViewer:op.account===userId,bodyRead:true,commentPreviewRead:true,commentPreviewComplete:false,writePermission:"not_yet_tested"},postHash:postHash(post),content:post.content.slice(0,3000),visibility:post.ugc_right??null,commentIds:post.comments.map(c=>c.id),commentPreview:post.comments.slice(-12).map(c=>({id:c.id,authorQQ:c.authorQQ,text:c.text.slice(0,400),isReply:c.isReply})),commentsComplete:false,existingCommentId:duplicate?.id??null}};
}
function receiptId(value,tid){const ids=[value.commentid,value.comment_id,value.commentId,value.data?.commentid,value.data?.comment_id,value.data?.commentId,value.data?.tid,value.tid].map(v=>typeof v==='number'&&Number.isSafeInteger(v)?String(v):v).filter(v=>validId(v)&&!/^sk[-_]/i.test(v)&&v!==tid),unique=[...new Set(ids)];return unique.length===1?unique[0]:null;}
export async function writeSpaceComment(client,op,prepared,signal,onDispatch,responseJson){
 if(prepared.state?.existingCommentId)throw Object.assign(Error('已读到本账号相同评论，未重复提交'),{definitive:true});
 const q=client.channel;if(!q.ready||!q.connection?.connected||String((await q.connection.call('get_login_info',{})).user_id)!==op.account||prepared.session.account!==op.account)throw Error('提交前QQ账号变化');signal?.throwIfAborted();
 const t=prepared.target;if(t.userId!==String(op.args.userId)||t.tid!==op.args.tid||t.text!==op.args.text||!q.ready||!q.connection.connected)throw Error('评论目标准备后变化，未提交');const form={hostUin:t.userId,topicId:t.userId+'_'+t.tid,content:op.action==='qq_space_reply'?t.wireText:t.text,...op.action==='qq_space_reply'?{commentId:t.rootSequence,replyUin:t.replyToQQ,commentUin:t.replyToQQ}:{},format:'json',qzreferrer:prepared.session.headers.referer};
 onDispatch();let value,http;try{const response=await client.request('https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk='+prepared.session.gtk,{method:'POST',headers:{...prepared.session.headers,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form).toString(),redirect:'error',signal:AbortSignal.any([signal??new AbortController().signal,AbortSignal.timeout(20000)])});http=commentHTTPDiagnostics(response);value=await responseJson(response);}catch(error){saveCommentDiagnostics(client,op,{...http,schema:'qq-comment-receipt/1',parseState:'unavailable_or_invalid'});throw error;}
 const diagnostics=commentReceiptDiagnostics(value,t.tid,http);saveCommentDiagnostics(client,op,diagnostics);
 const codes=[value?.code,value?.ret].filter(v=>v!==undefined&&v!==null);if(!codes.length||codes.some(v=>!['number','string'].includes(typeof v)||!/^[-+]?\d{1,9}$/.test(String(v)))||new Set(codes.map(Number)).size!==1)throw Error('评论提交未取得一致的可核验业务回执，不自动重发');const code=Number(codes[0]);if(code!==0)throw Object.assign(Error('QQ空间拒绝评论，code='+code),{definitive:true});
 return {apiAccepted:true,platformId:receiptId(value,t.tid),platformIdKind:'api_id_unmapped_to_preview',diagnostics,parentUserId:t.userId,parentTid:t.tid,submittedAt:new Date().toISOString(),scope:'API受理、原件观察和提交归属确认分开；接口ID尚未映射至页面序号，不自动重发'};
}
export async function verifySpaceComment(client,op,signal){
 const ack=op.receipt;if(ack?.apiAccepted!==true||!Array.isArray(op.before?.state?.commentIds)||ack.platformId===op.args.tid||ack.parentUserId&&ack.parentUserId!==String(op.args.userId)||ack.parentTid&&ack.parentTid!==op.args.tid)return null;
 const session=await client.session(signal);if(session.account!==op.account)return null;const post=await client.zoneGet(session,String(op.args.userId),op.args.tid,{comments:true});checkedPost(post,String(op.args.userId),op.args.tid);
 const matches=post.comments.filter(c=>c.authorQQ===op.account&&!c.isReply&&!c.textTruncated&&commentText(c.text)===commentText(op.args.text));
 if(matches.length!==1||!validId(matches[0].id)||op.before?.state?.commentIds?.includes(matches[0].id))return null;
 return {verified:false,observed:true,platformId:null,commentReference:{postAuthorQQ:String(op.args.userId),postTid:op.args.tid,sequenceId:matches[0].id,idKind:'feeds3_post_local_sequence'},parentUserId:String(op.args.userId),parentTid:op.args.tid,authorQQ:op.account,textVerified:true,apiReceiptId:validId(ack.platformId)?ack.platformId:null,receiptCorrelation:'unproven',source:'feeds3_html',visibility:'account_readback',observedAt:new Date().toISOString(),notice:'原件下已读到本账号匹配根评论；页面序号不等于接口评论ID，未证明该评论属于本次提交。有限预览不能证明历史上不存在同文，不代表他人可见或已读。不会重发'};
}
