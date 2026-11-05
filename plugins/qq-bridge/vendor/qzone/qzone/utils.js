// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
export function calcGtk(val) {
    let hsh = 5381;
    for(let i = 0; i < val.length; i++){
        hsh += (hsh << 5) + val.charCodeAt(i);
    }
    return hsh & 0x7fffffff;
}
export function parseJsonp(text, _callback) {
    const s = text.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
        try {
            return JSON.parse(s);
        } catch  {}
    }
    const fcbIdx = s.indexOf('frameElement.callback(');
    if (fcbIdx !== -1) {
        const start = fcbIdx + 'frameElement.callback('.length;
        const inner = extractBracketContent(s, start - 1);
        if (inner !== null) {
            try {
                return JSON.parse(inner);
            } catch  {}
        }
    }
    const open = s.indexOf('(');
    if (open !== -1) {
        const inner = extractBracketContent(s, open);
        if (inner !== null) {
            try {
                return JSON.parse(inner);
            } catch  {}
        }
    }
    try {
        return JSON.parse(s);
    } catch  {
        return {
            _empty: true,
            raw: s.slice(0, 500)
        };
    }
}
function extractBracketContent(s, openIdx) {
    let depth = 0;
    for(let i = openIdx; i < s.length; i++){
        if (s[i] === '(') depth++;
        else if (s[i] === ')') {
            depth--;
            if (depth === 0) return s.slice(openIdx + 1, i);
        }
    }
    return null;
}
export function safeDecodeJsonResponse(body, jsonpCallback) {
    let text;
    if (Buffer.isBuffer(body)) {
        text = body.toString('utf8');
        if (text.includes('参数错误') || text.includes('\ufffd')) {
            const latin = body.toString('latin1');
            if (!latin.includes('\ufffd')) text = latin;
        }
    } else {
        text = body;
    }
    if (!text.trim()) {
        return {
            _empty: true,
            http_status: 200
        };
    }
    const parsed = parseJsonp(text, jsonpCallback);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
    }
    return {
        _empty: true,
        raw: text.slice(0, 200)
    };
}
export function log(level, msg) {
    // AI Friend adaptation: parsing never copies private post snippets to service logs.
    void level; void msg;
}
export function quotePlus(s) {
    return encodeURIComponent(s).replace(/%20/g, '+');
}
export function unescapeXHex(s) {
    return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h)=>String.fromCharCode(parseInt(h, 16)));
}
export function htmlUnescape(s) {
    return s.replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n)=>String.fromCharCode(parseInt(n, 10))).replace(/&#x([0-9a-fA-F]+);/g, (_, h)=>String.fromCharCode(parseInt(h, 16)));
}
