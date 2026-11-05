import {randomUUID} from 'node:crypto';
import {text, uuid, STORE, noSecret, aborted, hash} from './util.js';
import {videoQuoteEvidence} from './video-notes.js';

export function videoRecallRequest(args) {
  const query = text(args.query, '视频回忆问题', 300), alternate = args.alternateQuery === undefined ? undefined : text(args.alternateQuery, '备选检索表达', 160);
  const keywords = args.keywords ?? [], limit = args.limit ?? 3;
  if (!Array.isArray(keywords) || keywords.length > 8 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4) throw Error('视频回忆范围无效');
  const clean = {query, alternateQuery: alternate, keywords: keywords.map(k => text(k, '视频检索词', 40)), limit};
  noSecret(JSON.stringify(clean)); return clean;
}

/** Dispatch the existing model tool through the public DSH policy pipeline. */
export async function recallWithMnemon(ctx, exec, query) {
  if (typeof ctx.tools.execute !== 'function' || !ctx.tools.get?.('mnemon_recall', exec.agent)) return {results: [], unavailable: '当前会话未提供Mnemon召回，未绕过当前View直接读取全库'};
  aborted(exec.signal);
  const result = await ctx.tools.execute({callId: randomUUID(), rootCallId: exec.rootCallId ?? exec.callId,
    parent: exec.token, name: 'mnemon_recall', arguments: {query, mode: 'smart', limit: 6}, agent: exec.agent, signal: exec.signal});
  for (const context of result.additionalContexts ?? []) exec.deferContext?.(context);
  if (!result.isError && result.concludesTurn) exec.concludeTurn?.();
  aborted(exec.signal);
  if (result.isError) return {results: [], unavailable: 'Mnemon召回未完成；不能据此判断没有相关视频'};
  return result.value;
}

export class VideoRecall {
  constructor(adapter) { this.adapter = adapter; this.activities = adapter.activities; this.db = adapter.journal.db; }

  async links(memory, signal) {
    // The model never submits memory ids or text to this bridge; these are the
    // records admitted by the pinned Mnemon View in the nested tool result.
    const id = uuid(memory.id), storeId = memory.memoryBodyId;
    if (typeof storeId !== 'string' || !STORE.test(storeId)) return [];
    const rows = this.db.prepare(`SELECT s.operation_json,s.receipt_json,r.id,r.report_id,r.frame_json
      FROM apply_steps s JOIN apply_runs r ON r.id=s.run_id
      WHERE s.status='applied' AND json_extract(s.receipt_json,'$.nativeId')=?
        AND json_extract(s.receipt_json,'$.storeId')=?`).all(id, storeId);
    if (!rows.length) return [];
    const current = await this.adapter.client.showReadOnly(storeId, id, signal);
    if (!current || current.id !== id || current.deleted_at != null) return [];
    const linked = [];
    for (const row of rows) {
      const operation = JSON.parse(row.operation_json), receipt = JSON.parse(row.receipt_json), frame = JSON.parse(row.frame_json);
      if (operation.kind !== 'native_add' || operation.target !== 'event' || operation.storeId !== storeId || receipt.verified !== true || receipt.nativeId !== id || current.content !== operation.content) continue;
      if (frame?.protocol !== 'ai-friend/activity-memory/1' || frame.authorization?.kind !== 'activity' || frame.authorization.policy !== 'activity-observation-v1') continue;
      if (this.adapter.applications.protection?.withdrawnReport(row.report_id)) continue;
      const source = frame.sources?.find(s => s.kind === 'external_observation' && s.channel === 'bilibili' && s.observationId === frame.authorization.observationId);
      if (!source || !this.activities.store.verify(source)) continue;
      const observation = this.activities.store.observation(source.observationId);
      if (!this.db.prepare("SELECT 1 FROM activity_runs WHERE observation_id=? AND coalesce(json_extract(request_json,'$.learn'),1)!=0").get(observation.id)) continue;
      const quote = operation.evidence?.find(e => e.sourceId === source.id)?.quote;
      if (!quote) continue;
      const original = videoQuoteEvidence(observation, quote), p = observation.payload;
      linked.push({bvid:p.bvid, page:p.page, cid:p.video?.cid == null ? null : String(p.video.cid), title:p.title,
        observationId:observation.id, observedAt:observation.created_at, nativeReference:{storeId, id}, nativeContentHash:hash(current.content), evidenceId:original.id});
    }
    return linked;
  }

  async find(args, recall, signal) {
    const request = videoRecallRequest(args), queries = [request.query];
    if (request.alternateQuery && request.alternateQuery.toLowerCase() !== request.query.toLowerCase()) queries.push(request.alternateQuery);
    const candidates = new Map(), calls = [], unavailable = [], checked = new Map(); let invalidLinks = 0;
    for (const query of queries) {
      aborted(signal); const result = await recall(query);
      aborted(signal);
      if (!result || !Array.isArray(result.results)) throw Error('Mnemon视频候选响应格式无效');
      calls.push({query, admitted:result.results.length, notRun:result.notRun === true, budgetExhausted:result.budgetExhausted === true,
        replayed:result.replayed === true, truncated:result.memoryEvidence?.truncated === true, unavailable:Boolean(result.unavailable)});
      if (result.unavailable) unavailable.push('记忆召回暂不可用，结果不完整');
      if (result.notRun) break;
      const listSeen = new Set();
      for (const [rank, memory] of result.results.slice(0, 12).entries()) {
        aborted(signal); const reference = String(memory?.memoryBodyId) + ':' + String(memory?.id);
        let links;
        try {
          if (!checked.has(reference)) checked.set(reference, await this.links(memory, signal));
          links = checked.get(reference);
        } catch (error) { aborted(signal); invalidLinks++; continue; }
        for (const link of links) {
          const key = link.bvid + ':' + link.page + ':' + (link.cid ?? 'text');
          let candidate = candidates.get(key);
          if (!candidate) { candidate={...link, rankScore:0, anchors:[]}; candidates.set(key,candidate); }
          if (!listSeen.has(key)) { candidate.rankScore += 1 / (60 + rank + 1); listSeen.add(key); }
          if (!candidate.anchors.some(a=>a.observationId===link.observationId)) candidate.anchors.push(link);
        }
      }
      // A refinement is optional and only used when the initial route found no
      // traceable video. The shared View can still deny it if its budget closed.
      if (candidates.size || result.unavailable || result.budgetExhausted) break;
    }
    const ranked = [...candidates.values()].sort((a,b)=>b.rankScore-a.rankScore || b.observedAt.localeCompare(a.observedAt));
    const results=[];
    for (const candidate of ranked.slice(0,request.limit)) {
      aborted(signal);
      try {
        const video=`https://www.bilibili.com/video/${candidate.bvid}/?p=${candidate.page}`;
        const detail=this.activities.videoNotes.read(video,{cid:candidate.cid,query:request.query,keywords:request.keywords,evidenceId:candidate.evidenceId,limit:2});
        if (!detail.evidence.some(e=>e.id===candidate.evidenceId)) throw Error('视频候选原件未读回');
        const current=await this.adapter.client.showReadOnly(candidate.nativeReference.storeId,candidate.nativeReference.id,signal);
        if (!current || current.deleted_at!=null || hash(current.content)!==candidate.nativeContentHash) throw Error('视频经历在回查期间已变化');
        results.push({...candidate, anchors:candidate.anchors.slice(0,3), sourceUrl:video,
          notes:detail.notes, evidence:detail.evidence, revision:detail.revision, fragmentRetrieval:detail.retrieval,
          scope:detail.scope});
      } catch(error) { aborted(signal); invalidLinks++; }
    }
    const output={status:results.length?'candidates':unavailable.length?'unavailable':calls.some(c=>c.notRun||c.budgetExhausted)?'budget_limited':'not_found',
      query:request.query, candidates:results, ambiguous:ranked.length>1,
      retrieval:{method:'现有Mnemon smart召回及本轮共享额度；以已应用的Native写入回执、当前正文及观察原件建立候选；再按同版视频回查片段',
        calls, linkedVideos:ranked.length, invalidLinks, limited:ranked.length>results.length, unavailable},
      scope:'这里只返回有实际经历写入回执的候选；排序不是事实置信度或唯一匹配证明。无结果可能因召回、预算、旧来源缺失或已被更正。原文和推断分开；不重新看视频，不写长期记忆或人格。'};
    while (JSON.stringify(output).length>12000 && output.candidates.length) {
      const largest=output.candidates.reduce((a,b)=>JSON.stringify(a).length>=JSON.stringify(b).length?a:b);
      if (largest.notes.length) largest.notes.pop();
      else if (largest.evidence.length>1) largest.evidence.splice(largest.evidence.findLastIndex(e=>e.id!==largest.evidenceId),1);
      else output.candidates.pop();
      output.retrieval.limited=true; output.truncated=true;
    }
    output.ambiguous=ranked.length>1;
    if (!output.candidates.length && output.status==='candidates') output.status='incomplete';
    noSecret(JSON.stringify(output)); return output;
  }
}
