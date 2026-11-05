import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {readDecisionState} from './status.js';
export function readAttentionStatus(instance,{now=Date.now()}={}){
 const db=new DatabaseSync(path.join(instance,'companion/companion.sqlite'),{readOnly:true});try{const meta=db.prepare('SELECT schema_version FROM attention_meta WHERE id=1').get();if(meta?.schema_version!==1)throw new Error('Unsupported attention schema');return {snapshot:true,...readDecisionState(db,now)};}finally{db.close();}
}
