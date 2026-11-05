// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
import { preprocessHtml } from './preprocess.js';
import { collectT1TidRefs } from './tidParams.js';
import { extractFeedContentFromHtml } from './content.js';
import { canonicalPostTidFromFeedAttrs, dataAttrFromFeedData } from './feedDataCanonical.js';
function extractPostContentFromFeedRegion(region) {
    const tbt = region.match(/class="[^"]*txt-box-title[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|h[1-6])>/i);
    if (tbt) {
        const raw = tbt[1];
        const text = extractFeedContentFromHtml(raw);
        const idx = text.indexOf('：');
        if (idx >= 0) return text.substring(idx + 1).trim();
        return text.trim();
    }
    const fInfoMatch = region.match(/class="f-info[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (fInfoMatch) {
        return extractFeedContentFromHtml(fInfoMatch[1]).trim();
    }
    const preMatch = region.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (preMatch) {
        return preMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return '';
}
function buildPostMetaFromFeedRegion(region, attrs, canonicalTid) {
    const dataUin = dataAttrFromFeedData(attrs, 'uin');
    const abstime = parseInt(dataAttrFromFeedData(attrs, 'abstime') || '0', 10);
    let content = extractPostContentFromFeedRegion(region);
    let views = 0;
    const viewMatch = region.match(/浏览\s*(\d+)\s*次/);
    if (viewMatch) views = parseInt(viewMatch[1], 10);
    let likeCount = 0;
    const likeCntMatch = region.match(/class="f-like-cnt"[^>]*>(\d+)</i) || region.match(/\\x3C[^>]*f-like-cnt[^>]*>(\d+)\\x3C/i);
    if (likeCntMatch) likeCount = parseInt(likeCntMatch[1], 10);
    let commentCount = 0;
    const cmtMatch = region.match(/cmtnum[=:]\s*["']?(\d+)/i) || region.match(/data-cmtnum="(\d+)"/i);
    if (cmtMatch) commentCount = parseInt(cmtMatch[1], 10);
    if (commentCount === 0) {
        const lis = region.match(/<li\s+class="comments-item/gi);
        if (lis) commentCount = lis.length;
    }
    const uinMatch = region.match(/t1_uin=(\d+)/);
    const uin = (dataUin && dataUin !== '0' ? dataUin : uinMatch?.[1]) ?? '';
    const shouldInclude = content.length > 0 || views > 0 || likeCount > 0 || commentCount > 0;
    if (!shouldInclude) return null;
    return {
        tid: canonicalTid,
        uin,
        content,
        views,
        likeCount,
        commentCount,
        createTime: abstime > 0 ? abstime : undefined,
        _source: 'feeds3_html'
    };
}
export function parseFeeds3PostMetaScoped(processedText) {
    const result = new Map();
    const feedDataPat = /name="feed_data"\s*([^>]*)>/g;
    const matches = [];
    let fm;
    while((fm = feedDataPat.exec(processedText)) !== null){
        matches.push({
            index: fm.index,
            attrs: fm[1]
        });
    }
    if (matches.length === 0) return result;
    for(let i = 0; i < matches.length; i++){
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : processedText.length;
        const region = processedText.slice(start, end);
        const attrs = matches[i].attrs;
        const tidRaw = dataAttrFromFeedData(attrs, 'tid') || dataAttrFromFeedData(attrs, 'origtid');
        const dataUin = dataAttrFromFeedData(attrs, 'uin');
        if (tidRaw === 'advertisement_app' || dataUin === '0' || !tidRaw) continue;
        const prevFdPos = i > 0 ? matches[i - 1].index : -1;
        const beforeStart = prevFdPos >= 0 ? Math.max(prevFdPos, start - 8000) : Math.max(0, start - 8000);
        const searchBefore = processedText.slice(beforeStart, start);
        const searchAfterHead = region.slice(0, 4000);
        const canonical = canonicalPostTidFromFeedAttrs(attrs, searchBefore, searchAfterHead);
        if (!canonical) continue;
        const meta = buildPostMetaFromFeedRegion(region, attrs, canonical);
        if (meta) result.set(canonical, meta);
    }
    return result;
}
function parseFeeds3PostMetaLegacy(html) {
    const result = new Map();
    const tidPositions = [];
    const seenTid = new Set();
    for (const r of collectT1TidRefs(html)){
        if (seenTid.has(r.postTid)) continue;
        seenTid.add(r.postTid);
        tidPositions.push({
            tid: r.postTid,
            index: r.index
        });
    }
    for(let i = 0; i < tidPositions.length; i++){
        const { tid } = tidPositions[i];
        const startIdx = tidPositions[i].index;
        const endIdx = i < tidPositions.length - 1 ? tidPositions[i + 1].index : html.length;
        const block = html.slice(startIdx, endIdx);
        const uinMatch = block.match(/t1_uin=(\d+)/);
        const uin = uinMatch?.[1] ?? '';
        let content = '';
        const fInfoMatch = block.match(/class="f-info[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (fInfoMatch) {
            content = fInfoMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        if (!content) {
            const preMatch = block.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
            if (preMatch) {
                content = preMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            }
        }
        let views = 0;
        const viewMatch = block.match(/浏览\s*(\d+)\s*次/);
        if (viewMatch) views = parseInt(viewMatch[1], 10);
        let likeCount = 0;
        const likeCntMatch = block.match(/class="f-like-cnt"[^>]*>(\d+)</) || block.match(/\\x3C[^>]*f-like-cnt[^>]*>(\d+)\\x3C/i);
        if (likeCntMatch) likeCount = parseInt(likeCntMatch[1], 10);
        let commentCount = 0;
        const cmtMatch = block.match(/cmtnum[=:]\s*["']?(\d+)/i);
        if (cmtMatch) commentCount = parseInt(cmtMatch[1], 10);
        let createTime;
        const abstimeMatch = block.match(/data-abstime="(\d+)"/);
        if (abstimeMatch) createTime = parseInt(abstimeMatch[1], 10);
        if (content || views > 0 || likeCount > 0) {
            result.set(tid, {
                tid,
                uin,
                content,
                views,
                likeCount,
                commentCount,
                createTime,
                _source: 'feeds3_html'
            });
        }
    }
    return result;
}
export function parseFeeds3PostMeta(text, processedText) {
    const html = processedText ?? preprocessHtml(text).text;
    const scoped = parseFeeds3PostMetaScoped(html);
    if (scoped.size > 0) {
        return scoped;
    }
    return parseFeeds3PostMetaLegacy(html);
}
