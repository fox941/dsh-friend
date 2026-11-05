// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
export function dataAttrFromFeedData(attrs, name) {
    const m = attrs.match(new RegExp(`data-${name}="([^"]*)"`));
    return m?.[1] ?? '';
}
export function canonicalPostTidFromFeedAttrs(attrs, searchBefore, searchAfterHead) {
    let tid = dataAttrFromFeedData(attrs, 'tid') || dataAttrFromFeedData(attrs, 'origtid');
    if (!tid || tid === 'advertisement_app') return '';
    if (/^\d+$/.test(tid)) {
        const fkey = dataAttrFromFeedData(attrs, 'fkey');
        if (fkey) return fkey;
        const combined = `${searchBefore} ${attrs} ${searchAfterHead}`;
        let keyMatch = combined.match(/data-key="([a-z0-9]{6,})"/i);
        if (!keyMatch) keyMatch = combined.match(/key:\s*['"]([a-z0-9]{6,})['"]/i);
        if (keyMatch) return keyMatch[1];
    }
    return tid;
}
