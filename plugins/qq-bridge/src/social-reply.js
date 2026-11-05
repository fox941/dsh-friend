import {eventStickerScope} from './stickers.js';
import {qqSegments} from './qq-media.js';
import {hash, noSecret} from './validation.js';
import {socialGate} from './social-gate.js';

const activeSource = new Set(['queued', 'sent', 'ignored']);
const decisionKeys = new Set(['disposition', 'body', 'reason', 'afterSeconds', 'emotionProposals', 'memoryProposals', 'replyFormat', 'imageAssetIds', 'onMediaFailure', 'stickerId', 'stickerCollections']);
const scopeOf = e => ({account: e.account, peer: e.sender, thread: e.thread_key, groupId: e.kind === 'group' ? String(e.raw.group_id) : null});
const sameScope = (scope, event) => scope?.account === event.account && scope.thread === event.thread_key
  && (event.kind === 'group' ? String(scope.groupId) === String(event.raw.group_id) : !scope.groupId && scope.peer === event.sender);

function observedImages(controller, event) {
  const input = controller.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:social:' + event.id);
  if (!input) return [];
  const read = controller.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('read:' + input.id);
  if (!read) return [];
  const original = controller.store.media(input.id), observation = controller.store.media(read.id);
  if (original?.kind !== 'input' || observation?.kind !== 'observation' || observation.inputId !== input.id
    || !sameScope(original.scope, event) || !sameScope(observation.scope, event)) return [];
  if(observation.observationVersion===2&&(observation.inputFingerprint!==hash(JSON.stringify([original.id,original.scope,original.segments]))||JSON.stringify(original.segments)!==JSON.stringify(qqSegments(event.raw))))return [];
  return (observation.images ?? []).filter(image => typeof image.assetId === 'string' && /^[a-f0-9]{64}$/.test(image.sha256)).slice(0, 4)
    .map(image => ({...image, observedDescription: typeof observation.visualInterpretation?.text === 'string' ? observation.visualInterpretation.text.slice(0, 600) : null}));
}

/** Only bounded, actually read images from this conversation become options. */
export function socialReplyOptions(controller, event) {
  const ids = controller.store.db.prepare("SELECT id FROM platform_events WHERE account=? AND thread_key=? AND rowid<=(SELECT rowid FROM platform_events WHERE id=?) AND status IN ('queued','sent','ignored') ORDER BY rowid DESC LIMIT 8").all(event.account, event.thread_key, event.id);
  const images = [], seen = new Set();
  for (const row of ids) {
    try {
      const source = controller.store.event(row.id);
      if (!source || !activeSource.has(source.status) || !sameScope(scopeOf(source), event)) continue;
      for (const image of observedImages(controller, source)) {
        if (seen.has(image.assetId) || images.length >= 4) continue;
        seen.add(image.assetId);
        images.push({assetId: image.assetId, sha256: image.sha256, sourceEventId: source.id,
          sourceHash: source.raw_hash, postedByQQ: source.sender, origin: image.origin,
          actualRead: true, scope: 'same-conversation', sourceText: source.body.slice(0, 160), observedDescription: image.observedDescription});
      }
    } catch { /* A damaged or withdrawn source is not a usable image option. */ }
  }
  let stickers=[],stickerLibraryUnavailable=false;try{stickers=controller.stickers?.search(eventStickerScope(event),event.body.slice(0,500),8).items??[];}catch{stickerLibraryUnavailable=true;}
  const currentInput=controller.store.db.prepare('SELECT id FROM platform_media WHERE event_key=?').get('input:social:'+event.id);
  const collectable=controller.stickers&&currentInput?controller.stickers.observed(eventStickerScope(event),{inputId:currentInput.id}):[];
  return {stickers,collectable,stickerLibraryUnavailable,formats: ['text', ...stickers.length?['sticker']:[], ...typeof controller.media?.voice === 'function' ? ['voice'] : [], ...images.length ? ['image'] : []],
    voiceMaxChars: 1000, maxImages: 4, images, mediaFailureDefault: 'defer',
    boundary: '已收藏表情由同一AI共用，sticker可选择其他QQ会话收藏的stickerId，只提供图片描述与标签；不推断原来源人物或聊天。仅回复当前原会话。voice的body就是实际朗读文字；image只选这里实际读过的assetId。准备不是发送；不提供任意路径、URL、base64或其他收件人。'};
}

export function normalizeSocialReply(decision, options) {
  if (Object.keys(decision).some(key => !decisionKeys.has(key))) throw Error('社交回复包含未知字段或其他目标');
  const format = decision.replyFormat ?? 'text', body = decision.body;
  if (!['text', 'voice', 'image', 'sticker'].includes(format) || !options.formats.includes(format)) throw Error('当前社交回复形式不可用');
  if (typeof body !== 'string' || Array.from(body).length > 1500 || !['image','sticker'].includes(format) && !body.trim()) throw Error('QQ回复正文异常');
  if (format === 'voice' && body.length > options.voiceMaxChars) throw Error('语音正文超出范围');
  const onMediaFailure = decision.onMediaFailure ?? 'defer';
  if (!['text', 'defer'].includes(onMediaFailure)) throw Error('媒体失败策略无效');
  let imageAssetIds = [];
  if (format === 'image') {
    imageAssetIds = decision.imageAssetIds;
    if (!Array.isArray(imageAssetIds) || imageAssetIds.length < 1 || imageAssetIds.length > options.maxImages
      || new Set(imageAssetIds).size !== imageAssetIds.length
      || imageAssetIds.some(id => typeof id !== 'string' || !options.images.some(image => image.assetId === id))) throw Error('图片不属于当前已读会话资产');
  } else if (decision.imageAssetIds !== undefined) throw Error('非图片回复不能附带图片资产');
  if(format==='sticker'&&!options.stickers?.some(s=>s.stickerId===decision.stickerId))throw Error('表情不属于当前会话候选');
  if(format!=='sticker'&&decision.stickerId!==undefined)throw Error('非表情回复不能附带表情ID');
  noSecret(body);
  return {format, body, imageAssetIds, onMediaFailure,...format==='sticker'?{stickerId:decision.stickerId}:{}};
}

function imageProof(controller, event, candidate) {
  const source = controller.store.event(candidate.sourceEventId);
  if (!source || !activeSource.has(source.status) || source.raw_hash !== candidate.sourceHash || !sameScope(scopeOf(source), event)) throw Error('图片原消息已失效');
  if (!observedImages(controller, source).some(image => image.assetId === candidate.assetId && image.sha256 === candidate.sha256)) throw Error('图片读取依据已变化');
}

export function recheckSocialImages(controller, event, prepared) {
  for (const candidate of prepared.imageProofs ?? []) imageProof(controller, event, candidate);
}

/** Preparation is local/cache work. Only the caller may subsequently dispatch. */
export async function prepareSocialReply(controller, event, plan, options, signal) {
  if (plan.format === 'text') return {format: 'text', assetIds: [], imageProofs: [], reply: plan.body,
    segments: [{type: 'text', data: {text: plan.body}}],
    metadata: {requestedFormat: 'text', format: 'text', assetIds: [], preparationId: null, fallback: false}};
  const scope = {...scopeOf(event), origin: 'social_reply', sourceEventId: event.id, sourceHash: event.raw_hash};
  const fingerprint = hash(JSON.stringify([event.id, event.raw_hash, plan]));
  const key = 'social-reply:' + fingerprint;
  let prepared;
  try {
    if (plan.format === 'voice') {
      const voice = await controller.media.voice(plan.body, scope, signal);
      signal?.throwIfAborted();
      if (voice?.kind !== 'voice' || voice.text !== plan.body || voice.scope?.sourceEventId !== event.id || voice.scope.sourceHash !== event.raw_hash || !sameScope(voice.scope, event)) throw Error('语音资产不属于本次回复');
      const asset = await controller.media.asset(voice.id);
      if (asset.kind !== 'voice') throw Error('语音资产类型不符');
      prepared = {format: 'voice', assetIds: [voice.id], voiceEngine: voice.engine,
        segments: [{type: 'record', data: {file: 'base64://' + asset.bytes.toString('base64')}}], imageProofs: []};
    } else if(plan.format==='sticker'){
      const scope=eventStickerScope(event),asset=await controller.stickers.asset(scope,plan.stickerId);
      prepared={format:'sticker',assetIds:[],imageProofs:[],stickerProof:{id:plan.stickerId,scope,sha256:asset.row.sha256},
       segments:[...plan.body.trim()?[{type:'text',data:{text:plan.body}}]:[],{type:'image',data:{file:'base64://'+asset.bytes.toString('base64'),sub_type:1,summary:'[表情]'}}]};
    } else {
      const imageProofs = plan.imageAssetIds.map(id => options.images.find(image => image.assetId === id));
      const segments = plan.body.trim() ? [{type: 'text', data: {text: plan.body}}] : [];
      for (const candidate of imageProofs) {
        imageProof(controller, event, candidate);
        const asset = await controller.media.asset(candidate.assetId);
        if (asset.kind !== 'image' || hash(asset.bytes) !== candidate.sha256) throw Error('图片内容或类型变化');
        segments.push({type: 'image', data: {file: 'base64://' + asset.bytes.toString('base64')}});
      }
      prepared = {format: 'image', assetIds: plan.imageAssetIds, segments, imageProofs};
    }
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (plan.format === 'text') throw error;
    const outcome = await socialGate(controller, event, signal);
    if (outcome) return {outcome};
    // The error details may contain local paths or provider bodies; keep them out
    // of replies and durable public evidence. No network send has started here.
    controller.store.saveMedia('social-reply-failure:' + fingerprint + ':' + controller.store.time(), {
      kind: 'social_reply_preparation_failed', scope, sourceEventId: event.id, sourceHash: event.raw_hash,
      requestedFormat: plan.format, onMediaFailure: plan.onMediaFailure, notice: '媒体未准备完成，未提交消息'});
    if (plan.onMediaFailure === 'defer' || !plan.body.trim()) {
      controller.defer({kind: 'time', at: controller.store.now().valueOf() + 60000});
      return {outcome: {pending: true, notice: 'Media preparation incomplete; reconsider later'}};
    }
    const text = (plan.format === 'voice' ? '语音暂时没准备好，先用文字回复：' : '图片暂时没准备好，先用文字回复：') + plan.body;
    prepared = {format: 'text', assetIds: [], segments: [{type: 'text', data: {text}}], imageProofs: [], fallback: true, fallbackText: text};
  }
  const evidence = controller.store.saveMedia(key + ':' + hash(JSON.stringify([prepared.format, prepared.assetIds, Boolean(prepared.fallback)])), {
    kind: 'social_reply', scope, sourceEventId: event.id, sourceHash: event.raw_hash, body: plan.body,
    requestedFormat: plan.format, format: prepared.format, assetIds: prepared.assetIds,
    ...(prepared.voiceEngine ? {voiceEngine: prepared.voiceEngine} : {}), fallback: Boolean(prepared.fallback),
    imageProofs: prepared.imageProofs,...prepared.stickerProof?{stickerId:prepared.stickerProof.id}:{}, preparedAt: controller.store.time(), state: 'prepared_not_sent'});
  return {...prepared, reply: prepared.fallbackText ?? (plan.body || '【图片回复】'),
    metadata: {requestedFormat: plan.format, format: prepared.format, assetIds: prepared.assetIds,
      preparationId: evidence.id,...prepared.stickerProof?{stickerId:prepared.stickerProof.id}:{}, ...(prepared.voiceEngine ? {voiceEngine: prepared.voiceEngine} : {}), fallback: Boolean(prepared.fallback)}};
}

export async function recheckSocialSticker(controller,event,prepared){if(!prepared.stickerProof)return;const p=prepared.stickerProof,a=await controller.stickers.asset(eventStickerScope(event),p.id);if(a.row.sha256!==p.sha256)throw Error('发送前表情内容变化');}
