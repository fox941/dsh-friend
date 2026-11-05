import {biliId} from './activity-config.js';
import {hash, noSecret, text} from './util.js';

const excerptIndex = raw => [...raw.matchAll(/[\s\S]{1,400}/gu)].map((m, i) => ({id: 'excerpt-' + i, text: m[0], offset: m.index}));
const cidOf = payload => payload.video?.cid == null ? null : String(payload.video.cid);
const keyOf = (target, cid) => target.bvid + ':' + target.page + ':' + (cid ?? 'text');
const noteId = (key, observationId, index) => 'vn-' + hash(key + ':' + observationId + ':' + index).slice(0, 32);
const kinds = new Set(['understanding', 'question']);
const allowed = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => keys.includes(k));

/** This validates references and shape, not the truth of an interpretation. */
export function validateVideoNotes(value, observation) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > 3) throw Error('视频笔记每次最多三条');
  const excerpts = new Set(excerptIndex(observation.text).map(e => e.id));
  return value.map(entry => {
    if (!allowed(entry, ['kind', 'text', 'evidenceId', 'supersedes', 'reason']) || !kinds.has(entry.kind) || !excerpts.has(entry.evidenceId)) throw Error('视频笔记类型或原文编号无效');
    const supersedes = entry.supersedes ?? [];
    if (!Array.isArray(supersedes) || supersedes.length > 3 || new Set(supersedes).size !== supersedes.length || supersedes.some(id => typeof id !== 'string' || !/^vn-[a-f0-9]{32}$/.test(id))) throw Error('视频笔记修订引用无效');
    const result = {kind: entry.kind, text: text(entry.text, '视频暂定理解或疑问', 700), evidenceId: entry.evidenceId, supersedes,
      reason: supersedes.length ? text(entry.reason, '修订依据', 400) : entry.reason == null ? null : text(entry.reason, '笔记依据', 400)};
    noSecret(JSON.stringify(result));
    return result;
  });
}

function termsFor(query, keywords = []) {
  if (!Array.isArray(keywords) || keywords.length > 8) throw Error('检索关键词最多八项');
  const q = query === undefined ? '' : text(query, '回查问题', 300);
  const tokens = keywords.map(k => text(k, '检索词', 40));
  if (q) tokens.push(q, ...[...new Intl.Segmenter('zh', {granularity: 'word'}).segment(q)].filter(s => s.isWordLike && s.segment.length > 1).map(s => s.segment));
  const stop = new Set(['之前', '视频', '什么', '怎么', '如何', '这个', '那个', '里面', '目前', '我们', '是不是', '请问', '一下', '看到', '为什么']);
  return [...new Set(tokens.map(s => s.toLowerCase()).filter(s => s.length > 1 && !stop.has(s)))].slice(0, 16);
}
const score = (raw, terms) => terms.reduce((n, term) => n + (raw.toLowerCase().includes(term) ? Math.min(term.length, 12) : 0), 0);

function evidenceTypes(payload, excerpt) {
  if (!payload.video?.segments) return [payload.dataSource];
  // Reconstruct the original renderer, so a cut excerpt retains its modality even
  // when its label is thousands of characters earlier. Unmatched legacy layouts
  // stay unclassified instead of guessing that "multimodal" means an actual image.
  const parts = [], spans = []; let position = 0;
  const add = (value, type) => { if (parts.length) position++; spans.push({start: position, end: position + value.length, type}); parts.push(value); position += value.length; };
  for (const segment of payload.video.segments) {
    add(`【片段 ${segment.startSeconds.toFixed(2)}–${segment.endSeconds.toFixed(2)}秒】`, 'scope_marker');
    if (segment.language.text) add(`【${{subtitle:'平台字幕',ai_subtitle:'平台AI字幕，可能误识别',asr:'本地语音转写，可能误识别'}[segment.language.source]}】\n${segment.language.text}`, segment.language.source);
    for (const frame of segment.frames) add(`【画面模型解读，推断而非字幕；${frame.seconds.toFixed(2)}秒；帧${frame.sha256.slice(0,12)}】${frame.description}`, 'model_visual_interpretation');
    if (!segment.language.text) add('本片段未取得可用语言文字；不能据此推断完整声音、语气或音乐。', 'scope_marker');
  }
  if (parts.join('\n').slice(0, payload.text.length) !== payload.text) return ['unclassified_legacy_excerpt'];
  return [...new Set(spans.filter(s => s.start < excerpt.offset + excerpt.text.length && s.end > excerpt.offset).map(s => s.type))];
}

function evidence(observation, excerpt) {
  const payload = observation.payload;
  const segments = payload.video?.segments ?? [];
  const starts = segments.map(s => payload.text.indexOf(`【片段 ${s.startSeconds.toFixed(2)}–${s.endSeconds.toFixed(2)}秒】`));
  const ranges = segments.filter((s, i) => starts[i] >= 0 && starts[i] < excerpt.offset + excerpt.text.length && (starts[i + 1] >= 0 ? starts[i + 1] : payload.text.length) > excerpt.offset)
    .map(s => ({startSeconds: s.startSeconds, endSeconds: s.endSeconds}));
  return {id: observation.id + ':' + excerpt.id, observationId: observation.id, excerptId: excerpt.id, text: excerpt.text,
    sourceHash: observation.content_hash, sourceUrl: payload.url, scope: payload.scope, ranges,
    sourceType: payload.dataSource, evidenceTypes: evidenceTypes(payload, excerpt), interpretation: 'sourceType=multimodal仅是观察容器；按evidenceTypes区分subtitle/ai_subtitle/asr/model_visual_interpretation。画面描述是模型推断；范围是采样区间，不证明连续视听或作者观点真实'};
}

export function videoQuoteEvidence(observation, quote) {
  if (typeof quote !== 'string' || !quote.trim()) throw Error('视频回忆缺少原文依据');
  const start = observation.payload.text.indexOf(quote);
  if (start < 0) throw Error('视频回忆引文已不属于原件');
  const excerpt = excerptIndex(observation.payload.text).find(e => start >= e.offset && start < e.offset + e.text.length);
  return evidence(observation, excerpt);
}

/** Rebuildable, source-bound working notes. No memory/personality writes or model calls. */
export class VideoNotes {
  constructor(activity) {
    this.activity = activity;
    this.db = activity.db;
    this.journal = activity.journal;
    this.db.exec(`CREATE TABLE IF NOT EXISTS activity_video_notebooks(
      video_key TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE,
      observation_id TEXT NOT NULL UNIQUE, source_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
      content_hash TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(video_key,revision));
      CREATE INDEX IF NOT EXISTS activity_observations_video ON activity_observations(
        json_extract(payload_json,'$.bvid'),json_extract(payload_json,'$.page'),json_extract(payload_json,'$.video.cid'));`);
  }

  sources(target, cid, {excludeObservationId} = {}) {
    const sql = `SELECT o.id FROM activity_observations o WHERE json_extract(o.payload_json,'$.bvid')=?
      AND json_extract(o.payload_json,'$.page')=? ${cid === undefined ? '' : "AND coalesce(CAST(json_extract(o.payload_json,'$.video.cid') AS TEXT),'text')=?"}
      AND EXISTS(SELECT 1 FROM activity_runs r WHERE r.observation_id=o.id AND coalesce(json_extract(r.request_json,'$.learn'),1)!=0)
      ORDER BY o.rowid`;
    return this.db.prepare(sql).all(target.bvid, target.page, ...cid === undefined ? [] : [cid ?? 'text'])
      .filter(r => r.id !== excludeObservationId).map(r => this.activity.observation(r.id));
  }

  rows(key) { return this.db.prepare('SELECT * FROM activity_video_notebooks WHERE video_key=? ORDER BY revision').all(key); }

  decode(row) {
    if (hash(row.payload_json) !== row.content_hash) throw Error('视频笔记校验失败');
    const value = JSON.parse(row.payload_json), observation = this.activity.observation(row.observation_id);
    if (!observation || observation.content_hash !== row.source_hash || keyOf(observation.payload, cidOf(observation.payload)) !== row.video_key || value.observationId !== row.observation_id || value.revision !== row.revision) throw Error('视频笔记原件或版本已变化');
    if (!this.db.prepare("SELECT 1 FROM activity_runs WHERE observation_id=? AND coalesce(json_extract(request_json,'$.learn'),1)!=0").get(row.observation_id)) throw Error('视频笔记来源未允许学习');
    for (const entry of value.entries) {
      const excerpt = excerptIndex(observation.payload.text).find(e => e.id === entry.evidenceId);
      if (!excerpt || entry.source.id !== evidence(observation, excerpt).id || JSON.stringify(entry.source) !== JSON.stringify(evidence(observation, excerpt))) throw Error('视频笔记引用原件不符');
    }
    return value;
  }

  state(key) {
    const revisions = this.rows(key).map(r => this.decode(r)), active = new Map(), all = [];
    for (const revision of revisions) for (const entry of revision.entries) {
      for (const id of entry.supersedes) active.delete(id);
      active.set(entry.id, entry); all.push(entry);
    }
    return {revision: revisions.at(-1)?.revision ?? 0, revisions, active: [...active.values()], all};
  }

  validateEdits(proposals, payload) {
    const active = new Set(this.state(keyOf(payload, cidOf(payload))).active.map(e => e.id)), replaced = new Set();
    for (const proposal of proposals ?? []) for (const id of proposal.supersedes) {
      if (!active.has(id) || replaced.has(id)) throw Error('修订必须引用同版视频当前有效的笔记，不能重复撤换');
      replaced.add(id);
    }
  }

  append(runId, observationId, reflection, expectedRevision, {rebuild = false, record = false} = {}) {
    return this.journal.transaction(() => {
      const run = this.activity.get(runId), observation = this.activity.observation(observationId);
      if (!run || run.observation_id !== observationId || !observation) throw Error('视频笔记缺少对应活动原件');
      const finish = receipt => {
        if (record) this.activity.update(runId, run.status, {decision: {...run.decision, videoNotesReceipt: receipt}});
        return receipt;
      };
      if (run.request.learn === false) return finish({status: 'disabled_by_request'});
      const old = this.db.prepare('SELECT * FROM activity_video_notebooks WHERE observation_id=?').get(observationId);
      if (old) return finish({status: 'already_applied', revision: this.decode(old).revision, observationId});
      const key = keyOf(observation.payload, cidOf(observation.payload)), current = this.state(key);
      if (expectedRevision !== undefined && expectedRevision !== current.revision) return finish({status: 'source_changed', reason: '视频笔记已有后续版本，保留原观察，未覆盖笔记'});
      const excerpts = excerptIndex(observation.payload.text);
      let proposals = validateVideoNotes(reflection.videoNotes, observation.payload);
      if (proposals === null) {
        const quote = reflection.quote ?? excerpts.find(e => e.id === reflection.quoteId)?.text;
        const quoteAt = typeof quote === 'string' ? observation.payload.text.indexOf(quote) : -1;
        const excerpt = excerpts.find(e => e.text === quote) ?? excerpts.find(e => quoteAt >= e.offset && quoteAt < e.offset + e.text.length);
        if (!excerpt) throw Error('阶段理解缺少原件引用');
        proposals = [{kind: 'understanding', text: text(reflection.summary, '阶段理解', 700), evidenceId: excerpt.id, supersedes: [], reason: null}];
      }
      if (!proposals.length) return finish({status: 'no_change'});
      this.validateEdits(proposals, observation.payload);
      const revision = current.revision + 1, entries = proposals.map((p, i) => ({...p, id: noteId(key, observationId, i), revision,
        source: evidence(observation, excerpts.find(e => e.id === p.evidenceId)), status: 'tentative_interpretation'}));
      const value = {protocol: 'ai-friend/video-notes/1', revision, observationId, runId, title: observation.payload.title,
        bvid: observation.payload.bvid, page: observation.payload.page, cid: cidOf(observation.payload), entries, derived: true};
      const raw = JSON.stringify(value); noSecret(raw);
      this.db.prepare('INSERT INTO activity_video_notebooks VALUES(?,?,?,?,?,?,?,?)').run(key, revision, runId, observationId, observation.content_hash, raw, hash(raw), this.activity.time());
      return finish({status: rebuild ? 'rebuilt' : 'applied', revision, observationId, noteIds: entries.map(e => e.id)});
    });
  }

  synchronize(target, cid, {excludeObservationId} = {}) {
    // Reuse successful original reflections, including pre-upgrade history. No model re-interpretation.
    const sources = this.sources(target, cid, {excludeObservationId});
    for (const observation of sources) {
      if (this.db.prepare('SELECT 1 FROM activity_video_notebooks WHERE observation_id=?').get(observation.id)) continue;
      const runs = this.db.prepare('SELECT id FROM activity_runs WHERE observation_id=? ORDER BY rowid').all(observation.id);
      for (const row of runs) {
        const run = this.activity.get(row.id), reflection = run.decision?.reflection, receipt = run.decision?.videoNotesReceipt;
        if (run.request.learn === false || !reflection || receipt && !['applied', 'already_applied', 'rebuilt'].includes(receipt.status)) continue;
        const result = this.append(run.id, observation.id, reflection, run.decision?.videoNotesBase, {rebuild: true});
        if (receipt?.revision && result.revision !== receipt.revision) throw Error('视频笔记重建版本不符');
        break;
      }
    }
  }

  read(video, {cid, query, keywords = [], evidenceId, includeHistory = false, beforeRevision, limit = 8, excludeObservationId} = {}) {
    const target = typeof video === 'string' ? biliId(video) : biliId(`https://www.bilibili.com/video/${video.bvid}/?p=${video.page}`);
    if (cid !== undefined && cid !== null && !/^\d{1,30}$/.test(String(cid))) throw Error('视频CID无效');
    if (cid !== undefined && cid !== null) cid = String(cid);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12 || beforeRevision !== undefined && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)) throw Error('视频笔记读取范围无效');
    const terms = termsFor(query, keywords), sources = this.sources(target, cid, {excludeObservationId});
    const versions = [...new Set(sources.map(o => cidOf(o.payload)))];
    if (cid === undefined) cid = sources.length ? cidOf(sources.at(-1).payload) : null;
    this.synchronize(target, cid, {excludeObservationId});
    const state = this.state(keyOf(target, cid)), eligible = sources.filter(o => cidOf(o.payload) === cid), excluded = new Set(excludeObservationId ? [excludeObservationId] : []);
    const ranked = state.active.filter(e => !excluded.has(e.source.observationId)).map(e => ({entry: e, score: score(e.text, terms)}))
      .sort((a, b) => b.score - a.score || b.entry.revision - a.entry.revision);
    const selected = (terms.length ? ranked.filter(r => r.score > 0) : ranked).slice(0, limit);
    const resultEvidence = new Map();
    if (evidenceId !== undefined) {
      if (typeof evidenceId !== 'string' || !/^[a-f0-9-]{36}:excerpt-\d{1,5}$/.test(evidenceId)) throw Error('视频原文引用编号无效');
      const [observationId, excerptId] = evidenceId.split(':'), observation = eligible.find(o => o.id === observationId);
      const excerpt = observation && excerptIndex(observation.payload.text).find(e => e.id === excerptId);
      if (!excerpt) throw Error('当前视频版本未找到允许回查的原件引用');
      resultEvidence.set(evidenceId, evidence(observation, excerpt));
    }
    for (const {entry} of selected) resultEvidence.set(entry.source.id, entry.source);
    const rawMatches = [];
    for (const observation of eligible) for (const excerpt of excerptIndex(observation.payload.text)) {
      const s = score(excerpt.text, terms);
      if (s > 0) rawMatches.push({source: evidence(observation, excerpt), score: s, at: observation.created_at});
    }
    rawMatches.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at));
    for (const row of rawMatches) { if (resultEvidence.size >= limit) break; resultEvidence.set(row.source.id, row.source); }
    const evidenceList = [...resultEvidence.values()].slice(0, limit);
    const output = {status: 'read', ...target, cid, availableVersions: versions, revision: state.revision,
      notes: selected.map(({entry, score}) => ({...entry, score, source: {id: entry.source.id, observationId: entry.source.observationId, ranges: entry.source.ranges}})),
      evidence: evidenceList, retrieval: {terms, method: '按视频版本过滤，暂定笔记匹配后回查原文，辅以全历史片段的字面检索；不保证语义改写命中',
        observationsSearched: eligible.length, activeNotes: state.active.length, matchedNotes: ranked.filter(r => r.score > 0).length, matchedExcerpts: rawMatches.length,
        limited: selected.length < (terms.length ? ranked.filter(r => r.score > 0).length : ranked.length) || evidenceList.length < new Set([...selected.map(r => r.entry.source.id), ...rawMatches.map(r => r.source.id)]).size},
      scope: '可重建的阶段性理解和未证实疑问，不是独立经历、已核实事实或新的人格依据；仅限实际观察范围，未匹配不代表没有发生。不同CID不混用，文本旧版范围单独保留。'};
    if (includeHistory) {
      const history = state.revisions.filter(r => beforeRevision === undefined || r.revision < beforeRevision).slice(-4).reverse();
      output.history = history.map(r => ({...r, entries: r.entries.map(e => ({...e, source: {id: e.source.id, observationId: e.source.observationId, ranges: e.source.ranges}}))}));
      while (output.history.length > 1 && JSON.stringify(output.history).length > 5000) output.history.pop();
      output.nextBeforeRevision = output.history.length && state.revisions.some(r => r.revision < output.history.at(-1).revision) ? output.history.at(-1).revision : null;
    }
    while (JSON.stringify(output).length > 12000 && output.evidence.length > 0) {
      const removed = output.evidence.pop();
      output.notes = output.notes.filter(e => e.source.id !== removed.id);
      output.retrieval.limited = true; output.truncated = true;
    }
    // A returned active note always has its raw citation in the same response.
    const returnedIds = new Set(output.evidence.map(e => e.id));
    output.notes = output.notes.filter(e => returnedIds.has(e.source.id));
    return output;
  }
}
