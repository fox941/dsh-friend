// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
import { log, htmlUnescape } from '../utils.js';
import { preprocessHtml } from './preprocess.js';
import { canonicalPostTidFromFeedAttrs } from './feedDataCanonical.js';
import { stripHtmlTags } from './content.js';
import { collectT1TidRefs, firstT1TidIn } from './tidParams.js';
function t1TidsInSnippet(snippet) {
    const out = [];
    const re = /t1_tid=([^&"'<>\s]+)/gi;
    let m;
    while((m = re.exec(snippet)) !== null){
        const v = m[1].trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}
function commentBlockMatchesPost(fullBlock, fixedPostTid) {
    const t1s = t1TidsInSnippet(fullBlock);
    if (t1s.length === 0) return true;
    const anchorLooksReal = (t)=>/^[a-f0-9]{16,}$/i.test(t) || /^d\d+_\d+_/i.test(t);
    const relevant = t1s.filter(anchorLooksReal);
    if (relevant.length === 0) return true;
    const uniq = [
        ...new Set(relevant)
    ];
    const hits = uniq.filter((t)=>t === fixedPostTid);
    if (hits.length === 0) return false;
    if (uniq.length > 1 && uniq.some((t)=>t !== fixedPostTid)) return false;
    return true;
}
function validateComment(comment, source) {
    const errors = [];
    if (!comment['commentid'] || typeof comment['commentid'] !== 'string' || comment['commentid'].length === 0) {
        errors.push('missing or invalid commentid');
    }
    if (!comment['uin'] || typeof comment['uin'] !== 'string' || comment['uin'].length === 0) {
        errors.push('missing or invalid uin');
    }
    if (!comment['name'] || typeof comment['name'] !== 'string' || comment['name'].length === 0) {
        errors.push('missing or invalid name');
    }
    if (typeof comment['content'] !== 'string') {
        errors.push('missing or invalid content type');
    }
    const ct = comment['createtime'];
    const fseq = comment['_feeds3_seq'];
    if (typeof ct !== 'number' || ct <= 0 && typeof fseq !== 'number') {
        errors.push('missing or invalid createtime');
    }
    if (errors.length > 0 && source === 'root') {
        log('DEBUG', `validateComment [${source}]: commentid=${comment['commentid']}, errors=[${errors.join(', ')}]`);
    }
    return {
        valid: errors.length === 0,
        errors
    };
}
function extractReplyToNickname(body) {
    const htmlPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:&nbsp;|\s)*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>([^<]+)<\/a>/i;
    const htmlMatch = body.match(htmlPattern);
    if (htmlMatch) {
        return htmlUnescape(htmlMatch[1].trim());
    }
    const textPattern = /回复\s*[@＠]([^:：\s]+)/i;
    const textMatch = body.match(textPattern);
    if (textMatch) {
        return htmlUnescape(textMatch[1].trim());
    }
    return null;
}
const COMMENT_IMG_EXCLUDED = [
    /qzonestyle\.gtimg\.cn\/qzone\/em\//,
    /qzonestyle\.gtimg\.cn\/qzone\/space\//,
    /\/ac\/b\.gif$/,
    /qlogo\.cn/,
    /qzapp\.qlogo\.cn/,
    /qzonestyle\.gtimg\.cn\/act/
];
function extractImagesFromCommentHtml(html) {
    const urls = [];
    const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
    for (const m of html.matchAll(/<img[^>]+>/gi)){
        const tag = m[0];
        const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
        const dataSrc = tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1];
        const dataOrig = tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1];
        const lzSrc = tag.match(/\b(?:lz-src|lazy-src)=["']([^"']+)["']/i)?.[1];
        for (const url of [
            src,
            dataSrc,
            dataOrig,
            lzSrc
        ]){
            if (!url || urls.includes(url)) continue;
            if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && isUserPic(url)) urls.push(url);
        }
    }
    return urls;
}
function extractPicUrlsFromDataPickey(html) {
    const urls = [];
    const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
    const re = /data-pickey="([^,]+),([^"]+)"/gi;
    let m;
    while((m = re.exec(html)) !== null){
        const url = m[2].trim();
        if (!url.startsWith('http')) continue;
        if (!isUserPic(url)) continue;
        if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && !urls.includes(url)) urls.push(url);
    }
    return urls;
}
function extractPicUrlsFromImageAnchors(html) {
    const urls = [];
    const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
    const re = /<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>/gi;
    let m;
    while((m = re.exec(html)) !== null){
        const url = m[1];
        if (!isUserPic(url)) continue;
        if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && !urls.includes(url)) urls.push(url);
    }
    return urls;
}
function extractQpicUrlsFromText(html, isUserPic) {
    const urls = [];
    const pattern = /https?:\/\/[^"'\s<>]*qpic\.cn\/[^"'\s<>]+|https?:\/\/[^"'\s<>]*photo\.store\.qq\.com\/[^"'\s<>]+/gi;
    let m;
    while((m = pattern.exec(html)) !== null){
        const url = m[0];
        if (isUserPic(url) && !urls.includes(url)) urls.push(url);
    }
    return urls;
}
function extractPicUrlsFromBackgroundImage(html) {
    const urls = [];
    const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
    const re = /url\(\s*["']?(https?:\/\/[^"')]+)["']?\s*\)/gi;
    let m;
    while((m = re.exec(html)) !== null){
        const url = m[1].trim();
        if (!isUserPic(url)) continue;
        if ((url.includes('qpic.cn') || url.includes('photo.store.qq.com')) && !urls.includes(url)) urls.push(url);
    }
    return urls;
}
function extractImagesFromCommentThumbnails(body) {
    const startIdx = body.search(/<div[^>]*class="[^"]*comments-thumbnails[^"]*"/i);
    if (startIdx < 0) return [];
    const afterOpen = body.indexOf('>', startIdx) + 1;
    const endIdx = body.indexOf('<div', afterOpen);
    const thumbBlock = endIdx > afterOpen ? body.slice(afterOpen, endIdx) : body.slice(afterOpen, afterOpen + 3000);
    const urls = [];
    const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
    for (const m of thumbBlock.matchAll(/<img[^>]+>/gi)){
        const tag = m[0];
        const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
        const dataSrc = tag.match(/\bdata-src=["']([^"']+)["']/i)?.[1];
        const dataOrig = tag.match(/\bdata-original=["']([^"']+)["']/i)?.[1];
        const lzSrc = tag.match(/\b(?:lz-src|lazy-src)=["']([^"']+)["']/i)?.[1];
        for (const url of [
            src,
            dataSrc,
            dataOrig,
            lzSrc
        ]){
            if (!url || urls.includes(url)) continue;
            if (isUserPic(url) && (url.includes('qpic.cn') || url.includes('photo.store.qq.com') || /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url))) urls.push(url);
        }
    }
    if (urls.length === 0) {
        const fromText = extractQpicUrlsFromText(thumbBlock, isUserPic);
        for (const u of fromText)if (!urls.includes(u)) urls.push(u);
    }
    return urls;
}
function getCommentContentFragment(body, isReply) {
    function truncateAtCommentsOp(html) {
        const opMatch = html.match(/<div\s+class="[^"]*comments-op[^"]*"/i);
        if (opMatch) {
            let truncated = html.slice(0, opMatch.index);
            const lastLt = truncated.lastIndexOf('<');
            if (lastLt >= 0) {
                const afterLt = truncated.slice(lastLt);
                const looksLikeTag = /^<[a-zA-Z\/]/.test(afterLt);
                const hasClose = afterLt.includes('>');
                if (looksLikeTag && !hasClose) truncated = truncated.slice(0, lastLt);
            }
            return truncated;
        }
        return html;
    }
    if (isReply) {
        const replyPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:\s*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>)(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|$)/i;
        const replyMatch = body.match(replyPattern);
        if (replyMatch) return truncateAtCommentsOp(replyMatch[1]);
    }
    const rootPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|<\/div>\s*<div|$)/i;
    const rootMatch = body.match(rootPattern);
    if (rootMatch) return truncateAtCommentsOp(rootMatch[1]);
    const loosePattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>\s*[:：]\s*([^<]+)/i;
    const looseMatch = body.match(loosePattern);
    if (looseMatch) return looseMatch[1].trim();
    const contentPattern = /<div[^>]*class="[^"]*comments-content[^"]*"[^>]*>[\s\S]*?<\/a>\s*[:：]\s*([^<]+(?:<[^>]+>[^<]*)*)/i;
    const contentMatch = body.match(contentPattern);
    if (contentMatch) return truncateAtCommentsOp(contentMatch[1]);
    return null;
}
function extractCommentContentAndImages(body, isReply) {
    const fragment = getCommentContentFragment(body, isReply);
    const content = fragment ? htmlUnescape(stripHtmlTags(fragment)).trim() : '';
    const fromFragment = fragment ? extractImagesFromCommentHtml(fragment) : [];
    const fromBody = extractImagesFromCommentHtml(body);
    const fromThumbnails = extractImagesFromCommentThumbnails(body);
    const fromPickey = extractPicUrlsFromDataPickey(body);
    const fromAnchors = extractPicUrlsFromImageAnchors(body);
    const pic = [
        ...fromFragment
    ];
    for (const url of [
        ...fromBody,
        ...fromThumbnails,
        ...fromPickey,
        ...fromAnchors
    ]){
        if (!pic.includes(url)) pic.push(url);
    }
    if (pic.length === 0 && /comments-thumbnails/i.test(body)) {
        const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
        for (const u of extractQpicUrlsFromText(body, isUserPic)){
            if (!pic.includes(u)) pic.push(u);
        }
    }
    if (pic.length === 0) {
        const isUserPic = (u)=>u.startsWith('http') && !COMMENT_IMG_EXCLUDED.some((p)=>p.test(u));
        for (const u of extractQpicUrlsFromText(body, isUserPic)){
            if (!pic.includes(u)) pic.push(u);
        }
        for (const u of extractPicUrlsFromBackgroundImage(body)){
            if (!pic.includes(u)) pic.push(u);
        }
    }
    return {
        content,
        pic
    };
}
function extractCommentContent(body, isReply) {
    function truncateAtCommentsOp(html) {
        const opMatch = html.match(/<div\s+class="[^"]*comments-op[^"]*"/i);
        if (opMatch) {
            let truncated = html.slice(0, opMatch.index);
            const lastLt = truncated.lastIndexOf('<');
            if (lastLt >= 0) {
                const afterLt = truncated.slice(lastLt);
                const looksLikeTag = /^<[a-zA-Z\/]/.test(afterLt);
                const hasClose = afterLt.includes('>');
                if (looksLikeTag && !hasClose) {
                    truncated = truncated.slice(0, lastLt);
                }
            }
            return truncated;
        }
        return html;
    }
    if (isReply) {
        const replyPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*回复(?:\s*<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>)(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|$)/i;
        const replyMatch = body.match(replyPattern);
        if (replyMatch) {
            const truncated = truncateAtCommentsOp(replyMatch[1]);
            return htmlUnescape(stripHtmlTags(truncated)).trim();
        }
    }
    const rootPattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>(?:&nbsp;|\s)*[:：](?:&nbsp;|\s)*([\s\S]*?)(?:<div\s+class="comments-op|<div\s+class="mod-comments-sub|<\/div>\s*<div|$)/i;
    const rootMatch = body.match(rootPattern);
    if (rootMatch) {
        const truncated = truncateAtCommentsOp(rootMatch[1]);
        return htmlUnescape(stripHtmlTags(truncated)).trim();
    }
    const loosePattern = /<a[^>]*class="[^"]*nickname[^"]*"[^>]*>[^<]*<\/a>\s*[:：]\s*([^<]+)/i;
    const looseMatch = body.match(loosePattern);
    if (looseMatch) {
        return htmlUnescape(looseMatch[1].trim());
    }
    const contentPattern = /<div[^>]*class="[^"]*comments-content[^"]*"[^>]*>[\s\S]*?<\/a>\s*[:：]\s*([^<]+(?:<[^>]+>[^<]*)*)/i;
    const contentMatch = body.match(contentPattern);
    if (contentMatch) {
        const truncated = truncateAtCommentsOp(contentMatch[1]);
        return htmlUnescape(stripHtmlTags(truncated)).trim();
    }
    return '';
}
function parseCommentTime(body, widerContext = '') {
    const hay = `${body}\n${widerContext}`;
    const unixM = hay.match(/(?:^|[?&])(?:abstime|createtime|ctime|pubtime|oper_time)=(\d{9,13})\b/i);
    if (unixM) {
        let n = parseInt(unixM[1], 10);
        if (n > 1e12) n = Math.floor(n / 1000);
        if (n > 1e8 && n < 2e10) return n;
    }
    const dataM = hay.match(/data-(?:time|ct|ts|opertime|seconds)="(\d{9,13})"/i);
    if (dataM) {
        let n = parseInt(dataM[1], 10);
        if (n > 1e12) n = Math.floor(n / 1000);
        if (n > 1e8 && n < 2e10) return n;
    }
    const timeMatch = body.match(/class="[^"]*\bstate\b[^"]*"[^>]*>\s*([^<]+)/);
    if (!timeMatch) return 0;
    const ts = timeMatch[1].trim();
    const d = new Date();
    const hm = ts.match(/(\d{1,2}):(\d{2})/);
    if (hm) {
        if (ts.includes('昨天')) d.setDate(d.getDate() - 1);
        else if (ts.includes('前天')) d.setDate(d.getDate() - 2);
        d.setHours(parseInt(hm[1], 10), parseInt(hm[2], 10), 0, 0);
        return Math.floor(d.getTime() / 1000);
    }
    const md = ts.match(/(\d{1,2})[-月](\d{1,2})/);
    if (md) {
        d.setMonth(parseInt(md[1], 10) - 1, parseInt(md[2], 10));
        d.setHours(0, 0, 0, 0);
        return Math.floor(d.getTime() / 1000);
    }
    const ymd = ts.match(/(\d{4})[-年](\d{1,2})[-月](\d{1,2})/);
    if (ymd) {
        d.setFullYear(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10));
        d.setHours(0, 0, 0, 0);
        return Math.floor(d.getTime() / 1000);
    }
    return 0;
}
function findMatchingClosingCommentsItemLi(text, start) {
    const liCommentsOpen = /<li\s+class="comments-item/g;
    let depth = 1;
    let pos = start;
    while(depth > 0 && pos < text.length){
        const nextClose = text.indexOf('</li>', pos);
        if (nextClose < 0) return -1;
        liCommentsOpen.lastIndex = pos;
        const openMatch = liCommentsOpen.exec(text);
        const nextOpen = openMatch !== null && openMatch.index < nextClose ? openMatch.index : -1;
        if (nextOpen >= 0) {
            depth++;
            pos = nextOpen + 1;
        } else {
            depth--;
            if (depth === 0) return nextClose + 6;
            pos = nextClose + 1;
        }
    }
    return -1;
}
function parseFeeds3CommentsInRegion(region, fixedPostTid, feeds3Seq) {
    const bucket = [];
    const rootCommentPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="commentroot"[^>]*>/gi;
    let rootMatch;
    while((rootMatch = rootCommentPat.exec(region)) !== null){
        const openTag = rootMatch[0];
        const openEnd = rootMatch.index + openTag.length;
        const closeEnd = findMatchingClosingCommentsItemLi(region, openEnd);
        if (closeEnd < 0) continue;
        const fullBlock = region.slice(rootMatch.index, closeEnd);
        const body = region.slice(openEnd, closeEnd - 6);
        if (!commentBlockMatchesPost(fullBlock, fixedPostTid)) {
            log('DEBUG', `parseFeeds3CommentsInRegion: skip root comment block (t1 mismatch). want=${fixedPostTid.slice(-14)} t1s=${t1TidsInSnippet(fullBlock).map((x)=>x.slice(-14)).join('|')}`);
            continue;
        }
        const rootTid = openTag.match(/data-tid="([^"]*)"/)?.[1] ?? '';
        const rootUin = openTag.match(/data-uin="([^"]*)"/)?.[1] ?? '';
        const rootNick = openTag.match(/data-nick="([^"]*)"/)?.[1] ?? '';
        if (!rootTid) continue;
        const { content: rootContent, pic: rootPic } = extractCommentContentAndImages(body, false);
        const rootTime = parseCommentTime(body, fullBlock);
        const rootComment = {
            commentid: rootTid,
            uin: rootUin,
            name: rootNick,
            content: rootContent,
            createtime: rootTime,
            is_reply: false,
            _source: 'feeds3_html',
            _feeds3_seq: feeds3Seq.value++
        };
        if (rootPic.length > 0) rootComment['pic'] = rootPic;
        bucket.push(rootComment);
        const subCommentsPat = /<div[^>]*class="[^"]*mod-comments-sub[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>[\s\S]*?<\/div>/gi;
        subCommentsPat.lastIndex = 0;
        let subBlockMatch;
        while((subBlockMatch = subCommentsPat.exec(fullBlock)) !== null){
            const subUl = subBlockMatch[1];
            const replyPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="replyroot"[^>]*>/gi;
            replyPat.lastIndex = 0;
            let replyMatch;
            while((replyMatch = replyPat.exec(subUl)) !== null){
                const replyOpenTag = replyMatch[0];
                const replyOpenEnd = replyMatch.index + replyOpenTag.length;
                const replyCloseEnd = findMatchingClosingCommentsItemLi(subUl, replyOpenEnd);
                if (replyCloseEnd < 0) continue;
                const replyBody = subUl.slice(replyOpenEnd, replyCloseEnd - 6);
                const replyTid = replyOpenTag.match(/data-tid="([^"]*)"/)?.[1] ?? '';
                const replyUin = replyOpenTag.match(/data-uin="([^"]*)"/)?.[1] ?? '';
                const replyNick = replyOpenTag.match(/data-nick="([^"]*)"/)?.[1] ?? '';
                if (!replyTid) continue;
                const t2Uin = replyBody.match(/t2_uin=(\d+)/i)?.[1] ?? '';
                const t2Tid = replyBody.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? '';
                const replyToNickname = extractReplyToNickname(replyBody);
                const { content: replyContent, pic: replyPic } = extractCommentContentAndImages(replyBody, true);
                const replyTime = parseCommentTime(replyBody, fullBlock);
                const finalReplyId = t2Tid ? `${rootTid}_r_${replyTid}_${replyUin}` : `${rootTid}_${replyTid}_${replyUin}`;
                const replyComment = {
                    commentid: finalReplyId,
                    uin: replyUin,
                    name: replyNick,
                    content: replyContent,
                    createtime: replyTime,
                    is_reply: true,
                    parent_comment_id: rootTid,
                    _source: 'feeds3_html',
                    _feeds3_seq: feeds3Seq.value++
                };
                if (t2Uin) replyComment['reply_to_uin'] = t2Uin;
                if (replyToNickname) replyComment['reply_to_nickname'] = replyToNickname;
                if (t2Tid) replyComment['reply_to_comment_id'] = t2Tid;
                if (replyPic.length > 0) replyComment['pic'] = replyPic;
                bucket.push(replyComment);
            }
        }
    }
    const legacyCommentPat = /<li\s+class="comments-item[^"]*"([^>]*)>/g;
    let legacyMatch;
    const seenCommentIds = new Set();
    for (const c of bucket){
        seenCommentIds.add(c['commentid']);
    }
    while((legacyMatch = legacyCommentPat.exec(region)) !== null){
        const attrs = legacyMatch[1];
        if (attrs.includes('data-type="commentroot"') || attrs.includes('data-type="replyroot"')) continue;
        const openEnd = legacyMatch.index + legacyMatch[0].length;
        const closeEnd = findMatchingClosingCommentsItemLi(region, openEnd);
        if (closeEnd < 0) continue;
        const legacyFull = region.slice(legacyMatch.index, closeEnd);
        if (!commentBlockMatchesPost(legacyFull, fixedPostTid)) continue;
        const body = region.slice(openEnd, closeEnd - 6);
        const commentId = attrs.match(/data-tid="([^"]*)"/)?.[1] ?? '';
        const uin = attrs.match(/data-uin="([^"]*)"/)?.[1] ?? '';
        const nick = attrs.match(/data-nick="([^"]*)"/)?.[1] ?? '';
        if (!commentId || seenCommentIds.has(commentId)) continue;
        seenCommentIds.add(commentId);
        const isReply = body.includes('回复');
        const { content, pic: legacyPic } = extractCommentContentAndImages(body, isReply);
        const createdTime = parseCommentTime(body, region.slice(Math.max(0, legacyMatch.index - 2000), Math.min(region.length, closeEnd + 500)));
        const t2Uin = body.match(/t2_uin=(\d+)/i)?.[1] ?? '';
        const t2Tid = body.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? '';
        const replyToNickname = isReply ? extractReplyToNickname(body) : null;
        const comment = {
            commentid: commentId,
            uin,
            name: nick,
            content,
            createtime: createdTime,
            is_reply: isReply,
            _source: 'feeds3_html',
            _feeds3_seq: feeds3Seq.value++
        };
        if (legacyPic.length > 0) comment['pic'] = legacyPic;
        if (isReply) {
            if (t2Uin) comment['reply_to_uin'] = t2Uin;
            if (replyToNickname) comment['reply_to_nickname'] = replyToNickname;
            if (t2Tid) comment['reply_to_comment_id'] = t2Tid;
        }
        bucket.push(comment);
    }
    return bucket;
}
export function parseFeeds3CommentsScoped(processedText) {
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
    const feeds3Seq = {
        value: 0
    };
    for(let i = 0; i < matches.length; i++){
        const start = matches[i].index;
        const end = i + 1 < matches.length ? matches[i + 1].index : processedText.length;
        const region = processedText.slice(start, end);
        const prevFdPos = i > 0 ? matches[i - 1].index : -1;
        const beforeStart = prevFdPos >= 0 ? Math.max(prevFdPos, start - 8000) : Math.max(0, start - 8000);
        const searchBefore = processedText.slice(beforeStart, start);
        const searchAfterHead = region.slice(0, 4000);
        const canonical = canonicalPostTidFromFeedAttrs(matches[i].attrs, searchBefore, searchAfterHead);
        if (!canonical) continue;
        const list = parseFeeds3CommentsInRegion(region, canonical, feeds3Seq);
        if (list.length === 0) continue;
        if (!result.has(canonical)) result.set(canonical, []);
        const dest = result.get(canonical);
        const seen = new Set(dest.map((c)=>String(c['commentid'])));
        for (const c of list){
            const id = String(c['commentid']);
            if (!seen.has(id)) {
                seen.add(id);
                dest.push(c);
            }
        }
    }
    return result;
}
function finalizeParseFeeds3CommentsResult(result, startTime) {
    const stats = {
        rootComments: 0,
        replyComments: 0,
        validComments: 0,
        invalidComments: 0,
        errors: [],
        durationMs: 0
    };
    for (const comments of result.values()){
        for (const comment of comments){
            if (comment['is_reply']) stats.replyComments++;
            else stats.rootComments++;
        }
    }
    stats.durationMs = Date.now() - startTime;
    for (const comments of result.values()){
        for (const comment of comments){
            const validation = validateComment(comment, 'root');
            if (validation.valid) {
                stats.validComments++;
            } else {
                stats.invalidComments++;
                if (stats.errors.length < 10) {
                    stats.errors.push(`cid=${comment['commentid']}: ${validation.errors.join(', ')}`);
                }
            }
        }
    }
    log('INFO', `parseFeeds3Comments: posts=${result.size}, root=${stats.rootComments}, replies=${stats.replyComments}, valid=${stats.validComments}, invalid=${stats.invalidComments}, duration=${stats.durationMs}ms`);
    if (stats.errors.length > 0) {
        log('DEBUG', `parseFeeds3Comments validation errors: ${stats.errors.slice(0, 5).join('; ')}${stats.errors.length > 5 ? '...' : ''}`);
    }
    return result;
}
function parseFeeds3CommentsLegacyInferTid(processedText, startTime) {
    const result = new Map();
    const tidRefs = collectT1TidRefs(processedText);
    let feeds3Seq = 0;
    const rootCommentPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="commentroot"[^>]*>/gi;
    let rootMatch;
    while((rootMatch = rootCommentPat.exec(processedText)) !== null){
        const openTag = rootMatch[0];
        const openEnd = rootMatch.index + openTag.length;
        const closeEnd = findMatchingClosingCommentsItemLi(processedText, openEnd);
        if (closeEnd < 0) continue;
        const fullBlock = processedText.slice(rootMatch.index, closeEnd);
        const body = processedText.slice(openEnd, closeEnd - 6);
        const rootTid = openTag.match(/data-tid="([^"]*)"/)?.[1] ?? '';
        const rootUin = openTag.match(/data-uin="([^"]*)"/)?.[1] ?? '';
        const rootNick = openTag.match(/data-nick="([^"]*)"/)?.[1] ?? '';
        if (!rootTid) continue;
        let postTid = firstT1TidIn(fullBlock);
        if (!postTid && tidRefs.length) {
            const prevTids = tidRefs.filter((r)=>r.index < rootMatch.index);
            if (prevTids.length > 0) postTid = prevTids[prevTids.length - 1].postTid;
        }
        if (!postTid) continue;
        if (!commentBlockMatchesPost(fullBlock, postTid)) continue;
        const { content: rootContent, pic: rootPic } = extractCommentContentAndImages(body, false);
        const rootTime = parseCommentTime(body, fullBlock);
        const rootComment = {
            commentid: rootTid,
            uin: rootUin,
            name: rootNick,
            content: rootContent,
            createtime: rootTime,
            is_reply: false,
            _source: 'feeds3_html',
            _feeds3_seq: feeds3Seq++
        };
        if (rootPic.length > 0) rootComment['pic'] = rootPic;
        if (!result.has(postTid)) result.set(postTid, []);
        result.get(postTid).push(rootComment);
        const subCommentsPat = /<div[^>]*class="[^"]*mod-comments-sub[^"]*"[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>[\s\S]*?<\/div>/gi;
        subCommentsPat.lastIndex = 0;
        let subBlockMatch;
        while((subBlockMatch = subCommentsPat.exec(fullBlock)) !== null){
            const subUl = subBlockMatch[1];
            const replyPat = /<li\s+class="comments-item[^"]*"[^>]*data-type="replyroot"[^>]*>/gi;
            replyPat.lastIndex = 0;
            let replyMatch;
            while((replyMatch = replyPat.exec(subUl)) !== null){
                const replyOpenTag = replyMatch[0];
                const replyOpenEnd = replyMatch.index + replyOpenTag.length;
                const replyCloseEnd = findMatchingClosingCommentsItemLi(subUl, replyOpenEnd);
                if (replyCloseEnd < 0) continue;
                const replyBody = subUl.slice(replyOpenEnd, replyCloseEnd - 6);
                const replyTid = replyOpenTag.match(/data-tid="([^"]*)"/)?.[1] ?? '';
                const replyUin = replyOpenTag.match(/data-uin="([^"]*)"/)?.[1] ?? '';
                const replyNick = replyOpenTag.match(/data-nick="([^"]*)"/)?.[1] ?? '';
                if (!replyTid) continue;
                const t2Uin = replyBody.match(/t2_uin=(\d+)/i)?.[1] ?? '';
                const t2Tid = replyBody.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? '';
                const replyToNickname = extractReplyToNickname(replyBody);
                const { content: replyContent, pic: replyPic } = extractCommentContentAndImages(replyBody, true);
                const replyTime = parseCommentTime(replyBody, fullBlock);
                const finalReplyId = t2Tid ? `${rootTid}_r_${replyTid}_${replyUin}` : `${rootTid}_${replyTid}_${replyUin}`;
                const replyComment = {
                    commentid: finalReplyId,
                    uin: replyUin,
                    name: replyNick,
                    content: replyContent,
                    createtime: replyTime,
                    is_reply: true,
                    parent_comment_id: rootTid,
                    _source: 'feeds3_html',
                    _feeds3_seq: feeds3Seq++
                };
                if (t2Uin) replyComment['reply_to_uin'] = t2Uin;
                if (replyToNickname) replyComment['reply_to_nickname'] = replyToNickname;
                if (t2Tid) replyComment['reply_to_comment_id'] = t2Tid;
                if (replyPic.length > 0) replyComment['pic'] = replyPic;
                result.get(postTid).push(replyComment);
            }
        }
    }
    const legacyCommentPat = /<li\s+class="comments-item[^"]*"([^>]*)>/g;
    let legacyMatch;
    const seenCommentIds = new Set();
    for (const comments of result.values()){
        for (const c of comments){
            seenCommentIds.add(c['commentid']);
        }
    }
    while((legacyMatch = legacyCommentPat.exec(processedText)) !== null){
        const attrs = legacyMatch[1];
        if (attrs.includes('data-type="commentroot"') || attrs.includes('data-type="replyroot"')) {
            continue;
        }
        const openEnd = legacyMatch.index + legacyMatch[0].length;
        const closeEnd = findMatchingClosingCommentsItemLi(processedText, openEnd);
        if (closeEnd < 0) continue;
        const body = processedText.slice(openEnd, closeEnd - 6);
        const commentId = attrs.match(/data-tid="([^"]*)"/)?.[1] ?? '';
        const uin = attrs.match(/data-uin="([^"]*)"/)?.[1] ?? '';
        const nick = attrs.match(/data-nick="([^"]*)"/)?.[1] ?? '';
        if (!commentId || seenCommentIds.has(commentId)) continue;
        seenCommentIds.add(commentId);
        let postTid = firstT1TidIn(body);
        if (!postTid && tidRefs.length) {
            const next = tidRefs.find((r)=>r.index >= closeEnd);
            if (next) postTid = next.postTid;
            else postTid = tidRefs[tidRefs.length - 1].postTid;
        }
        if (!postTid) continue;
        const isReply = body.includes('回复');
        const { content, pic: legacyPic } = extractCommentContentAndImages(body, isReply);
        const createdTime = parseCommentTime(body, processedText.slice(Math.max(0, legacyMatch.index - 2000), Math.min(processedText.length, closeEnd + 500)));
        const t2Uin = body.match(/t2_uin=(\d+)/i)?.[1] ?? '';
        const t2Tid = body.match(/t2_tid=([^&"\s]+)/i)?.[1] ?? '';
        const replyToNickname = isReply ? extractReplyToNickname(body) : null;
        const comment = {
            commentid: commentId,
            uin,
            name: nick,
            content,
            createtime: createdTime,
            is_reply: isReply,
            _source: 'feeds3_html',
            _feeds3_seq: feeds3Seq++
        };
        if (legacyPic.length > 0) comment['pic'] = legacyPic;
        if (isReply) {
            if (t2Uin) comment['reply_to_uin'] = t2Uin;
            if (replyToNickname) comment['reply_to_nickname'] = replyToNickname;
            if (t2Tid) comment['reply_to_comment_id'] = t2Tid;
        }
        if (!result.has(postTid)) result.set(postTid, []);
        result.get(postTid).push(comment);
    }
    return finalizeParseFeeds3CommentsResult(result, startTime);
}
export function parseFeeds3Comments(text) {
    const startTime = Date.now();
    const { text: processedText } = preprocessHtml(text);
    const scoped = parseFeeds3CommentsScoped(processedText);
    if (scoped.size > 0) {
        return finalizeParseFeeds3CommentsResult(scoped, startTime);
    }
    return parseFeeds3CommentsLegacyInferTid(processedText, startTime);
}
