import {createHash} from 'node:crypto';
const paths=['code','ret','data','data.code','data.ret','commentid','comment_id','commentId','data.commentid','data.comment_id','data.commentId','tid','data.tid','id','data.id','t1_tid','data.t1_tid','t2_tid','data.t2_tid','comment','data.comment','commentlist','data.commentlist'];
const scalarPaths=new Set(['code','ret','data.code','data.ret']);
const safeId=v=>{const s=typeof v==='number'&&Number.isSafeInteger(v)?String(v):v;return typeof s==='string'&&/^[-\w]{1,128}$/.test(s)&&!/^sk[-_]/i.test(s)?s:null;};
const at=(v,p)=>p.split('.').reduce((o,k)=>o!==null&&typeof o==='object'&&Object.hasOwn(o,k)?o[k]:undefined,v);
export function commentHTTPDiagnostics(response){return {httpStatus:Number.isInteger(response?.status)?response.status:null,contentClass:(()=>{const t=String(response?.headers?.get?.('content-type')??'').toLowerCase();return t.includes('json')?'json':t.includes('javascript')?'javascript':t.includes('html')?'html':'other';})()};}
export function commentReceiptDiagnostics(value,parentTid,http={}){
 const record=value!==null&&typeof value==='object'&&!Array.isArray(value),fields=[];
 for(const path of paths){const v=at(value,path);if(v===undefined)continue;const type=v===null?'null':Array.isArray(v)?'array':typeof v,row={path,type};if(type==='array')row.length=Math.min(v.length,1000000);if(scalarPaths.has(path)&&['number','string'].includes(type)&&/^[-+]?\d{1,9}$/.test(String(v)))row.code=Number(v);if(!scalarPaths.has(path)&&path!=='data'){const id=safeId(v);if(id&&/^(?:commentid|comment_id|commentId|tid|id|t1_tid|t2_tid)$/.test(path.split('.').at(-1))){row.idHash=createHash('sha256').update(id).digest('hex');row.idLength=id.length;row.kind=id===parentTid?'parent_post_id':path.endsWith('t1_tid')?'parent_reference':'unmapped_api_identifier';}}fields.push(row);}
 return {schema:'qq-comment-receipt/1',parseState:'parsed',...http,rootType:value===null?'null':Array.isArray(value)?'array':typeof value,unknownTopLevelFields:record?Math.min(Object.keys(value).filter(k=>!paths.some(p=>p.split('.')[0]===k)).length,1000000):0,fields,parsedPayloadHash:createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex'),rawPayloadStored:false};
}
export function saveCommentDiagnostics(client,op,diagnostics){
 const current=client.store?.operation?.(op.id);if(!current)return;
 if(current.account!==op.account||!['qq_space_comment','qq_space_reply'].includes(current.action)||current.dispatched!==true||!['sending','accepted','unknown','unconfirmed'].includes(current.status))throw Error('评论诊断记录归属变化');
 client.store.patch(op.id,current.status,{receiptDiagnostics:diagnostics});
}
