import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {instanceRoot} from './paths.mjs';
const id=process.argv[2],db=new DatabaseSync(path.join(instanceRoot,'companion/companion.sqlite'),{readOnly:true});
try{
  const meta=db.prepare('SELECT schema_version,revision FROM goal_meta WHERE id=1').get();if(meta.schema_version!==1)throw new Error('Unsupported goal schema');
  const decode=row=>row?JSON.parse(row.value_json):null;
  if(id){const goal=decode(db.prepare('SELECT value_json FROM companion_goals WHERE id=?').get(id));if(!goal)throw new Error('Goal not found');console.log(JSON.stringify({goal,steps:db.prepare('SELECT value_json FROM goal_steps WHERE goal_id=? ORDER BY rowid').all(id).map(decode),history:db.prepare('SELECT action,reason,created_at FROM goal_changes WHERE goal_id=? ORDER BY rowid DESC LIMIT 20').all(id)},null,2));}
  else console.log(JSON.stringify({revision:meta.revision,goals:db.prepare('SELECT value_json FROM companion_goals ORDER BY updated_at DESC,rowid DESC LIMIT 30').all().map(decode),notice:'候选愿望与计划不等于承诺或已发生经历；此命令只读，不调用模型。'},null,2));
}finally{db.close();}
