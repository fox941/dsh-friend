// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
const T1_TID_CAPTURE = /t1_tid=([^&"'<>\s]+)/i;
export function collectT1TidRefs(text) {
    const out = [];
    const re = /t1_tid=([^&"'<>\s]+)/gi;
    let m;
    while((m = re.exec(text)) !== null){
        const v = m[1].trim();
        if (v) out.push({
            index: m.index,
            postTid: v
        });
    }
    return out;
}
export function firstT1TidIn(snippet) {
    const m = snippet.match(T1_TID_CAPTURE);
    return m?.[1]?.trim() ?? '';
}
