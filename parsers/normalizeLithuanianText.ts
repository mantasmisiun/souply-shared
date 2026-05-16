/**
 * Normalize OCR'd text to the Lithuanian alphabet's character set.
 *
 * Lithuanian uses ONLY these letters (plus ASCII digits/punctuation):
 *   a b c d e f g h i j k l m n o p r s t u v y z
 *   ą č ę ė į š ų ū ž
 *   (uppercase variants of all of these)
 *
 * Anything else on a Lithuanian receipt is an OCR error or a foreign-
 * brand spelling. We map common confusions to their Lithuanian or ASCII
 * counterpart, then NFD-decompose and strip combining marks as a catch-
 * all for the long tail.
 *
 * Platform-agnostic — pure string transformation. Identical results on
 * iOS, Android, Node. Apply after OCR and before parsing so every chain
 * parser sees clean text.
 *
 * Trade-offs:
 *   - Lithuanian diacritics pass through untouched (whitelist preserved).
 *   - `q`, `w`, `x` pass through because they appear in foreign brand
 *     names on real Lithuanian receipts (e.g. "Wax", "ExtraQuality").
 *   - Imported brand names with diacritics (e.g. "Pâté", "Häagen") are
 *     ASCII-fied. Acceptable for this app — catalog matches against
 *     ASCII anyway and these are rare on LT receipts.
 *   - `é` is mapped to `ė`, not `e`, because in OCR'd Lithuanian text
 *     the acute is almost always a misread dot-above. The handful of
 *     genuine French words (`café`) lose precision but match the
 *     Lithuanian token they were meant to be.
 *
 * Map below is intentionally explicit (no clever Unicode tricks) so
 * future additions are obvious. Order within each "family" doesn't
 * matter — keys are unique characters.
 */

const CHAR_MAP: Record<string, string> = {
    // ── a-family (none Lithuanian) ──
    'ā': 'a', 'Ā': 'A',
    'ă': 'a', 'Ă': 'A',
    'â': 'a', 'Â': 'A',
    'à': 'a', 'À': 'A',
    'á': 'a', 'Á': 'A',
    'ã': 'a', 'Ã': 'A',
    'ä': 'a', 'Ä': 'A',
    'å': 'a', 'Å': 'A',
    'ǎ': 'a', 'Ǎ': 'A',
    // Vietnamese stacks — OCR fallback when MLKit confuses receipt fonts
    'ắ': 'a', 'Ắ': 'A',
    'ấ': 'a', 'Ấ': 'A',
    'ẩ': 'a', 'Ẩ': 'A',
    'ẫ': 'a', 'Ẫ': 'A',
    'ằ': 'a', 'Ằ': 'A',
    'ầ': 'a', 'Ầ': 'A',
    'ạ': 'a', 'Ạ': 'A',
    // ą stays — Lithuanian

    // ── c-family ──
    'ć': 'č', 'Ć': 'Č',
    'ĉ': 'č', 'Ĉ': 'Č',
    'ç': 'c', 'Ç': 'C',
    // č stays — Lithuanian

    // ── e-family ──
    // Both ė (Lithuanian) and plain e are valid; OCR usually confuses
    // a dot-above with an acute or grave. Map acute → ė (most common
    // miscount in observed receipts), grave → e (less common as ė).
    'é': 'ė', 'É': 'Ė',
    'è': 'e', 'È': 'E',
    'ê': 'ė', 'Ê': 'Ė',
    'ë': 'ė', 'Ë': 'Ė',
    'ě': 'ė', 'Ě': 'Ė',
    'ē': 'ė', 'Ē': 'Ė',
    // ę, ė stay — Lithuanian

    // ── i-family ──
    'í': 'i', 'Í': 'I',
    'ì': 'i', 'Ì': 'I',
    'î': 'i', 'Î': 'I',
    'ï': 'i', 'Ï': 'I',
    'ī': 'i', 'Ī': 'I',
    'ĩ': 'i', 'Ĩ': 'I',
    'ǐ': 'i', 'Ǐ': 'I',
    'ỉ': 'i', 'Ỉ': 'I',
    // į stays — Lithuanian

    // ── l/n (no diacritic variants in Lithuanian) ──
    'ł': 'l', 'Ł': 'L',
    'ñ': 'n', 'Ñ': 'N',
    'ń': 'n', 'Ń': 'N',
    'ň': 'n', 'Ň': 'N',

    // ── o-family (Lithuanian has plain o only) ──
    'ó': 'o', 'Ó': 'O',
    'ò': 'o', 'Ò': 'O',
    'ô': 'o', 'Ô': 'O',
    'õ': 'o', 'Õ': 'O',
    'ö': 'o', 'Ö': 'O',
    'ø': 'o', 'Ø': 'O',
    'ō': 'o', 'Ō': 'O',
    'ǒ': 'o', 'Ǒ': 'O',

    // ── s-family ──
    'ś': 'š', 'Ś': 'Š',
    'ş': 's', 'Ş': 'S',
    'ŝ': 'š', 'Ŝ': 'Š',
    // š stays — Lithuanian

    // ── u-family (ų, ū are Lithuanian) ──
    'ú': 'u', 'Ú': 'U',
    'ù': 'u', 'Ù': 'U',
    'û': 'u', 'Û': 'U',
    'ü': 'u', 'Ü': 'U',
    'ǔ': 'u', 'Ǔ': 'U',
    'ǖ': 'u', 'Ǖ': 'U',
    'ű': 'u', 'Ű': 'U',
    'ũ': 'u', 'Ũ': 'U',

    // ── y-family ──
    'ý': 'y', 'Ý': 'Y',
    'ÿ': 'y', 'Ÿ': 'Y',

    // ── z-family ──
    'ź': 'ž', 'Ź': 'Ž',
    'ż': 'ž', 'Ż': 'Ž',
    // ž stays — Lithuanian
};

// Letters we keep verbatim (Lithuanian alphabet + ASCII letters that
// appear in brand names on real receipts). Using a Set lookup keeps
// the per-char branch tight; the alternative — regex — is fine too.
const KEEP = new Set<string>([
    'a','b','c','d','e','f','g','h','i','j','k','l',
    'm','n','o','p','q','r','s','t','u','v','w','x','y','z',
    'A','B','C','D','E','F','G','H','I','J','K','L',
    'M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z',
    'ą','č','ę','ė','į','š','ų','ū','ž',
    'Ą','Č','Ę','Ė','Į','Š','Ų','Ū','Ž',
]);

const NON_LETTER_RE = /\p{L}/u;
const COMBINING_MARK_RE = /\p{M}/gu;

/**
 * Apply the Lithuanian normalization pass to a single string.
 * Empty / null-ish inputs pass through unchanged.
 */
export function normalizeLithuanianText(input: string): string {
    if (!input) return input;
    let out = '';
    for (const ch of input) {
        // Direct map hit — fast path for the common confusions.
        const mapped = CHAR_MAP[ch];
        if (mapped !== undefined) {
            out += mapped;
            continue;
        }
        // Letter we keep as-is (Lithuanian + ASCII Latin).
        if (KEEP.has(ch)) {
            out += ch;
            continue;
        }
        // Non-letter (digit / punctuation / whitespace / symbol).
        // Pass through — receipts have plenty of these (€, commas, etc).
        if (!NON_LETTER_RE.test(ch)) {
            out += ch;
            continue;
        }
        // Unknown letter — long-tail catch-all. NFD-decompose to split
        // base + combining marks, then drop the marks. Works for most
        // accented Latin glyphs we haven't mapped explicitly.
        out += ch.normalize('NFD').replace(COMBINING_MARK_RE, '');
    }
    return out;
}
