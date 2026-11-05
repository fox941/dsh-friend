// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
import { log, htmlUnescape, parseJsonp } from '../utils.js';
import { processEmojis, parseEmojis } from '../emoji.js';
export function parseMentions(content, options = {
    processEmojis: true
}) {
    const mentions = [];
    const mentionPattern = /@\{uin:(\d+),nick:([^,]+),who:(\d+),auto:(\d+)\}/g;
    let match;
    while((match = mentionPattern.exec(content)) !== null){
        mentions.push({
            uin: match[1],
            nick: match[2],
            who: parseInt(match[3], 10),
            auto: parseInt(match[4], 10)
        });
    }
    let text = content.replace(mentionPattern, '').trim();
    if (options.processEmojis) {
        text = processEmojis(text, {
            mode: 'name'
        });
    }
    return {
        text,
        mentions
    };
}
export function extractVideos(raw) {
    const videos = [];
    const videoList = raw['video'];
    if (!Array.isArray(videoList)) return videos;
    for (const v of videoList){
        if (!v['video_id']) continue;
        videos.push({
            videoId: String(v['video_id']),
            coverUrl: String(v['pic_url'] || ''),
            thumbnailUrl: v['url1'],
            videoUrl: v['url3'],
            duration: parseInt(String(v['video_time'] || '0'), 10),
            width: parseInt(String(v['cover_width'] || '0'), 10),
            height: parseInt(String(v['cover_height'] || '0'), 10)
        });
    }
    return videos;
}
export function parseReplyComments(list3, parentCommentId) {
    const replies = [];
    for (const item of list3){
        const rawContent = String(item['content'] || '');
        const { text: content, mentions } = parseMentions(rawContent);
        const { emojis } = parseEmojis(rawContent);
        const replyToMention = mentions.length > 0 ? mentions[0] : undefined;
        const reply = {
            commentid: `${parentCommentId}_r_${item['tid']}`,
            uin: String(item['uin'] || ''),
            name: String(item['name'] || ''),
            content,
            createtime: parseInt(String(item['create_time'] || '0'), 10),
            mentions,
            reply_to_mention: replyToMention,
            _source: 'reply_list',
            ...emojis.length > 0 && {
                emojis
            }
        };
        replies.push(reply);
    }
    return replies;
}
export function parseEnhancedComment(raw) {
    const rawContent = String(raw['content'] || '');
    const { text: content, mentions } = parseMentions(rawContent);
    const { emojis } = parseEmojis(rawContent);
    const comment = {
        commentid: String(raw['tid'] || ''),
        uin: String(raw['uin'] || ''),
        name: String(raw['name'] || ''),
        content,
        createtime: parseInt(String(raw['create_time'] || '0'), 10),
        createTime: String(raw['createTime'] || ''),
        createTime2: String(raw['createTime2'] || ''),
        reply_num: parseInt(String(raw['reply_num'] || '0'), 10),
        mentions: mentions.length > 0 ? mentions : undefined,
        source_name: raw['source_name'],
        source_url: raw['source_url'],
        t2_source: raw['t2_source'],
        t2_subtype: raw['t2_subtype'],
        t2_termtype: raw['t2_termtype'],
        abledel: raw['abledel'],
        private: raw['private'],
        _source: 'h5_json',
        emojis: emojis.length > 0 ? emojis : undefined
    };
    const list3 = raw['list_3'];
    if (Array.isArray(list3) && list3.length > 0) {
        comment.replies = parseReplyComments(list3, comment.commentid);
    }
    return comment;
}
export function extractDeviceInfo(raw) {
    const name = raw['source_name'];
    if (!name) return undefined;
    return {
        name,
        url: raw['source_url'],
        termtype: raw['t1_termtype']
    };
}
export function extractFriendsFromFeeds3FromText(text, selfUin) {
    const byUin = new Map();
    const opuinRe = /\bopuin:'(\d+)'/g;
    let m;
    while((m = opuinRe.exec(text)) !== null){
        const opuin = m[1];
        if (opuin === '0') continue;
        const start = m.index;
        const nextOpuin = text.indexOf("opuin:'", start + 1);
        const end = nextOpuin >= 0 ? nextOpuin : text.length;
        const block = text.slice(start, end);
        const uinM = block.match(/\buin:'(\d+)'/);
        const uin = uinM ? uinM[1] : opuin;
        const nickM = block.match(/\bnickname:'((?:[^'\\]|\\.)*)'/);
        const nickname = nickM ? nickM[1].replace(/\\'/g, "'") : '';
        const logM = block.match(/\blogimg:'((?:[^'\\]|\\.)*)'/);
        const avatar = logM ? logM[1].replace(/\\'/g, "'") : '';
        if (!byUin.has(uin)) {
            byUin.set(uin, {
                uin,
                nickname,
                avatar
            });
        } else {
            const cur = byUin.get(uin);
            if (nickname) cur.nickname = nickname;
            if (avatar) cur.avatar = avatar;
        }
    }
    const fNickRe = /<div\s+class="f-nick"[^>]*>[\s\S]*?<a[^>]+href="[^"]*\/(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while((m = fNickRe.exec(text)) !== null){
        const uin = m[1];
        let nickname = (m[2] ?? '').replace(/<[^>]+>/g, '').trim();
        nickname = htmlUnescape(nickname);
        if (!uin || uin === '0') continue;
        if (!byUin.has(uin)) {
            byUin.set(uin, {
                uin,
                nickname,
                avatar: ''
            });
        } else {
            const cur = byUin.get(uin);
            if (nickname && !cur.nickname) cur.nickname = nickname;
        }
    }
    const list = Array.from(byUin.values()).filter((f)=>f.uin !== selfUin);
    log('DEBUG', `extractFriendsFromFeeds3FromText: ${list.length} friends (excluded self ${selfUin})`);
    return list;
}
export function extractExternparam(text) {
    try {
        const o = text.trim().startsWith('{') ? JSON.parse(text) : parseJsonp(text);
        const data = o?.data;
        const main = data?.main;
        const v = main?.externparam ?? data?.externparam ?? o?.externparam;
        if (typeof v === 'string' && v.length > 0) return v;
    } catch  {}
    const m = text.match(/externparam:'([^']+)'/);
    if (m) return m[1];
    const m2 = text.match(/"externparam"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m2) return m2[1].replace(/\\"/g, '"');
    return '';
}
