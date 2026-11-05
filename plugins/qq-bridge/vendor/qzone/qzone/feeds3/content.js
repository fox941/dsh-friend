// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
import { processEmojis } from '../emoji.js';
export function extractEmojisFromHtml(html) {
    return html.replace(/<img[^>]+src=["'][^"']*\/qzone\/em\/(e\d+)\.[^"']*["'][^>]*>/gi, (_, code)=>{
        return `[em]${code}[/em]`;
    });
}
export function stripHtmlTags(html) {
    const withEmojis = extractEmojisFromHtml(html);
    return withEmojis.replace(/<[^>]+>/g, '');
}
export function extractFeedContentFromHtml(html) {
    const withEmoji = extractEmojisFromHtml(html);
    const noTags = withEmoji.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\\[trn]/g, '').replace(/[\t\r\n]+/g, ' ').trim();
    return processEmojis(noTags, {
        mode: 'name'
    });
}
