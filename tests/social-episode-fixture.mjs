import {setup as base} from './social-media-experience-fixture.mjs';
export async function setup(t){const f=await base(t),episode={calls:[],selection:null,audit:true,acceptCorrections:null,beforeAudit:null},host=f.controller.host;
 host.link=async frame=>{episode.calls.push(frame);return {decision:episode.selection??{relatedEventIds:[],corrections:[],reason:'本次不关联'}};};host.linkAudit=async frame=>{await episode.beforeAudit?.(frame);return {decision:{accept:episode.audit,acceptedCorrections:episode.audit?(episode.acceptCorrections??frame.proposal.corrections.map((_,i)=>i)):[],reason:'隔离审核核对同一话题及明确文字纠正'}};};
 function relate(events,corrections=[]){episode.selection={relatedEventIds:events.map(e=>e.id),corrections,reason:'隔离模型判断同一话题'};}
 async function prime(options){const e=await f.send(options);await f.run(e);return e;}
 return {...f,episode,relate,prime};}
