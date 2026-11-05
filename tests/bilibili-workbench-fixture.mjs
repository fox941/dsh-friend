import {randomUUID} from 'node:crypto';
import {fixture as videoFixture,bload} from './video-continuous-fixture.mjs';
export {bload};
const {BilibiliInboxStore}=await bload('bilibili-inbox-store.js'),{BilibiliSocialStore}=await bload('bilibili-social-store.js'),{BilibiliAccountStore}=await bload('bilibili-account-store.js'),{BilibiliWorkbenchView}=await bload('workbench-view.js'),{hash}=await bload('util.js');
export async function fixture(t,{run=true}={}){
 const f=await videoFixture(t),db=f.journal.db,inbox=new BilibiliInboxStore(f.journal),social=new BilibiliSocialStore(inbox),account=new BilibiliAccountStore(f.journal);
 db.exec("CREATE TABLE IF NOT EXISTS platform_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS platform_operations(id TEXT PRIMARY KEY,action TEXT NOT NULL,status TEXT NOT NULL,args_json TEXT NOT NULL,receipt_json TEXT,dispatched INTEGER,reason TEXT,created_at TEXT,updated_at TEXT);");
 inbox.bind('12345');if(run)await f.run();
 const controller={journal:f.journal,instance:f.activity.instance,activities:f.activity,bilibiliInbox:{store:inbox,config:{enabled:true},polling:false},bilibiliSocial:{store:social,config:{outgoing:true}},accountActions:{store:account},writeEnabled:()=>true};
 const view=new BilibiliWorkbenchView(controller);
 const event=(text,status='queued')=>{const id=randomUUID(),raw=JSON.stringify({text,account:'12345'}),at='2026-11-05T03:00:00.000Z';db.prepare('INSERT INTO bili_inbox_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,randomUUID(),'private','6789',Date.parse(at)/1000,raw,hash(raw),status,at,at);return id;};
 const dump=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:db.prepare('SELECT * FROM "'+name+'" ORDER BY rowid').all()})));
 return {...f,get activity(){return f.activity;},reopen:async()=>{await f.reopen();controller.activities=f.activity;},db,view,controller,event,dump,account,social,inbox};
}
