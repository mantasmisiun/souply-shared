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
    /** The PII TEXT extent (the masked words' top/bottom), WITHOUT the padding.
     *  The clamp must never trim a mask past these — the card/loyalty number stays
     *  covered even when a recognised band overlaps the same rows. Absent (old stored
     *  receipts) → the clamp falls back to the band's own edges (no trim). */
    piiTop?: number;
    piiBottom?: number;
}

// ── text folding ────────────────────────────────────────────────────
// Lower-case + strip Lithuanian diacritics so ASCII patterns match.
const LT_FOLD: Record<string, string> = {
    ą: 'a', č: 'c', ę: 'e', ė: 'e', į: 'i', š: 's', ų: 'u', ū: 'u', ž: 'z',
};
// NFD-strip ALL diacritics, not just the Lithuanian set: OCR produces stray Latin-1
// accents too ("KOR(ELÉS" — the acute É is not \w, so it broke the label regexes and
// left the full loyalty number unmasked, receipt-268). LT_FOLD stays as a belt for any
// glyph NFD leaves composed.
const fold = (s: string): string =>
    s.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[ąčęėįšųūž]/g, (c) => LT_FOLD[c] ?? c);

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
// Captures the label + separators so the VALUE start is the match end. OCR mangles the middle of
// the word (the 2nd n → r/m: "Kasinirkas", receipt-146 SIMKUTE), so anchor only on the reliable
// "kasin…k" stem (kasin + ≤3 garbled chars + k) instead of a literal "kasinink".
// "[\w ]{0,4}" between the "kasin" stem and the "k": tolerates OCR garbles (kasin→kasinirk)
// AND a SPACE where OCR split the word into two boxes ("Kasini nkas"), which left the cashier
// name unmasked. The bounded length keeps it from running across unrelated words.
const CASHIER_LABEL = /kasin[\w ]{0,4}k\w*\s*(nr\.?|nr)?\s*[:.\-–]?\s*/;
// Loyalty card number printed in FULL (not PCI star-masked) — e.g. IKI's
// "IKI KORTELĖS NR. 99110000000005068582". The label is a loyalty-card "NR".
// "kor?el" (1 optional char between KOR and EL) tolerates the common OCR misread
// KORTELĖS → KORIELĖS (T→I), which otherwise left the full card number unmasked.
// `.?` (not `\w?`) in the T slot: OCR also reads the T as NON-word junk ("KOR(ELĖS NR",
// receipt-268 — the full loyalty number sailed through unmasked). The trailing anchor
// keeps the loosened stem specific: "nr" OR the spelled-out "numer(is)" — IKI's GIFT
// card prints "KORTELĖS NUMERIS 0000123971" (receipt-398/401; OCR can even reverse the
// order, "0000123971 KORTELES NUMERIS"), which the nr-only anchor let sail through into
// the stored image AND the wordsDump line text.
const LOYALTY_NUMBER_LABEL = /kor.?el\w*\s*n(?:r|umer)/;
// A long bare digit run (the full loyalty number; spaces allowed between groups, plus the
// ^/- junk OCR inserts mid-number — "9440006300214^32954" must mask END TO END).
const LONG_DIGIT_RUN = /\d[\d ^\-]{8,}\d/;

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

    // RECEIPT tilt SAMPLES: each WIDE multi-word line's (yCentre, slope). The receipt is
    // CURVED, so a single global median over-tilts a mask near the flat top and under/over-
    // tilts one near the steep bottom — we read the LOCAL slope at the mask's own Y
    // (localSlopeAtY). refTilt is only the fallback when <1 sample brackets it.
    const refSamples: { y: number; slope: number }[] = [];
    {
        const xs = lines.map((l) => l.xLeft).concat(lines.map((l) => l.xRight));
        const W = Math.max(1, Math.max(...xs) - Math.min(...xs));
        for (const l of lines) {
            const ws = l.words;
            if (!ws || ws.length < 2) continue;
            const lw = ws.reduce((a, b) => ((b.xLeft + b.xRight) < (a.xLeft + a.xRight) ? b : a));
            const rw = ws.reduce((a, b) => ((b.xLeft + b.xRight) > (a.xLeft + a.xRight) ? b : a));
            const lcx = (lw.xLeft + lw.xRight) / 2, rcx = (rw.xLeft + rw.xRight) / 2;
            if (rcx - lcx > 0.4 * W) refSamples.push({ y: (lw.yTop + rw.yTop) / 2, slope: (rw.yTop - lw.yTop) / (rcx - lcx) });
        }
    }
    const refTilt = refSamples.length
        ? Math.max(-0.12, Math.min(0.12, [...refSamples].sort((a, b) => a.slope - b.slope)[Math.floor(refSamples.length / 2)].slope))
        : 0;
    // LOCAL receipt slope at a given Y — linear interpolation between the two bracketing
    // wide lines (nearest outside the range; refTilt with <1 sample). Same shape as
    // ikiParser.localSlopeAtY so masks and parser bands follow the curve identically.
    const localSlopeAtY = (y: number): number => {
        if (!refSamples.length) return refTilt;
        const a = [...refSamples].sort((p, q) => p.y - q.y);
        if (y <= a[0].y) return a[0].slope;
        if (y >= a[a.length - 1].y) return a[a.length - 1].slope;
        let i = 0;
        while (i < a.length - 1 && a[i + 1].y < y) i++;
        const L = a[i], R = a[i + 1];
        const t = (y - L.y) / ((R.y - L.y) || 1);
        return Math.max(-0.12, Math.min(0.12, L.slope + (R.slope - L.slope) * t));
    };

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

        // The line's OWN OCR corner Y is unreliable for tilt — MLKit returns
        // cornerPoints FLAT on skewed text — so the slope is derived below from the
        // masked WORDS / receipt reference tilt. lt/lb remain the anchor for the
        // no-word fallback branch.
        const lineW = Math.max(1, line.xRight - line.xLeft);
        const lt = line.yLeftTop ?? line.yTop;
        const lb = line.yLeftBottom ?? line.yBottom;

        // WORD-ANCHORED box: real x-span from the masked words; Y anchored at those
        // words' own top/bottom and TILTED by the line slope so it bends. Pad keeps
        // it over-covering so the PAN is never exposed. Char→x + line edges when no
        // words are present.
        let boxLeft: number, boxRight: number, anchorTop: number, anchorBot: number;
        const valueWords = (line.words ?? [])
            .filter((w) => (w.xLeft + w.xRight) / 2 >= valXLeft - padX)
            .sort((a, b) => a.xLeft - b.xLeft);
        // CASHIER band must not swallow the receipt number / register that share its
        // row ("Kvito Nr. 168/645/104148 Kasa 0027 Kasininkas <name>"). The char→x
        // value-start under-estimates when the wide "Nr." token skews the proportion,
        // pulling those tokens under the mask (receipt 116). Drop LEADING tokens that
        // are clearly NOT the cashier value — a receipt number (has a slash) / a long
        // digit run / the literal "Kasa" — so the band starts at the real cashier
        // value. Only ever NARROWS; the stop-at-first-real-word guard never strips a
        // name. (The Kvito Nr is extracted pre-mask, so it stays shown but unmasked.)
        if (kind === 'cashier' && valueWords.length > 1) {
            const notCashierValue = (txt: string) => {
                const s = (txt ?? '').trim();
                return /\d\/\d/.test(s) || /^[0-9]{6,}$/.test(s) || /^kasa$/i.test(s);
            };
            while (valueWords.length > 1 && notCashierValue(valueWords[0].text)) {
                valueWords.shift();
            }
        }
        if (valueWords.length > 0) {
            const L = valueWords[0], R = valueWords[valueWords.length - 1];
            boxLeft = Math.max(line.xLeft, L.xLeft - padX);
            boxRight = R.xRight + padX;
            // Span ALL value words (not just the first/last) so a multi-fragment PAN
            // whose MIDDLE fragment sits below its ends still has its true top/bottom —
            // keeps the piiTop/piiBottom caps conservative (defence-in-depth).
            anchorTop = Math.min(...valueWords.map((w) => w.yTop));   // highest top across all
            anchorBot = Math.max(...valueWords.map((w) => w.yBottom)); // lowest bottom across all
        } else {
            boxLeft = Math.max(line.xLeft, valXLeft - padX);
            boxRight = line.xRight + span * 0.02;
            anchorTop = lt;
            anchorBot = lb;
        }
        // TILT for the band edges: the masked WORDS' own slope when 2+ span enough, else the
        // LOCAL receipt slope at this mask's Y (NOT a global median that over-tilts near the
        // curved receipt's flat top). EXCEPT when the fragment tops are STAGGERED (a number
        // split across rows is not one tilted line — any tilt lifts a corner off a fragment):
        // then use a FLAT envelope (slope 0) of the min-top/max-bottom, which hugs all fragments.
        let slope: number;
        const locSlope = localSlopeAtY(anchorTop);
        if (valueWords.length >= 2) {
            const L2 = valueWords[0], R2 = valueWords[valueWords.length - 1];
            const lcx = (L2.xLeft + L2.xRight) / 2, rcx = (R2.xLeft + R2.xRight) / 2;
            const wordSlope = rcx - lcx > 0.15 * lineW
                ? Math.max(-0.12, Math.min(0.12, (R2.yTop - L2.yTop) / (rcx - lcx)))
                : locSlope;
            const wH = valueWords.map((w) => w.yBottom - w.yTop).sort((a, b) => a - b);
            const medianWordH = wH[Math.floor(wH.length / 2)] || 1;
            const stagger = Math.max(...valueWords.map((w) => w.yTop)) - Math.min(...valueWords.map((w) => w.yTop));
            // The masked WORDS' own slope is noisy (redacted/short tokens) — on receipt-96 the
            // cashier value tilted the WRONG way vs the receipt, lifting the mask's right edge UP
            // into the receipt-number line above. Trust the word slope ONLY when it CONFIRMS the
            // receipt's local tilt (same direction, within 0.02); otherwise ride the receipt tilt
            // so every mask slopes consistently with the product bands (and stays off the row above).
            slope = stagger > 0.5 * medianWordH
                ? 0
                : (Math.abs(wordSlope - locSlope) <= 0.02 ? wordSlope : locSlope);
        } else {
            slope = locSlope;
        }
        // PIVOT at the value words' CENTRE (like ikiParser.footBand), not the left edge — a
        // left pivot lifts the far edge off the PII. The masked-word BBOX is axis-aligned but
        // ALREADY encloses the tilted glyphs, so its height H = glyphThickness + |slope|·width:
        // tilting that bbox AGAIN (and padding) inflates a single word to ~3 rows that spill
        // onto the line below. Instead build a TIGHT band of the real glyph thickness, pivoted
        // on the bbox vertical CENTRE, following the slope — it hugs the glyph strip (bottom-
        // left→top-right) without the empty bbox corners. Floored at 0.35·H + padY so a tighter-
        // than-modelled OCR box can never expose a glyph. For slope 0 (flat/staggered) this
        // reduces to exactly the old flat envelope [anchorTop−padY, anchorBot+padY].
        const cxAnchor = valueWords.length > 0
            ? (Math.min(...valueWords.map((w) => w.xLeft)) + Math.max(...valueWords.map((w) => w.xRight))) / 2
            : (boxLeft + boxRight) / 2;
        const valueWidth = valueWords.length > 0
            ? Math.max(...valueWords.map((w) => w.xRight)) - Math.min(...valueWords.map((w) => w.xLeft))
            : (boxRight - boxLeft);
        const H = anchorBot - anchorTop;
        const cyAnchor = (anchorTop + anchorBot) / 2;
        const halfT = Math.max(H - Math.abs(slope) * valueWidth, 0.35 * H) / 2 + padY;
        const topAt = (x: number) => cyAnchor + slope * (x - cxAnchor) - halfT;
        const botAt = (x: number) => cyAnchor + slope * (x - cxAnchor) + halfT;
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
            // PII text extent (no padding) — the inviolable core the clamp must not trim.
            piiTop: anchorTop,
            piiBottom: anchorBot,
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
            // Union the PII core too (covers both originals — clamp can't trim either).
            last.piiTop = Math.min(last.piiTop ?? last.yTop, b.piiTop ?? b.yTop);
            last.piiBottom = Math.max(last.piiBottom ?? last.yBottom, b.piiBottom ?? b.yBottom);
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
        // PII guard: the clamp may NEVER move a mask edge past the PII text — the card /
        // loyalty number must stay covered. Fall back to the mid-line for old stored
        // masks that predate piiTop/piiBottom.
        const mid = (b.yTop + b.yBottom) / 2;
        const piiTop = b.piiTop ?? mid;      // top edge may be pushed DOWN no further than here
        const piiBottom = b.piiBottom ?? mid; // bottom edge may be pulled UP no higher than here
        let yLeftTop = b.yLeftTop ?? b.yTop;
        let yRightTop = b.yRightTop ?? b.yTop;
        let yLeftBottom = b.yLeftBottom ?? b.yBottom;
        let yRightBottom = b.yRightBottom ?? b.yBottom;
        for (const p of protectedRegions) {
            const xOverlap = !(p.xRight <= b.xLeft || p.xLeft >= b.xRight);
            if (!xOverlap) continue;
            // SUBSTANTIAL overlap only (fast-path). A mask that merely clips the EDGE of a
            // protected band is not hiding its data; skip so we don't disturb the mask.
            const overlapW = Math.min(p.xRight, b.xRight) - Math.max(p.xLeft, b.xLeft);
            const maskW = Math.max(1, b.xRight - b.xLeft);
            const protW = Math.max(1, p.xRight - p.xLeft);
            if (overlapW / maskW < 0.35 && overlapW / protW < 0.35) continue;
            // PER-CORNER X-CONTAINMENT: only move a corner whose x ACTUALLY falls inside
            // the protected band's x-range. Never extrapolate the band's edge across a
            // corner that lies outside it — that is what lifted the PAN mask's far-left
            // corner (nowhere near the total) up off the card number on receipt 77.
            const leftIn = b.xLeft >= p.xLeft && b.xLeft <= p.xRight;
            const rightIn = b.xRight >= p.xLeft && b.xRight <= p.xRight;
            const pCenter = (p.yTop + p.yBottom) / 2;
            if (pCenter <= mid) {
                // protected band above → push the mask's TOP corners down to its bottom
                // edge, but never below the PII top (else the card number's top shows).
                const blY = p.yLeftBottom ?? p.yBottom;
                const brY = p.yRightBottom ?? p.yBottom;
                if (leftIn) yLeftTop = Math.min(piiTop, Math.max(yLeftTop, edgeYAt(p.xLeft, p.xRight, blY, brY, b.xLeft)));
                if (rightIn) yRightTop = Math.min(piiTop, Math.max(yRightTop, edgeYAt(p.xLeft, p.xRight, blY, brY, b.xRight)));
            } else {
                // protected band below → pull the mask's BOTTOM corners up to its top
                // edge, but never above the PII bottom (else the card number's bottom shows).
                const tlY = p.yLeftTop ?? p.yTop;
                const trY = p.yRightTop ?? p.yTop;
                if (leftIn) yLeftBottom = Math.max(piiBottom, Math.min(yLeftBottom, edgeYAt(p.xLeft, p.xRight, tlY, trY, b.xLeft)));
                if (rightIn) yRightBottom = Math.max(piiBottom, Math.min(yRightBottom, edgeYAt(p.xLeft, p.xRight, tlY, trY, b.xRight)));
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

/** A word/line box in the same pixel space as the mask bands. */
export interface PiiBox { xLeft: number; xRight: number; yTop: number; yBottom: number; }

/** True when a box's CENTRE sits inside ANY mask band (band Y = the UNION of its skew
 *  corners AND piiTop/piiBottom, so a tilted card/loyalty row is never under-covered).
 *  Redacts PII words out of the persisted wordsDump (it ships in staging+prod). Uses the
 *  CENTRE — not any overlap — so a neighbouring label that merely EDGE-clips a tall card
 *  band (e.g. "Pardavimas" grazing the bank band by a few px) is NOT blanked; a real PII
 *  word sits fully inside its band so its centre is always within. looksLikePiiText
 *  backstops every digit/star run regardless. */
export function wordCentreInMaskBand(box: PiiBox, bands: MaskBand[]): boolean {
    const cx = (box.xLeft + box.xRight) / 2, cy = (box.yTop + box.yBottom) / 2;
    for (const b of bands) {
        if (cx < b.xLeft || cx > b.xRight) continue;
        const top = Math.min(b.yTop, b.yLeftTop ?? b.yTop, b.yRightTop ?? b.yTop, b.piiTop ?? b.yTop);
        const bot = Math.max(b.yBottom, b.yLeftBottom ?? b.yBottom, b.yRightBottom ?? b.yBottom, b.piiBottom ?? b.yBottom);
        if (cy >= top && cy <= bot) return true;
    }
    return false;
}

/** Defence-in-depth for wordsDump redaction: word text that LOOKS like a card/loyalty
 *  number regardless of band detection (which is fragile) — a 10+ digit run (loyalty
 *  number; 8-digit trader IDs stay clear) or a star-masked PAN. Cashier NAMES have no
 *  pattern, so they rely on the band overlap. */
export function looksLikePiiText(text: string): boolean {
    return LONG_DIGIT_RUN.test(text) || MASK_RUN.test(text);
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
