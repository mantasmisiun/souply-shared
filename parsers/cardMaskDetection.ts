/**
 * Bank-card + loyalty-card MASK DETECTION.
 *
 * Given OCR lines (each carrying its y-band + x-bounds from MLKit), find
 * the spots that expose a PAYMENT-CARD or LOYALTY-CARD number and return
 * the redaction boxes that must be burned into the receipt image before
 * it leaves the device — and the lines whose number must be stripped
 * from the stored parsed text.
 *
 * Core rule (learned from real receipts):
 *   A real card / loyalty number is ALWAYS printed star-masked
 *   (`454792******1937`, `************1937`, `944000*********5645`),
 *   per PCI. So we mask ONLY lines that contain a starred number — and
 *   only the number's horizontal span, never the whole line. This:
 *     - hides the sensitive PAN (incl. the leading BIN digits),
 *     - KEEPS the label ("bankinė kortelė" / "AČIŪ kortelė") visible,
 *     - never touches bare digit runs (VMI barcode, Inv. Nr., RRN,
 *       terminal id) or amount lines ("Atsiskaitymo suma 2,24",
 *       "Su AČIŪ kortele sutaupėte -2,24"), which are not card numbers.
 *
 * The actual digits NEVER appear in the output (`text` is pre-redacted),
 * so the dev trace + detail overlay + any log are safe to show.
 *
 * Chain-agnostic: one universal pass covers Maxima/Rimi/Iki/Norfa/Lidl.
 * Migration-independent: consumes OCR lines, produces geometry.
 */

export interface MaskLineInput {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export type MaskBandKind = 'bank' | 'loyalty' | 'cashier';

export interface MaskBand {
    /** Top of the redaction box (parser y-space, padded). */
    yTop: number;
    /** Bottom of the redaction box (parser y-space, padded). */
    yBottom: number;
    /** Left edge of the box — starts at the number, so the label to its
     *  left stays readable. Pixel x-space of the page the line is on. */
    xLeft: number;
    /** Right edge — the line's right edge (covers the number fully even
     *  if char→x estimation drifts). */
    xRight: number;
    /** What the box hides — drives the legend + colour. */
    kind: MaskBandKind;
    /** Short human label for the dev overlay (`BANKAS` / `LOJALUMO`). */
    label: string;
    /** Why it fired (bank/loyalty label on the line, or carried context). */
    reasons: string[];
    /** Pre-REDACTED text: the visible label with the number replaced by a
     *  placeholder. Safe to log / store — the digits are gone. */
    text: string;
}

// ── text folding ────────────────────────────────────────────────────
// Lower-case + strip Lithuanian diacritics so ASCII patterns match.
const LT_FOLD: Record<string, string> = {
    ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z',
};
const fold = (s: string): string =>
    s.toLowerCase().replace(/[ąčęėįšųūž]/g, (c) => LT_FOLD[c] ?? c);

// ── markers ─────────────────────────────────────────────────────────
// A STAR-MASKED number: ≥4 masking glyphs (`* x X • ·`), spaces allowed
// between them. The defining signature of a real PAN / loyalty number.
// (4-run minimum avoids matching a stray `**` footnote marker.)
const MASK_RUN = /(?:[*xX•·]\s?){4,}/;
// Chars that can belong to the number token around the mask run — leading
// BIN digits + grouped last-four, spaces between groups. NO letters (so
// the label to the left is excluded) and NO comma (so a trailing amount
// like "1937 2,24" doesn't pull the label boundary).
const NUM_CHAR = /[\dxX*•· ]/;

// Bank / payment LABELS that, when on the masked-number line OR seen just
// above as context, classify the number as a payment card.
const BANK_CTX = /mokejim|bankin|\bbanko\b|kortel\w*\s*(nr|numer)|\b(visa|mastercard|master\s?card|maestro|v\s?pay|vpay|amex|american\s?express|debit|credit)\b|atsiskaitym|bekontakt|\b(aid|arn|rrn)\b|a0000000\d|terminal/;
// Loyalty LABELS — the loyalty programmes of the five chains.
const LOYALTY_CTX = /lojalum|mano\s+rimi|lidl\s*plus|mano\s+iki|\bikiuk|aciu\w*\s+(kortel|nuolaid)/;
// Cashier line: `Kasininkas` / `Kasininkė` + the name/id after it (PII).
// Captures the label + separators so the VALUE start is the match end.
const CASHIER_LABEL = /kasinink\w*\s*(nr\.?|nr)?\s*[:.\-–]?\s*/;

/** How many lines a context label reaches forward to a bare number. */
const CONTEXT_REACH = 6;

/**
 * Detect bank-card + loyalty-card redaction boxes in a receipt's OCR
 * lines. `chain` is accepted for future per-chain tuning; current pass
 * is universal. Returns boxes sorted top→bottom.
 */
export function detectCardMaskBands(
    lines: MaskLineInput[],
    _chain?: string | null,
): MaskBand[] {
    if (!lines || lines.length === 0) return [];

    const heights = lines
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 20;
    const padY = Math.max(2, medianH * 0.2);

    const bands: MaskBand[] = [];
    // Carry the most recent payment/loyalty label forward so a bare
    // masked number (`************1937` on its own line) inherits a kind.
    let ctxKind: MaskBandKind | null = null;
    let ctxAtIdx = -Infinity;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const f = fold(line.text);

        const isLoyaltyLabel = LOYALTY_CTX.test(f);
        const isBankLabel = BANK_CTX.test(f);
        // Update context from any label on this line (whether or not the
        // line itself carries a number — labels alone are NOT masked).
        if (isBankLabel) { ctxKind = 'bank'; ctxAtIdx = i; }
        else if (isLoyaltyLabel) { ctxKind = 'loyalty'; ctxAtIdx = i; }

        // Decide what (if anything) on this line is sensitive, and where
        // its VALUE starts (chars before it = visible label, never masked).
        let valueStart: number;
        let kind: MaskBandKind;
        let reason: string;

        const m = MASK_RUN.exec(line.text);
        const km = CASHIER_LABEL.exec(f);
        // A star-run only counts as a real PAN / loyalty number if the
        // line ALSO has a visible digit (last-4 / BIN). A line of pure
        // mask glyphs is a SECTION SEPARATOR (`************`, `* * ★ ★`),
        // not a number — and has nothing sensitive to hide anyway.
        if (m && /\d/.test(line.text)) {
            // Star-masked PAN / loyalty number. Expand left over the
            // leading BIN digits + group spaces so the box covers it all.
            let numStart = m.index;
            while (numStart > 0 && NUM_CHAR.test(line.text[numStart - 1])) numStart--;
            while (numStart < m.index && line.text[numStart] === ' ') numStart++;
            valueStart = numStart;
            // A label on this very line wins; else carried context; else
            // default to bank (a stray masked PAN is almost always a card).
            if (isLoyaltyLabel) { kind = 'loyalty'; reason = 'loyalty-label'; }
            else if (isBankLabel) { kind = 'bank'; reason = 'bank-label'; }
            else if (ctxKind && i - ctxAtIdx <= CONTEXT_REACH) { kind = ctxKind; reason = `ctx-${ctxKind}`; }
            else { kind = 'bank'; reason = 'masked-number'; }
        } else if (km && km.index + km[0].length < line.text.length) {
            // Cashier name / id (PII) — mask everything after the label.
            valueStart = km.index + km[0].length;
            kind = 'cashier';
            reason = 'kasininkas';
        } else {
            // Bare digit runs (barcode / Inv. Nr. / RRN), labels, amounts —
            // not sensitive. Left untouched.
            continue;
        }

        // Map the value's char-start to an x-position within the line's
        // box, nudge left, and run the box to the line's right edge
        // (robust against char→x estimation drift).
        const len = Math.max(1, line.text.length);
        const span = Math.max(1, line.xRight - line.xLeft);
        const padX = span * 0.04 + 8;
        const valXLeft = line.xLeft + (valueStart / len) * span;
        const boxLeft = Math.max(line.xLeft, valXLeft - padX);
        const boxRight = line.xRight + span * 0.02;

        // REDACT the value out of the display/stored text up front.
        const labelPart = line.text.slice(0, valueStart).trim();
        const redacted = labelPart ? `${labelPart} [•••]` : '[•••]';

        bands.push({
            yTop: line.yTop - padY,
            yBottom: line.yBottom + padY,
            xLeft: boxLeft,
            xRight: boxRight,
            kind,
            label: kind === 'bank' ? 'BANKAS' : kind === 'loyalty' ? 'LOJALUMO' : 'KASININKAS',
            reasons: [reason],
            text: redacted,
        });
    }

    bands.sort((a, b) => a.yTop - b.yTop);
    // Merge same-kind boxes whose y-ranges overlap: OCR sometimes splits
    // one printed row (e.g. "Lojalumo kortelė ****1234") into two
    // line-boxes → two near-identical detections. Union them into one.
    const merged: MaskBand[] = [];
    for (const b of bands) {
        const last = merged[merged.length - 1];
        if (last && last.kind === b.kind && b.yTop <= last.yBottom) {
            last.yTop = Math.min(last.yTop, b.yTop);
            last.yBottom = Math.max(last.yBottom, b.yBottom);
            last.xLeft = Math.min(last.xLeft, b.xLeft);
            last.xRight = Math.max(last.xRight, b.xRight);
            for (const r of b.reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
        } else {
            merged.push(b);
        }
    }
    return merged;
}

/**
 * Text-level redaction for the STORED parsedData (rawText fields + product
 * rawLines). Mirrors detectCardMaskBands but operates on text, line by line,
 * so the DB never holds a card / loyalty number or cashier name. Each
 * `rawText` is `\n`-joined OCR lines, so splitting on `\n` matches the bands.
 *
 *   - card / loyalty number  → keep the label, blank the number
 *   - `Kasininkas <name>`    → keep the label, blank the value
 *   - pure-asterisk separators / digitless lines → untouched
 */
export function redactReceiptText(text: string | null | undefined): string {
    if (!text) return text ?? '';
    return text
        .split('\n')
        .map((line) => {
            const f = fold(line);
            // Cashier line → keep label, blank the name/id.
            const km = CASHIER_LABEL.exec(f);
            if (km && km.index + km[0].length < line.length) {
                return `${line.slice(0, km.index + km[0].length)}[•••]`;
            }
            // Card / loyalty number: a ≥4 star-run on a line that has a digit.
            if (MASK_RUN.test(line) && /\d/.test(line)) {
                const m = MASK_RUN.exec(line)!;
                let numStart = m.index;
                while (numStart > 0 && NUM_CHAR.test(line[numStart - 1])) numStart--;
                while (numStart < m.index && line[numStart] === ' ') numStart++;
                const label = line.slice(0, numStart).trimEnd();
                return label ? `${label} [•••]` : '[•••]';
            }
            return line;
        })
        .join('\n');
}

/** Copy-paste-friendly trace of detected mask boxes for the dev batch log.
 *  Never contains card digits — `band.text` is pre-redacted. */
export function traceCardMaskBands(bands: MaskBand[]): string {
    if (bands.length === 0) return '(no card/loyalty numbers detected)';
    return bands
        .map(
            (b, i) =>
                `#${i + 1} [${b.label}] y ${Math.round(b.yTop)}–${Math.round(b.yBottom)} ` +
                `x ${Math.round(b.xLeft)}–${Math.round(b.xRight)}  via:${b.reasons.join(',')}\n` +
                `     “${b.text}”`,
        )
        .join('\n');
}
