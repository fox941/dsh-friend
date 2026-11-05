import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {instanceRoot} from './paths.mjs';
const db=new DatabaseSync(path.join(instanceRoot,'companion/companion.sqlite'),{readOnly:true});
try{
 const control=db.prepare('SELECT schema_version,paused FROM proactive_control WHERE id=1').get();if(control.schema_version!==1)throw new Error('Unsupported proactive schema');
 const query=process.argv[2]??'';if(query.length>80)throw new Error('Query too long');const pattern='%'+query.replace(/[\\%_]/g,ch=>'\\'+ch)+'%';
 const counts=db.prepare('SELECT status,count(*) n FROM proactive_items GROUP BY status').all(),published=db.prepare("SELECT body,platform_id,updated_at FROM proactive_attempts WHERE status='sent' AND body LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT 10").all(pattern);
 console.log(JSON.stringify({paused:Boolean(control.paused),counts,published,notice:'只读；仅sent表示OneBot返回了消息ID，不表示对方已读。unknown不自动重发。'},null,2));
}finally{db.close();}
