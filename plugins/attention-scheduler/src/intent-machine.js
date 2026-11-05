import {createMachine,transition} from 'xstate';

const active=['pending','selected','admitting','waking','running','waiting','paused'];
const terminal=['completed','failed','dismissed','cancelled'];
const all=[...active,...terminal];
const edges={
 pending:['selected','waiting','running','completed','failed','dismissed','cancelled'],
 selected:['pending','admitting','waking','running','waiting','paused',...terminal],
 admitting:['pending','running','waiting',...terminal],
 waking:['pending','admitting','running','waiting',...terminal],
 running:['pending','waiting','paused',...terminal],
 waiting:['pending','running',...terminal],
 paused:['pending','selected','running','waiting',...terminal]
};
const states=Object.fromEntries(all.map(status=>[status,{on:Object.fromEntries(all.map(target=>['move:'+target,{target,
 guard:({event})=>status===target||edges[status]?.includes(target)||event.reconcile===true&&['completed','failed'].includes(status)&&target==='pending'
}]))}]));
const machine=createMachine({id:'attention-intent',initial:'pending',states});

/** Pure transition against the committed row. Nothing in an actor cache survives a DB rollback. */
export function nextIntentStatus(previous,target,{reconcile=false}={}){
 if(!all.includes(previous)||!all.includes(target))throw new Error('调度事项状态无效');
 const [next]=transition(machine,machine.resolveState({value:previous,context:{}}),{type:'move:'+target,reconcile});
 if(next.value!==target)throw new Error('调度事项不允许此状态转换；已结束事项重新执行需要明确核对原任务');
 return next.value;
}
