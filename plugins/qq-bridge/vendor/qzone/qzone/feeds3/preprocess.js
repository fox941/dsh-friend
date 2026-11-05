// Source: Gu-Heping/onebot-qzone e2c6da0ffea8937adac690352647bb023c312759; MIT; mechanically stripped TypeScript.
import { log } from '../utils.js';
export function preprocessHtml(text) {
    const startTime = Date.now();
    const originalLength = text.length;
    let replacements = 0;
    let processed = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    processed = processed.replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    replacements += (text.match(/&amp;|&lt;|&gt;|&nbsp;|\u00a0/gi) || []).length;
    processed = processed.replace(/>\s+</g, '><');
    processed = processed.replace(new RegExp('\\\\\\\\/', 'g'), '/').replace(new RegExp('\\\\x27', 'g'), "'");
    const duration = Date.now() - startTime;
    log('DEBUG', `preprocessHtml: ${originalLength} -> ${processed.length} chars, ${replacements} replacements, ${duration}ms`);
    return {
        text: processed,
        stats: {
            originalLength,
            processedLength: processed.length,
            replacements
        }
    };
}
