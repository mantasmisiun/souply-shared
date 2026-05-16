/**
 * Rimi Receipt Parser.
 *
 * Two-step pipeline:
 *
 *   STEP 1 — Band detection across the WHOLE receipt.
 *     `findReceiptBandsRimi` returns one entry per recognised
 *     region of the receipt:
 *       - `store-name`        e.g. "UAB RIMI LIETUVA, T709"
 *       - `store-address`     e.g. "Tilžės g. 109, Šiauliai"
 *       - `product`           one band per product (anchor + name +
 *                             weight/multi-buy line + per-item
 *                             discount + bag-deposit block)
 *       - `receipt-no`        "Kvito Nr. 80/162/36162 Kasa 0037"
 *       - `datetime`          "LAIKAS YYYY-MM-DD HH:MM:SS"
 *       - `total`             "Mokėti N,NN" row
 *
 *   STEP 2 — Per-band content extraction.
 *     `extractRimiProduct` consumes one product band's typed line
 *     content and produces a `RimiProduct`. Reconcile self-check:
 *     `anchorPrice − Nuol.savings ≈ Galut.kaina` (€0.02 tolerance)
 *     when both halves of the discount row are captured by OCR;
 *     when only one half lands, the other is derived from the
 *     anchor so promoPrice still surfaces.
 *
 * Public entry points:
 *   - `parseRimiReceipt(lines)`       — full receipt (header + products + footer)
 *   - `parseRimiHeaderOnly(lines)`    — early header probe
 *   - `isRimiReceipt(lineTexts)`      — chain detection
 *   - `findReceiptBandsRimi(lines)`   — step 1 + per-product internals
 *   - `traceReceiptBandsRimi(lines)`  — step 1 trace dump (dev tool)
 *   - `traceRimiExtract(lines)`       — step 2 trace dump (dev tool)
 *
 * Convention note: `parseRimiReceipt` emits per-unit prices for
 * rows with a weight or multi-buy line — `price` ==
 * `pricePerUnit` and `promoPrice` is divided by `quantity`. The
 * line total is recovered downstream as `price × quantity`. Lower-
 * level functions (`extractRimiProduct` directly) keep raw line
 * totals; the normalization happens once at the receipt-level
 * boundary so the dev trace and reconcile self-check operate on
 * the receipt's printed numbers.
 */

export interface Region {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

/**
 * Logical kind for a parsed field's bbox. The mobile photo view groups
 * regions by kind to colour and label each band ("Suma", "Data ir
 * laikas", "Kvito Nr.", …). Add new kinds at the end so persisted
 * receipts stay forward-compatible.
 *
 * `storeName` is reserved but not currently emitted — name comes from
 * the server's store-match by address. The kind exists so future
 * parser work can label it without a new schema bump.
 */
export type RegionKind =
    | 'storeName'
    | 'storeAddress'
    | 'storeCode'
    | 'total'
    | 'date'
    | 'time'
    | 'dateTime'
    | 'receiptNo';

/** A `Region` with the logical field it covers. Used in
 *  `header.lineRegions` / `footer.lineRegions` post-Phase-6. */
export interface LabeledRegion extends Region {
    kind: RegionKind;
}

/** Input line: text plus its bounding box on the source image. */
export interface RimiLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface RimiProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
    rawLines: string[];
    region: Region;
}

export interface RimiHeader {
    chainName: string;
    storeCode: string;
    storeAddress: string;
    pvmCode: string;
    rawText: string;
    region: Region;
    /** Per-field source-line bboxes tagged with their `kind` — store
     *  code, address, etc. Mobile renders one band per entry, coloured
     *  by kind; falls back to the block-`region` bbox when empty
     *  (legacy receipts). */
    lineRegions: LabeledRegion[];
}

export interface RimiFooter {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
    region: Region;
    /** Per-field source-line bboxes tagged with their `kind` — total,
     *  date/time, receipt №. Mobile renders one band per entry,
     *  coloured by kind; falls back to `region` when empty. */
    lineRegions: LabeledRegion[];
}

export interface RimiParseResult {
    header: RimiHeader;
    products: RimiProduct[];
    footer: RimiFooter;
}

// ───────── regexes ─────────

// Positive product-price line: `X,YY A` / `X,YY B`.
const POSITIVE_PRICE_RE = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;

// Relaxed bare-price anchor for receipts where MLKit drops the
// trailing VAT letter (`0,01` instead of `0,01 A`). Used ONLY by
// findAnchors with mandatory prev-line context so deposit
// totals, Galut.kaina amounts, and other numeric noise don't
// get promoted to fake anchors. Tight `\d+[.,]\d{2}` anchored
// to start/end keeps stray numbers like `40` or `22,` out.
const RELAXED_PRICE_RE = /^\d+[.,]\d{2}$/;

// Per-item discount: `Nuol. -X,XX  Galut. kaina Y,YY`. OCR is loose
// about the comma between Galut and kaina, and stuffs whitespace
// into decimal numbers (`1, 10`).
const DISCOUNT_RE =
    /Nuo[li]\s*\.?\s*-(\d+[.,]\s?\d{2})\s+Gal[uūü]t\s*[.,]?\s*k?aina\s*(\d+[.,]\s?\d{2})/i;

// Half-discount fragments — MLKit splits the discount row at the
// column gap on some receipts, leaving each half on its own OCR
// line. Either fragment, on its own, still belongs to the
// preceding product's band. Loosened: no line-anchor `^`/`\b`
// (lets stray leading/trailing chars still match), and OCR digit
// confusions (`O`/`o` → `0`, `I`/`l` → `1`) inside the amount.
const NUOL_FRAGMENT_RE = /Nuo[li]\s*\.?\s*-\s*[\dOoIl]+[.,]\s?[\dOoIl]{1,2}/i;
const GALUT_FRAGMENT_RE = /Gal[uūü]t\s*[.,]?\s*k?aina\s*[\dOoIl]+[.,]\s?[\dOoIl]{1,2}/i;

// Weighable: `0,340 kg X 7,59 EUR/kg`.
const WEIGHT_RE = /(\d+[.,]\s?\d{1,3})\s*kg\s*[xX×]\s*(\d+[.,]\s?\d{1,2})\s*(?:EUR|€)/i;

// Multi-buy: `2 vnt X 1,99 EUR`.
const MULTI_RE = /(\d+)\s*vnt\s*\.?\s*[xX×]\s*(\d+[.,]\s?\d{1,2})\s*(?:EUR)?/i;

// Fused weight/multi anchor: MLKit occasionally emits the row's right-
// column anchor (`X,YY A`) and the row's left-column weight/multi
// detail as a single OCR line, e.g.
//   "0, 89 0,690 kg X 1,29 EUR/kg A"
// Format: leading bare price + middle weight-or-multi info + trailing
// AB letter. We split such lines into two virtual lines (the middle
// detail and a canonical `X,YY A` anchor) before band detection so
// the standard pipeline picks them up cleanly.
const FUSED_ANCHOR_RE =
    /^\s*(\d+[.,]\s?\d{2})\s+(.+?)\s+([AB])\s*$/;

// Strict YYYY-MM-DD with valid month (01-12) and day (01-31).
// Year prefix `20\d{2}` keeps Inv. Nr. hyphenated digit blobs out.
const DATE_RE = /(20\d{2})\s*-\s*(0[1-9]|1[0-2])\s*-\s*(0[1-9]|[12]\d|3[01])/;

// HH:MM:SS or HH:MM with valid hour/minute. Lookbehind dropped
// for Hermes compatibility — consume one non-digit char before
// the time instead.
const TIME_RE = /(?:^|[^\d])((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?!\d)/;

// Header signal — diacritic-stripped match so `Ė`/`Ë`/`È`/`É`/
// `Ē`/`Ě` all collapse to plain `E` for pattern matching.
const PIRKEJAS_RE = /PIRKEJAS/i;

// Footer signals — the products region ends here. MLKit sometimes
// splits "SUTEIKTOS NUOLAIDOS:" at the column gap between the two
// words, so we accept either word alone. Tested against
// stripDiacritics(text), so MLKit variants (`NƯOLAIDOS`, `Jūs`,
// `MOKĖJIMAS`) all reduce to plain ASCII before matching.
//
// `^` anchors are dropped on phrases that get prefixed by a
// stray amount column in column-split OCR — e.g. line emitted as
// "-0, 14 Panaudoti MANO RIMI pinigai" because the right-column
// amount sorted ahead of the left-column label. The phrases are
// specific enough (multi-word + brand names) not to false-match
// inside product names.
const FOOTER_SIGNAL_RE =
    /(?:SUTE[IK]+T?OS\b|\bNUOLAIDOS\b|JUS\s+SUTAUP|MOKEJIMAS\s+KORTELE|Panaudoti\s+MANO\s+RIMI|Kitos\s+akcij)/i;

// Receipt number — three flavours in priority order:
//   1. "Kvito Nr. X/Y/Z Kasa NNNN" — canonical compact form.
//   2. "Kvito numeris XXXXX" — VMI verification block fallback.
//   3. "BANKO KVITO NR. NNNNN" — bank slip, NOT the receipt no.
const RECEIPT_NO_KVITO_NR_RE = /^Kvito\s+Nr\.?\b/i;
const RECEIPT_NO_KVITO_NUMERIS_RE = /^Kvito\s+numeris\b/i;
const BANKO_KVITO_RE = /^BANKO\s+KVITO/i;

// LAIKAS line — date/time anchor.
const LAIKAS_LABEL_RE = /\bLAIKAS\b/i;

// `Mokėti` total label. Match the LABEL only — the amount lives
// on a separate OCR line on most Rimi receipts. `\b` keeps
// `Mokestis` and `Mokėtina` from false-matching.
//
// Diacritic char class is wider than just Lithuanian ė because OCR
// engines (MLKit included) sometimes substitute `ė` with `ê` (e with
// circumflex) or `ë` (e with diaeresis) when the model treats the
// Lithuanian over-dot as a generic accent. Observed in the wild on a
// PDFium-rendered Rimi receipt: the Mokėti row OCR'd as "Mokêti"
// and the strict `[eėèé]` class missed it, leaving total=null. The
// UI then fell back to the server's currentChain estimate (a wildly
// different number) which read as a parser bug to the user.
//
// Reused by parseFooter's path-1 same-line moketiMatch regex too —
// any expansion here must propagate to that regex (and to parts of
// the parser that look for Lithuanian "ė" variants in similar
// label words like `sutaupėte`).
const E_DIACRITIC_CLASS = '[eėèéêëē]';
const TOTAL_LABEL_RE = new RegExp(`^\\s*Mok${E_DIACRITIC_CLASS}ti\\b`, 'i');

// Address heuristic — primary path is the canonical street suffix
// abbreviation (`g.`/`pr.`/`al.`/`pl.`/`a.`).
const ADDRESS_RE =
    /(?:^|\s|[a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ])(g|pr|al|pl|a)\.\s/i;

// Fallback for receipts where MLKit mangles the suffix (g→9, etc).
// Universal Lithuanian address shape: a house number followed by
// a comma and a Capitalised Lithuanian-letter word (the city).
const ADDRESS_FALLBACK_RE =
    /\b\d+(?:[-/]\d+)?\s*,\s*[A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž]+/;

// Structured-extraction regexes for parseHeader. The line-test
// versions (above) gate band visualisation; these capture the
// individual pieces (street prefix, city tail) so we can rebuild
// a clean address string when MLKit splits the address across
// two lines AND glues PVM-code noise onto one of them — common
// failure mode in heavily-skewed photo OCR.
//
// STREET_PREFIX_RE allows comma in place of period after the
// suffix (`g,` instead of `g.`), and tolerates a stray comma
// between the street name and the suffix (`Gegužių, g.`). The
// letter-run also admits digits — OCR routinely substitutes
// `1` for `i`/`l` and `0` for `o` inside Lithuanian street names
// (`Gegužių` → `Geguž1ų`, `Tilžės` → `T1lžės`). The matcher's
// Levenshtein on the normalised form absorbs single-char diffs.
const STREET_PREFIX_RE =
    /([A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž\d]+)\s*[,]?\s*\b(g|pr|al|pl|a)\b\.?/;

// CITY_TAIL_RE picks out the "30, Šiauliai" component independent
// of which OCR line it lands on.
const CITY_TAIL_RE =
    /\b(\d+(?:[-/]\d+)?)\s*,\s*([A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž]+)/;

// Store-name heuristic. Rimi prints "UAB RIMI LIETUVA, T709" or
// "RIMI LIETUVA UAB, T709" — UAB + RIMI on the same line.
const STORE_NAME_RE = /\bUAB\b.*\bRIMI\b|\bRIMI\b.*\bUAB\b/i;

// Bag-deposit row — `Užstatas - vienkartinė plastiko pakuotė
// 0,10`. Used by both V1's product-name filter and V2's band
// absorption logic.
export const DEPOSIT_PATTERN = /[uūü]žstat/i;

// Deposit-name continuation keyword. Rimi's full deposit row
// reads "Užstatas - vienkartinė {metalinė|plastiko|popierinė}
// pakuotė" — when it wraps, the second OCR line contains one of
// these.
const DEPOSIT_CONT_RE = /\b(?:pakuot|metal|plastik|popier|vienkart|karton)/i;

// Bare numeric total like `0,20` — the deposit's price column,
// often emitted as its own OCR line on Rimi's column-split rows.
const BARE_PRICE_RE = /^\s*[\dOoIl]+\s*[.,]\s*[\dOoIl]{2}\s*$/;

// Checkout-only non-catalog items: disposable bags (maišelis) and
// reusable shopping bags (maišas). Charged per piece but not
// something shoppers compare prices on.
//
// Character class for the central diacritic accepts `s`/`š`/`ž`/`z`
// — MLKit confuses `š` (s+caron) with `ž` (z+caron) on some
// prints. Without `ž`/`z` in the class, "maiželis" / "maizelis"
// OCR variants slip through as products.
export const NON_CATALOG_PATTERN = /\b(?:vienkartinis|didelis|pirkini[uų])?\s*(?:plastikinis|popierinis)?\s*mai[sšžz](?:elis|as)\b/i;

// ───────── helpers ─────────

function parseNum(str: string): number {
    return parseFloat(str.replace(',', '.').replace(/\s/g, ''));
}

/**
 * Loose number parser — `,` → `.`, strips whitespace inside
 * decimals (`1, 10`), and folds OCR digit confusions (`O`/`o` → 0,
 * `I`/`l` → 1).
 */
function parseNumLoose(str: string): number {
    return parseFloat(
        str
            .replace(/,/g, '.')
            .replace(/\s/g, '')
            .replace(/[Oo]/g, '0')
            .replace(/[IlL]/g, '1'),
    );
}

/** Bounding region that covers all given lines. Empty input returns zeros. */
function regionOf(lines: RimiLine[]): Region {
    if (lines.length === 0) return { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
    return {
        yTop: Math.min(...lines.map((l) => l.yTop)),
        yBottom: Math.max(...lines.map((l) => l.yBottom)),
        xLeft: Math.min(...lines.map((l) => l.xLeft)),
        xRight: Math.max(...lines.map((l) => l.xRight)),
    };
}

/**
 * Drop combining diacritics so OCR variants of `Ė`
 * (`Ë`/`È`/`É`/`Ē`/`Ě`) collapse to plain `E` for pattern matching.
 */
const stripDiacritics = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '');

const isPositivePriceLine = (line: RimiLine): boolean => {
    const t = line.text.trim();
    if (!POSITIVE_PRICE_RE.test(t)) return false;
    if (t.startsWith('-')) return false;
    return true;
};

/**
 * If `line` is a fused weight/multi anchor (leading bare price +
 * weight-or-multi middle + trailing AB), return the two component
 * RimiLine entries (middle detail first, canonical anchor second).
 * Both inherit the original geometry so the band region still covers
 * the whole physical row. Returns null when the line is not fused.
 *
 * Guarded by an inner WEIGHT_RE/MULTI_RE check so we don't split
 * benign lines that happen to have a leading number and a trailing
 * letter (e.g. footer noise).
 */
const splitFusedAnchorLine = (line: RimiLine): [RimiLine, RimiLine] | null => {
    const trimmed = line.text.trim();
    if (POSITIVE_PRICE_RE.test(trimmed)) return null;
    const match = trimmed.match(FUSED_ANCHOR_RE);
    if (!match) return null;
    const [, priceText, middle, vat] = match;
    const middleTrim = middle.trim();
    const middleNormalized = normalizeForNumberRegex(middleTrim);
    if (!WEIGHT_RE.test(middleNormalized) && !MULTI_RE.test(middleNormalized)) return null;
    return [
        { ...line, text: middleTrim },
        { ...line, text: `${priceText} ${vat}` },
    ];
};

/**
 * Consolidate raw OCR fragments that sit on the same physical row
 * into single logical lines. The parser's per-line classifiers
 * (DISCOUNT_RE, WEIGHT_RE, etc.) need intact lines — when MLKit
 * emits the discount row as e.g. ["Nuol.-1,40", "Galut. kaina",
 * "3,09"] across three boxes, none of the fragments individually
 * matches DISCOUNT_RE, the band's forward absorption breaks at the
 * first unrecognised piece, and the discount tail leaks into the
 * NEXT product's preName.
 *
 * Same-row decided by yTop proximity AND centerY proximity (the
 * yTop check alone admits skewed-photo adjacent rows whose bboxes
 * happen to overlap; centerY filters those out — same physical row
 * has centers within a few pixels, adjacent rows ~one row-height
 * apart).
 *
 * Price-like fragments stay separate from text:
 *   - both anchor (`X,YY A`) and bare-price (`X,YY`) lines are
 *     preserved so band detection can still see the anchor.
 *   - exception: a single VAT letter (`A`/`B`) on the same row as
 *     a bare-price fragment is glued back onto the price, since
 *     that's just an MLKit anchor split — `4,49` + `A` becomes
 *     the canonical `4,49 A` form.
 *   - when last is anchor/price and current is text, the text is
 *     spliced BEFORE last so left-column wraps end up in preName.
 *
 * Mirrors the merge behaviour the analize screen used to apply
 * outside the parser, but kept inside so batch / dev paths benefit
 * too and the screen can keep passing raw allLines.
 */
const ROW_MERGE_YTOP_THRESHOLD_PX = 30;
const ROW_MERGE_CENTER_RATIO = 0.4;
const VAT_LETTER_RE = /^[AB]$/;
const BARE_PRICE_FRAGMENT_RE = /^\s*\d+[.,]\s?\d{2}\s*$/;

const isPriceLikeFragment = (line: RimiLine): boolean => {
    const t = line.text.trim();
    return POSITIVE_PRICE_RE.test(t) || BARE_PRICE_FRAGMENT_RE.test(t);
};

const mergeRowFragments = (rawLines: RimiLine[]): RimiLine[] => {
    const sorted = [...rawLines].sort((a, b) => a.yTop - b.yTop);
    const out: RimiLine[] = [];
    for (const line of sorted) {
        if (out.length === 0) {
            out.push({ ...line });
            continue;
        }
        const last = out[out.length - 1];
        const yTopDiff = Math.abs(line.yTop - last.yTop);
        if (yTopDiff >= ROW_MERGE_YTOP_THRESHOLD_PX) {
            out.push({ ...line });
            continue;
        }
        const minH = Math.min(
            line.yBottom - line.yTop,
            last.yBottom - last.yTop,
        );
        const centerDist = Math.abs(
            (line.yTop + line.yBottom) / 2 -
                (last.yTop + last.yBottom) / 2,
        );
        if (minH <= 0 || centerDist >= minH * ROW_MERGE_CENTER_RATIO) {
            out.push({ ...line });
            continue;
        }

        const lineText = line.text.trim();
        const lastText = last.text.trim();
        const lineIsVat = VAT_LETTER_RE.test(lineText);
        const lastIsVat = VAT_LETTER_RE.test(lastText);
        const lineIsPrice = isPriceLikeFragment(line);
        const lastIsPrice = isPriceLikeFragment(last);

        // VAT letter + bare-price fragment on the same row → an
        // MLKit-split anchor. Glue back into canonical "X,YY A".
        if (lineIsVat && lastIsPrice) {
            last.text = `${lastText} ${lineText}`;
            last.yBottom = Math.max(last.yBottom, line.yBottom);
            last.xRight = Math.max(last.xRight, line.xRight);
            continue;
        }
        if (lastIsVat && lineIsPrice) {
            last.text = `${lineText} ${lastText}`;
            last.yTop = Math.min(last.yTop, line.yTop);
            last.yBottom = Math.max(last.yBottom, line.yBottom);
            last.xLeft = Math.min(last.xLeft, line.xLeft);
            last.xRight = Math.max(last.xRight, line.xRight);
            continue;
        }

        // Price-like fragment vs text: keep separate so band
        // detection still sees the price as an anchor candidate.
        if (lineIsPrice && !lastIsPrice) {
            out.push({ ...line });
            continue;
        }
        if (!lineIsPrice && lastIsPrice) {
            out.splice(out.length - 1, 0, { ...line });
            continue;
        }
        if (lineIsPrice && lastIsPrice) {
            out.push({ ...line });
            continue;
        }

        // Two same-row plain-text boxes can be either:
        //   (a) column fragments to concatenate (left column + right
        //       column of the same physical row), OR
        //   (b) duplicate OCR readings of the same physical row that
        //       MLKit emitted twice with slightly different character
        //       recognition (iOS quirk on faded thermal-print rows).
        //
        // Distinguishing them needs both x-overlap and text similarity:
        //   - column fragments: separate x-ranges (gap between them),
        //     dissimilar text content
        //   - duplicates:        overlapping x-ranges (same column),
        //     near-identical text differing only by digit-confusion
        //     substitutions
        //
        // When both signals agree it's a duplicate, drop the new
        // reading and expand the existing bbox; otherwise fall
        // through to the column-fragment concatenation below.
        const lastW = last.xRight - last.xLeft;
        const lineW = line.xRight - line.xLeft;
        const xOverlap = Math.max(
            0,
            Math.min(last.xRight, line.xRight) - Math.max(last.xLeft, line.xLeft),
        );
        const minW = Math.min(lastW, lineW);
        const xOverlapRatio = minW > 0 ? xOverlap / minW : 0;

        // Position-aligned char-overlap as a cheap similarity proxy.
        // OCR duplicate variants typically differ by 1-2 character
        // substitutions at the same position (e.g. "UŽspaudžiami" vs
        // "UŽspaudžiani"), which scores ~95% here. Two genuinely
        // different texts score below ~50% even when lengths align.
        let positionMatches = 0;
        const minLen = Math.min(lastText.length, lineText.length);
        for (let k = 0; k < minLen; k++) {
            if (lastText[k] === lineText[k]) positionMatches++;
        }
        const maxLen = Math.max(lastText.length, lineText.length);
        const textSim = maxLen > 0 ? positionMatches / maxLen : 0;

        if (xOverlapRatio > 0.5 && textSim > 0.7) {
            // Duplicate — keep the first-seen reading, expand bounds.
            last.yTop = Math.min(last.yTop, line.yTop);
            last.yBottom = Math.max(last.yBottom, line.yBottom);
            last.xLeft = Math.min(last.xLeft, line.xLeft);
            last.xRight = Math.max(last.xRight, line.xRight);
            continue;
        }

        // Column fragments → consolidate. Order the concatenation by
        // xLeft (visual reading order) so boxes glue back into row
        // order, not whatever order MLKit emitted. iOS MLKit on
        // multi-unit rows often emits the right column ("x 4,95 EUR")
        // before the left ("2 vnt.") when both share a yTop; a
        // yTop-sorted concat would yield "x 4,95 EUR 2 vnt." which
        // breaks MULTI_RE downstream and leaks the price column into
        // the displayed name. xLeft order recovers "2 vnt. x 4,95
        // EUR" → MULTI_RE matches. Android is unaffected: one box
        // per row, this branch never fires.
        const merged = last.xLeft <= line.xLeft
            ? `${lastText} ${lineText}`
            : `${lineText} ${lastText}`;
        last.text = merged.replace(/\s+/g, ' ').trim();
        last.yTop = Math.min(last.yTop, line.yTop);
        last.yBottom = Math.max(last.yBottom, line.yBottom);
        last.xLeft = Math.min(last.xLeft, line.xLeft);
        last.xRight = Math.max(last.xRight, line.xRight);
    }
    return out;
};

// Pre-normalise the line before testing weight/multi regexes:
//   - stripDiacritics: OCR variants of `EUR` (e.g. `EỦR`, `EŪR`)
//     still match the trailing currency anchor.
//   - ocrDigitClass: OCR confusions in digit positions (`o`→`0`,
//     `l`→`1`) — Rimi receipts often emit `2 vnt. X o,65 EUR` or
//     `0,138 kg X 4,99 EUR` where MLKit gives back letter chars
//     for digits in the price column. Without normalising, the
//     regex's `\d+` anchors fail and the line falls through into
//     name-fragment territory, polluting the displayed name and
//     dropping pricePerUnit/quantity/unit.
// Both substitutions are safe in this context because the regexes
// require the surrounding `kg X` / `vnt X` shape, so a non-numeric
// line ("Galut. kaina" → "Ga1ut. kaina") still doesn't match.
const ocrDigitClass = (s: string): string =>
    s.replace(/[Oo]/g, '0').replace(/[lI]/g, '1');
// Collapse runs of decimal separators ("8,,99" → "8,99", "8..99" → "8.99",
// "8,.99" → "8,99"). MLKit on iOS occasionally emits an extra comma or
// period adjacent to a real one when the thermal-print dot bleeds into
// the next pixel column — the second separator looks like a glyph but
// belongs to the same decimal. Display text keeps the raw form (we don't
// mutate name characters); this only affects pre-regex normalization
// for WEIGHT_RE / MULTI_RE matching, which is what blocks rows like
// `0,230 kg X 8,,99 EUR/ kg` from being recognised as weight lines and
// leaks them into the displayed name.
const collapseRepeatedSep = (s: string): string =>
    s.replace(/([.,])[.,]+/g, '$1');
const normalizeForNumberRegex = (s: string): string =>
    ocrDigitClass(stripDiacritics(collapseRepeatedSep(s)));

const isWeightOrMultiLine = (line: RimiLine): boolean => {
    const t = normalizeForNumberRegex(line.text);
    return WEIGHT_RE.test(t) || MULTI_RE.test(t);
};

const isDiscountLine = (line: RimiLine): boolean => {
    const t = line.text.trim();
    if (DISCOUNT_RE.test(t)) return true;
    if (NUOL_FRAGMENT_RE.test(t)) return true;
    if (GALUT_FRAGMENT_RE.test(t)) return true;
    return false;
};

const isDepositLine = (line: RimiLine): boolean =>
    DEPOSIT_PATTERN.test(line.text);

// ───────── detection ─────────

export function isRimiReceipt(lines: string[]): boolean {
    const first15 = lines.slice(0, 15).join(' ').toUpperCase();
    return first15.includes('RIMI');
}

// ───────── section boundaries ─────────

function findHeaderEnd(lines: RimiLine[]): number {
    for (let i = 0; i < Math.min(lines.length, 25); i++) {
        if (!PIRKEJAS_RE.test(stripDiacritics(lines[i].text))) continue;
        // Skip every line whose y-range overlaps the PIRKĖJAS row
        // by ≥50% of the shorter line's height. MLKit emits the
        // row as multiple text blocks (label, masked PAN,
        // occasional short digit/glyph fragments at arbitrary x);
        // they all share the same physical row but arrive on
        // different OCR-line indices. Text-pattern matching alone
        // couldn't catch them all (some fragments are too short or
        // not even X/digit shapes). The y-overlap test covers them
        // uniformly.
        const ref = lines[i];
        const refH = ref.yBottom - ref.yTop;
        let next = i + 1;
        while (next < lines.length) {
            const cand = lines[next];
            const candH = cand.yBottom - cand.yTop;
            const overlap =
                Math.min(cand.yBottom, ref.yBottom) -
                Math.max(cand.yTop, ref.yTop);
            const minH = Math.min(refH, candH);
            if (minH <= 0 || overlap < minH * 0.5) break;
            next++;
        }
        return next;
    }
    // Fallback: stop two lines before the first standalone price.
    for (let i = 0; i < lines.length; i++) {
        if (POSITIVE_PRICE_RE.test(lines[i].text.trim())) {
            return Math.max(0, i - 2);
        }
    }
    return Math.min(8, lines.length);
}

function findFooterStart(lines: RimiLine[], afterIdx: number): number {
    for (let i = afterIdx; i < lines.length; i++) {
        if (FOOTER_SIGNAL_RE.test(stripDiacritics(lines[i].text))) return i;
    }
    return lines.length;
}

// ───────── header bands (store name + address) ─────────

/**
 * Walk the header slice, tag the first store-name and store-address
 * lines we recognise. Each becomes a single-line band.
 *
 * Address detection: prefer the strict suffix path (`g.`/`pr.`/…)
 * when it matches, otherwise fall back to "house-number + comma +
 * Capitalised city" — the universal LT-address shape that survives
 * OCR mangling of the suffix abbreviation.
 */
function findHeaderBands(headerSlice: RimiLine[]): RimiReceiptBand[] {
    const out: RimiReceiptBand[] = [];
    let foundName = false;
    let foundAddress = false;
    let addressFallbackCandidate: RimiLine | null = null;
    for (const line of headerSlice) {
        const text = line.text.trim();
        if (!foundName && STORE_NAME_RE.test(text)) {
            out.push({
                kind: 'store-name',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'store',
            });
            foundName = true;
            continue;
        }
        if (foundAddress || /UAB|RIMI|PVM|PIRK/i.test(text)) continue;
        if (ADDRESS_RE.test(text)) {
            out.push({
                kind: 'store-address',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'addr',
            });
            foundAddress = true;
            continue;
        }
        if (
            addressFallbackCandidate === null &&
            ADDRESS_FALLBACK_RE.test(text)
        ) {
            addressFallbackCandidate = line;
        }
    }
    if (!foundAddress && addressFallbackCandidate) {
        out.push({
            kind: 'store-address',
            yTop: addressFallbackCandidate.yTop,
            yBottom: addressFallbackCandidate.yBottom,
            label: 'addr',
        });
    }
    return out;
}

// ───────── header / footer parsers ─────────

export function parseHeader(lines: RimiLine[]): RimiHeader {
    let storeCode = '';
    let pvmCode = '';

    // Collect address pieces independently. MLKit can split the
    // address across two lines (e.g. "Gegužių, g,s LM237 153113"
    // on one line, "30, Šiauliai" on the next) and even glue PVM
    // code digits onto the street line. Pulling out just the
    // captured street prefix + city tail and re-stitching gives
    // the API matcher clean input regardless of OCR layout.
    let streetName = '';
    let streetSuffix = '';
    let houseNumber = '';
    let city = '';

    // Per-line region tracker: when a line yields a captured field
    // (store identity, street, house/city), record its bbox once so
    // the Kvitas-tab photo can show precise bands instead of one
    // big block over the whole header. Each entry is tagged with its
    // `kind` so the mobile renderer can colour and label per field.
    const seen = new Set<string>();
    const lineRegions: LabeledRegion[] = [];
    const trackLine = (line: RimiLine, kind: RegionKind) => {
        const key = `${kind}:${line.yTop}:${line.xLeft}`;
        if (seen.has(key)) return;
        seen.add(key);
        lineRegions.push({
            kind,
            yTop: line.yTop,
            yBottom: line.yBottom,
            xLeft: line.xLeft,
            xRight: line.xRight,
        });
    };

    for (const line of lines) {
        const text = line.text.trim();
        const codeMatch = text.match(/\bT(\d{3,4})\b/);
        if (codeMatch && /RIMI|LIETUVA/i.test(text)) {
            storeCode = 'T' + codeMatch[1];
            trackLine(line, 'storeCode');
        }

        const pvmMatch = text.match(/(LT|IT)\d{9,12}/);
        if (pvmMatch) pvmCode = pvmMatch[0];

        // Skip lines we know aren't addresses to avoid picking up
        // stray "RIMI" or "PIRK" matches as street names.
        if (/UAB|RIMI|PVM|PIRK|Elektroninis/i.test(text)) continue;

        if (!streetName) {
            const sm = text.match(STREET_PREFIX_RE);
            if (sm) {
                streetName = sm[1];
                streetSuffix = sm[2].toLowerCase();
                trackLine(line, 'storeAddress');
            }
        }
        if (!houseNumber) {
            const cm = text.match(CITY_TAIL_RE);
            if (cm) {
                houseNumber = cm[1];
                city = cm[2];
                trackLine(line, 'storeAddress');
            }
        }
    }

    let storeAddress = '';
    if (streetName && houseNumber) {
        storeAddress = `${streetName} ${streetSuffix}. ${houseNumber}, ${city}`;
    } else if (streetName) {
        storeAddress = `${streetName} ${streetSuffix}.`;
    } else if (houseNumber) {
        storeAddress = `${houseNumber}, ${city}`;
    }

    lineRegions.sort((a, b) => a.yTop - b.yTop);
    return {
        chainName: 'RIMI',
        storeCode,
        storeAddress,
        pvmCode,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
        lineRegions,
    };
}

/**
 * Strip "previous-item residue" from the start of a product name.
 *
 * When a per-item discount row (`Nuol. -X,XX Galut. kaina Y,YY`)
 * OCRs onto the same line as the next product's name, the
 * walking-back logic lumps it all into the name. Same happens
 * with the Mano Rimi loyalty-card masked PAN
 * (`XXXXXXXXXXXXXXX9631`) at the very start of the receipt body.
 *
 * Strategy: find the last occurrence of a discount marker and cut
 * everything up through it — the product name starts right after.
 */
function stripLeadingDiscountNoise(name: string): string {
    let s = name;
    s = s.replace(/^[KX][KXжk]{3,}\s*[\dOIl]{0,8}(?:\s+\d)?\s*/i, '');
    const markerRe = /(Nuol\s*\.?\s*-?\s*\d+[.,]\s?\d+|Gal[uūü]t\s*\.?\s*k?aina\s*[\dl][.,]\s?\d+)/gi;
    let lastEnd = -1;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(s)) !== null) {
        lastEnd = m.index + m[0].length;
    }
    if (lastEnd > 0) s = s.slice(lastEnd);
    return s.trim();
}

export function cleanProductName(name: string): string {
    let cleaned = stripLeadingDiscountNoise(name);
    cleaned = cleaned
        .replace(/,?\s*\d+[\.,]?\d*\s*(g|kg|ml|l|vnt\.?|rit\.?)\s*$/i, '')
        .trim();
    cleaned = cleaned.replace(/\s+\d+(kg|g|ml|l)\s*$/i, '').trim();
    cleaned = cleaned.replace(/,\s*$/, '').trim();
    return cleaned;
}

export function parseFooter(lines: RimiLine[]): RimiFooter {
    let total: number | null = null;
    let date = '';
    let time = '';
    let receiptNo = '';
    let totalSavings: number | null = null;

    // Per-line region tracker (see parseHeader). Captures the lines
    // that yielded total / date / time / receiptNo so the photo view
    // bands each one precisely. Tagged with `kind` for per-field
    // colour + label on the mobile renderer.
    const seen = new Set<string>();
    const lineRegions: LabeledRegion[] = [];
    const trackLine = (line: RimiLine | undefined, kind: RegionKind) => {
        if (!line) return;
        const key = `${kind}:${line.yTop}:${line.xLeft}`;
        if (seen.has(key)) return;
        seen.add(key);
        lineRegions.push({
            kind,
            yTop: line.yTop,
            yBottom: line.yBottom,
            xLeft: line.xLeft,
            xRight: line.xRight,
        });
    };

    // OCR digit confusions on Rimi: `1`↔`l`/`I`, `0`↔`O`/`o`. Both
    // halves of the amount need to tolerate them — receipts in the
    // wild produce things like "Mokėti 25, O4" (cents read `O4`) and
    // "Mokėti 22,r 18" (a stray `r` between the decimal and cents).
    // Separator: one comma/period/space anchor followed by any
    // non-digit junk, so the cents pair stays attached.
    const ocrDigit = (s: string): string =>
        s.replace(/[lI]/g, '1').replace(/[Oo]/g, '0');
    const DIGIT_CHARS = '\\dOoIl';
    const SEPARATOR = `[.,\\s][^${DIGIT_CHARS}]*`;

    // AMOUNT_RE accepts trailing junk (currency code, VAT letter, OCR
    // smudge) — anchored start so a stray prefix can't slide the
    // integer into the cents; tail is lenient because Rimi prints
    // amounts as "25,04 EUR" or "25,04 A" depending on layout.
    const AMOUNT_RE = new RegExp(
        `^([${DIGIT_CHARS}]+)${SEPARATOR}([${DIGIT_CHARS}]{2})(?:\\b|$)`,
    );
    const parseAmount = (s: string): number | null => {
        const m = s.trim().match(AMOUNT_RE);
        if (!m) return null;
        const intVal = parseInt(ocrDigit(m[1]), 10);
        if (isNaN(intVal)) return null;
        return parseFloat(intVal + '.' + ocrDigit(m[2]));
    };

    for (let i = 0; i < lines.length; i++) {
        const text = lines[i].text.trim();

        // Path 1: same-line "Mokėti N,NN". Uses the expanded diacritic
        // class so OCR variants like "Mokêti"/"Mokëti" still match.
        // The `total === null` guard prevents a later partial-match
        // (e.g. on a Mokestis-derived line that slips through) from
        // overwriting the first canonical match.
        const moketiMatch = text.match(
            new RegExp(
                `Mok${E_DIACRITIC_CLASS}ti\\s+([${DIGIT_CHARS}]+)${SEPARATOR}([${DIGIT_CHARS}]{2})`,
                'i',
            ),
        );
        if (moketiMatch && total === null) {
            const intVal = parseInt(ocrDigit(moketiMatch[1]), 10);
            const cents = ocrDigit(moketiMatch[2]);
            if (!isNaN(intVal)) {
                total = parseFloat(intVal + '.' + cents);
                trackLine(lines[i], 'total');
            }
        }

        // "Mokėti" label scan — three layouts in the wild:
        //   A) Same physical row, two OCR boxes: `Mokėti   25,04`.
        //      Identified by y-RANGE OVERLAP between ml and cand
        //      (more lenient than the previous center-distance check
        //      which rejected pairs with mismatched text heights).
        //   B) Stacked-but-nearby: `Mokėti` on one row, `25,04` on
        //      the next. Forward-scan within a few lines.
        //   C) MLKit DROPPED the integer half of the amount entirely
        //      (observed on a PDFium-rendered Rimi receipt: the bold
        //      "6,89" was OCR'd as just "89" with no separator, so
        //      parseAmount can't recover it). Fall back to the FIRST
        //      parseable amount further down the footer — typically
        //      the VAT row's Suma-su-PVM column, which equals total.
        //      The forward scan is bounded so unrelated content
        //      below the footer can't false-positive.
        //
        // Uses TOTAL_LABEL_RE (word-boundary, not strict end-anchor)
        // so OCR-trailing tokens like "Mokėti EUR" / "Mokėti :" still
        // trigger the scan.
        //
        // trackLine(ml, 'total') runs UNCONDITIONALLY when the label
        // is found — mirrors V2's `findReceiptBandsRimi` semantics so
        // the band is always emitted even if no amount can be
        // extracted from nearby lines. Without this the receipt-
        // detail view shows no Suma band on receipts whose amount
        // OCR is broken, even though V2 finds the label cleanly.
        if (TOTAL_LABEL_RE.test(text) && total === null) {
            const ml = lines[i];
            trackLine(ml, 'total');
            const isSameRow = (cand: RimiLine): boolean =>
                Math.max(ml.yTop, cand.yTop) < Math.min(ml.yBottom, cand.yBottom);

            let chosenCand: RimiLine | undefined;
            let chosenAmount: number | null = null;

            // Pass A — same-row scan (canonical Rimi layout).
            for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) {
                if (k === i) continue;
                const cand = lines[k];
                if (!isSameRow(cand)) continue;
                const amount = parseAmount(cand.text);
                if (amount !== null) {
                    chosenCand = cand;
                    chosenAmount = amount;
                    break;
                }
            }

            // Pass B — forward scan up to 10 lines past Mokėti.
            // Walks forward only so a discount/savings row above
            // can't false-positive. Stops at the `Kvito Nr.` line
            // (definitive end of the total/payment block) so
            // unrelated amounts further down can't slip in.
            if (chosenAmount === null) {
                const KVITO_NR_STOP = /^Kvito\s+Nr/i;
                for (let k = i + 1; k <= Math.min(lines.length - 1, i + 10); k++) {
                    const cand = lines[k];
                    if (KVITO_NR_STOP.test(cand.text.trim())) break;
                    const amount = parseAmount(cand.text);
                    if (amount !== null) {
                        chosenCand = cand;
                        chosenAmount = amount;
                        break;
                    }
                }
            }

            if (chosenAmount !== null && chosenCand) {
                total = chosenAmount;
                trackLine(chosenCand, 'total');
            }
        }

        if (!date) {
            const dt = text.match(
                /(\d{4}-\d{2}-\d{2})\s+(\d{2}\s?:\s?\d{2}\s?:\s?\d{2})/,
            );
            if (dt) {
                date = dt[1];
                time = dt[2].replace(/\s/g, '');
                trackLine(lines[i], 'dateTime');
            } else {
                // Column-split fallback: the printed footer often has
                // `LAIKAS  YYYY-MM-DD  HH:MM:SS` or `CR-XXXXX  YYYY-MM-DD HH:MM:SS`
                // on a single physical row, but MLKit can emit the
                // label / date / time as up to three separate text
                // boxes. If this line carries one half, scan nearby
                // lines (±3) for the other half on the same y-row.
                const dateOnly = text.match(/(\d{4}-\d{2}-\d{2})/);
                const timeOnly = text.match(
                    /(?:^|[^\d])((?:[01]\d|2[0-3])\s?:\s?[0-5]\d\s?:\s?[0-5]\d)(?!\d)/,
                );
                if (dateOnly || timeOnly) {
                    const ml = lines[i];
                    const mlCenter = (ml.yTop + ml.yBottom) / 2;
                    const mlH = ml.yBottom - ml.yTop;
                    let foundDate = dateOnly ? dateOnly[1] : '';
                    let foundTime = timeOnly ? timeOnly[1].replace(/\s/g, '') : '';
                    let dateLine: RimiLine | undefined = dateOnly ? ml : undefined;
                    let timeLine: RimiLine | undefined = timeOnly ? ml : undefined;
                    for (
                        let k = Math.max(0, i - 3);
                        k <= Math.min(lines.length - 1, i + 3);
                        k++
                    ) {
                        if (k === i) continue;
                        const cand = lines[k];
                        const candCenter = (cand.yTop + cand.yBottom) / 2;
                        const candH = cand.yBottom - cand.yTop;
                        const minH = Math.min(mlH, candH);
                        if (minH <= 0) continue;
                        if (Math.abs(candCenter - mlCenter) >= minH * 0.5) continue;
                        if (!foundDate) {
                            const m = cand.text.match(/(\d{4}-\d{2}-\d{2})/);
                            if (m) {
                                foundDate = m[1];
                                dateLine = cand;
                            }
                        }
                        if (!foundTime) {
                            const m = cand.text.match(
                                /(?:^|[^\d])((?:[01]\d|2[0-3])\s?:\s?[0-5]\d\s?:\s?[0-5]\d)(?!\d)/,
                            );
                            if (m) {
                                foundTime = m[1].replace(/\s/g, '');
                                timeLine = cand;
                            }
                        }
                        if (foundDate && foundTime) break;
                    }
                    if (foundDate && foundTime) {
                        date = foundDate;
                        time = foundTime;
                        // dateLine and timeLine may be the same physical
                        // line (combined date+time bbox) — `trackLine`'s
                        // dedup uses kind+coords so we tag the combined
                        // case as `dateTime` and the split case with
                        // distinct `date`/`time` kinds so the renderer
                        // can colour both halves identically.
                        if (dateLine && timeLine && dateLine === timeLine) {
                            trackLine(dateLine, 'dateTime');
                        } else {
                            trackLine(dateLine, 'date');
                            trackLine(timeLine, 'time');
                        }
                    }
                }
            }
        }

        // ReceiptNo: anchor to start of line so "BANKO KVITO NR. NNNN"
        // (bank slip — not the receipt no) doesn't false-positive. Two
        // canonical forms — `Kvito Nr. X/Y/Z Kasa NNNN` and `Kvito
        // numeris XXXXX`. Both use the pre-defined anchored regexes
        // at the top of the file so the BANKO guard is single-source.
        //
        // Rimi receipt numbers are pure digits + slashes — any letter
        // chars (l, I, O, o) the OCR emits are misreads of 1 / 1 / 0 /
        // 0. Normalise via ocrDigit before storing so the displayed
        // receiptNo doesn't contain stray letters (and so DB lookups
        // that compare against fresh OCR output still match).
        if (!receiptNo && !BANKO_KVITO_RE.test(text) && RECEIPT_NO_KVITO_NR_RE.test(text)) {
            const tail = text.replace(/^Kvito\s+Nr\.?\s*/i, '');
            const cleaned = ocrDigit(
                tail
                    .replace(/\s*Kasa\s+\d+.*$/i, '')
                    .replace(/\s+/g, '')
                    .trim(),
            );
            if (cleaned) {
                receiptNo = cleaned;
                trackLine(lines[i], 'receiptNo');
            }
        }

        if (!receiptNo && !BANKO_KVITO_RE.test(text) && RECEIPT_NO_KVITO_NUMERIS_RE.test(text)) {
            const m = text.match(/^Kvito\s+numeris\s+(\d+)/i);
            if (m) {
                receiptNo = ocrDigit(m[1]);
                trackLine(lines[i], 'receiptNo');
            }
        }

        // Same OCR diacritic resilience as Mokėti — `sutaupėte`
        // sometimes OCRs as `sutaupête`.
        if (new RegExp(`sutaup${E_DIACRITIC_CLASS}te`, 'i').test(text)) {
            const s = text.match(/(\d+[.,]\d{2})/);
            if (s) totalSavings = parseNum(s[1]);
            else if (i + 1 < lines.length) {
                const ns = lines[i + 1].text.trim().match(/(\d+[.,]\d{2})/);
                if (ns) totalSavings = parseNum(ns[1]);
            }
        }
    }

    lineRegions.sort((a, b) => a.yTop - b.yTop);
    return {
        total,
        date,
        time,
        receiptNo,
        totalSavings,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
        lineRegions,
    };
}

// ───────── band model (internal) ─────────
//
// Architecture: HARD WALLS. Anchors (positive-price lines) define
// band centers. The midpoint between consecutive anchors is the
// physical wall. Every line in the product slice is assigned to
// exactly one band based on whether its y-center falls inside that
// band's walls — there is no absorption rule that lets a line drift
// across a wall, no "same-row continuation" that can pull the next
// product's name into the previous band. Anchor-rule misfires can
// still attach a line to the wrong band, but ONLY if its yCenter
// physically sits inside that band's wall range. A draw on the
// dev overlay = the exact extraction boundary.

interface ProductBandInternal {
    anchorIdx: number;
    /** Top wall in productSlice y-space. Lines with center > topWall belong here. */
    topWall: number;
    /** Bottom wall. Lines with center <= bottomWall belong here. */
    bottomWall: number;
}

/**
 * Identify product anchors. Strict path is the canonical
 * `X,YY A`/`X,YY B` price line. Relaxed path accepts `X,YY`
 * without the VAT letter (OCR drop) WHEN the previous line is
 * name-like and not already a discount/weight/deposit/another
 * anchor — this is what catches plastic-bag rows
 * (`Plastikinis maišelis ... 0,01`) when MLKit drops the `A`.
 */
function findProductAnchors(productSlice: RimiLine[]): number[] {
    const anchors: number[] = [];
    for (let i = 0; i < productSlice.length; i++) {
        const line = productSlice[i];
        const prev = i > 0 ? productSlice[i - 1] : null;
        if (isPositivePriceLine(line)) {
            anchors.push(i);
            continue;
        }
        if (!RELAXED_PRICE_RE.test(line.text.trim())) continue;
        if (!prev) continue;
        if (isPositivePriceLine(prev)) continue;
        if (isDiscountLine(prev)) continue;
        if (isWeightOrMultiLine(prev)) continue;
        if (isDepositLine(prev)) continue;
        if (!/\p{L}/u.test(prev.text)) continue;
        // iOS MLKit sometimes drops the trailing unit letter off an
        // amount column ("1,51 l" → "1,51"), leaving a bare X,YY line
        // between the row's two name fragments. With a name-like prev,
        // the relaxed branch above would accept it as a price anchor —
        // stealing the row's real anchor from the strict `X,YY A` line
        // that follows. Defer to the strict anchor: if one appears
        // within the next two lines with no intervening structural
        // line (discount/weight/multi/deposit), drop this candidate.
        let foundStrictAhead = false;
        for (let k = i + 1; k <= i + 2 && k < productSlice.length; k++) {
            const ahead = productSlice[k];
            if (isPositivePriceLine(ahead)) { foundStrictAhead = true; break; }
            if (isDiscountLine(ahead)) break;
            if (isWeightOrMultiLine(ahead)) break;
            if (isDepositLine(ahead)) break;
        }
        if (foundStrictAhead) continue;
        anchors.push(i);
    }
    return anchors;
}

/**
 * Build hard-walled product bands. The wall between bands is placed
 * in the gap between the previous band's POST-ANCHOR TAIL and the
 * next band's FIRST PRENAME LINE.
 *
 * The tail is determined by content classification (discount,
 * weight/multi, deposit) of lines below the anchor — the same
 * categorisation extractRimiProduct uses, so a line marked as
 * postAnchor here will also be reachable as postAnchor downstream.
 * No "same-row absorption" rule, no relaxed-name-like absorption:
 * the only lines that extend a band below its anchor are ones whose
 * text matches a postAnchor regex.
 *
 * Once tails are known, the wall = midpoint between (max tail yBottom)
 * and (yTop of the first line that's NOT in the current tail and
 * sits below it). The first band's top wall is -∞; the last band's
 * bottom wall is +∞.
 */
function findProductBandsInternal(productSlice: RimiLine[]): ProductBandInternal[] {
    const anchorIdxs = findProductAnchors(productSlice);
    if (anchorIdxs.length === 0) return [];

    // For each anchor, scan downward through productSlice and collect
    // tail-eligible lines. Stops at the next anchor OR the first line
    // we don't recognise (= start of next product).
    //
    // Three classes of tail content:
    //   1. Discount       — "Nuol. -X,XX Galut. kaina Y,YY" (or fragments)
    //   2. Weight / multi — "0,690 kg X 1,29 EUR/kg" / "2 vnt. X 1,09 EUR"
    //   3. Deposit row    — Rimi prints the bag-deposit ("Užstatas …
    //      vienkartinė metalinė pakuotė") as 2-4 separate OCR lines:
    //        deposit-name      ← matches DEPOSIT_PATTERN ([uūü]žstat)
    //        wrap (×0-2)       ← "metalinė pakuotė" / "vienkartinė …"
    //                            (DEPOSIT_CONT_RE)
    //        qty               ← "2 vnt. X 0,10 EUR" (weight/multi)
    //        total             ← "0,20" (bare price)
    //      None of the continuation lines individually match
    //      DEPOSIT_PATTERN, so we need a depositSeen flag and an
    //      explicit phased absorption — otherwise the wrap leaks
    //      into the NEXT product's band as preName.
    const tailBottoms: number[] = [];
    for (let bi = 0; bi < anchorIdxs.length; bi++) {
        const anchorIdx = anchorIdxs[bi];
        const anchor = productSlice[anchorIdx];
        const nextAnchorTop = bi + 1 < anchorIdxs.length
            ? productSlice[anchorIdxs[bi + 1]].yTop
            : Number.POSITIVE_INFINITY;

        let lastBottom = anchor.yBottom;
        let depositSeen = false;
        let depositWraps = 0;
        let depositTotalAbsorbed = false;

        for (let k = anchorIdx + 1; k < productSlice.length; k++) {
            const line = productSlice[k];
            if (line.yTop >= nextAnchorTop) break;
            if (anchorIdxs.includes(k)) break;

            if (isDepositLine(line)) {
                depositSeen = true;
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            if (isDiscountLine(line)) {
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            if (isWeightOrMultiLine(line)) {
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            // Deposit continuation: wrap text like "metalinė pakuotė".
            // Only counts AFTER we've seen a deposit-name line, capped
            // at 2 wraps so we don't runaway into the next product.
            if (depositSeen && depositWraps < 2 && DEPOSIT_CONT_RE.test(line.text)) {
                depositWraps++;
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            // Deposit total: a bare-price fragment ("0,20") that
            // shows up after the deposit name + wrap + qty. Only
            // accepted when depositSeen is set so a stray bare price
            // in the next product's preName can't trigger it.
            if (depositSeen && !depositTotalAbsorbed && BARE_PRICE_RE.test(line.text.trim())) {
                depositTotalAbsorbed = true;
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            break;
        }
        tailBottoms.push(lastBottom);
    }

    const bands: ProductBandInternal[] = [];
    for (let bi = 0; bi < anchorIdxs.length; bi++) {
        const anchorIdx = anchorIdxs[bi];
        let topWall: number;
        if (bi === 0) {
            topWall = Number.NEGATIVE_INFINITY;
        } else {
            // Reuse the previous band's bottom wall — they share the wall.
            topWall = bands[bi - 1].bottomWall;
        }
        // Bottom wall = midpoint between this band's tail bottom and
        // the next line's top. Crucially: the LAST band uses the same
        // rule (clamped to its own tail bottom), NOT +∞ — otherwise
        // any post-receipt noise like "Virtualus kup. 996…" or other
        // metadata between the last anchor and the footer marker
        // would sweep into the last band.
        //
        // The next-line eligibility check uses the candidate's
        // y-CENTER, not its yTop. The next product's first name line
        // routinely has yTop equal to (or 1-2 px above) the previous
        // anchor's yBottom — printing leaves no vertical gap between
        // adjacent rows. A strict `yTop > tailBottom` would skip those
        // lines and place the wall too far down, sweeping the next
        // product's first name line into the previous band.
        const tailBottom = tailBottoms[bi];
        let firstNextTop = Number.POSITIVE_INFINITY;
        for (const line of productSlice) {
            const center = (line.yTop + line.yBottom) / 2;
            if (center > tailBottom && line.yTop < firstNextTop) {
                firstNextTop = line.yTop;
            }
        }
        const bottomWall = Number.isFinite(firstNextTop)
            ? (tailBottom + firstNextTop) / 2
            : tailBottom;
        bands.push({ anchorIdx, topWall, bottomWall });
    }
    return bands;
}

/**
 * Classify a line by content for the dev-overlay trace and the
 * extraction loop's `entry.reason` field. The classification has
 * NO bearing on band membership — that's decided purely by the
 * y-walls — but it's useful metadata for debugging and lets
 * extractRimiProduct skip same-row anchor companions cleanly.
 */
function classifyLineReason(line: RimiLine): RimiLineReason {
    if (isDiscountLine(line)) return 'discount';
    if (isWeightOrMultiLine(line)) return 'weight-multi';
    if (isDepositLine(line)) return 'deposit';
    return 'name';
}

// ───────── footer bands (receipt-no + datetime) ─────────

/**
 * Walk the footer slice, tag the first datetime and receipt-no
 * lines we recognise. Datetime: any line carrying both a strict
 * YYYY-MM-DD and an HH:MM(:SS), OR a `LAIKAS` label line.
 * Receipt-no: `Kvito Nr.` (preferred) → `Kvito numeris`. Bank slip
 * lines (`BANKO KVITO NR.`) excluded.
 */
function findFooterBands(footerSlice: RimiLine[]): RimiReceiptBand[] {
    const out: RimiReceiptBand[] = [];
    let dateBandSet = false;
    for (let i = 0; i < footerSlice.length; i++) {
        const line = footerSlice[i];
        const text = line.text.trim();

        if (!dateBandSet) {
            const hasDate = DATE_RE.test(text);
            const hasTime = TIME_RE.test(text);
            const hasLabel = LAIKAS_LABEL_RE.test(text);
            if ((hasDate && hasTime) || hasLabel) {
                let yTop = line.yTop;
                let yBottom = line.yBottom;
                if (!(hasDate && hasTime) && hasLabel) {
                    for (let k = i + 1; k < Math.min(i + 3, footerSlice.length); k++) {
                        const next = footerSlice[k];
                        if (DATE_RE.test(next.text) || TIME_RE.test(next.text)) {
                            yBottom = Math.max(yBottom, next.yBottom);
                        } else {
                            break;
                        }
                    }
                }
                out.push({
                    kind: 'datetime',
                    yTop,
                    yBottom,
                    label: 'date',
                });
                dateBandSet = true;
            }
        }
    }

    let receiptBandSet = false;
    for (const line of footerSlice) {
        const text = line.text.trim();
        if (BANKO_KVITO_RE.test(text)) continue;
        if (RECEIPT_NO_KVITO_NR_RE.test(text)) {
            out.push({
                kind: 'receipt-no',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'nr',
            });
            receiptBandSet = true;
            break;
        }
    }
    if (!receiptBandSet) {
        for (const line of footerSlice) {
            const text = line.text.trim();
            if (BANKO_KVITO_RE.test(text)) continue;
            if (RECEIPT_NO_KVITO_NUMERIS_RE.test(text)) {
                out.push({
                    kind: 'receipt-no',
                    yTop: line.yTop,
                    yBottom: line.yBottom,
                    label: 'nr',
                });
                break;
            }
        }
    }

    return out;
}

// ───────── public API ─────────

export type RimiBandKind =
    | 'store-name'
    | 'store-address'
    | 'product'
    | 'receipt-no'
    | 'datetime'
    | 'total';

export interface RimiReceiptBand {
    kind: RimiBandKind;
    yTop: number;
    yBottom: number;
    /**
     * Human-readable label rendered next to the band on the dev
     * overlay. For products: the band index (`#3`). For typed
     * fields: a short identifier (`store`, `addr`, `nr`, `date`,
     * `sum`).
     */
    label: string;
}

export interface RimiBandLineEntry {
    line: RimiLine;
    sliceIdx: number;
    reason: RimiLineReason;
}

export type RimiLineReason =
    | 'name'
    | 'anchor'
    | 'discount'
    | 'weight-multi'
    | 'deposit'
    | 'deposit-cont'
    | 'deposit-qty'
    | 'deposit-total'
    | 'same-row'
    | 'other';

export interface RimiBandInternal {
    bandIdx: number;
    anchor: RimiBandLineEntry;
    preName: RimiBandLineEntry[];
    postAnchor: RimiBandLineEntry[];
}

export interface RimiReceiptBandPlan {
    bands: RimiReceiptBand[];
    productInternals: RimiBandInternal[];
}

interface BandsContext {
    headerEnd: number;
    footerStart: number;
    headerSlice: RimiLine[];
    productSlice: RimiLine[];
    footerSlice: RimiLine[];
    bands: RimiReceiptBand[];
    productInternals: RimiBandInternal[];
}

function computeBandsContext(rawLines: RimiLine[]): BandsContext {
    const headerEnd = findHeaderEnd(rawLines);
    const footerStart = findFooterStart(rawLines, headerEnd);
    const headerSlice = rawLines.slice(0, headerEnd);
    // Two-stage normalisation of the product slice before band
    // detection:
    //   1. mergeRowFragments — consolidate raw OCR fragments that
    //      live on the same physical row into single logical lines
    //      so DISCOUNT_RE / WEIGHT_RE etc. see intact text. Without
    //      this the band loop breaks on stray fragments (e.g. the
    //      discount row split across three boxes) and the tail
    //      leaks into the next product's preName.
    //   2. splitFusedAnchorLine — for the inverse case where MLKit
    //      glued the weight detail and the anchor into ONE line,
    //      split it back apart so each part feeds its own
    //      classifier.
    // Restricted to the product slice; header/footer have their own
    // shapes and we don't want to perturb their parsing.
    const rawProductSlice = rawLines.slice(headerEnd, footerStart);
    const mergedProductSlice = mergeRowFragments(rawProductSlice);
    const productSlice: RimiLine[] = [];
    for (const line of mergedProductSlice) {
        const split = splitFusedAnchorLine(line);
        if (split) {
            productSlice.push(split[0], split[1]);
        } else {
            productSlice.push(line);
        }
    }
    const footerSlice = rawLines.slice(footerStart);

    const bands: RimiReceiptBand[] = [];
    bands.push(...findHeaderBands(headerSlice));

    const internal = findProductBandsInternal(productSlice);
    const productBands: RimiReceiptBand[] = [];
    const productInternals: RimiBandInternal[] = [];
    const centerOf = (line: RimiLine) => (line.yTop + line.yBottom) / 2;

    // Visible top/bottom of the productSlice — used to clamp the
    // first band's open top wall and the last band's open bottom
    // wall so the dev overlay shows a finite rectangle.
    const sliceTop = productSlice.length > 0
        ? Math.min(...productSlice.map((l) => l.yTop))
        : 0;
    const sliceBottom = productSlice.length > 0
        ? Math.max(...productSlice.map((l) => l.yBottom))
        : 0;

    for (let bi = 0; bi < internal.length; bi++) {
        const band = internal[bi];
        // Hard-walled membership: every line whose yCenter falls
        // strictly above the bottom wall and strictly above the
        // top wall (i.e. center > topWall && center <= bottomWall)
        // is in this band — full stop. There is no "but the line
        // looked like a discount, absorb it across the wall" rule.
        const memberIdxs: number[] = [];
        for (let k = 0; k < productSlice.length; k++) {
            const center = centerOf(productSlice[k]);
            if (center > band.topWall && center <= band.bottomWall) {
                memberIdxs.push(k);
            }
        }
        if (memberIdxs.length === 0) continue;

        const visTop = Number.isFinite(band.topWall) ? band.topWall : sliceTop;
        const visBottom = Number.isFinite(band.bottomWall) ? band.bottomWall : sliceBottom;
        productBands.push({
            kind: 'product',
            yTop: visTop,
            yBottom: visBottom,
            label: `#${bi + 1}`,
        });

        // Split members by index relative to the anchor:
        //   sliceIdx < anchorIdx  → preName (name lines, ordered as
        //                            they appear in productSlice).
        //   sliceIdx > anchorIdx  → postAnchor (discount, weight,
        //                            multi, deposit, stray fragments).
        // mergeRowFragments earlier in the pipeline already spliced
        // same-row column-split wraps BEFORE their anchor in the
        // slice, so this index split correctly puts left-column
        // wraps into preName.
        const preName: RimiBandLineEntry[] = [];
        const postAnchor: RimiBandLineEntry[] = [];
        for (const k of memberIdxs) {
            if (k === band.anchorIdx) continue;
            const line = productSlice[k];
            const entry: RimiBandLineEntry = {
                line,
                sliceIdx: k,
                reason: classifyLineReason(line),
            };
            if (k < band.anchorIdx) preName.push(entry);
            else postAnchor.push(entry);
        }
        productInternals.push({
            bandIdx: productInternals.length,
            anchor: {
                line: productSlice[band.anchorIdx],
                sliceIdx: band.anchorIdx,
                reason: 'anchor',
            },
            preName,
            postAnchor,
        });
    }

    bands.push(...productBands);

    bands.push(...findFooterBands(footerSlice));

    // Total band — first `Mokėti` line in the footer slice.
    for (const line of footerSlice) {
        if (TOTAL_LABEL_RE.test(line.text)) {
            bands.push({
                kind: 'total',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'sum',
            });
            break;
        }
    }

    return {
        headerEnd,
        footerStart,
        headerSlice,
        productSlice,
        footerSlice,
        bands,
        productInternals,
    };
}

/**
 * Step 1: locate every region we want to band on the receipt +
 * surface per-product typed content for step 2.
 */
export function findReceiptBandsRimi(rawLines: RimiLine[]): RimiReceiptBandPlan {
    const ctx = computeBandsContext(rawLines);
    return { bands: ctx.bands, productInternals: ctx.productInternals };
}

// ───────── trace dumps (dev tool) ─────────

const TRUNC = (s: string, n = 80): string =>
    s.length <= n ? s : s.slice(0, n - 1) + '…';

const fmtY = (line: RimiLine): string =>
    `y=${Math.round(line.yTop)}..${Math.round(line.yBottom)}`;

/**
 * Copy-paste-friendly trace of how findReceiptBandsRimi sliced
 * the receipt. Two sections: a band summary, then a per-OCR-line
 * dump with the classification each products-slice line received.
 */
export function traceReceiptBandsRimi(rawLines: RimiLine[]): string {
    const ctx = computeBandsContext(rawLines);
    const out: string[] = [];
    out.push(
        `lines: total=${rawLines.length} ` +
            `headerEnd=${ctx.headerEnd} footerStart=${ctx.footerStart} ` +
            `bands=${ctx.bands.length}`,
    );
    if (ctx.headerEnd > 0 && ctx.headerEnd <= rawLines.length) {
        const lastH = rawLines[ctx.headerEnd - 1];
        out.push(`  lastHeaderLine: ${fmtY(lastH)} "${TRUNC(lastH.text)}"`);
    }
    if (ctx.footerStart < rawLines.length) {
        const firstF = rawLines[ctx.footerStart];
        out.push(`  firstFooterLine: ${fmtY(firstF)} "${TRUNC(firstF.text)}"`);
    }
    out.push('');

    for (const band of ctx.bands) {
        out.push(
            `── band kind=${band.kind} label=${band.label} y=${Math.round(band.yTop)}..${Math.round(band.yBottom)} (Δ ${Math.round(band.yBottom - band.yTop)} px)`,
        );
    }

    const internal = findProductBandsInternal(ctx.productSlice);
    const anchorSet = new Set(internal.map((b) => b.anchorIdx));
    const inBand = new Map<number, number>();
    const centerOf = (line: RimiLine) => (line.yTop + line.yBottom) / 2;
    for (let bi = 0; bi < internal.length; bi++) {
        const band = internal[bi];
        for (let k = 0; k < ctx.productSlice.length; k++) {
            const c = centerOf(ctx.productSlice[k]);
            if (c > band.topWall && c <= band.bottomWall) inBand.set(k, bi + 1);
        }
    }
    const classify = (line: RimiLine, sliceIdx: number): string => {
        const tags: string[] = [];
        if (anchorSet.has(sliceIdx)) tags.push('anchor');
        if (isPositivePriceLine(line)) tags.push('+price');
        if (isDiscountLine(line)) tags.push('discount');
        if (isWeightOrMultiLine(line)) tags.push('weight/multi');
        if (isDepositLine(line)) tags.push('deposit');
        return tags.length > 0 ? tags.join(',') : '?';
    };

    out.push('');
    out.push('— products slice —');
    for (let i = 0; i < ctx.productSlice.length; i++) {
        const line = ctx.productSlice[i];
        const tags = classify(line, i);
        const bandLabel = inBand.has(i) ? `b${inBand.get(i)}` : 'b-';
        out.push(
            `  slice[${i}] ${fmtY(line)} ${bandLabel} ${tags} "${TRUNC(line.text)}"`,
        );
    }
    return out.join('\n');
}

// ───────── step 2: per-band content extraction ─────────

export interface RimiExtractResult {
    product: RimiProduct | null;
    warnings: string[];
}

const RECONCILE_TOLERANCE_EUR = 0.02;

/**
 * Convert one classified Rimi product band into a `RimiProduct`
 * (or skip it). Reconcile self-check on receipts that have a
 * discount block: `anchorPrice − Nuol.savings ≈ Galut.kaina`. The
 * receipt prints both sides explicitly when OCR catches the full
 * row, so we just verify they agree (€0.02 tolerance). When OCR
 * truncates one half of the row, the other is derived from the
 * anchor so promoPrice still surfaces.
 */
export function extractRimiProduct(internal: RimiBandInternal): RimiExtractResult {
    const warnings: string[] = [];

    // Price from the anchor. Strict form first (`X,YY A`),
    // relaxed form (`X,YY` without the VAT letter) as fallback.
    const anchorText = internal.anchor.line.text.trim();
    let price: number;
    const strictMatch = anchorText.match(POSITIVE_PRICE_RE);
    if (strictMatch) {
        price = parseNumLoose(strictMatch[1]);
    } else if (RELAXED_PRICE_RE.test(anchorText)) {
        price = parseNumLoose(anchorText);
        warnings.push(`anchor RELAXED form "${anchorText}" → ${price.toFixed(2)}`);
    } else {
        return {
            product: null,
            warnings: [`skip:anchor-parse-failed "${anchorText}"`],
        };
    }

    let pricePerUnit: number | null = null;
    let quantity = 1;
    let unit = 'vnt';
    let savings: number | null = null;
    let finalPrice: number | null = null;
    let depositSeen = false;
    const nameFragments: string[] = [];

    const allEntries: Array<{ entry: RimiBandLineEntry; isPreName: boolean }> = [
        ...internal.preName.map((e) => ({ entry: e, isPreName: true })),
        ...internal.postAnchor.map((e) => ({ entry: e, isPreName: false })),
    ];
    for (const { entry, isPreName } of allEntries) {
        const text = entry.line.text.trim();
        if (!text) continue;

        const fullDiscount = text.match(DISCOUNT_RE);
        if (fullDiscount) {
            savings = parseNumLoose(fullDiscount[1]);
            finalPrice = parseNumLoose(fullDiscount[2]);
            continue;
        }
        const nuolFragment = text.match(
            /Nuo[li]\s*\.?\s*-\s*([\dOoIl]+[.,]\s?[\dOoIl]{1,2})/i,
        );
        if (nuolFragment && savings === null) {
            savings = parseNumLoose(nuolFragment[1]);
            continue;
        }
        const galutFragment = text.match(
            /Gal[uūü]t\s*[.,]?\s*k?aina\s*([\dOoIl]+[.,]\s?[\dOoIl]{1,2})/i,
        );
        if (galutFragment && finalPrice === null) {
            finalPrice = parseNumLoose(galutFragment[1]);
            continue;
        }
        // Pre-normalise (diacritic strip + OCR digit class) before
        // weight/multi matching — receipts in the wild produce
        // `EỦR` instead of `EUR` (diacritic) and `2 vnt. X o,65 EUR`
        // instead of `0,65` (digit-letter). Without normalising,
        // either failure blocks the regex and the weight-info line
        // leaks into the displayed name, with pricePerUnit /
        // quantity / unit lost.
        const stripped = normalizeForNumberRegex(text);
        const weightMatch = stripped.match(WEIGHT_RE);
        if (weightMatch && pricePerUnit === null) {
            quantity = parseNumLoose(weightMatch[1]);
            pricePerUnit = parseNumLoose(weightMatch[2]);
            unit = 'kg';
            continue;
        }
        const multiMatch = stripped.match(MULTI_RE);
        if (multiMatch && pricePerUnit === null) {
            quantity = parseInt(multiMatch[1], 10);
            pricePerUnit = parseNumLoose(multiMatch[2]);
            unit = 'vnt';
            continue;
        }
        if (
            entry.reason === 'deposit' ||
            entry.reason === 'deposit-cont' ||
            entry.reason === 'deposit-qty' ||
            entry.reason === 'deposit-total'
        ) {
            depositSeen = true;
            continue;
        }
        if (DEPOSIT_PATTERN.test(text)) {
            depositSeen = true;
            continue;
        }
        if (BARE_PRICE_RE.test(text)) continue;
        if (depositSeen) continue;
        // Only preName entries contribute to the product name. PostAnchor
        // entries are bookkeeping (discount/weight/multi/deposit/same-row
        // companions of the anchor row); even when they slip through the
        // classifiers above (stray "A" letters, the "Galut. kaina" half
        // of a fragmented discount, etc.) they should never end up in
        // the displayed name. With mergeRowFragments active, legitimate
        // left-column wraps land in preName via the splice, so this no
        // longer drops anything that should have been in the name.
        if (!isPreName) continue;
        if (/[a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ]/.test(text)) {
            nameFragments.push(text);
        }
    }

    const rawName = nameFragments.join(' ').trim();
    if (!rawName) {
        return { product: null, warnings: ['skip:no-name'] };
    }
    if (NON_CATALOG_PATTERN.test(rawName)) {
        return {
            product: null,
            warnings: [`skip:non-catalog "${rawName.slice(0, 60)}"`],
        };
    }
    if (DEPOSIT_PATTERN.test(rawName)) {
        return {
            product: null,
            warnings: [`skip:deposit-only "${rawName.slice(0, 60)}"`],
        };
    }

    const name = cleanProductName(rawName);

    // Rimi prints both the savings and the final price explicitly.
    // Use BOTH to drive: (a) reconcile (when both came from OCR,
    // verify anchor − savings ≈ finalPrice), and (b) recovery
    // (when OCR caught only one half of the discount row, derive
    // the missing half from the anchor so promoPrice still
    // surfaces).
    const savingsCaptured = savings !== null;
    const finalPriceCaptured = finalPrice !== null;
    if (savingsCaptured && finalPriceCaptured) {
        const expected = price - savings!;
        const delta = Math.abs(expected - finalPrice!);
        if (delta > RECONCILE_TOLERANCE_EUR) {
            warnings.push(
                `reconcile MISMATCH: price=${price.toFixed(2)} − savings=${savings!.toFixed(2)} = ` +
                    `${expected.toFixed(2)} but Galut.kaina=${finalPrice!.toFixed(2)} (Δ=${delta.toFixed(2)})`,
            );
        }
    } else if (savingsCaptured && !finalPriceCaptured) {
        finalPrice = Math.round((price - savings!) * 100) / 100;
        warnings.push(
            `Galut.kaina derived: price=${price.toFixed(2)} − savings=${savings!.toFixed(2)} = ${finalPrice.toFixed(2)} (OCR missed the printed amount)`,
        );
    } else if (!savingsCaptured && finalPriceCaptured) {
        savings = Math.round((price - finalPrice!) * 100) / 100;
        warnings.push(
            `Nuol. derived: price=${price.toFixed(2)} − Galut.kaina=${finalPrice!.toFixed(2)} = ${savings.toFixed(2)} (OCR missed the printed amount)`,
        );
    }

    const promoPrice = finalPrice;

    // ppu × qty reconcile + self-heal. Receipts print the price-per-
    // unit in the middle column (`2 vnt. X 4,99 EUR` or `0,690 kg X
    // 1,29 EUR/kg`) where MLKit has no structural anchor to validate
    // against — single-digit OCR errors land here often. The `price`
    // anchor (`X,YY A`, strict regex with VAT letter) and the
    // `quantity` (constrained by `vnt`/`kg` suffix) are both
    // higher-confidence, so when the math fails we re-derive ppu
    // from `price / quantity`. See the corresponding block in
    // maximaParser.ts for the rationale and the bounded-delta guard
    // that keeps this from false-healing when the wrong number was
    // elsewhere.
    if (pricePerUnit !== null) {
        const expected = pricePerUnit * quantity;
        const delta = Math.abs(expected - price);
        if (delta > RECONCILE_TOLERANCE_EUR) {
            const HEAL_MAX_PPU_DELTA = 0.5;
            const derived = quantity !== 0
                ? Math.round((price / quantity) * 100) / 100
                : null;
            if (
                derived !== null &&
                Math.abs(derived * quantity - price) <= RECONCILE_TOLERANCE_EUR &&
                Math.abs(derived - pricePerUnit) <= HEAL_MAX_PPU_DELTA
            ) {
                warnings.push(
                    `reconcile HEALED: ppu ${pricePerUnit.toFixed(2)} → ${derived.toFixed(2)} ` +
                        `(price=${price.toFixed(2)} ÷ qty=${quantity})`,
                );
                pricePerUnit = derived;
            } else {
                warnings.push(
                    `reconcile MISMATCH: ppu=${pricePerUnit.toFixed(2)} × qty=${quantity} = ` +
                        `${expected.toFixed(2)} but price=${price.toFixed(2)} (Δ=${delta.toFixed(2)})`,
                );
            }
        }
    }

    const allLines = [
        ...internal.preName.map((e) => e.line),
        internal.anchor.line,
        ...internal.postAnchor.map((e) => e.line),
    ];
    const region = regionOf(allLines);
    const rawLines = allLines.map((l) => l.text);

    return {
        product: {
            name,
            price,
            promoPrice,
            quantity,
            unit,
            pricePerUnit,
            rawLines,
            region,
        },
        warnings,
    };
}

/**
 * Per-band extraction trace, copy-paste-friendly. Companion to
 * `traceReceiptBandsRimi` for step 2.
 */
export function traceRimiExtract(rawLines: RimiLine[]): string {
    const ctx = computeBandsContext(rawLines);
    const out: string[] = [];
    out.push(`bands=${ctx.productInternals.length}`);
    for (const internal of ctx.productInternals) {
        const bandNum = internal.bandIdx + 1;
        const { product, warnings } = extractRimiProduct(internal);
        const skipMsg = warnings.find((w) => w.startsWith('skip:'));
        if (!product) {
            const skip = skipMsg ?? 'no product emitted';
            out.push(`band ${bandNum}: SKIP ${skip}`);
            for (const w of warnings) {
                if (w === skipMsg) continue;
                out.push(`        WARN ${w}`);
            }
            continue;
        }
        const mismatch = warnings.find((w) => w.startsWith('reconcile MISMATCH'));
        const status = mismatch ? 'WARN' : warnings.length > 0 ? 'NOTE' : 'OK';
        const promo = product.promoPrice === null ? 'null' : product.promoPrice.toFixed(2);
        const ppu = product.pricePerUnit === null ? 'null' : product.pricePerUnit.toFixed(2);
        let reconcile: string;
        if (product.promoPrice === null) {
            reconcile = 'reconcile:n/a';
        } else if (mismatch) {
            const savings = product.price - product.promoPrice;
            reconcile = `reconcile:${product.price.toFixed(2)}−${savings.toFixed(2)}=${(product.price - savings).toFixed(2)} vs Galut=${product.promoPrice.toFixed(2)} ✗`;
        } else {
            const savings = product.price - product.promoPrice;
            reconcile = `reconcile:${product.price.toFixed(2)}−${savings.toFixed(2)}=${product.promoPrice.toFixed(2)} ✓`;
        }
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

// ───────── public entry points ─────────

/**
 * Full receipt parse: header + products + footer.
 *
 * Convention: rows with a weight or multi-buy line have their
 * `price` and `promoPrice` normalized to PER-UNIT values here
 * (`price = pricePerUnit`, `promoPrice = promoPrice / qty`).
 * Downstream code recovers the line total as `price × quantity`.
 * Single-pack rows (no weight/multi line) keep `price` as the
 * line total since `quantity = 1`.
 *
 * `extractRimiProduct` keeps the raw line totals for the dev
 * trace and reconcile self-check; the normalization happens once
 * at this boundary.
 */
export function parseRimiReceipt(rawLines: RimiLine[]): RimiParseResult {
    const ctx = computeBandsContext(rawLines);
    const header = parseHeader(rawLines.slice(0, ctx.headerEnd));
    const footer = parseFooter(rawLines.slice(ctx.footerStart));
    const products: RimiProduct[] = [];
    for (const internal of ctx.productInternals) {
        const { product } = extractRimiProduct(internal);
        if (!product) continue;
        if (product.pricePerUnit !== null && product.quantity > 0) {
            product.price = product.pricePerUnit;
            if (product.promoPrice !== null) {
                product.promoPrice =
                    Math.round((product.promoPrice / product.quantity) * 100) / 100;
            }
        }
        products.push(product);
    }
    return { header, products, footer };
}

export function parseRimiHeaderOnly(rawLines: RimiLine[]): RimiHeader {
    const headerEnd = findHeaderEnd(rawLines);
    return parseHeader(rawLines.slice(0, headerEnd));
}
