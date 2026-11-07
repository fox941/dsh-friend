const normalize=s=>s.normalize('NFKC').toLocaleLowerCase();
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const stop=new Set(['的','了','我','你','她','他','是','在','有','和','与','请','查','找','一下','工作间','文件']);
export async function searchWorkshopFiles(w,{query,limit=8}={},signal){
 if(typeof query!=='string'||!query.trim()||query.length>300||!Number.isSafeInteger(limit)||limit<1||limit>12)throw Error('工作间检索需要1–300字查询，返回上限1–12');
 w.validate(query);signal?.throwIfAborted();
 const phrase=normalize(query.trim()),terms=[...new Set([...segmenter.segment(phrase)].filter(s=>s.isWordLike&&!stop.has(s.segment)).map(s=>s.segment))].slice(0,16);
 if(!terms.length)terms.push(phrase);
 const index=await w.inventory(),found=[];let charactersRead=0;
 for(const item of index){
  signal?.throwIfAborted();const r=await w.readInternal(item.path);if(r.version==='absent')continue;
  charactersRead+=r.content.length;const content=normalize(r.content),filename=normalize(item.path);let score=content.includes(phrase)?20:0,position=content.indexOf(phrase);const matched=[];
  for(const t of terms){const at=content.indexOf(t);if(filename.includes(t)||at>=0){matched.push(t);score+=filename.includes(t)?10:2;if(at>=0&&(position<0||at<position))position=at;}}
  if(!score)continue;const from=Math.max(0,position-100),to=Math.min(r.content.length,from+400);
  found.push({kind:'workshop_artifact',isLongTermFact:false,path:r.path,title:r.content.match(/^#\s+(.+)$/mu)?.[1]?.slice(0,100)??r.path,version:r.version,bytes:r.bytes,excerpt:r.content.slice(from,to),excerptStart:from,excerptTruncated:from>0||to<r.content.length,matchedTerms:matched,score});
 }
 found.sort((a,b)=>b.score-a.score||a.path.localeCompare(b.path));
 return {status:found.length?'matches':'no_match',results:found.slice(0,limit),coverage:{filesScanned:index.length,charactersRead,totalMatches:found.length,truncated:found.length>limit,scope:'current_workshop_files'},hint:'这是当前工作文件的正文检索，未搜索旧版本。文件可包含日记、梦、虚构和计算结果，不自动证明现实事件；用friend_workshop_read按路径读全文及当前版本。没有改写源文件或长期记忆。'};
}
