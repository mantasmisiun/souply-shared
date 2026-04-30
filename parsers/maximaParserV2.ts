/**
 * Maxima Receipt Parser — V2.
 *
 * V2 splits parsing into TWO independent steps so each can be
 * inspected and refined without mixing concerns:
 *
 *   STEP 1 — Band detection + line classification.
 *     `findProductBandsV2` returns `{ bands, internals }`:
 *       - `bands[]` carries the y-coord boundaries between products
 *         (contiguous: `bands[i].yBottom === bands[i+1].yTop`) for
 *         the visual overlay and image cropping.
 *       - `internals[]` carries each band's typed line content —
 *         the anchor row, pre-anchor name fragments, and every
 *         post-anchor line tagged with its role (unit-qty,
 *         discount-label, deposit-name, taisymas-*, same-row, …).
 *
 *     Boundary set produced for N detected products:
 *       y0 = midpoint between the last header line and the first
 *            product line (= bands[0].yTop)
 *       yi = midpoint between product i and product i+1
 *            (= bands[i-1].yBottom = bands[i].yTop)
 *       yN = midpoint between the last product line and the first
 *            footer line (= bands[N-1].yBottom)
 *
 *   STEP 2 — Per-band content extraction (consumes `internals`).
 *     Converts each `BandInternal` into a `MaximaProduct` (name,
 *     price, promoPrice, quantity, unit, etc.) without touching
 *     OCR data outside the band. Lives in a sibling module that
 *     reads the typed entries directly — no string parsing of the
 *     trace dump, no re-classification.
 *
 * Splitting like this lets us debug each phase visually: if step 1's
 * boundaries are wrong, the band rectangles drawn over the receipt
 * image will be in the wrong place; if step 2's extraction is wrong,
 * the rectangles are right but the parsed fields are not.
 *
 * `traceProductBandsV2` renders the same `internals` data as a
 * paste-friendly text dump — the trace and step 2 can never
 * disagree about a line's role.
 */

import {
    splitMergedLines,
    findHeaderEnd,
    regionOf,
    parseNum,
    cleanProductName,
    parseHeader,
    parseFooter,
    NON_CATALOG_LINE_RE,
    type MaximaLine,
    type MaximaProduct,
    type MaximaParseResult,
} from './maximaParser.js';

// ───────── regexes ─────────

const STANDALONE_PRICE_RE = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const NEG_AMOUNT_RE = /^-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const INLINE_NEG_AMOUNT_RE = /-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;

// Bare-price anchor — for receipts where MLKit drops the trailing
// `A`/`B` VAT letter entirely (`"1,89"` instead of `"1,89 A"`).
// Used ONLY by `findAnchors` with mandatory prev-line context so
// deposit totals (`"0,10"` after `PET (depozitinis)`) and other
// numeric noise don't get promoted to fake product anchors.
// Tight format (exactly two decimals, full-line anchor) keeps stray
// numbers like `"40"` or `"22,"` out.
const RELAXED_PRICE_RE = /^\d+[.,]\d{2}$/;

// Tolerant unit-qty pattern. Covers `1,99 X 1,986 kg` (weighable),
// `0,59 X 4 vnt.` (multi-pack), `1,59 X 2 maiš.` (multi-bag).
const UNIT_QTY_RE =
    /(\d+[.,]\s?\d{1,2})\s*[xX×]\s*(\d+(?:[.,]\s?\d{1,3})?)\s*(k[gqa]|mai[sšŠ]\.?|vnt\.?|pak\.?)/i;

// Fallback for lines where MLKit drops the unit suffix entirely
// (`3,59 X 2` instead of `3,59 X 2 vnt.`). Requires the *whole*
// line to be `<price> X <qty>` — anchoring with ^/$ keeps stray
// numeric substrings (e.g. continuation fragments containing
// "10 X 2 ") from matching. Step 2 will default the unit to `vnt`
// when it sees a band with this shape and no explicit suffix.
const UNIT_QTY_NOUNIT_RE =
    /^\s*(\d+[.,]\s?\d{1,2})\s*[xX×]\s*(\d+(?:[.,]\s?\d{1,3})?)\s*$/i;

// Three discount label flavours seen in real receipts:
//   - "AČIŪ nuolaida prekei:<name>"
//   - "Sutaupėte:<name>"
//   - "Nuolaida prekei"
// All can appear with the amount on the same line OR on the next.
//
// Character class for the trailing `ė` accepts `e`/`é`/`è`/`ė` —
// MLKit on Maxima's thermal print drops or remaps the diacritic in
// either direction. Real corpus has at least `Sutaupéte` (acute)
// alongside the canonical `Sutaupėte`; without this the discount
// label is missed and the savings row floats into the next band.
//
// `preke\s*i` rather than `prekei` because OCR sometimes splits the
// final `i` off as a separate glyph (`preke i:` vs `prekei:`); both
// occur in the corpus.
const DISCOUNT_LABEL_RE = /(?:nuo\s*la\s*ida\s+preke\s*i|sutaup[eéèė]t)/i;

// Refund/correction marker. Maxima prints a `TAISYMAS` header
// followed by a 2- or 3-line block that mirrors the original
// purchase line: name repeat, `-X,XX A` neg amount, and (for
// weighable / multi-pack) a unit-qty repeat. The whole block
// belongs to the band of the product being refunded so the band
// reflects the net transaction, not just the gross.
const TAISYMAS_RE = /^\s*TAISYMAS\s*$/i;

const FOOTER_SEP_RE = /^={10,}\s*#?\s*$/;

// PET / can deposit. Always follows its parent product on the
// receipt — absorbed into the parent's band so deposits don't
// fragment a product into two bands.
const DEPOSIT_LINE_RE = /\b(?:pet|skardin[eė])\s*\(depozitin[eėi][sa]?[is]?\)/i;

// V2-local footer-start detector. Two-pass: strong signals beat the
// weak `^={10,}` separator. The shared V1 `findFooterStart` returns
// at the first match, which on receipts where MLKit emits a stray
// `===` mid-receipt incorrectly chops the last product's discount
// off its band. Strong-signal-first avoids that class of false
// positive.
//
// Strong signals come in two flavours: receipt-end markers
// (`Suteiktos naudos`, `Kvito suma`, `Mokėtina suma`) and
// pre-totals markers that appear on receipts which print a VAT
// breakdown / deposit summary BEFORE the canonical end marker
// (`Be PVM`/`Su PVM` column headers, `A= 21,00%` VAT rate row,
// `Depozitas/įmoka` deposit summary). Without the pre-totals
// markers, those 5–10 summary lines sit inside the product slice
// as orphans and the last band's yBottom gets extended down past
// the actual products region.
function findFooterStartV2(lines: MaximaLine[], afterIdx: number): number {
    const norm = (s: string): string =>
        s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (let i = afterIdx; i < lines.length; i++) {
        const t = norm(lines[i].text);
        if (/suteiktos\s+naudos/.test(t)) return i;
        if (/^aciu\s+nuolaidos/.test(t)) return i;
        if (/^kvito\s+suma/.test(t)) return i;
        if (/^f1\s*moketina/.test(t)) return i;
        if (/^moketina\s+suma/.test(t)) return i;
        // Pre-totals VAT/deposit summary markers.
        if (/^be\s+pvm\b/.test(t)) return i;
        if (/^su\s+pvm\b/.test(t)) return i;
        if (/^depozitas\b/.test(t)) return i;
        // VAT rate row e.g. "A= 21,00%". Anchored to start of line +
        // requires the trailing `%` so it doesn't false-positive on
        // a product code or a stray label.
        if (/^[ab]\s*=\s*\d+[.,]?\d*\s*%/.test(t)) return i;
    }
    for (let i = afterIdx; i < lines.length; i++) {
        if (/^={10,}/.test(lines[i].text)) return i;
    }
    return lines.length;
}

// ───────── detection (re-exported from V1 — unchanged) ─────────

export { isMaximaReceipt } from './maximaParser.js';

// ───────── band model (internal) ─────────

interface InternalBand {
    /** Index of the price-anchor line inside the products slice. */
    anchorIdx: number;
    /** Inclusive last line index belonging to this product. */
    lastIdx: number;
}

/**
 * One observation made while building bands. Every line that V2
 * touches gets one of these so the trace dump can show "for each
 * line, what V2 thought it was and why".
 *
 * Indices are into the products slice (i.e. after header is stripped),
 * so they line up with what the parser internals see.
 */
type TraceReason =
    | 'name'              // pre-anchor name fragment glued to the upcoming band
    | 'anchor'            // positive-price line that started the band
    | 'unit-qty'          // `1,99 X 1,118 kg` style row
    | 'discount-label'    // `AČIŪ nuolaida prekei:` / `Sutaupėte:` (label on its own row)
    | 'discount-amount'   // `-X,XX A` on the row after a discount label
    | 'inline-discount'   // discount label and `-X,XX A` on the same row
    | 'bare-negative'     // standalone `-X,XX A` with no preceding label
    | 'deposit-name'      // `PET (depozitinis)` / can deposit
    | 'deposit-qty'       // unit-qty row of a deposit block
    | 'deposit-price'     // positive-price row of a deposit block
    | 'taisymas-header'   // refund/correction header
    | 'taisymas-name'     // name fragment inside a refund block
    | 'taisymas-amount'   // mandatory neg amount of a refund block
    | 'taisymas-qty'      // optional trailing unit-qty of a refund block
    | 'same-row'          // unclassified line at same y as last absorbed (left-column continuation)
    | 'stop-next-anchor'  // extension stopped: next line is a new product's name
    | 'stop-footer-sep';  // extension stopped: hit the `==========` separator


function isPositivePriceLine(line: MaximaLine): boolean {
    const t = line.text.trim();
    if (!STANDALONE_PRICE_RE.test(t)) return false;
    if (t.startsWith('-')) return false;
    return true;
}

function isDiscountLabelLine(line: MaximaLine): boolean {
    return DISCOUNT_LABEL_RE.test(line.text);
}

function isUnitQtyLine(line: MaximaLine): boolean {
    return UNIT_QTY_RE.test(line.text) || UNIT_QTY_NOUNIT_RE.test(line.text);
}

function isDepositLine(line: MaximaLine): boolean {
    return DEPOSIT_LINE_RE.test(line.text);
}

function isFooterSepLine(line: MaximaLine): boolean {
    return FOOTER_SEP_RE.test(line.text.trim());
}

/**
 * Find every line index that's a true product anchor.
 *
 * Strict path: positive-price line (`X,XX A`/`B`) not preceded by a
 * discount label.
 *
 * Relaxed path: bare-price line (`X,XX` with the trailing VAT letter
 * dropped by OCR) preceded by a name-like line. Required exclusions
 * on the previous line keep deposit totals, discount amounts, and
 * other numeric noise from being promoted to fake anchors:
 *   - deposit-name → next line is the deposit's right-column total,
 *     not a new product (handled inside extendBand via same-row)
 *   - existing positive-price → two prices in a row never legitimate
 *   - discount-label → following line is a discount amount, not a price
 *   - neg amount → trailing context of a discount block
 *   - TAISYMAS header → refund block, no positive prices
 *   - non-letter content → no name fragment to anchor against, likely
 *     numeric noise rather than a product
 */
function findAnchors(lines: MaximaLine[]): number[] {
    const anchors: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prev = i > 0 ? lines[i - 1] : null;
        if (isPositivePriceLine(line)) {
            if (prev && isDiscountLabelLine(prev)) continue;
            anchors.push(i);
            continue;
        }
        if (!RELAXED_PRICE_RE.test(line.text.trim())) continue;
        if (!prev) continue;
        const prevText = prev.text.trim();
        if (isDepositLine(prev)) continue;
        if (isPositivePriceLine(prev)) continue;
        if (isDiscountLabelLine(prev)) continue;
        if (NEG_AMOUNT_RE.test(prevText)) continue;
        if (TAISYMAS_RE.test(prevText)) continue;
        if (!/\p{L}/u.test(prev.text)) continue;
        anchors.push(i);
    }
    return anchors;
}

/**
 * Extend a band downward from its anchor, absorbing every line that
 * "belongs to" this product:
 *   - unit-qty rows
 *   - discount blocks (label + amount, inline or two-line)
 *   - standalone negative amounts (rare OCR artefact)
 *   - PET / can deposit blocks (deposit name + unit-qty + price)
 *
 * Stops at the next product's name line or the footer separator.
 *
 * If `events` is supplied, every absorbed line is appended with its
 * reason and the stop reason is recorded — used by the trace dump.
 */
function extendBand(
    lines: MaximaLine[],
    anchorIdx: number,
    events?: { sliceIdx: number; reason: TraceReason }[],
): number {
    let last = anchorIdx;
    let j = anchorIdx + 1;
    let stopReason: 'stop-next-anchor' | 'stop-footer-sep' = 'stop-next-anchor';
    while (j < lines.length) {
        const next = lines[j];
        if (isFooterSepLine(next)) {
            stopReason = 'stop-footer-sep';
            break;
        }

        if (isUnitQtyLine(next)) {
            last = j;
            events?.push({ sliceIdx: j, reason: 'unit-qty' });
            j++;
            continue;
        }

        if (isDiscountLabelLine(next)) {
            last = j;
            // Same-line discount? splitMergedLines should have split
            // it, but if it didn't (and the amount is still attached),
            // we're already done — this row is the discount.
            if (INLINE_NEG_AMOUNT_RE.test(next.text)) {
                events?.push({ sliceIdx: j, reason: 'inline-discount' });
                j++;
                continue;
            }
            events?.push({ sliceIdx: j, reason: 'discount-label' });
            j++;
            if (j < lines.length && NEG_AMOUNT_RE.test(lines[j].text.trim())) {
                last = j;
                events?.push({ sliceIdx: j, reason: 'discount-amount' });
                j++;
            }
            continue;
        }

        if (NEG_AMOUNT_RE.test(next.text.trim())) {
            last = j;
            events?.push({ sliceIdx: j, reason: 'bare-negative' });
            j++;
            continue;
        }

        // TAISYMAS refund block. Absorbs the marker + a mirrored
        // copy of the original line (name, neg amount, optional
        // unit-qty) into the band of the product being refunded so
        // the refund stays attached to its source row.
        //
        // Phased absorption to keep tight bounds on what gets eaten:
        //   1. After the header, absorb name fragments until we see
        //      the neg amount. Hard cap at 3 in case of malformed
        //      input — prevents runaway absorption.
        //   2. Absorb the neg amount. Mandatory; if missing this
        //      branch silently bails.
        //   3. Optionally absorb a trailing unit-qty (only present
        //      for weighable / multi-pack refunds).
        // Stops on positive-price (next product) or footer-sep at
        // every step so we never cross a band boundary.
        if (TAISYMAS_RE.test(next.text.trim())) {
            last = j;
            events?.push({ sliceIdx: j, reason: 'taisymas-header' });
            j++;
            let nameLines = 0;
            while (j < lines.length && nameLines < 3) {
                const ln = lines[j];
                if (isFooterSepLine(ln)) break;
                if (NEG_AMOUNT_RE.test(ln.text.trim())) break;
                if (isPositivePriceLine(ln)) break;
                last = j;
                events?.push({ sliceIdx: j, reason: 'taisymas-name' });
                j++;
                nameLines++;
            }
            if (j < lines.length && NEG_AMOUNT_RE.test(lines[j].text.trim())) {
                last = j;
                events?.push({ sliceIdx: j, reason: 'taisymas-amount' });
                j++;
            }
            if (j < lines.length && isUnitQtyLine(lines[j])) {
                last = j;
                events?.push({ sliceIdx: j, reason: 'taisymas-qty' });
                j++;
            }
            continue;
        }

        // PET / can deposit block follows this product. Absorb the
        // deposit's name + unit-qty + price into the parent so
        // the deposit doesn't fragment off into its own band.
        if (isDepositLine(next)) {
            last = j;
            events?.push({ sliceIdx: j, reason: 'deposit-name' });
            j++;
            if (j < lines.length && isUnitQtyLine(lines[j])) {
                last = j;
                events?.push({ sliceIdx: j, reason: 'deposit-qty' });
                j++;
            }
            if (j < lines.length && isPositivePriceLine(lines[j])) {
                last = j;
                events?.push({ sliceIdx: j, reason: 'deposit-price' });
                j++;
            }
            continue;
        }

        // Same physical row as the most recently absorbed line.
        // Maxima's two-column layout (name on left, price on right)
        // gets emitted by MLKit as separate text blocks at the same
        // y, so a name continuation, multi-line name fragment, or a
        // deposit's right-column total ("0,10" without trailing A)
        // appears as the *next* OCR line even though it's the same
        // physical row. Without this, extension stops at that line
        // and orphans the unit-qty / discount block below it.
        //
        // Threshold: y-overlap > 50% of the shorter line's height.
        // Real continuations have ≥80% overlap on Maxima receipts;
        // genuinely-different rows have a 5–15 px gap (no overlap),
        // so the cutoff has comfortable margin in both directions.
        const refLine = lines[last];
        const overlap =
            Math.min(next.yBottom, refLine.yBottom) -
            Math.max(next.yTop, refLine.yTop);
        const minH = Math.min(
            next.yBottom - next.yTop,
            refLine.yBottom - refLine.yTop,
        );
        if (minH > 0 && overlap > minH * 0.5) {
            last = j;
            events?.push({ sliceIdx: j, reason: 'same-row' });
            j++;
            continue;
        }

        // Anything else = the next product's name line. Stop here.
        break;
    }
    // Sentinel "stop event" — its sliceIdx is the line that caused the
    // stop (or lines.length if we ran off the end). Lets the trace
    // dump show what V2 *refused* to absorb, which is usually the
    // most informative thing when bands are wrong.
    events?.push({ sliceIdx: j, reason: stopReason });
    return last;
}

/**
 * Build internal bands. Anchor indices that fall inside an
 * already-built band's range are skipped — this is what makes
 * absorbed deposits (whose price line is itself a positive-price
 * anchor) NOT spawn a duplicate band.
 *
 * `eventsPerBand` is appended in lockstep with the returned bands —
 * every band's extension events are recorded so step 2 (per-band
 * content extraction) and the trace dump can both read the same
 * underlying classification without re-running extension.
 */
function buildBands(
    lines: MaximaLine[],
    eventsPerBand: { sliceIdx: number; reason: TraceReason }[][],
): InternalBand[] {
    const anchorIndices = findAnchors(lines);
    const bands: InternalBand[] = [];
    let coveredUpTo = -1;
    for (const anchorIdx of anchorIndices) {
        if (anchorIdx <= coveredUpTo) continue;
        const events: { sliceIdx: number; reason: TraceReason }[] = [];
        const lastIdx = extendBand(lines, anchorIdx, events);
        bands.push({ anchorIdx, lastIdx });
        eventsPerBand.push(events);
        coveredUpTo = lastIdx;
    }
    return bands;
}

// ───────── public API ─────────

export interface ProductBand {
    /**
     * yTop in the same coord space as the input lines (image-pixel
     * for single-page, parser-concat space for multi-page). Equal to
     * the previous band's yBottom (no gaps).
     */
    yTop: number;
    /** yBottom; equal to the next band's yTop. */
    yBottom: number;
}

/**
 * One classified line inside a band. `sliceIdx` is the line's
 * position in the products slice (after `splitMergedLines` +
 * header strip), included so callers can cross-reference against
 * the trace dump.
 */
export interface BandLineEntry {
    line: MaximaLine;
    sliceIdx: number;
    reason: TraceReason;
}

/**
 * Per-band typed content. Step 2 (per-band content extraction)
 * reads from these directly: name from `preName` + `postAnchor`
 * entries tagged `same-row`, price from `anchor`, unit-qty from
 * the matching `postAnchor` entry, etc. The trace dump iterates
 * the same data to render its line-by-line view, so step 1's
 * classification is the single source of truth.
 */
export interface BandInternal {
    /** 0-based; matches the index in `bands`. Visual band number = bandIdx + 1. */
    bandIdx: number;
    /** Positive-price line that anchored this band. */
    anchor: BandLineEntry;
    /** Name fragments appearing before the anchor, in slice order. */
    preName: BandLineEntry[];
    /**
     * Lines absorbed downward from the anchor, in slice order.
     * Excludes the terminal stop sentinel (carried separately on
     * `stop` so consumers know what *would-have-been* the next
     * line if extension hadn't stopped).
     */
    postAnchor: BandLineEntry[];
    /** Why extension stopped + which slice idx caused it. */
    stop: {
        sliceIdx: number;
        reason: 'stop-next-anchor' | 'stop-footer-sep' | 'stop-end-of-input';
    };
}

export interface ReceiptBandPlan {
    /** Bands covering the products region, in y-order. */
    bands: ProductBand[];
    /** Per-band typed content, 1:1 with `bands`. */
    internals: BandInternal[];
}

/**
 * Internal context object — carries everything the public API and
 * the trace dump need without re-running `splitMergedLines` /
 * `findHeaderEnd` / band detection twice.
 */
interface BandsContext {
    processed: MaximaLine[];
    headerEnd: number;
    footerStart: number;
    productSlice: MaximaLine[];
    bands: ProductBand[];
    internals: BandInternal[];
}

/**
 * Run the full step-1 pipeline (split → header/footer detect →
 * anchor → extend → boundary smoothing) and produce both the
 * y-coord band list and the per-band typed content. All public
 * entry points delegate here so the work happens exactly once.
 */
function computeBandsContext(rawLines: MaximaLine[]): BandsContext {
    const processed = splitMergedLines(rawLines);
    const headerEnd = findHeaderEnd(processed);
    const footerStart = findFooterStartV2(processed, headerEnd);
    const productSlice = processed.slice(headerEnd, footerStart);

    // Display-only boundaries: midpoints between header end / first
    // product line, and last product line / first footer line. These
    // give the first and last band clean dividers against the
    // surrounding regions.
    let topBoundY: number | undefined;
    if (headerEnd > 0 && headerEnd < processed.length) {
        topBoundY = (processed[headerEnd - 1].yBottom + processed[headerEnd].yTop) / 2;
    }
    let bottomBoundY: number | undefined;
    if (footerStart > 0 && footerStart < processed.length) {
        bottomBoundY = (processed[footerStart - 1].yBottom + processed[footerStart].yTop) / 2;
    }

    const eventsPerBand: { sliceIdx: number; reason: TraceReason }[][] = [];
    const internalBands = buildBands(productSlice, eventsPerBand);

    const bands: ProductBand[] = [];
    const internals: BandInternal[] = [];
    for (let bi = 0; bi < internalBands.length; bi++) {
        const band = internalBands[bi];
        // Lines before the first anchor are loose name fragments —
        // attach them to the first band so leading multi-line names
        // aren't lost.
        const sliceStart = bi === 0 ? 0 : internalBands[bi - 1].lastIdx + 1;
        const bandLines = productSlice.slice(sliceStart, band.lastIdx + 1);
        const region = regionOf(bandLines);
        bands.push({ yTop: region.yTop, yBottom: region.yBottom });

        const events = eventsPerBand[bi];
        const preName: BandLineEntry[] = [];
        for (let k = sliceStart; k < band.anchorIdx; k++) {
            preName.push({ line: productSlice[k], sliceIdx: k, reason: 'name' });
        }
        const stopEv = events.find(
            (e) => e.reason === 'stop-next-anchor' || e.reason === 'stop-footer-sep',
        );
        const postAnchor: BandLineEntry[] = events
            .filter((e) => e.reason !== 'stop-next-anchor' && e.reason !== 'stop-footer-sep')
            .map((e) => ({ line: productSlice[e.sliceIdx], sliceIdx: e.sliceIdx, reason: e.reason }));
        const stop = stopEv
            ? {
                  sliceIdx: stopEv.sliceIdx,
                  reason: stopEv.reason as 'stop-next-anchor' | 'stop-footer-sep',
              }
            : {
                  sliceIdx: productSlice.length,
                  reason: 'stop-end-of-input' as const,
              };
        internals.push({
            bandIdx: bi,
            anchor: {
                line: productSlice[band.anchorIdx],
                sliceIdx: band.anchorIdx,
                reason: 'anchor',
            },
            preName,
            postAnchor,
            stop,
        });
    }

    // Make adjacent bands share an exact divider, and extend the
    // first/last bands to the header/footer dividers.
    if (bands.length > 0) {
        if (topBoundY !== undefined) bands[0].yTop = topBoundY;
        for (let i = 0; i < bands.length - 1; i++) {
            const mid = (bands[i].yBottom + bands[i + 1].yTop) / 2;
            bands[i].yBottom = mid;
            bands[i + 1].yTop = mid;
        }
        if (bottomBoundY !== undefined) bands[bands.length - 1].yBottom = bottomBoundY;
    }

    return { processed, headerEnd, footerStart, productSlice, bands, internals };
}

/**
 * Step 1: find product band boundaries + per-band typed content.
 * Pure (no I/O), so safe on any platform. Bands are made contiguous
 * and the first/last bands are extended to the header/footer
 * dividers so consumers can use `(yTop, yBottom)` directly as a
 * crop region. `internals` carries the same line-level
 * classification the trace dump renders, so step 2 doesn't need to
 * re-derive it.
 */
export function findProductBandsV2(lines: MaximaLine[]): ReceiptBandPlan {
    const ctx = computeBandsContext(lines);
    return { bands: ctx.bands, internals: ctx.internals };
}

// ───────── diagnostic trace (dev tool) ─────────

const TRUNC = (s: string, n = 80): string =>
    s.length <= n ? s : s.slice(0, n - 1) + '…';

const fmtY = (line: MaximaLine): string =>
    `y=${Math.round(line.yTop)}..${Math.round(line.yBottom)}`;

/**
 * Build a copy-paste-friendly trace of how V2 step 1 partitioned a
 * receipt's lines into bands. Format is line-oriented (one OCR line
 * per row in the dump) with explicit reasons, indices, and y-coords
 * so a reader can match the dump against the receipt-detail overlay.
 *
 * The dump is intentionally exhaustive — every product-region line
 * appears exactly once with a reason tag. When the user reports
 * "band 4 is wrong", finding the offending row is a single visual
 * scan of the trace.
 *
 * Reads from `computeBandsContext` so the classification the trace
 * shows is byte-for-byte the same one step 2 sees in `internals`.
 *
 * Pure: no console.log inside; the caller decides what to do with
 * the returned string.
 */
export function traceProductBandsV2(rawLines: MaximaLine[]): string {
    const ctx = computeBandsContext(rawLines);
    const { processed, headerEnd, footerStart, productSlice, internals } = ctx;

    const out: string[] = [];
    out.push(
        `lines: total=${rawLines.length} afterSplit=${processed.length} ` +
            `headerEnd=${headerEnd} footerStart=${footerStart} ` +
            `productSlice=[${headerEnd}..${footerStart}) bands=${internals.length}`,
    );
    if (headerEnd > 0) {
        const lastHeader = processed[headerEnd - 1];
        out.push(`  lastHeaderLine: ${fmtY(lastHeader)} "${TRUNC(lastHeader.text)}"`);
    }
    if (footerStart < processed.length) {
        const firstFooter = processed[footerStart];
        out.push(`  firstFooterLine: ${fmtY(firstFooter)} "${TRUNC(firstFooter.text)}"`);
    }
    out.push('');

    // Build a per-line tag map directly from internals so the
    // trace and step 2 can never disagree about a line's role.
    type Tag = { bandIdx1: number; reason: TraceReason };
    const tags = new Map<number, Tag>();
    for (const band of internals) {
        const bandIdx1 = band.bandIdx + 1;
        for (const e of band.preName) tags.set(e.sliceIdx, { bandIdx1, reason: e.reason });
        tags.set(band.anchor.sliceIdx, { bandIdx1, reason: band.anchor.reason });
        for (const e of band.postAnchor) tags.set(e.sliceIdx, { bandIdx1, reason: e.reason });
    }

    if (internals.length === 0) {
        out.push('NO ANCHORS FOUND. All product-region lines:');
        for (let i = 0; i < productSlice.length; i++) {
            const ln = productSlice[i];
            out.push(`  slice[${i}] ${fmtY(ln)} "${TRUNC(ln.text)}"`);
        }
        return out.join('\n');
    }

    let currentBand = 0;
    for (let i = 0; i < productSlice.length; i++) {
        const ln = productSlice[i];
        const tag = tags.get(i);
        if (!tag) {
            // Unclassified — usually means a stray line after the last
            // band's stop. Render with a `?` reason so it's obvious.
            out.push(
                `  slice[${i}] ${fmtY(ln)} reason=? band=- "${TRUNC(ln.text)}"`,
            );
            continue;
        }
        if (tag.bandIdx1 !== currentBand) {
            currentBand = tag.bandIdx1;
            const band = internals[currentBand - 1];
            const lastIdx = band.postAnchor.length > 0
                ? band.postAnchor[band.postAnchor.length - 1].sliceIdx
                : band.anchor.sliceIdx;
            out.push('');
            out.push(
                `── band ${currentBand}: anchor=slice[${band.anchor.sliceIdx}] ` +
                    `lastIdx=slice[${lastIdx}] ` +
                    `${band.stop.reason}=slice[${band.stop.sliceIdx}]`,
            );
        }
        out.push(
            `  slice[${i}] ${fmtY(ln)} reason=${tag.reason} band=${tag.bandIdx1} "${TRUNC(ln.text)}"`,
        );
    }
    return out.join('\n');
}

// ───────── step 2: per-band content extraction ─────────

/**
 * Outcome of running step 2 on a single band. `product` is null
 * when the band represents something we don't surface as a
 * shopping-cart product (deposits, plastic bags, TAISYMAS refunds)
 * OR when the anchor couldn't be parsed at all. `warnings` is
 * always populated for skipped bands (the skip reason) and may
 * also carry diagnostic notes on emitted products (relaxed-anchor
 * fallback, unit-qty regex miss, reconcile mismatch).
 */
export interface ExtractResult {
    product: MaximaProduct | null;
    warnings: string[];
}

const RECONCILE_TOLERANCE_EUR = 0.02;

/**
 * Convert one classified band into a `MaximaProduct` (or skip it).
 *
 * Inputs come from step 1's `BandInternal` — anchor + name fragments
 * + post-anchor lines, all already tagged with reasons. Step 2's job
 * is purely field extraction: regex out the numeric/string content
 * and check the receipt's own arithmetic for sanity.
 *
 * Skips:
 *   - any band whose `postAnchor` contains a `taisymas-*` event
 *     (refund, net-zero — drop the line)
 *   - any band whose joined name reduces to a non-catalog or
 *     deposit-only string (plastic bag, "PET (depozitinis)" alone)
 *
 * Reconcile self-check:
 *   For bands with an extracted unit-qty, verifies that
 *   `pricePerUnit × quantity ≈ price` (tolerance €0.02). Mismatch
 *   surfaces a warning with the full math so the operator can
 *   eyeball which factor went wrong (qty? ppu? price?). Warning
 *   is informational — the product is still emitted.
 */
export function extractMaximaProduct(internal: BandInternal): ExtractResult {
    const warnings: string[] = [];

    // TAISYMAS refund: net zero, drop.
    const hasTaisymas = internal.postAnchor.some(
        (e) =>
            e.reason === 'taisymas-header' ||
            e.reason === 'taisymas-name' ||
            e.reason === 'taisymas-amount' ||
            e.reason === 'taisymas-qty',
    );
    if (hasTaisymas) {
        const refundedName = internal.preName.map((e) => e.line.text).join(' ').trim();
        return {
            product: null,
            warnings: [`skip:taisymas-refund "${refundedName.slice(0, 60)}"`],
        };
    }

    // Price from anchor. Strict form first, relaxed (no A/B) as
    // fallback so the few OCR-dropped-letter receipts still produce
    // a price — but flag the fallback so it's visible.
    const anchorText = internal.anchor.line.text.trim();
    let price: number;
    const strictPriceMatch = anchorText.match(STANDALONE_PRICE_RE);
    if (strictPriceMatch) {
        price = parseNum(strictPriceMatch[1]);
    } else if (RELAXED_PRICE_RE.test(anchorText)) {
        price = parseNum(anchorText);
        warnings.push(`anchor RELAXED form "${anchorText}" → ${price.toFixed(2)}`);
    } else {
        return {
            product: null,
            warnings: [`skip:anchor-parse-failed "${anchorText}"`],
        };
    }

    // Name = pre-anchor fragments + same-row continuations that
    // appear BEFORE any deposit-name on this band. A `same-row`
    // event after a deposit-name is the deposit's right-column
    // total ("0,10"), not a name continuation — exclude it.
    const nameLineEntries: BandLineEntry[] = [...internal.preName];
    let depositSeen = false;
    for (const e of internal.postAnchor) {
        if (e.reason === 'deposit-name') {
            depositSeen = true;
            continue;
        }
        if (e.reason === 'same-row' && !depositSeen) {
            nameLineEntries.push(e);
        }
    }
    const rawName = nameLineEntries.map((e) => e.line.text).join(' ').trim();

    // Non-catalog filter — plastic bags, deposit-only entries.
    if (NON_CATALOG_LINE_RE.test(rawName)) {
        return {
            product: null,
            warnings: [`skip:non-catalog "${rawName.slice(0, 60)}"`],
        };
    }
    if (DEPOSIT_LINE_RE.test(rawName)) {
        return {
            product: null,
            warnings: [`skip:deposit-only "${rawName.slice(0, 60)}"`],
        };
    }

    const name = cleanProductName(rawName);

    // Unit-qty extraction: strict form first (carries unit), then
    // the unit-less fallback. If the band had a `unit-qty` event
    // but neither regex matches the line text, that's a step-1/step-2
    // disagreement worth surfacing — the band absorption rule
    // accepted the line but the field-extraction regex didn't.
    let pricePerUnit: number | null = null;
    let quantity = 1;
    let unit = 'vnt';
    const unitQtyEntry = internal.postAnchor.find((e) => e.reason === 'unit-qty');
    if (unitQtyEntry) {
        const text = unitQtyEntry.line.text;
        const strictMatch = text.match(UNIT_QTY_RE);
        if (strictMatch) {
            pricePerUnit = parseNum(strictMatch[1]);
            quantity = parseNum(strictMatch[2]);
            const rawUnit = strictMatch[3].toLowerCase();
            // Normalize OCR variants: `kq`/`ka` → `kg`, `maišš.` → `maiš`,
            // `pakel.` → `pak`, anything else → `vnt`.
            if (rawUnit.startsWith('k')) unit = 'kg';
            else if (rawUnit.startsWith('mai')) unit = 'maiš';
            else if (rawUnit.startsWith('pak')) unit = 'pak';
            else unit = 'vnt';
        } else {
            const noUnitMatch = text.match(UNIT_QTY_NOUNIT_RE);
            if (noUnitMatch) {
                pricePerUnit = parseNum(noUnitMatch[1]);
                quantity = parseNum(noUnitMatch[2]);
                unit = 'vnt';
            } else {
                warnings.push(
                    `unit-qty tag present but no regex matched: "${text}"`,
                );
            }
        }
    }

    // promoPrice from the first discount/neg event we see. The
    // signed amount is the savings; promoPrice = price - |amount|.
    let promoPrice: number | null = null;
    for (const e of internal.postAnchor) {
        if (e.reason === 'discount-amount' || e.reason === 'bare-negative') {
            const m = e.line.text.trim().match(NEG_AMOUNT_RE);
            if (m) {
                const amount = parseNum(m[1]);
                promoPrice = Math.round((price - amount) * 100) / 100;
                break;
            }
        }
        if (e.reason === 'inline-discount') {
            const m = e.line.text.match(INLINE_NEG_AMOUNT_RE);
            if (m) {
                const amount = parseNum(m[1]);
                promoPrice = Math.round((price - amount) * 100) / 100;
                break;
            }
        }
    }

    // Reconcile self-check on bands that have an extracted unit-qty.
    // Receipt's own arithmetic: `ppu × qty` should match the printed
    // line price. Mismatch beyond €0.02 means OCR scrambled one of
    // the three numbers — log it but still emit the product.
    if (pricePerUnit !== null) {
        const expected = pricePerUnit * quantity;
        const delta = Math.abs(expected - price);
        if (delta > RECONCILE_TOLERANCE_EUR) {
            warnings.push(
                `reconcile MISMATCH: ppu=${pricePerUnit.toFixed(2)} × qty=${quantity} = ` +
                    `${expected.toFixed(2)} but price=${price.toFixed(2)} (Δ=${delta.toFixed(2)})`,
            );
        }
    }

    // Stitch raw lines + bbox region for downstream consumers.
    const allEntries: BandLineEntry[] = [
        ...internal.preName,
        internal.anchor,
        ...internal.postAnchor,
    ];
    const allLines = allEntries.map((e) => e.line);
    const region = regionOf(allLines);
    const rawLines = allLines.map((l) => l.text);

    const product: MaximaProduct = {
        name,
        price,
        promoPrice,
        quantity,
        unit,
        pricePerUnit,
        rawLines,
        region,
    };
    return { product, warnings };
}

/**
 * V2's full-receipt parser. Matches V1's `parseMaximaReceipt`
 * shape so callers can drop V2 in without changing downstream
 * code (matching service, comparison harness, etc.).
 *
 * Header and footer reuse V1's parsers verbatim — V2 owns only
 * the products array. Step 1 (band detection) and step 2
 * (per-band content extraction) feed the products field; bands
 * that resolve to deposits, plastic bags, or TAISYMAS refunds
 * are silently dropped to match what truth files contain.
 */
export function parseMaximaReceiptV2(rawLines: MaximaLine[]): MaximaParseResult {
    const ctx = computeBandsContext(rawLines);
    const header = parseHeader(ctx.processed.slice(0, ctx.headerEnd));
    const footer = parseFooter(ctx.processed.slice(ctx.footerStart));
    const products: MaximaProduct[] = [];
    for (const internal of ctx.internals) {
        const { product } = extractMaximaProduct(internal);
        if (product) products.push(product);
    }
    return { header, products, footer };
}

/**
 * Per-band extraction trace, copy-paste-friendly. Companion to
 * `traceProductBandsV2` for step 2 — same band ordering, one row
 * per band, with the extracted product fields and the reconcile
 * status inline so a single glance spots arithmetic drift.
 *
 * Format conventions:
 *   - `OK`/`WARN`/`SKIP` prefix per band
 *   - `reconcile:✓` or `reconcile:✗ Δ=X` for bands with unit-qty
 *   - `reconcile:n/a` for single-pack non-weighable rows
 *   - Multiple warnings on one band print on extra indented lines
 */
export function traceMaximaExtractV2(rawLines: MaximaLine[]): string {
    const ctx = computeBandsContext(rawLines);
    const out: string[] = [];
    out.push(`bands=${ctx.internals.length}`);
    for (const internal of ctx.internals) {
        const bandNum = internal.bandIdx + 1;
        const { product, warnings } = extractMaximaProduct(internal);
        const skipMsg = warnings.find((w) => w.startsWith('skip:'));
        if (!product) {
            // Skip + maybe additional warnings.
            const skip = skipMsg ?? 'no product emitted';
            out.push(`band ${bandNum}: SKIP ${skip}`);
            for (const w of warnings) {
                if (w === skipMsg) continue;
                out.push(`        WARN ${w}`);
            }
            continue;
        }
        // Reconcile state derived from warnings — the extractor
        // already computed it, no need to redo the math.
        const mismatch = warnings.find((w) => w.startsWith('reconcile MISMATCH'));
        let reconcile: string;
        if (product.pricePerUnit === null) {
            reconcile = 'reconcile:n/a';
        } else if (mismatch) {
            const expected = (product.pricePerUnit * product.quantity).toFixed(2);
            const delta = Math.abs(product.pricePerUnit * product.quantity - product.price).toFixed(2);
            reconcile =
                `reconcile:${product.pricePerUnit.toFixed(2)}×${product.quantity}=${expected} ✗ Δ=${delta}`;
        } else {
            const expected = (product.pricePerUnit * product.quantity).toFixed(2);
            reconcile =
                `reconcile:${product.pricePerUnit.toFixed(2)}×${product.quantity}=${expected} ✓`;
        }
        const status = mismatch ? 'WARN' : warnings.length > 0 ? 'NOTE' : 'OK';
        const promo = product.promoPrice === null ? 'null' : product.promoPrice.toFixed(2);
        const ppu = product.pricePerUnit === null ? 'null' : product.pricePerUnit.toFixed(2);
        out.push(
            `band ${bandNum}: ${status}  name="${TRUNC(product.name, 60)}"  ` +
                `price=${product.price.toFixed(2)}  promo=${promo}  ` +
                `qty=${product.quantity}  unit=${product.unit}  ppu=${ppu}  ${reconcile}`,
        );
        for (const w of warnings) {
            if (w === mismatch) continue;
            out.push(`        ${w}`);
        }
    }
    return out.join('\n');
}

export type { MaximaLine };
