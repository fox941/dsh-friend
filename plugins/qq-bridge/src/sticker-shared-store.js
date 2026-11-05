import fs from 'node:fs/promises';
import {existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ensurePackAt,openIndexWriter} from '../vendor/dsh-meme/memes.js';
import {hash} from './validation.js';
import {imageType} from './qq-media.js';

const ext={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'};
const hex=/^[a-f0-9]{64}$/;
const originKey=o=>hash(JSON.stringify([o.scope,o.source]));
const scopeKey=s=>hash(JSON.stringify(s));

/** Same-AI shared images. Provenance stays internal; the pack index contains
 * only image-derived descriptions/tags, never private conversation reasons. */
export class SharedStickerStore{
 constructor(library){this.l=library;this.initialized=false;this.initializing=null;this.tail=Promise.resolve();this.report=null;}
 root(scope){return path.join(this.l.root,'shared-'+scope.account);}
 assertPath(target){
  const relative=path.relative(this.l.instance,path.resolve(target));if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('表情目录超出实例');
  let current=this.l.instance;for(const part of relative.split(path.sep)){current=path.join(current,part);try{if(lstatSync(current).isSymbolicLink())throw Error('表情目录不能经过目录联接或符号链接');}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 ensure(scope){
  const root=this.root(scope);this.assertPath(root);this.assertPath(path.join(root,'index.db'));this.assertPath(path.join(root,'manifest.json'));ensurePackAt(root,{id:'qq-shared-'+scope.account,name:'AI共用表情库',description:'同一AI账号所有已接入QQ会话共用；来源记录内部保留'});
  this.assertPath(path.join(root,'index.db'));const db=openIndexWriter(root);
  try{const version=db.prepare('PRAGMA user_version').get().user_version;if(![0,2].includes(version))throw Error('不支持的共用表情库版本');
   db.exec('CREATE TABLE IF NOT EXISTS sticker_meta(path TEXT PRIMARY KEY,value_json TEXT NOT NULL,value_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sticker_imports(legacy_key TEXT PRIMARY KEY,expected_hash TEXT NOT NULL,sticker_id TEXT,status TEXT NOT NULL,notice TEXT,created_at TEXT NOT NULL)');
   if(version!==2)db.exec('PRAGMA user_version=2');
  }finally{db.close();}return root;
 }
 rows(scope){
  this.l.checkScope(scope);const root=this.root(scope),file=path.join(root,'index.db');this.assertPath(file);if(!existsSync(file))return [];
  const db=new DatabaseSync(file,{readOnly:true});try{
   if(db.prepare('PRAGMA user_version').get().user_version!==2)throw Error('共用表情库版本不符');
   return db.prepare('SELECT path,value_json,value_hash FROM sticker_meta ORDER BY rowid DESC').all().map(r=>{
    if(hash(r.value_json)!==r.value_hash)throw Error('共用表情记录校验失败');const v=JSON.parse(r.value_json);
    if(v.schema!==2||v.account!==scope.account||v.path!==r.path||!hex.test(v.id)||v.sha256!==v.id||!Array.isArray(v.origins)||!v.origins.length)throw Error('共用表情记录账号或来源格式异常');
    return v;
   });
  }finally{db.close();}
 }
 valid(row){return row.origins.some(o=>{try{const p=this.l.source(o.source.inputId,o.source.observationId,o.source.assetId,o.scope);return p.image.sha256===row.sha256;}catch{return false;}});}
 publicMetadata(origin){
  try{const p=this.l.source(origin.source.inputId,origin.source.observationId,origin.source.assetId,origin.scope);
   const item=p.read.stickerAnalysis?.find(i=>i.assetId===origin.source.assetId);
   const caption=(item?.description??(p.read.images?.length===1?p.read.visualInterpretation?.text:null)??'已收藏的图片表情').slice(0,240);
   // User-supplied/model collection tags may refer to a private conversation.
   // Only words actually present in the image analysis are shared for lookup.
   return {caption,tags:(origin.tags??[]).filter(t=>typeof t==='string'&&caption.includes(t)).slice(0,8)};
  }catch{return {caption:'已收藏的图片表情（来源暂不可核验）',tags:[]};}
 }
 origin(scope,candidate,metadata,createdAt){return {scope,source:{inputId:candidate.inputId,observationId:candidate.observationId,assetId:candidate.assetId},caption:metadata.caption,tags:metadata.tags??[],reason:metadata.reason,createdAt};}
 async persist(scope,bytes,origin,{legacyKey,expectedHash,signal}={}){
  signal?.throwIfAborted();const digest=hash(bytes),mediaType=imageType(bytes),suffix=ext[mediaType];if(!suffix||bytes.length>8*1024*1024)throw Error('表情原件格式或大小异常');
  const root=this.ensure(scope),rows=this.rows(scope),old=rows.find(r=>r.id===digest),key=originKey(origin);
  const duplicate=old?.origins.some(o=>originKey(o)===key);
  const sameConversation=old?.origins.some(o=>scopeKey(o.scope)===scopeKey(origin.scope)&&this.valid({...old,origins:[o]}));
  if(!legacyKey&&old&&(duplicate||sameConversation))return {status:'already_collected',row:old,sourceAdded:false};
  if(!legacyKey&&!old&&(rows.length>=this.l.maxItems||rows.reduce((n,r)=>n+r.bytes,0)+bytes.length>this.l.maxBytes))throw Error('AI共用表情库已达容量上限，旧收藏全部保留，不自动淘汰');
  const relative='memes/'+digest+suffix,file=path.join(root,relative);this.assertPath(file);await fs.mkdir(path.dirname(file),{recursive:true});
  try{await fs.writeFile(file,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(hash(await fs.readFile(file))!==digest)throw Error('共用表情同名文件内容不同');}
  signal?.throwIfAborted();const origins=old?.origins??[];
  const publicInfo=old&&!old.caption.startsWith('已收藏的图片表情')?{caption:old.caption,tags:old.tags}:this.publicMetadata(origin);
  const value=old?{...old,origins:duplicate?origins:[...origins,origin]}:{schema:2,account:scope.account,id:digest,path:relative,sha256:digest,
   md5:createHash('md5').update(bytes).digest('hex'),mediaType,bytes:bytes.length,...publicInfo,createdAt:origin.createdAt,origins:[origin]};
  const raw=JSON.stringify(value),db=openIndexWriter(root);
  try{db.exec('BEGIN IMMEDIATE');
   db.prepare('INSERT INTO memes VALUES(?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET caption=excluded.caption,keywords=excluded.keywords').run(relative,value.tags[0]??'daily',path.basename(relative),value.caption,value.tags.join(' '),Date.now(),Date.now());
   db.prepare('INSERT INTO sticker_meta VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET value_json=excluded.value_json,value_hash=excluded.value_hash').run(relative,raw,hash(raw));
   if(legacyKey)db.prepare('INSERT INTO sticker_imports VALUES(?,?,?,\'imported\',NULL,?) ON CONFLICT(legacy_key) DO UPDATE SET expected_hash=excluded.expected_hash,sticker_id=excluded.sticker_id,status=excluded.status,notice=NULL').run(legacyKey,expectedHash,digest,this.l.store.time());
   db.exec('COMMIT');
  }catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
  return {status:old?'already_collected':'collected',row:value,sourceAdded:!duplicate};
 }
 serial(fn){const run=this.tail.then(fn);this.tail=run.catch(()=>{});return run;}
 async initialize(scope,signal){
  this.l.checkScope(scope);if(this.initialized)return this.report;
  if(!this.initializing)this.initializing=this.serial(()=>this.migrate(scope)).then(r=>{this.report=r;this.initialized=true;return r;}).finally(()=>{this.initializing=null;});
  const result=await this.initializing;signal?.throwIfAborted();return result;
 }
 async migrate(scope){
  const root=this.ensure(scope),report={version:2,account:scope.account,imported:0,reused:0,issues:[],legacyDirectoriesUntouched:true,platformWrites:0,at:this.l.store.time()};
  const entries=await fs.readdir(this.l.root,{withFileTypes:true});
  for(const entry of entries){if(!hex.test(entry.name))continue;
   const legacyRoot=path.join(this.l.root,entry.name);this.assertPath(legacyRoot);if(!entry.isDirectory())continue;
   const file=path.join(legacyRoot,'index.db');if(!existsSync(file))continue;this.assertPath(file);let records;
   const d=new DatabaseSync(file,{readOnly:true});try{if(d.prepare("SELECT 1 FROM sqlite_master WHERE name='sticker_meta'").get())records=d.prepare('SELECT path,value_json,value_hash FROM sticker_meta ORDER BY rowid').all();}finally{d.close();}
   for(const record of records??[]){const key=entry.name+':'+record.path;let marker;
    const db=new DatabaseSync(path.join(root,'index.db'),{readOnly:true});try{marker=db.prepare('SELECT expected_hash,status FROM sticker_imports WHERE legacy_key=?').get(key);}finally{db.close();}
    if(marker?.status==='imported'&&marker.expected_hash===record.value_hash){report.reused++;continue;}
    try{if(hash(record.value_json)!==record.value_hash)throw Error('legacy_metadata_hash');const old=JSON.parse(record.value_json);
     if(old.scope?.account!==scope.account)continue;
     if(hash(JSON.stringify(old.scope))!==entry.name||!hex.test(old.id)||old.id!==old.sha256||record.path!==old.path||old.path!=='memes/'+old.id+ext[old.mediaType])throw Error('legacy_scope_or_path');
     const sourceFile=path.join(legacyRoot,old.path);this.assertPath(sourceFile);const bytes=await fs.readFile(sourceFile);
     if(hash(bytes)!==old.id||bytes.length!==old.bytes||imageType(bytes)!==old.mediaType)throw Error('legacy_image_hash');
     const origin={scope:old.scope,source:old.source,caption:old.caption,tags:old.tags,reason:old.reason,createdAt:old.createdAt,legacyKey:key};
     await this.persist(scope,bytes,origin,{legacyKey:key,expectedHash:record.value_hash});report.imported++;
    }catch{report.issues.push({legacyDirectory:entry.name,path:record.path,notice:'原收藏未通过完整性核对，旧记录和原件保留；本项未进入共用库'});}
   }
  }
  report.uniqueImages=this.rows(scope).length;report.status=report.issues.length?'partial':'completed';
  const destination=path.join(root,'migration-report.json'),temp=destination+'.tmp';this.assertPath(destination);this.assertPath(temp);
  await fs.writeFile(temp,JSON.stringify(report,null,2)+'\n');await fs.rename(temp,destination);return report;
 }
 async collect(scope,candidate,metadata,asset,signal){
  await this.initialize(scope,signal);
  return this.serial(async()=>{signal?.throwIfAborted();const proof=this.l.source(candidate.inputId,candidate.observationId,candidate.assetId,scope);if(hash(asset.bytes)!==proof.image.sha256)throw Error('收藏前原件已变化');
   return this.persist(scope,asset.bytes,this.origin(scope,candidate,metadata,this.l.store.time()),{signal});
  });
 }
 async asset(scope,id){await this.initialize(scope);return this.readAsset(scope,id);}
 async readAsset(scope,id){
  this.l.checkScope(scope);if(!hex.test(id))throw Error('表情标识无效');const row=this.rows(scope).find(r=>r.id===id);
  if(!row||!this.valid(row))throw Error('AI共用图库没有当前可用的这张表情');
  const root=await fs.realpath(this.root(scope)),file=await fs.realpath(path.join(root,row.path));this.assertPath(path.join(this.root(scope),row.path));
  if(!file.startsWith(root+path.sep)||path.basename(file)!==row.sha256+ext[row.mediaType])throw Error('表情路径范围变化');
  const bytes=await fs.readFile(file);if(bytes.length!==row.bytes||hash(bytes)!==row.sha256||imageType(bytes)!==row.mediaType)throw Error('表情图片内容变化');return {row,bytes,file};
 }
}
