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
    // Optional per-corner Y (skew) from MLKit cornerPoints, so the redaction box
    // can follow a tilted receipt. Absent → treated as the axis-aligned rect.
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
    // Per-word boxes (MLKit elements). When present, the redaction box is anchored
    // to the actual masked WORDS (real x + per-word Y) instead of a char→x guess.
    words?: { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number }[];
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
    /** Per-corner Y (skew), padded — so the box can be drawn/burned as a
     *  parallelogram that follows the receipt tilt. Absent → axis-aligned. */
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
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
// Loyalty card number printed in FULL (not PCI star-masked) — e.g. IKI's
// "IKI KORTELĖS NR. 99110000000005068582". The label is a loyalty-card "NR".
const LOYALTY_NUMBER_LABEL = /kortel\w*\s*nr/;
// A long bare digit run (the full loyalty number; spaces allowed between groups).
const LONG_DIGIT_RUN = /\d[\d ]{8,}\d/;

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
        } else if (LOYALTY_NUMBER_LABEL.test(f) && LONG_DIGIT_RUN.test(line.text)) {
            // Loyalty card number printed in full (not star-masked) — mask the
            // long digit run; the "… KORTELĖS NR." label stays visible.
            const dm = line.text.match(LONG_DIGIT_RUN);
            if (!dm || dm.index == null) continue;
            valueStart = dm.index;
            kind = 'loyalty';
            reason = 'loyalty-number';
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

        // REDACT the value out of the display/stored text up front.
        const labelPart = line.text.slice(0, valueStart).trim();
        const redacted = labelPart ? `${labelPart} [•••]` : '[•••]';

        // Per-line tilt from the line's OWN OCR corner Y (the smoothed per-line
        // slope). The box bends with it on BOTH branches, so even a SINGLE-word PAN
        // redaction follows the receipt curve (a single word's box is otherwise
        // flat). FLAT row → slope 0 → rectangle; never a borrowed global tilt.
        const lineW = Math.max(1, line.xRight - line.xLeft);
        const lt = line.yLeftTop ?? line.yTop, rt = line.yRightTop ?? line.yTop;
        const lb = line.yLeftBottom ?? line.yBottom, rb = line.yRightBottom ?? line.yBottom;
        const slopeT = (rt - lt) / lineW;
        const slopeB = (rb - lb) / lineW;

        // WORD-ANCHORED box: real x-span from the masked words; Y anchored at those
        // words' own top/bottom and TILTED by the line slope so it bends. Pad keeps
        // it over-covering so the PAN is never exposed. Char→x + line edges when no
        // words are present.
        let boxLeft: number, boxRight: number, anchorX: number, anchorTop: number, anchorBot: number;
        const valueWords = (line.words ?? [])
            .filter((w) => (w.xLeft + w.xRight) / 2 >= valXLeft - padX)
            .sort((a, b) => a.xLeft - b.xLeft);
        if (valueWords.length > 0) {
            const L = valueWords[0], R = valueWords[valueWords.length - 1];
            boxLeft = Math.max(line.xLeft, L.xLeft - padX);
            boxRight = R.xRight + padX;
            anchorX = L.xLeft;
            anchorTop = Math.min(L.yTop, R.yTop);   // highest top of the value words
            anchorBot = Math.max(L.yBottom, R.yBottom); // lowest bottom → over-covers all
        } else {
            boxLeft = Math.max(line.xLeft, valXLeft - padX);
            boxRight = line.xRight + span * 0.02;
            anchorX = line.xLeft;
            anchorTop = lt;
            anchorBot = lb;
        }
        const topAt = (x: number) => anchorTop + slopeT * (x - anchorX) - padY;
        const botAt = (x: number) => anchorBot + slopeB * (x - anchorX) + padY;
        const yLT = topAt(boxLeft), yRT = topAt(boxRight);
        const yLB = botAt(boxLeft), yRB = botAt(boxRight);
        bands.push({
            yTop: Math.min(yLT, yRT),
            yBottom: Math.max(yLB, yRB),
            xLeft: boxLeft,
            xRight: boxRight,
            kind,
            label: kind === 'bank' ? 'BANKAS' : kind === 'loyalty' ? 'LOJALUMO' : 'KASININKAS',
            reasons: [reason],
            text: redacted,
            yLeftTop: yLT,
            yRightTop: yRT,
            yLeftBottom: yLB,
            yRightBottom: yRB,
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
            // Union the skew corners too (top = highest, bottom = lowest).
            last.yLeftTop = Math.min(last.yLeftTop ?? last.yTop, b.yLeftTop ?? b.yTop);
            last.yRightTop = Math.min(last.yRightTop ?? last.yTop, b.yRightTop ?? b.yTop);
            last.yLeftBottom = Math.max(last.yLeftBottom ?? last.yBottom, b.yLeftBottom ?? b.yBottom);
            last.yRightBottom = Math.max(last.yRightBottom ?? last.yBottom, b.yRightBottom ?? b.yBottom);
            for (const r of b.reasons) if (!last.reasons.includes(r)) last.reasons.push(r);
        } else {
            merged.push(b);
        }
    }
    return merged;
}

/** A recognised data band (product / header / footer line) the mask must not
 *  cover. Same pixel space as the mask bands; optional per-corner Y (skew) so
 *  the clamp can follow a tilted band's edge instead of a flat bound. */
export interface ProtectedRegion {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
}

/** Interpolate a band edge's Y at a given x (x clamped into the band's span). */
const edgeYAt = (xL: number, xR: number, yL: number, yR: number, x: number): number => {
    if (xR <= xL) return (yL + yR) / 2;
    const cx = Math.max(xL, Math.min(xR, x));
    return yL + ((cx - xL) / (xR - xL)) * (yR - yL);
};

/**
 * Trim mask bands so they never cover a recognised data band — the same
 * "no band overlaps another" rule the product/header/footer bands follow.
 * Real receipts stack rows tightly, so a mask's vertical padding (and the odd
 * px of OCR-box overlap) can bleed into the row above/below — e.g. the cashier
 * mask creeping up over the "Kvito Nr." (receipt number) band.
 *
 * TILT-AWARE: each mask corner is pushed only as far as the protected band's
 * actual (interpolated) edge AT THAT CORNER'S X, not the band's flat min/max.
 * On a skewed receipt that means the mask top nests parallel to the protected
 * band's bottom edge — so we don't over-push the mask down (which would reveal
 * the top of the PII below). Never past the mask's own mid-line, so the PII the
 * mask exists to hide always stays covered. Masks only constrain against
 * protected bands they actually overlap horizontally.
 */
export function clampMaskBandsToProtected(
    bands: MaskBand[],
    protectedRegions: ProtectedRegion[],
): MaskBand[] {
    if (!bands.length || !protectedRegions.length) return bands;
    return bands.map((b) => {
        const mid = (b.yTop + b.yBottom) / 2;
        let yLeftTop = b.yLeftTop ?? b.yTop;
        let yRightTop = b.yRightTop ?? b.yTop;
        let yLeftBottom = b.yLeftBottom ?? b.yBottom;
        let yRightBottom = b.yRightBottom ?? b.yBottom;
        for (const p of protectedRegions) {
            const xOverlap = !(p.xRight <= b.xLeft || p.xLeft >= b.xRight);
            if (!xOverlap) continue;
            const pCenter = (p.yTop + p.yBottom) / 2;
            if (pCenter <= mid) {
                // protected band above → push the mask's TOP corners down to its
                // bottom edge at each corner's x (capped at the mask mid-line).
                const blY = p.yLeftBottom ?? p.yBottom;
                const brY = p.yRightBottom ?? p.yBottom;
                yLeftTop = Math.min(mid, Math.max(yLeftTop, edgeYAt(p.xLeft, p.xRight, blY, brY, b.xLeft)));
                yRightTop = Math.min(mid, Math.max(yRightTop, edgeYAt(p.xLeft, p.xRight, blY, brY, b.xRight)));
            } else {
                // protected band below → pull the mask's BOTTOM corners up to its
                // top edge at each corner's x (capped at the mask mid-line).
                const tlY = p.yLeftTop ?? p.yTop;
                const trY = p.yRightTop ?? p.yTop;
                yLeftBottom = Math.max(mid, Math.min(yLeftBottom, edgeYAt(p.xLeft, p.xRight, tlY, trY, b.xLeft)));
                yRightBottom = Math.max(mid, Math.min(yRightBottom, edgeYAt(p.xLeft, p.xRight, tlY, trY, b.xRight)));
            }
        }
        return {
            ...b,
            yTop: Math.min(yLeftTop, yRightTop),
            yBottom: Math.max(yLeftBottom, yRightBottom),
            yLeftTop,
            yRightTop,
            yLeftBottom,
            yRightBottom,
        };
    });
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
            // Loyalty card number printed in full (e.g. "IKI KORTELĖS NR. 9911…").
            if (LOYALTY_NUMBER_LABEL.test(f) && LONG_DIGIT_RUN.test(line)) {
                const dm = line.match(LONG_DIGIT_RUN)!;
                const label = line.slice(0, dm.index).trimEnd();
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
