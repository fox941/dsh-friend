import {GIF_SAMPLING_VERSION} from './gif-preview.js';
import {hash,noSecret} from './validation.js';
import {openIndexWriter} from '../vendor/dsh-meme/memes.js';

/** Derived image-only analysis; does not modify old observations, collection
 * origins/reasons, role memory, QQ favorites or platform operations. */
export class StickerVision{
 constructor(library){this.l=library;this.tail=Promise.resolve();}
 key(scope,row){return 'sticker-vision:'+GIF_SAMPLING_VERSION+':'+scope.account+':'+row.id;}
 cached(scope,row){
  const ref=this.l.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get(this.key(scope,row));if(!ref)return null;
  const v=this.l.store.media(ref.id);if(v?.kind!=='sticker_visual_analysis'||v.account!==scope.account||v.sha256!==row.sha256||v.version!==GIF_SAMPLING_VERSION||typeof v.description!=='string'||!v.description.trim()||v.description.length>240||!['sampled-frames','first-frame-only'].includes(v.coverage?.kind)||v.frames?.length!==v.coverage.frameCount||v.frames.length<1||v.frames.length>3||!v.temporalAnalysis)throw Error('派生表情分析校验失败');return v;
 }
 existing(row){
  for(const origin of row.origins??[])try{const p=this.l.source(origin.source.inputId,origin.source.observationId,origin.source.assetId,origin.scope),image=p.read.images.find(i=>i.assetId===origin.source.assetId),item=p.read.stickerAnalysis?.find(i=>i.assetId===origin.source.assetId);
   if(image.visualSampling?.version===GIF_SAMPLING_VERSION&&image.visualCoverage==='sampled-frames'&&image.frames?.length>=2&&image.frames.length<=3&&typeof item?.description==='string'&&item.description.trim()&&item.description.length<=240&&item.temporalAnalysis)return {description:item.description,coverage:image.visualSampling,frames:image.frames,temporalAnalysis:item.temporalAnalysis};
  }catch{/* Invalid origins do not supply an alternative image description. */}return null;
 }
 view(row){const v=this.cached({account:row.account},row)??this.existing(row);return v?{description:v.description,visualCoverage:v.coverage.kind,visualSampling:v.coverage,temporalAnalysis:v.temporalAnalysis}:{description:row.caption,visualCoverage:row.mediaType==='image/gif'?'first-frame-only':'single-image'};}
 async prepare(scope,query,limit,signal){
  await this.l.initialize(scope,signal);if(typeof this.l.media?.analyzeSticker!=='function')return;
  const task=this.tail.then(async()=>{
   signal?.throwIfAborted();const results=this.l.search(scope,query,limit),selected=results.items.map(i=>this.l.rows(scope).find(r=>r.id===i.stickerId)).filter(r=>r?.mediaType==='image/gif'&&!this.cached(scope,r)&&!this.existing(r));
   // One old GIF at most per lookup; ordinary static files never call vision.
   const row=selected[0];if(!row)return;const now=Date.parse(this.l.store.time()),failed=this.l.store.db.prepare('SELECT created_at FROM platform_media WHERE event_key LIKE ? ORDER BY rowid DESC LIMIT 1').get(this.key(scope,row)+':failed:%');
   if(failed&&now-Date.parse(failed.created_at)<3600000)return;
   try{
    const asset=await this.l.asset(scope,row.id),analysis=await this.l.media.analyzeSticker(asset,signal);signal?.throwIfAborted();
    // Source withdrawal, changed bytes or changed binding during vision cannot
    // turn that response into a usable shared analysis.
    const current=await this.l.asset(scope,row.id);if(hash(current.bytes)!==row.id)throw Error('表情原件变化');
    noSecret(analysis.description);const v=this.l.store.saveMedia(this.key(scope,row),{kind:'sticker_visual_analysis',version:GIF_SAMPLING_VERSION,account:scope.account,sha256:row.id,description:analysis.description,coverage:analysis.coverage,frames:analysis.frames,temporalAnalysis:analysis.temporalAnalysis,analyzedAt:this.l.store.time()});
    const db=openIndexWriter(this.l.scopeRoot(scope));try{db.prepare('UPDATE memes SET caption=?,keywords=? WHERE path=?').run(v.description,(row.tags??[]).filter(t=>v.description.includes(t)).join(' '),row.path);}finally{db.close();}
   }catch{signal?.throwIfAborted();this.l.store.saveMedia(this.key(scope,row)+':failed:'+Math.floor(now/3600000),{kind:'sticker_visual_analysis_failed',account:scope.account,sha256:row.id,notice:'补充分析未完成，继续保留旧描述与原图，不自动重试本回合'});}
  });this.tail=task.catch(()=>{});return task;
 }
}
