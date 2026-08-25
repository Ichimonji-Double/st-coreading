// Note-density presets — control how many notes the character leaves per chunk.
// Used by both the unified prompt (context/unified.js) and the notes-only
// prompt (notes/generator.js) so behavior stays consistent.

export const DENSITY_LEVELS = ['sparse', 'medium', 'dense'];
export const DEFAULT_DENSITY = 'medium';

export function densityGuidance(density, maxIdx, isChinese) {
    const max = Math.max(0, maxIdx);
    if (isChinese) {
        switch (density) {
            case 'sparse':
                return `从 [0]-[${max}] 里挑 0-1 段。只有真的让你停下来想一下、想跟朋友分享的段落才写。多数段落应该留空——不要为了写而写。`;
            case 'dense':
                return `从 [0]-[${max}] 里挑 1-3 段。只要有觉得有意思、有趣、有共鸣的地方就随手记一下，不用太克制。每段 1-2 句你真实的反应。`;
            case 'medium':
            default:
                return `从 [0]-[${max}] 里挑 0-2 段（宁缺毋滥，别硬凑）。有触动就写 1-2 句，什么都没触动到就留空。`;
        }
    }
    switch (density) {
        case 'sparse':
            return `Pick 0-1 paragraph from [0]-[${max}]. Only note something if it truly made you pause or want to share it with a friend. Most passages should get nothing — don't write just to write.`;
        case 'dense':
            return `Pick 1-3 paragraphs from [0]-[${max}]. If anything strikes you as interesting, funny, or resonant, jot down 1-2 sentences of reaction. Be generous, not restrained.`;
        case 'medium':
        default:
            return `Pick 0-2 paragraphs from [0]-[${max}] (be selective, don't force it). Write 1-2 sentences per pick if something struck you; leave empty if nothing did.`;
    }
}
