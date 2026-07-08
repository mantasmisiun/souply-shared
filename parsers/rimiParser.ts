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
    // Optional skew: top/bottom Y at the band's LEFT vs RIGHT edge, so the photo
    // overlay can draw a parallelogram that follows a tilted receipt. Absent →
    // render as the axis-aligned rectangle. Currently produced only by the IKI
    // photographed (thermal) parser.
    yLeftTop?: number;
    yRightTop?: number;
    yLeftBottom?: number;
    yRightBottom?: number;
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
    | 'receiptNo'
    | 'skipped';

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
    /** Marked by mergeRowFragmentsRimi: this box is ~2 printed rows tall — the
     *  OCR engine FUSED two physical rows into one garbled line (346px
     *  app-share wrapper PDFs). Such a box is a fusion, not a fragment: it is
     *  excluded from row-clustering (it y-overlaps BOTH rows and would glue
     *  them together) and its text is quarantined from product names. */
    fusedRow?: boolean;
    /** The TOP-half remnant of a split fused box: a two-row fusion whose text
     *  ends in a price is [previous product's discount row][next product's
     *  name row] — the price physically belongs to the TOP row (the previous
     *  band's Galut. kaina). The split keeps every band's content inside its
     *  own walls: this line is tail-eligible for the band above, never an
     *  anchor, and extractRimiProduct reads it as a recovered Galut. */
    fusedSplitTail?: boolean;
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
    /** Pack size extracted from the product name (e.g. `32` for "32 rit.",
     *  `990` for "990ml"). Separate from `quantity` (= how many packs the
     *  user bought) and `unit` (= the receipt-level pricing unit, vnt/kg).
     *  Used by the matcher to discriminate same-name products at different
     *  pack sizes (e.g. ZEWA EVERYDAY 32 rit. vs 12 rit. — without this,
     *  name-similarity alone returns the wrong pack at confidence 1.0). */
    parsedAmount?: number | null;
    parsedUnit?: string | null;
    /** True when the line is sold by weight (unit === 'kg'), false for
     *  per-piece rows. IKI-parser parity: drives the server resolver to
     *  keep a weighable catalog SP instead of falling through to a
     *  garbled same-name orphan. The processing coordinator threads it
     *  through unchanged — the parser only EMITs the field. */
    isWeighable?: boolean;
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
    /** RECEIPT-LEVEL RECONCILIATION (set by parseRimiReceipt, not parseFooter):
     *  Σ printed line totals (Galut-aware, pre-normalization) + receipt-level
     *  adjustments (Panaudoti MANO RIMI pinigai, Užstatas deposits,
     *  Apvalinimas) must equal the printed Mokėti total. This is the
     *  arithmetic self-verification the Phase-5 ensemble arbitrates on —
     *  without it every Rimi parse looks flagged and engine quality is
     *  judged blind. `reconciled` is only ever true against a total READ
     *  from the receipt (never against the derived fallback). */
    reconciled?: boolean;
    reconDelta?: number | null;
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
    /Nuo[li]\s*\.?\s*-(\d+[.,]\s?\d{2})\s+Gal[uūü]t\s*[.,:;]?\s*k?aina\s*(\d+[.,]\s?\d{2})/i;

// Half-discount fragments — MLKit splits the discount row at the
// column gap on some receipts, leaving each half on its own OCR
// line. Either fragment, on its own, still belongs to the
// preceding product's band. Loosened: no line-anchor `^`/`\b`
// (lets stray leading/trailing chars still match), and OCR digit
// confusions (`O`/`o` → `0`, `I`/`l` → `1`) inside the amount.
const NUOL_FRAGMENT_RE = /Nuo[li]\s*\.?\s*-\s*[\dOoIl]+[.,]\s?[\dOoIl]{1,2}/i;
const GALUT_FRAGMENT_RE = /Gal[uūü]t\s*[.,:;]?\s*k?aina\s*[\dOoIl]+[.,]\s?[\dOoIl]{1,2}/i;

// Weighable: `0,340 kg X 7,59 EUR/kg`. `[EF]?UR` tolerates two OCR
// patterns on the currency token:
//   - the leading `E` of `EUR` dropped entirely — observed on receipt
//     55 as "0,978 kg X 1,69UR/K_3. 1", which otherwise fails the
//     weight-line classifier and the entire row drops to unit=vnt qty=1.
//   - E↔F thermal-print confusion ("FUR" for "EUR") — the E's bottom
//     bar fades on thermal paper and MLKit reads F. Same class as the
//     IKI parser's T_EUR (`[EÉĖÈÊF]...`); diacritic variants are
//     already collapsed by normalizeForNumberRegex's stripDiacritics.
// "UR" preceded by `\d+[.,]\d{1,2}\s*` has no plausible false-positive
// shape in product names.
//
// `kg[^xX×]*[xX×]` (instead of `kg\s*[xX×]`) tolerates a stray
// non-X character between `kg` and `X` — observed on receipt 56 band 7
// as "0,494 kg? X 7,99 EUR/kg" where MLKit inserted a "?" after kg.
// Pre-fix that row was misclassified as preName and glued into the
// product name with unit/quantity/ppu all lost.
const WEIGHT_RE = /(\d+[.,]\s?\d{1,3})\s*kg[^xX×]*[xX×]\s*(\d+[.,]\s?\d{1,2})\s*(?:[EF]?UR|€)/i;

// Fallback for weighable lines where MLKit dropped the `kg` between
// the quantity and the X — observed on receipt 56 band 10 salmon as
// "0,524 .24 x 23,99 EUR/kg". The `EUR/kg` suffix is the unique
// signature that disambiguates "weighable" from "multi-buy" when the
// `kg` token between qty and X is missing; multi-buy lines never carry
// a `/kg` rate suffix. Tried only after WEIGHT_RE fails. Currency
// class shares WEIGHT_RE's `[EF]?UR` OCR tolerance.
const WEIGHT_RATE_ONLY_RE = /(\d+[.,]\s?\d{1,3})\s*[^xX×]*[xX×]\s*(\d+[.,]\s?\d{1,2})\s*(?:[EF]?UR|€)\s*\/\s*kg/i;

// Weighed-line HINT: the row is weight-SHAPED ("… kg × …" body or a
// "… EUR/kg" rate suffix) but too OCR-garbled for WEIGHT_RE /
// WEIGHT_RATE_ONLY_RE to extract numbers from (e.g. a letter inside
// the €/kg rate that the digit fold doesn't cover: "0,978 kg X 1,b9
// EUR/kg"). Used by extractRimiProduct's price-poisoning guard: a
// band with a kg hint but no recoverable €/kg must NOT fall back to
// unit=vnt with the anchor line total as its price — that total is
// for a FRACTION of a kg and would poison the per-unit reference
// price ("show it, never write price"). Neither alternative has a
// plausible false-positive shape inside product names ("kg" directly
// followed by an ×, or a currency-slash-kg rate suffix).
// The third alternative catches the fully-mushed skew garble: "46g429 EUKG"
// (printed "0,406 kg X 4,29 EUR/kg", ios-55 paprikos) — digits+g+digits with
// the EUR/kg marker collapsed into one EUKG token. No Lithuanian word ends in
// "EUKG", so the token alone is a safe weighed signal.
const WEIGHT_HINT_RE = /\bkg\b[^xX×]{0,10}[xX×]|(?:[EF]?UR|€)\s*\/\s*kg\b|\bE[UO]?KG\b/i;

// Multi-buy: `2 vnt X 1,99 EUR`. The X tolerates one junk char after it —
// photo OCR reads "2 vnt. x*2,69 EUR" (rimi-30-04-2026-2 p11 leaked the whole
// multi line into the product name and lost its quantity).
const MULTI_RE = /(\d+)\s*vnt\s*\.?\s*[xX×]\s*[*·]?\s*(\d+[.,]\s?\d{1,2})\s*(?:EUR)?/i;

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
//
// Stem tolerance (IKI-parser parity, T_RECEIPTNO_RE): thermal OCR
// garbles the "Kvito" stem one glyph at a time — `K`↔`A` (lost
// left stroke), `v`→`o`/`u`/`y`, and drops the `r` of "Nr." — so
// `[KA][vouy]ito` + `Nr?` accepts "Avito N. 80/162", "Kyito Nr,"
// etc. Guards that keep the widened stem from misfiring:
//   - the Nr-form's lookahead `(?=[\s\d]|$)` rejects "Kvito
//     numeris …" (an `n` alone would satisfy `Nr?`, but the next
//     char is `u`, not whitespace/digit) so the numeris path still
//     owns that layout;
//   - parseFooter additionally requires ≥1 digit in the captured
//     tail, so a fully-garbled footer row can't mint a junk id.
const RECEIPT_NO_KVITO_NR_RE = /^[KA][vouy]ito\s+Nr?[.,]?(?=[\s\d]|$)/i;
// Prefix stripper for the Nr form — must mirror RECEIPT_NO_KVITO_NR_RE.
const RECEIPT_NO_KVITO_NR_STRIP_RE = /^[KA][vouy]ito\s+Nr?[.,]?\s*/i;
const RECEIPT_NO_KVITO_NUMERIS_RE = /^[KA][vouy]ito\s+numeris\b/i;
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
//
// MLKit also sometimes splits a single street word across a space
// (`Zarasų` → `Zar asų`), which would otherwise truncate the street
// name to the first fragment and break the suffix anchor. The
// `(?:\s+[a-z…]+){0,2}` tail re-attaches up to two lowercase
// continuation fragments before the suffix; the matcher then strips
// whitespace, so `Zar asų g.` normalises to the same key as `Zarasų g.`.
const STREET_PREFIX_RE =
    /([A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž\d]+(?:\s+[a-ząčęėįšųūž\d]+){0,2})\s*[,]?\s*\b(g|pr|al|pl|a)\b\.?/;

// CITY_TAIL_RE picks out the "30, Šiauliai" component independent
// of which OCR line it lands on. The house number admits a single
// trailing letter (`5A`, `12B`) — common in Lithuanian addresses and
// otherwise dropped, which left the street-only fallback to match on.
const CITY_TAIL_RE =
    /\b(\d+[A-Za-z]?(?:[-/]\d+)?)\s*,\s*([A-ZĄČĘĖĮŠŲŪŽ][a-ząčęėįšųūž]+)/;

// Store-name heuristic. Rimi prints "UAB RIMI LIETUVA, T709" or
// "RIMI LIETUVA UAB, T709" — UAB + RIMI on the same line.
const STORE_NAME_RE = /\bUAB\b.*\bRIMI\b|\bRIMI\b.*\bUAB\b/i;

// Bag-deposit row — `Užstatas - vienkartinė plastiko pakuotė
// 0,10`. Used by both V1's product-name filter and V2's band
// absorption logic.
//
// `[žz2]` widening (IKI-parser parity): OCR reads the ž caron
// inconsistently — plain `z` ("Uzstatas") when the caron fades,
// `2` when the caron fuses with the z body. Without the class a
// garbled deposit row fails the filter and mints a phantom
// "Uzstatas…" product. No Lithuanian grocery word contains
// `u[žz2]stat` other than the deposit, so the class adds no
// false-positive surface.
export const DEPOSIT_PATTERN = /[uūü][žz2]stat/i;

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
//
// First-letter alternation `(?:m|rn|nn|n)` covers iOS MLKit's
// lowercase-`m` confusions: most often `n` (loses one of m's three
// vertical strokes — observed on iPhone reading "naiželis"), and
// occasionally `rn` / `nn`. The modifier `(?:plastikinis|popierinis)`
// immediately before kills false-positive risk — there's no
// Lithuanian grocery word starting with `nai[sšžz]elis` that would
// follow "plastikinis".
//
// Trailing `[A-Z]?` tolerates a single uppercase tax-code letter that
// occasionally glues onto the product name when the band parser
// merges the price line (`0,40 A`) into the name line — observed on
// Android batch test as "Rimi maišasA". Without it the \b boundary
// fails between `as` and `A` (both word chars) and the skip leaks
// through.
export const NON_CATALOG_PATTERN = /\b(?:vienkartinis|didelis|pirkini[uų])?\s*(?:plastikinis|popierinis)?\s*[A-Za-z]?(?:m|rn|nn|n)ai[sšžz](?:elis|as)[A-Z]?\b/i;

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
            .replace(/[IilL]/g, '1'),
    );
}

/** Round to 2 decimal places (money math). */
const round2 = (n: number): number => Math.round(n * 100) / 100;

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
    if (!WEIGHT_RE.test(middleNormalized) && !WEIGHT_RATE_ONLY_RE.test(middleNormalized) && !MULTI_RE.test(middleNormalized)) return null;
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
        // FUSED boxes never participate in same-row joins: a two-row-tall box
        // y-overlaps its neighbour rows, and joining glued the clean name
        // line "Sok. sk. sojos ger. ALPRO" onto the quarantined garbage box
        // on rimi-30-04-2026-23 — the quarantine then ate the REAL name too.
        if (out.length === 0 || line.fusedRow) {
            out.push({ ...line });
            continue;
        }
        const last = out[out.length - 1];
        if (last.fusedRow) {
            out.push({ ...line });
            continue;
        }
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
        // Vertical-overlap override: iOS MLKit occasionally gives a
        // text box an inflated bounding box (e.g. 81 px for a 25 px
        // text line), shifting its centerY below the sibling and
        // failing the centerDist check. When ≥ 60 % of the shorter
        // box's height overlaps the other box, they're on the same
        // physical row regardless of the centerDist result.
        const vertOverlap = Math.max(
            0,
            Math.min(line.yBottom, last.yBottom) - Math.max(line.yTop, last.yTop),
        );
        const isSameRow =
            (minH > 0 && centerDist < minH * ROW_MERGE_CENTER_RATIO) ||
            (minH > 0 && vertOverlap / minH >= 0.6);
        if (!isSameRow) {
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
    // WEIGHT_HINT_RE: a weight-SHAPED row too garbled for the strict
    // regexes still classifies as weight/multi so (a) band-tail
    // absorption keeps it with ITS product instead of leaking it into
    // the next band's preName, and (b) a bare price following it can't
    // become a relaxed anchor.
    return WEIGHT_RE.test(t) || WEIGHT_RATE_ONLY_RE.test(t) || MULTI_RE.test(t) || WEIGHT_HINT_RE.test(t);
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

// MLKit reads Lithuanian glyphs as CYRILLIC homoglyphs on PDF renders — fold
// to Latin at entry (IKI/Maxima parity; visually-identical pairs only).
const RIMI_CYRILLIC_HOMOGLYPHS: Record<string, string> = {
    'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'І': 'I', 'Ј': 'J', 'К': 'K',
    'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'Ѕ': 'S',
    'а': 'a', 'с': 'c', 'е': 'e', 'і': 'i', 'ј': 'j', 'о': 'o', 'р': 'p', 'х': 'x', 'ѕ': 's', 'у': 'y',
};
const foldRimiHomoglyphs = (l: RimiLine): RimiLine => {
    let text = l.text;
    if (/[Ѐ-ӿ]/.test(text)) {
        text = text.replace(/[Ѐ-ӿ]/g, (c) => RIMI_CYRILLIC_HOMOGLYPHS[c] ?? c);
    }
    // "$" before an uppercase run is a garbled Š/S ("$OKOLADE" for ŠOKOLADE,
    // BE09D63A) — no legitimate Rimi text uses the dollar sign.
    if (text.includes('$')) {
        text = text.replace(/\$(?=[A-ZĄČĘĖĮŠŲŪŽ]{2})/g, 'S');
    }
    return text === l.text ? l : { ...l, text };
};

// A fragment whose text is a bare price/amount — kept as its OWN line by the
// row merger so the anchor detection below still sees standalone prices.
const PRICE_SHAPE_FRAGMENT_RE = /^-?\s?\d+[.,]\s?\d{2}\s*[AB]?\s*$/;
const DISCOUNT_CTX_FRAGMENT_RE = /nuol|galut|kaina/i;

/**
 * Same-row fragment merger (Maxima/IKI parity — Rimi never had one, and the
 * 300-dpi PDF OCR splits rows constantly): "X 4,99 EUR" + "3 vnt." fragments
 * of one multi-buy row, "Nuol." + "-1,30 Galut. kaina" + "1,39" thirds of one
 * discount row, "2" + "l" halves of a litre mark. Clusters lines whose
 * y-ranges overlap ≥55% of the shorter line, then joins each cluster's
 * fragments x-sorted — EXCEPT bare price fragments ("1,69 A"), which stay
 * separate so anchors keep working, unless a same-row sibling carries
 * Nuol/Galut/kaina context (then the price is the discount's value, not an
 * anchor, and must merge into the discount line).
 */
/** Body-text test shared by the fused-row detector: ≥8 chars + a space keeps
 *  logo art, bare prices and stray letters out of both the median and the
 *  candidates. Mirrors utils/parseEnsemble.countFusedRows on the app side. */
const isRimiBodyText = (l: RimiLine): boolean =>
    l.text.trim().length >= 8 && l.text.trim().includes(' ');

export function mergeRowFragmentsRimi(rawLines: RimiLine[]): RimiLine[] {
    if (rawLines.length <= 1) return rawLines.slice();
    // FUSED-ROW pre-pass: a body line ~2× the receipt's median row height is
    // the OCR engine's fusion of two printed rows (low-res wrapper PDFs). It
    // y-overlaps BOTH rows, so feeding it to the clustering below glues two
    // physical rows into one merged line — the "name hijack" mechanic
    // (0AE04F24: "RIMI SMART, 1 l"+"be glitimo BARILLA" → one 104px box that
    // dragged the next product's name into the previous band). A fusion is
    // not a fragment: tag it, keep it out of clustering, let the band walls
    // place it alone. The 3.5× cap keeps decorative blocks out.
    const bodyHs = rawLines
        .filter(isRimiBodyText)
        .map((l) => l.yBottom - l.yTop)
        .filter((h) => h > 0)
        .sort((a, b) => a - b);
    const medH = bodyHs.length >= 8 ? bodyHs[Math.floor(bodyHs.length / 2)] : 0;
    // Height alone is NOT enough: a skewed photo row is also ~2× median
    // (ios-receipt-55 false-tagged two legit rows). A true fusion must
    // additionally SPAN TWO ROWS: at least two other lines each mostly
    // inside the candidate's y-range while being y-disjoint from EACH OTHER.
    const spansTwoRows = (c: RimiLine): boolean => {
        const inside = rawLines.filter((o) => {
            if (o === c) return false;
            const oh = o.yBottom - o.yTop;
            if (oh <= 0) return false;
            const ov = Math.min(o.yBottom, c.yBottom) - Math.max(o.yTop, c.yTop);
            return ov >= 0.6 * oh;
        });
        for (let a = 0; a < inside.length; a++) {
            for (let b = a + 1; b < inside.length; b++) {
                const la = inside[a], lb = inside[b];
                const ov = Math.min(la.yBottom, lb.yBottom) - Math.max(la.yTop, lb.yTop);
                const minH = Math.min(la.yBottom - la.yTop, lb.yBottom - lb.yTop);
                if (ov < 0.3 * minH) return true;
            }
        }
        return false;
    };
    const fusedOut: RimiLine[] = [];
    const clusterable: RimiLine[] = [];
    for (const l of rawLines) {
        const h = l.yBottom - l.yTop;
        // Two tag tiers: 1.75×+spans-two-rows (the proven signature), or a
        // full TWO ROWS tall regardless — a fusion can consume every other
        // line of both rows (rimi-30-04-2026-2: 2.12× box holding a Nuol row
        // + the next name). Photo-skew singles measure ≤1.81× across the
        // corpus, safely under the unconditional tier.
        if (
            medH > 0 && isRimiBodyText(l) && h <= 3.5 * medH
            && ((h >= 1.75 * medH && spansTwoRows(l)) || h >= 2.0 * medH)
        ) {
            // WALL-HONORING SPLIT: a two-row fusion whose text ends in a
            // price is [prev product's discount row][next product's name
            // row] (rimi-30-04-2026-2: "Lazdyny riesutu aetas RiMI 0,65").
            // Split at one row-pitch: the price goes back to the TOP half
            // where it is printed (the previous band's tail territory), the
            // garbled name keeps the bottom half — every band reads only
            // what lies inside its own walls.
            const tailM = h <= 2.6 * medH
                ? l.text.trim().match(/^(.{4,}?)[\s,]*(\d+[.,]\s?\d{2})\s*$/)
                : null;
            if (tailM) {
                const boundary = Math.round(l.yTop + medH);
                fusedOut.push({
                    text: tailM[2],
                    yTop: l.yTop,
                    yBottom: boundary,
                    xLeft: l.xLeft,
                    xRight: l.xRight,
                    fusedSplitTail: true,
                });
                fusedOut.push({ ...l, text: tailM[1].trim(), yTop: boundary, fusedRow: true });
            } else {
                fusedOut.push({ ...l, fusedRow: true });
            }
        } else {
            clusterable.push(l);
        }
    }
    if (clusterable.length === 0) return fusedOut.sort((a, b) => a.yTop - b.yTop || a.xLeft - b.xLeft);
    const sorted = clusterable.sort((a, b) => a.yTop - b.yTop || a.xLeft - b.xLeft);
    const clusters: RimiLine[][] = [];
    let cur: RimiLine[] = [sorted[0]];
    let top = sorted[0].yTop;
    let bottom = sorted[0].yBottom;
    for (let i = 1; i < sorted.length; i++) {
        const l = sorted[i];
        const overlap = Math.min(l.yBottom, bottom) - Math.max(l.yTop, top);
        const minH = Math.min(l.yBottom - l.yTop, bottom - top);
        if (minH > 0 && overlap >= minH * 0.55) {
            cur.push(l);
            top = Math.min(top, l.yTop);
            bottom = Math.max(bottom, l.yBottom);
        } else {
            clusters.push(cur);
            cur = [l];
            top = l.yTop;
            bottom = l.yBottom;
        }
    }
    clusters.push(cur);

    const out: RimiLine[] = [];
    for (const rawCl of clusters) {
        if (rawCl.length === 1) { out.push(rawCl[0]); continue; }
        // Reunite a SPLIT anchor first: a lone VAT letter ("A"/"B") fuses with
        // the nearest bare-price fragment to its LEFT ("1,98" + "A" → "1,98 A")
        // — otherwise the letter would merge into the TEXT side and the price,
        // stripped of its VAT letter, stops being an anchor (rimi-11-05 JUNGA
        // lost its band to the neighbour).
        const cl: RimiLine[] = [];
        const vatLetters = rawCl.filter((f) => /^[AB]$/.test(f.text.trim()));
        const rest = rawCl.filter((f) => !vatLetters.includes(f));
        for (const f of rest) cl.push({ ...f });
        for (const v of vatLetters) {
            let best: RimiLine | null = null;
            for (const f of cl) {
                if (!/^-?\s?\d+[.,]\s?\d{2}\s*$/.test(f.text.trim())) continue;
                if (f.xLeft > v.xLeft) continue;
                if (!best || f.xLeft > best.xLeft) best = f;
            }
            if (best) {
                best.text = `${best.text.trim()} ${v.text.trim()}`;
                best.xRight = Math.max(best.xRight, v.xRight);
            } else {
                cl.push({ ...v });
            }
        }
        if (cl.length === 1) { out.push(cl[0]); continue; }
        // SUB-ROW partition: a y-cluster on a skewed photo chains ACROSS
        // physical rows (bboxes tilt), and treating the whole cluster as one
        // row let the dedupe/concat below eat REAL neighbours on ios-55 —
        // "2 vnt. X 3,49 EUR" fell to the name row above it (45% y-overlap)
        // collapsing the multibuy, and "ALPRO, 14 %,250ml" fell to its own
        // first name line (58%). Same-row SOLID fragments overlap ≥~85%
        // pairwise (true double-reads 98-100%): union them at 70%. SHORT
        // junk double-reads ("IDDO", "1rc") sag halfway into a neighbouring
        // row and can sit at exactly 70% against it — they must never
        // BRIDGE two rows into one, so they don't participate in the union;
        // each attaches to the row it overlaps most (where the dedupe then
        // eats it).
        const clHs = cl.map((f) => f.yBottom - f.yTop).filter((v) => v > 0).sort((a, b) => a - b);
        const clMedH = clHs.length ? clHs[Math.floor(clHs.length / 2)] : 0;
        // Solidity reference = the TALL end of the cluster (junk can be half
        // its fragments and drags a plain median down to its own height),
        // clamped so one sagging outlier can't disqualify the real rows.
        const clRefH = Math.min(clHs.length ? clHs[clHs.length - 1] : 0, 1.5 * clMedH);
        const solidIdx = cl.map((f, idx) => idx).filter((idx) => cl[idx].yBottom - cl[idx].yTop >= 0.6 * clRefH);
        const yOverlapOf = (a: RimiLine, b: RimiLine): number =>
            Math.min(a.yBottom, b.yBottom) - Math.max(a.yTop, b.yTop);
        const parent = cl.map((_, idx) => idx);
        const findRoot = (a: number): number => (parent[a] === a ? a : (parent[a] = findRoot(parent[a])));
        for (let ai = 0; ai < solidIdx.length; ai++) {
            for (let bi = ai + 1; bi < solidIdx.length; bi++) {
                const a = solidIdx[ai], b = solidIdx[bi];
                const minH = Math.min(cl[a].yBottom - cl[a].yTop, cl[b].yBottom - cl[b].yTop);
                if (minH > 0 && yOverlapOf(cl[a], cl[b]) >= 0.7 * minH) parent[findRoot(a)] = findRoot(b);
            }
        }
        for (let s = 0; s < cl.length; s++) {
            if (solidIdx.includes(s)) continue;
            let best = -1, bestOv = 0;
            for (const a of solidIdx) {
                const ov = yOverlapOf(cl[s], cl[a]);
                if (ov > bestOv) { bestOv = ov; best = a; }
            }
            if (best !== -1 && bestOv > 0) parent[findRoot(s)] = findRoot(best);
        }
        const byRoot = new Map<number, RimiLine[]>();
        cl.forEach((f, idx) => {
            const r = findRoot(idx);
            const row = byRoot.get(r);
            if (row) row.push({ ...f }); else byRoot.set(r, [{ ...f }]);
        });
        const subRows = [...byRoot.values()];
        for (const rowFrags of subRows) {
        if (rowFrags.length === 1) { out.push(rowFrags[0]); continue; }
        // DOUBLE-READ suppression, per sub-row: the engine sometimes emits
        // the SAME physical text twice at near-identical coords — name rows
        // ("Virtos GIMINIŲ dešrelės," + "Virtos CIMINIŲ derelės," on
        // rimi-30-04-2026-2) AND price anchors (two "2,99 A" on ios-56, which
        // minted a phantom band holding only the next discount line). Two
        // fragments occupying ≥70% of the same x-span cannot be side-by-side
        // text; keep the one with more content.
        const deduped: RimiLine[] = [];
        for (const f of [...rowFrags].sort((a, b) => a.xLeft - b.xLeft)) {
            const dup = deduped.findIndex((k) => {
                const ov = Math.min(k.xRight, f.xRight) - Math.max(k.xLeft, f.xLeft);
                const minW = Math.min(k.xRight - k.xLeft, f.xRight - f.xLeft);
                return minW > 0 && ov >= 0.7 * minW;
            });
            if (dup === -1) deduped.push({ ...f });
            else if (f.text.trim().length > deduped[dup].text.trim().length) deduped[dup] = { ...f };
        }
        if (deduped.length === 1) { out.push(deduped[0]); continue; }
        const hasDiscountCtx = deduped.some((f) => DISCOUNT_CTX_FRAGMENT_RE.test(f.text));
        const separate = hasDiscountCtx
            ? []
            : deduped.filter((f) => PRICE_SHAPE_FRAGMENT_RE.test(f.text.trim()));
        const mergeable = deduped.filter((f) => !separate.includes(f));
        if (mergeable.length >= 2) {
            const xs = [...mergeable].sort((a, b) => a.xLeft - b.xLeft);
            out.push({
                text: xs.map((f) => f.text.trim()).filter(Boolean).join(' '),
                yTop: Math.min(...xs.map((f) => f.yTop)),
                yBottom: Math.max(...xs.map((f) => f.yBottom)),
                xLeft: Math.min(...xs.map((f) => f.xLeft)),
                xRight: Math.max(...xs.map((f) => f.xRight)),
            });
            out.push(...separate);
        } else {
            out.push(...deduped);
        }
        }
    }
    out.push(...fusedOut);
    out.sort((a, b) => a.yTop - b.yTop || a.xLeft - b.xLeft);
    return out;
}

/** OCR ZERO-GARBLE fold for price rows: a leading digit read as a letter turns
 *  "0,65 A" into "O,65" and the row stops anchoring — the band walls collapse
 *  and TWO products merge into one (rimi-30-04-2026-13 product 13). Folded
 *  ONLY when the ENTIRE text is a price shape with the letter in the leading
 *  slot — a name can never match (letters follow the digits). Same O→0 / l→1
 *  confusion classes the rest of the file already folds via ocrDigit. */
const PRICE_LEAD_GARBLE_RE = /^[OoIl](?=[.,]\s?\d{2}\s*[AB]?\s*$)/;
const foldPriceLeadGarble = (l: RimiLine): RimiLine => {
    const t = l.text.trim();
    if (!PRICE_LEAD_GARBLE_RE.test(t)) return l;
    const digit = /^[Oo]/.test(t) ? '0' : '1';
    return { ...l, text: digit + t.slice(1) };
};

/** Single entry-normalisation for every public Rimi entry point. */
const normalizeRimiLines = (rawLines: RimiLine[]): RimiLine[] =>
    mergeRowFragmentsRimi(rawLines.map(foldRimiHomoglyphs).map(foldPriceLeadGarble));

export function isRimiReceipt(lines: string[]): boolean {
    const first15 = lines.slice(0, 15).join(' ').toUpperCase();
    if (first15.includes('RIMI')) return true;
    // FALLBACKS: the header name can fail OCR entirely (logo print, crop,
    // glare). Any of these tokens is Rimi-specific WHEREVER it appears:
    // the company PVM code, the loyalty programme, the domain, the
    // support e-mail domain.
    const all = lines.join(' ').toUpperCase();
    return (
        all.includes('LT237153113') ||
        all.includes('MANO RIMI') ||
        all.includes('RIMI.LT') ||
        all.includes('RIMIBALTIC')
    );
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

/**
 * Match the per-unit / per-weight rate line that Rimi prints in the
 * middle column ("0,978 kg X 1,69 EUR/kg" or "2 vnt. X 4,99 EUR"). The
 * band classifier usually tags these as `weight/multi`, but on some
 * iOS receipts they slip into `preName` and get glued into the product
 * name. Strip the entire fragment so neither name-similarity nor
 * `extractPackSize` picks up tokens from it.
 *
 * Signature shape: `[number][unit] [maybe-junk] X [number][maybe-junk]
 * [optional EUR][optional /kg suffix] [optional trailing stray digit]`.
 * The `X` between number-unit pairs is the unique discriminator —
 * pack-size tokens never have an `X` next to them.
 */
const WEIGHT_LINE_FRAGMENT_RE =
    /[\dOoIlL][\dOoIlL.,]*\s*(?:kg|g|ml|l|vnt\.?)\s*[^\w\s]*\s*[xX×]\s*[\dOoIlL.,]+\s*[^\s,]*(?:\s+[\dOoIlL.,]+)?/gi;

// Companion to WEIGHT_LINE_FRAGMENT_RE for weighable lines where MLKit dropped
// the unit (`kg`) between the weight and the `X` but kept the `/kg` rate suffix
// at the end — observed as "0,986 .27 X 1,39 EUR/kg" (banana by-weight line
// where the intermediate slice was classified as preName and absorbed into the
// product name). The `EUR/kg` suffix uniquely discriminates weighable from
// multi-buy: multi-buy lines never carry a `/kg` rate suffix, so no false positives
// from numeric tokens in product names. `[^xX×]{0,20}` absorbs stray OCR
// fragments (e.g. the `.27` price fragment) between the weight qty and the `X`.
const WEIGHT_LINE_RATE_FRAGMENT_RE =
    /\d[\dOoIlL.,]*[^xX×]{0,20}[xX×]\s*[\dOoIlL.,]+\s*(?:[EF]?UR|€)?\s*\/\s*kg\b/gi;

/**
 * Detect and extract a pack-size token from the product name.
 *
 * Receipts print pack size inside the product name (e.g.
 * "Tualetinis popierius ZEWA EVERYDAY, 32 rit." or "Ind. gelis SOMAT
 * 990ml 55sk"). Without structured extraction:
 *   - `cleanProductName` strips trailing size tokens, so the name
 *     loses any discriminating signal
 *   - the matcher then can't tell a 32-roll pack from a 12-roll pack
 *     and returns confidence 1.0 against the wrong variant
 *
 * The digit class accepts OCR-confusing letters: `O`/`o` for 0,
 * `I`/`l`/`L`/`i` for 1. Receipts in the wild produce "lkg" for
 * "1 kg", "25Oml" for "250 ml", "i kg" for "1 kg". The substitution
 * happens at parse time (`parseNumLoose`) so the numeric value is
 * recovered correctly. We REQUIRE at least one actual digit in the
 * captured run to keep `\bg\b` and `\bl\b` from matching bare letters.
 *
 * Returns the first match in priority order (volume > weight > rolls
 * > tablets > sheets > packs > units > ply). Volume / weight are
 * most discriminating across pack variants; ply tends to be shared
 * across pack sizes so ranks last.
 *
 * The `l` (litre) pattern requires a decimal/comma in the numeric run
 * so "All in One" doesn't yield "1l" by reading the bare `l` as a
 * volume — false-positive risk is highest for that single-letter unit.
 *
 * `strippedName` removes the matched token + adjacent whitespace +
 * trailing-comma noise so downstream name-similarity scoring doesn't
 * count the numeric token twice. It also pre-strips any weight-line
 * fragment (see `WEIGHT_LINE_FRAGMENT_RE`).
 *
 * Returns `{ amount: null, unit: null, strippedName: name }` when no
 * token matches.
 */
export function extractPackSize(
    name: string,
): { amount: number | null; unit: string | null; strippedName: string } {
    // OCR digit class: real digits plus the letters MLKit confuses with
    // 0 (O/o) and 1 (I/l/L/i). `parseNumLoose` substitutes them at parse
    // time. We use `\b` anchors on each pattern instead of HAS_DIGIT_RE
    // so pure-substitute runs like "lkg" (= 1kg) and "i kg" (= 1 kg)
    // are accepted. Mid-word matches stay blocked by `\b`.
    const D = '[\\dOoIlLi]';
    // Per-unit weight-line garbage occasionally classified as preName
    // on iOS gets stripped first so its tokens don't poison the size
    // extractor or name-similarity scoring.
    let preStripped = name.replace(WEIGHT_LINE_FRAGMENT_RE, ' ');
    // Companion: rate-only weight-line (EUR/kg suffix, no unit before X).
    preStripped = preStripped.replace(WEIGHT_LINE_RATE_FRAGMENT_RE, ' ');
    // OCR underscore normalisation: MLKit substitutes `_` for a space or
    // thin separator in printed text (observed as "240_g" for "240 g").
    // Lithuanian grocery names never use underscores, so this is always
    // noise. Replace before unit patterns so `\s*g\b` can match.
    preStripped = preStripped.replace(/_/g, ' ');
    // OCR splits a size's digit run: "POPHOUSE, 18 0g" for a printed "180g",
    // "SMART, 2 5kg" for "2,5kg", "milteliai, 3 Og" for "30 g". Rejoin at a
    // comma-preceded size position only. kg/l get a DECIMAL join (2,5 kg packs
    // exist, 25 kg ones don't); g/ml concatenate. The tail fragment accepts the
    // OCR digit class (O→0 etc.), normalised by the size patterns below.
    preStripped = preStripped.replace(
        /(,\s*)(\d)[\s,]+([\dOoIl])\s*(kg|l)\b/gi,
        (_m, pre, a, b, unit) => `${pre}${a},${b} ${unit}`,
    );
    preStripped = preStripped.replace(
        /(,\s*)(\d{1,3})\s+([\dOoIl]{1,2})\s*(g|ml)\b/gi,
        (_m, pre, a, b, unit) => `${pre}${a}${b} ${unit}`,
    );
    // ", 1lkg" — a stray l between the per-kg reference "1 kg" and its unit
    // ("Saldainiai SLYVA ŠOKOLADE, 1lkg" on BE09D63A); the D-class kg pattern
    // would read "1l" as 11 kg. The ", 1 kg" reference suffix is the only
    // shape this appears in, so the fold is exact.
    preStripped = preStripped.replace(/(,\s*)1l\s*kg\b/gi, (_m, pre) => `${pre}1 kg`);

    // Milk-volume OCR fix: receipt prints "rieb., 2 l" (riebumas = fat
    // content, followed by litre volume) but iOS MLKit fuses the
    // space-separated "2 l" into "21" because lowercase `l` reads as
    // digit 1. The trailing "1" is unambiguously the litre mark in a
    // dairy context — milk isn't sold in non-litre integer amounts like
    // "21 of something". Restricted to dairy keywords + trailing-end
    // position so non-milk products with "rieb., 21 mėn" (matured-cheese
    // age) etc. don't false-trigger.
    const DAIRY_RE = /\b(?:pien|kefyr|r[uū]gpien|grietin|jogurt)/i;
    // `\s?` between the digit and the litre-mark-read-as-1: the row merger can
    // reassemble a fragment-split "2 l" as "2 1" (space preserved).
    const MILK_LITRE_OCR_RE = /(rieb\.[^,]*[,\s]\s*)([1-9])\s?1\b\s*(?![A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž])/i;
    // Some milk receipts don't print the "rieb." abbreviation — the fat
    // percentage is followed directly by the volume:
    //   "ROKIŠKIO NAMINIS pienas 2,5%, 1 l" → OCR'd "...2,5%, 1 1"
    // Same trailing-end damage but no rieb. anchor. The %-followed-by-
    // digit-pair shape at end is unambiguous for dairy products.
    const MILK_LITRE_NO_RIEB_RE = /%\s*,?\s+([1-9])\s+1\b\s*(?![A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž])/i;
    if (DAIRY_RE.test(preStripped)) {
        const milkMatch = preStripped.match(MILK_LITRE_OCR_RE);
        if (milkMatch) {
            const num = parseInt(milkMatch[2], 10);
            if (Number.isFinite(num) && num >= 1 && num <= 9) {
                const strippedName = preStripped
                    .replace(MILK_LITRE_OCR_RE, '$1')
                    .replace(/[,;]\s*$/g, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return { amount: num, unit: 'l', strippedName };
            }
        }
        const noRiebMatch = preStripped.match(MILK_LITRE_NO_RIEB_RE);
        if (noRiebMatch) {
            const num = parseInt(noRiebMatch[1], 10);
            if (Number.isFinite(num) && num >= 1 && num <= 9) {
                const strippedName = preStripped
                    .replace(MILK_LITRE_NO_RIEB_RE, '')
                    .replace(/[,;]\s*$/g, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return { amount: num, unit: 'l', strippedName };
            }
        }
    }

    // Sub-litre beverage OCR fix: receipt prints "0,5 l" / "0,33 l" /
    // "0,7 l" (standard bottle sizes for cocktails / beer / wine / soft
    // drinks) but iOS MLKit (a) splits the decimal comma with a space
    // and (b) fuses the trailing " l" into "1" because lowercase l
    // reads as digit 1. Final text: "0, 51" / "0, 331" / "0, 71" at
    // the trailing end of the name.
    //
    // Three guards keep this from false-matching percentage tokens
    // ("21,5%", "0,5%", etc.):
    //   1. BEVERAGE_RE — name must contain a beverage keyword
    //   2. Pattern starts with literal `0` followed by comma — anchors
    //      this to the sub-litre bottle convention. Whole-litre forms
    //      ("1 l", "2 l") are handled by the whole-number-l pattern.
    //   3. Trailing-end position (`\s*$`) — anchors to the volume slot
    //      at end of name, not random `0,X` digit pairs mid-name.
    const BEVERAGE_RE = /\b(?:kokteil|alus\b|vynas|alkohol|degtin|liker|šampan|sidr|spirit|al\.|rom)/i;
    const SUBLITRE_OCR_RE = /\b0\s*,\s*(\d{1,2})\s*[1l]\b\s*$/i;
    if (BEVERAGE_RE.test(preStripped)) {
        const subLitreMatch = preStripped.match(SUBLITRE_OCR_RE);
        if (subLitreMatch) {
            const decimalDigits = subLitreMatch[1];
            const num = parseFloat(`0.${decimalDigits}`);
            if (Number.isFinite(num) && num > 0 && num < 1) {
                const strippedName = preStripped
                    .replace(SUBLITRE_OCR_RE, '')
                    .replace(/[,;]\s*$/g, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return { amount: num, unit: 'l', strippedName };
            }
        }
    }

    // Whole-litre OCR fix for plant-based drinks and other beverages:
    // receipt prints "X l" (e.g. "1 l") but iOS MLKit either (a) fuses
    // digit + l into "X1" / "Xl" or (b) reads two digits ("11") because
    // `l` → `1`. The existing `\b(D+)\s+l\b` pattern only handles the
    // space-preserved case. Guard is broader than BEVERAGE_RE to also
    // cover "gerimas" (plant-based drink), "sultys"/"sulčių" (juice),
    // "vanduo"/"vand." (water).
    // Broader than BEVERAGE_RE: also covers juices, water, and oils
    // ("aliej") which can appear as "1,5 l" bottles. `ger\.` catches the
    // abbreviated "ger." form of "gėrimas" that Rimi prints on multi-word
    // product names where space is tight (e.g. "sojos ger. ALPRO PLANT …").
    const DRINK_RE = /\b(?:gerim|ger\.|sul[čc][iy]|sult[iy]|vand|alus\b|vyn|degtin|liker|šampan|sidr|kokteil|spirit|al\.|alkohol|aliej|rom)/i;
    // Matches trailing ", X1" / " X1" / " Xl" / " X l" (whole litres) OR
    // ", X,Y1" / " X,Y1" (decimal litres where `l` was OCR'd as `1`).
    // Example: "NATURA, 1,51" = "NATURA, 1,5 l" → amount=1.5, unit='l'.
    // The `(?:[.,]\d{1,2})?` capture of the decimal part relies on regex
    // backtracking: the engine first tries to take 2 decimal digits into
    // the capture (leaving nothing for `[1l]`), fails, backtracks, takes
    // 1 decimal digit, leaving the last `1` for `[1l]`. ✓
    const DRINK_TRAILING_LITRE_RE = /(?:,\s*|\s+)([1-9](?:[.,]\d{1,2})?)\s*[1l]\b\s*(?![A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž\d])/i;
    if (DRINK_RE.test(preStripped)) {
        const drinkMatch = preStripped.match(DRINK_TRAILING_LITRE_RE);
        if (drinkMatch) {
            const rawNum = drinkMatch[1].replace(',', '.').replace(/\s/g, '');
            const num = parseFloat(rawNum);
            if (Number.isFinite(num) && num >= 0.25 && num <= 9) {
                const strippedName = preStripped
                    .replace(DRINK_TRAILING_LITRE_RE, '')
                    .replace(/[,;]\s*$/g, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();
                return { amount: num, unit: 'l', strippedName };
            }
        }
    }

    // Dual-unit tokens like "75ml/75g" — Lithuanian solid/semi-solid
    // foods (ice cream, yogurt, pudding) print both the volume and the
    // legal net mass. EU labeling requires mass as the authoritative
    // figure, so catalogs store the gram value. When we see the
    // `X<vol>/Y<mass>` shape, pick the weight side regardless of
    // ordering. Strips the entire dual-unit fragment from the name so
    // the dangling "/" + orphan half don't leak through.
    const DUAL_RE = new RegExp(
        `(${D}+(?:[.,]${D}+)?)\\s*(ml|l|g|kg|1)\\s*\\/\\s*(${D}+(?:[.,]${D}+)?)\\s*(g|kg|ml|l|1)\\b`,
        'i',
    );
    const dualMatch = preStripped.match(DUAL_RE);
    if (dualMatch) {
        const num1 = dualMatch[1];
        // The `1` alternative in the unit slot is OCR-substitute for
        // lowercase `l` (the litre mark). Observed on iOS as
        // "1 l / 500 g" → "1 1 /500 g". Translate before downstream
        // logic so the weight-preference picker treats it as `l`.
        const translateOcrUnit = (u: string) => (u === '1' ? 'l' : u);
        const unit1 = translateOcrUnit(dualMatch[2].toLowerCase());
        const num2 = dualMatch[3];
        const unit2 = translateOcrUnit(dualMatch[4].toLowerCase());
        const isWeight = (u: string) => u === 'g' || u === 'kg';
        const pickNum = isWeight(unit1) ? num1 : isWeight(unit2) ? num2 : num1;
        const pickUnit = isWeight(unit1) ? unit1 : isWeight(unit2) ? unit2 : unit1;
        const normalised = pickNum
            .replace(/,/g, '.')
            .replace(/[Oo]/g, '0')
            .replace(/[IlLi]/g, '1');
        const num = parseFloat(normalised);
        if (Number.isFinite(num) && num > 0) {
            const strippedName = preStripped
                .replace(DUAL_RE, ' ')
                .replace(/\s+,\s*/g, ', ')
                .replace(/,\s*$/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return { amount: num, unit: pickUnit, strippedName };
        }
    }

    // Volume `l` patterns. Two variants because of the false-positive
    // risk with single-letter `l`:
    //   1. Decimal-l (`1.5l`, `0,5l`, `1,5 l`): require a decimal so
    //      "All in One" never reads as "1l in One".
    //   2. Whole-number-l (`2 l`, `1 l`): require ≥1 whitespace
    //      between the digit and `l`. Catches the common milk shape
    //      ("ROKIŠKIO pienas, 2 l") without re-introducing the "All"
    //      / "Atl" false positives — those have no whitespace before
    //      the `l`. Tried after the decimal variant so the decimal
    //      version takes precedence when both could match.
    // Trailing ", N 1" (or ", I 1") — the litre mark read as digit 1 at the
    // very END of the name ("ALPRO PLANT PROTEIN, I 1" = 1 l, "pienas …, 2 1"
    // = 2 l). Comma-preceded + end-anchored, so ordinary numbers can't match.
    const TRAILING_LITRE_AS_ONE_RE = /,\s*([1-9OoIl])\s+1\s*$/;
    {
        const t = preStripped.match(TRAILING_LITRE_AS_ONE_RE);
        if (t) {
            const num = parseInt(t[1].replace(/[Oo]/, '0').replace(/[Il]/, '1'), 10);
            if (Number.isFinite(num) && num >= 1 && num <= 9) {
                const strippedName = preStripped
                    .replace(TRAILING_LITRE_AS_ONE_RE, '')
                    .replace(/[,;]\s*$/g, '')
                    .trim();
                return { amount: num, unit: 'l', strippedName };
            }
        }
    }

    const patterns: Array<{ re: RegExp; unit: string }> = [
        { re: new RegExp(`\\b(${D}+(?:[.,]${D}+)?)\\s*ml\\b`, 'i'),  unit: 'ml' },
        // "400 9" — the g read as 9 at 300 dpi (kvitas 26117700 BARILLA).
        // Trailing-end + comma-preceded size position only, so a real number
        // sequence in a name can't false-match.
        { re: new RegExp(`,\\s*(${D}{2,4})\\s+9\\s*$`, 'i'),          unit: 'g'  },
        // "100c" — the g read as c ("Poesia 100c A"). \b after c blocks "cm";
        // an optional trailing VAT letter is tolerated at the end.
        { re: new RegExp(`\\b(${D}{2,4})\\s*c\\b\\.?\\s*(?:[AB]\\s*)?$`, 'i'), unit: 'g'  },
        { re: new RegExp(`\\b(${D}+[.,]${D}+)\\s*l\\b`, 'i'),         unit: 'l'  },
        { re: new RegExp(`\\b(${D}+)\\s+l\\b`, 'i'),                  unit: 'l'  },
        { re: new RegExp(`\\b(${D}+(?:[.,]${D}+)?)\\s*kg\\b`, 'i'),   unit: 'kg' },
        { re: new RegExp(`\\b(${D}+(?:[.,]${D}+)?)\\s*g\\b`, 'i'),    unit: 'g'  },
        { re: new RegExp(`\\b(${D}+)\\s*rit\\b\\.?`, 'i'),            unit: 'rit' },
        { re: new RegExp(`\\b(${D}+)\\s*sk\\b`, 'i'),                  unit: 'sk' },
        { re: new RegExp(`\\b(${D}+)\\s*lap\\b\\.?`, 'i'),             unit: 'lap' },
        { re: new RegExp(`\\b(${D}+)\\s*pak\\b\\.?`, 'i'),             unit: 'pak' },
        { re: new RegExp(`\\b(${D}+)\\s*vnt\\b\\.?`, 'i'),             unit: 'vnt' },
        { re: new RegExp(`\\b(${D}+)\\s*sl\\b\\.?`, 'i'),              unit: 'sl' },
    ];
    for (const { re, unit } of patterns) {
        // First ACCEPTABLE match, not just the first match: a pure-substitute
        // letter-run earlier in the string ("užkand.ig") must not shadow a
        // real size later ("165g") — scan all matches for this unit.
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        let m: RegExpMatchArray | null = null;
        for (const cand of preStripped.matchAll(g)) {
            if (!/\d/.test(cand[1]) && unit === 'g') continue;
            // zero-amounts ("18 0g" matching just "0g") must not shadow a real
            // size either — normalise and require > 0 before accepting.
            const probe = parseFloat(cand[1].replace(/,/g, '.').replace(/[Oo]/g, '0').replace(/[IlLi]/g, '1'));
            if (!Number.isFinite(probe) || probe <= 0) continue;
            m = cand as RegExpMatchArray;
            break;
        }
        if (!m) continue;
        // Wider OCR fold than parseNumLoose (which only handles I/l/L,
        // missing lowercase `i`). `i kg` on Rimi receipts reads `i`
        // where the printed digit was 1.
        const normalisedDigits = m[1]
            .replace(/,/g, '.')
            .replace(/[Oo]/g, '0')
            .replace(/[IlLi]/g, '1');
        const num = parseFloat(normalisedDigits);
        if (!Number.isFinite(num) || num <= 0) continue;

        // Strip the matched token + collapse adjacent whitespace and
        // dangling commas so the cleaned name doesn't double-count the
        // numeric token in name-similarity scoring.
        const strippedName = preStripped
            .replace(re, ' ')
            .replace(/\s+,\s*/g, ', ')
            .replace(/,\s*$/g, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
        return { amount: num, unit, strippedName };
    }
    // Last-resort: "N %" at the end of name where N is a 3-4 digit
    // integer ≥ 100 — impossible as a genuine percentage (no food has
    // ≥ 100 % fat/cocoa/etc.), so treat as OCR'd gram weight (g → %).
    // Decimal-separator percentages like "3,5 %" are unaffected because
    // \d{3,4} requires 3-4 CONSECUTIVE digits.
    const pctGramMatch = preStripped.match(/\b(\d{3,4})\s*%\s*$/);
    if (pctGramMatch) {
        const num = parseInt(pctGramMatch[1], 10);
        if (num >= 100 && num <= 9999) {
            const strippedName = preStripped
                .replace(/\b\d{3,4}\s*%\s*$/, '')
                .replace(/[,;]\s*$/g, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
            return { amount: num, unit: 'g', strippedName };
        }
    }
    return { amount: null, unit: null, strippedName: preStripped.replace(/\s{2,}/g, ' ').trim() };
}

export function parseFooter(lines: RimiLine[]): RimiFooter {
    let total: number | null = null;
    // True when the accepted Mokėti amount matched on a WHITESPACE-only
    // separator — that leniency exists for smudged commas, but a digit-DROP
    // garble produces the same shape with a wrong value (BE09D63A: bold
    // "31,93" OCR'd as "3 93" → 3.93). Weak reads get cross-checked against
    // the card slip below.
    let totalWeakSep = false;
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
        `^([${DIGIT_CHARS}]+)(${SEPARATOR})([${DIGIT_CHARS}]{2})(?:\\b|$)`,
    );
    const parseAmountEx = (s: string): { value: number; weak: boolean } | null => {
        const m = s.trim().match(AMOUNT_RE);
        if (!m) return null;
        const intVal = parseInt(ocrDigit(m[1]), 10);
        if (isNaN(intVal)) return null;
        return {
            value: parseFloat(intVal + '.' + ocrDigit(m[3])),
            weak: !/[.,]/.test(m[2]),
        };
    };
    const parseAmount = (s: string): number | null => parseAmountEx(s)?.value ?? null;

    for (let i = 0; i < lines.length; i++) {
        const text = lines[i].text.trim();

        // Path 1: same-line "Mokėti N,NN". Uses the expanded diacritic
        // class so OCR variants like "Mokêti"/"Mokëti" still match.
        // The `total === null` guard prevents a later partial-match
        // (e.g. on a Mokestis-derived line that slips through) from
        // overwriting the first canonical match.
        const moketiMatch = text.match(
            new RegExp(
                `Mok${E_DIACRITIC_CLASS}ti\\s+([${DIGIT_CHARS}]+)(${SEPARATOR})([${DIGIT_CHARS}]{2})`,
                'i',
            ),
        );
        if (moketiMatch && total === null) {
            const intVal = parseInt(ocrDigit(moketiMatch[1]), 10);
            const cents = ocrDigit(moketiMatch[3]);
            if (!isNaN(intVal)) {
                total = parseFloat(intVal + '.' + cents);
                totalWeakSep = !/[.,]/.test(moketiMatch[2]);
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
        //      parseAmount can't recover it). The forward scan is
        //      bounded by the Kvito-Nr AND the VAT-table header — the
        //      VAT columns are not reliably ordered, so an unreadable
        //      total heals via the PIRKINYS card-slip lane or the
        //      reconciliation-derived expected total instead.
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
            let chosenWeak = false;

            // Pass A — same-row scan (canonical Rimi layout).
            for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) {
                if (k === i) continue;
                const cand = lines[k];
                if (!isSameRow(cand)) continue;
                const amount = parseAmountEx(cand.text);
                if (amount !== null) {
                    chosenCand = cand;
                    chosenAmount = amount.value;
                    chosenWeak = amount.weak;
                    break;
                }
            }

            // Pass B — forward scan up to 10 lines past Mokėti.
            // Walks forward only so a discount/savings row above
            // can't false-positive. Stops at the `Kvito Nr.` line
            // (definitive end of the total/payment block) so
            // unrelated amounts further down can't slip in.
            if (chosenAmount === null) {
                const KVITO_NR_STOP = /^[KA][vouy]ito\s+Nr?/i;
                // VAT-table stop: the tax breakdown follows the payment
                // block and its columns (Be PVM / PVM suma / Suma su PVM)
                // are NOT reliably ordered — the forward scan used to grab
                // the FIRST parseable number and took "Be PVM" for the
                // total (rimi-30-04-2026-15: 0,36 instead of 0,44). With
                // the reconciliation-derived fallback in parseRimiReceipt a
                // missing total now heals arithmetically, so stopping here
                // strictly beats guessing a column.
                const VAT_TABLE_STOP = /Mokestis|Suma\s+su\s+PV[MH]|Be\s+PV[MH]|PV[MH]\s+suma/i;
                for (let k = i + 1; k <= Math.min(lines.length - 1, i + 10); k++) {
                    const cand = lines[k];
                    if (KVITO_NR_STOP.test(cand.text.trim())) break;
                    if (VAT_TABLE_STOP.test(cand.text)) break;
                    const amount = parseAmountEx(cand.text);
                    if (amount !== null) {
                        chosenCand = cand;
                        chosenAmount = amount.value;
                        chosenWeak = amount.weak;
                        break;
                    }
                }
            }

            if (chosenAmount !== null && chosenCand) {
                total = chosenAmount;
                totalWeakSep = chosenWeak;
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
            const tail = text.replace(RECEIPT_NO_KVITO_NR_STRIP_RE, '');
            const cleaned = ocrDigit(
                tail
                    .replace(/\s*Kasa\s+\d+.*$/i, '')
                    .replace(/\s+/g, '')
                    .trim(),
            );
            // Require ≥1 digit (post-ocrDigit fold) — the widened
            // [KA][vouy]ito stem admits more garbled lines, and a
            // digitless tail would otherwise mint a junk id that
            // poisons dedup. Digitless → fall through to the numeris
            // form / synthetic fallback instead.
            if (cleaned && /\d/.test(cleaned)) {
                receiptNo = cleaned;
                trackLine(lines[i], 'receiptNo');
            }
        }

        if (!receiptNo && !BANKO_KVITO_RE.test(text) && RECEIPT_NO_KVITO_NUMERIS_RE.test(text)) {
            // Digit class admits the O/o/I/l OCR confusions —
            // normalised right below via ocrDigit, same as the Nr form.
            const m = text.match(/^[KA][vouy]ito\s+numeris\s+([\dOoIl]+)/i);
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

    // CARD-SLIP total: the embedded card slip prints the charged amount as
    // "PIRKINYS  38,09 EUR" — equal to Mokėti on card payments. The amount
    // requires a REAL decimal separator, so it can't repeat a digit-drop
    // garble.
    const cardSlipTotal = (): { value: number | null; src: RimiLine } | null => {
        for (const l of lines) {
            if (!/P[Il1]RK[Il1]N[YV]S/i.test(l.text)) continue;
            const inline = l.text.match(/(\d+[.,]\s?\d{2})\s*(?:EUR)?\s*$/i);
            if (inline) return { value: parseNumLoose(inline[1]), src: l };
            const sib = lines.find((o) => o !== l
                && Math.max(o.yTop, l.yTop) < Math.min(o.yBottom, l.yBottom)
                && /^\d+[.,]\s?\d{2}\s*(?:EUR)?$/i.test(o.text.trim()));
            if (sib) return { value: parseNumLoose(sib.text), src: sib };
        }
        return null;
    };

    // WEAK-separator cross-check: a Mokėti amount that matched on
    // whitespace alone is kept only while nothing better exists — when the
    // card slip disagrees, the slip wins (BE09D63A: "Mokėti 3 93" → 3.93,
    // card slip "PIRKINYS 31,93 EUR"; the bogus 3.93 tripped the gross-
    // mismatch sanity, the total fell to the item-sum derivation and
    // reconciliation went self-referential). The corrected value is still a
    // READ total, so reconciliation can verify it.
    if (total !== null && totalWeakSep) {
        const slip = cardSlipTotal();
        if (slip && slip.value !== null && slip.value !== total) {
            total = slip.value;
            trackLine(slip.src, 'total');
        }
    }

    // Fallback lane: fires only when every Mokėti path failed (e.g. the
    // bold total digits shattered into unparseable fragments: "3 8" + "09"
    // on ios-receipt-55, "4 6" on rimi-30-04-2026-9). A READ total beats an
    // arithmetically derived one — reconciliation can then verify instead
    // of assume.
    if (total === null) {
        const slip = cardSlipTotal();
        if (slip && slip.value !== null) {
            total = slip.value;
            trackLine(slip.src, 'total');
        }
    }

    // LAST RESORT (cash receipt, IKI-parser parity): total = Grynieji
    // (cash tendered) − Grąža (change). When the payment block is too
    // scrambled to read a "Mokėti" total but the cash + change rows
    // survived, this still recovers it. Only when BOTH are cleanly
    // present and cash ≥ change.
    if (total === null) {
        const amtIn = (re: RegExp): number | null => {
            for (const l of lines) {
                if (!re.test(stripDiacritics(l.text))) continue;
                const m = l.text.match(/(\d+[.,]\s?\d{2})/);
                if (m) return parseNumLoose(m[1]);
            }
            return null;
        };
        const cash = amtIn(/Grynie/i);
        const change = amtIn(/Gr[aą][zž]a/i);
        if (cash !== null && change !== null && cash >= change) {
            total = round2(cash - change);
        }
    }

    // Synthetic receipt-id fallback (IKI-parser parity): when the
    // printed "Kvito Nr." row was too garbled to survive OCR, a
    // missing receiptNo bails the WHOLE scan downstream. Date + time
    // + total identify the purchase just as uniquely — the same
    // receipt photographed again yields the same synthetic id, so
    // backend dedup still works. Only minted when all three parts
    // are present; a partial key would collide across receipts.
    if (!receiptNo && date && time && total !== null) {
        receiptNo = syntheticReceiptNo(date, time, total);
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

/**
 * Deterministic fallback receipt id from date + time + total —
 * `${YYYYMMDD}-${HHMMSS}-${cents}-rimi-receipt`. Shared by
 * parseFooter (printed id garbled) and parseRimiReceipt (total only
 * recovered by the item-sum fallback) so both paths mint the SAME id
 * for the same receipt.
 */
function syntheticReceiptNo(date: string, time: string, total: number): string {
    return `${date.replace(/-/g, '')}-${time.replace(/:/g, '')}-${Math.round(total * 100)}-rimi-receipt`;
}

/**
 * RECEIPT-LEVEL adjustments between the item sum and the Mokėti total —
 * the three row kinds that move money without being products:
 *   • "Panaudoti MANO RIMI pinigai  -0,14" — loyalty wallet spend (negative)
 *   • "Užstatas - vienkartinė … pakuotė  0,20" — container deposit (positive;
 *     a taromat refund prints negative and the printed sign is kept)
 *   • "Apvalinimas ±0,0x" — cash rounding (signed)
 * The SUTEIKTOS NUOLAIDOS block also RE-LISTS per-product discounts — those
 * are already inside each product's Galut. kaina and must NOT be booked
 * (rimi-30-04-2026-13 double-count trap), hence label-matching only.
 * Amounts sit either on the label line itself or in the right price column
 * within ~2 row heights (the deposit label wraps over two rows).
 */
function rimiReceiptAdjustments(lines: RimiLine[]): { total: number; used: Set<RimiLine> } {
    // PLAIN amounts only — adjustment values never carry a VAT letter.
    // Tolerating "N,NN A" here made the deposit sibling-search grab nearby
    // product ANCHORS (rimi-30-04-2026-12 booked 2,18 A as a deposit).
    const priceShaped = (t: string) => /^-?\s?\d+[.,]\s?\d{2}\s*$/.test(t.trim());
    const val = (t: string): number | null => {
        const m = t.replace(/\s+/g, '').replace(',', '.').match(/-?\d+\.\d{2}/);
        return m ? parseFloat(m[0]) : null;
    };
    const used = new Set<RimiLine>();
    let adj = 0;
    for (const l of lines) {
        // Homoglyph-tolerant labels (garble gate): "RIMI"→"Rini"/"RlMl" is in
        // this corpus (rimi-30-04-2026-2: "Uždirbti MANO Rini pinigai") — the
        // "Panaudot…" stem is what distinguishes spend from the Uždirbti/
        // likutis recaps, so the RIMI token can be loose. Deposits reuse
        // DEPOSIT_PATTERN (ū/ü/2 classes) — the extract's band skip already
        // matches it, and a narrower regex here made the two lanes disagree.
        // `\w{0,2}pinig`: OCR doubles the leading letter ("Ppinigai" on
        // ios-55) — the Panaudot/MANO/R stems already pin the label down.
        const isPinigai = /Panaudot\w{0,2}\s+MANO\s+R\w{2,3}\s+\w{0,2}pinig/i.test(l.text);
        const isDeposit = DEPOSIT_PATTERN.test(l.text);
        const isRounding = /Apvalinim/i.test(l.text);
        if (!isPinigai && !isDeposit && !isRounding) continue;
        const rowH = Math.max(1, l.yBottom - l.yTop);
        // 1) amount on the label line itself
        const inline = l.text.match(/(-?\s?\d+[.,]\s?\d{2})\s*$/);
        let amount = inline ? val(inline[1]) : null;
        // 2) right-column sibling within ~2 rows below the label top (the
        //    deposit label wraps: "Užstatas - vienkartinė / metalinė pakuotė"
        //    with the 0,20 beside the SECOND row)
        if (amount == null) {
            let best: RimiLine | null = null;
            for (const o of lines) {
                if (o === l || used.has(o) || !priceShaped(o.text)) continue;
                if (o.xLeft < l.xRight) continue;
                if (o.yTop < l.yTop - rowH || o.yTop > l.yTop + 2.4 * rowH) continue;
                if (!best || Math.abs(o.yTop - l.yTop) < Math.abs(best.yTop - l.yTop)) best = o;
            }
            if (best) { used.add(best); amount = val(best.text); }
        }
        if (amount == null) continue;
        // pinigai is always a deduction even when OCR dropped the minus;
        // deposits/rounding keep the printed sign (covers taromat refunds).
        adj += isPinigai ? -Math.abs(amount) : amount;
    }
    return { total: Math.round(adj * 100) / 100, used };
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
        // A split fused-box tail is the PREVIOUS band's recovered Galut —
        // never an anchor (it would mint a phantom band).
        if (line.fusedSplitTail) continue;
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
        // A tail line's bbox can be INFLATED by fused/skewed OCR fragments (a
        // 90 px discount bbox against ~50 px rows, rimi-30-04-2026-5) — taking
        // its raw yBottom pushes the wall past the NEXT product's first name
        // line and sweeps it into this band. Cap each tail contribution to a
        // row-and-a-bit measured off this band's own anchor height.
        const anchorRowH = Math.max(20, anchor.yBottom - anchor.yTop);
        const cappedBottom = (line: RimiLine) =>
            Math.min(line.yBottom, line.yTop + 1.2 * anchorRowH);

        for (let k = anchorIdx + 1; k < productSlice.length; k++) {
            const line = productSlice[k];
            if (line.yTop >= nextAnchorTop) break;
            if (anchorIdxs.includes(k)) break;

            if (isDepositLine(line)) {
                depositSeen = true;
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            // Split fused-box tail = this band's recovered Galut row —
            // tail-eligible so the wall lands BELOW it.
            if (line.fusedSplitTail) {
                lastBottom = Math.max(lastBottom, cappedBottom(line));
                continue;
            }
            if (isDiscountLine(line)) {
                lastBottom = Math.max(lastBottom, cappedBottom(line));
                continue;
            }
            if (isWeightOrMultiLine(line)) {
                lastBottom = Math.max(lastBottom, cappedBottom(line));
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
        // Wall placement: no line CENTER can lie in the open gap
        // (tailBottom, firstNextTop) — any center past tailBottom already
        // bounded firstNextTop — so anywhere inside the gap assigns lines
        // identically. HUG THE TAIL (15% into the gap) instead of the
        // midpoint: when a printed-but-UNREAD row straddles the gap
        // (rimi-30-04-2026-8's dropped first name line), the midpoint sliced
        // it across two band crops; hugging leaves it visually with the NEXT
        // band, matching how read receipts render. Negative gaps (a
        // straddling box makes firstNextTop < tailBottom) keep the midpoint.
        const bottomWall = !Number.isFinite(firstNextTop)
            ? tailBottom
            : firstNextTop > tailBottom
                ? tailBottom + 0.15 * (firstNextTop - tailBottom)
                : (tailBottom + firstNextTop) / 2;
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
    // DRAWN band geometry ≠ walls. Walls are assignment constructs living in
    // the empty gap between bands; drawing them wall-to-wall sliced any
    // printed-but-UNREAD row across two band crops (rimi-30-04-2026-8's
    // dropped first name line). Draw each band down to its CONTENT hull and
    // start the next band's crop right there — inter-band pixels always
    // render with the band BELOW, same as on receipts where every row reads.
    let prevDrawnBottom: number | null = null;

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

        const contentBottom = Math.max(...memberIdxs.map((k) => productSlice[k].yBottom));
        const visTop = prevDrawnBottom
            ?? (Number.isFinite(band.topWall) ? band.topWall : sliceTop);
        const visBottom = bi === internal.length - 1
            ? Math.max(contentBottom, Math.min(sliceBottom, Number.isFinite(band.bottomWall) ? band.bottomWall : sliceBottom))
            : contentBottom;
        productBands.push({
            kind: 'product',
            yTop: visTop,
            yBottom: visBottom,
            label: `#${bi + 1}`,
        });
        prevDrawnBottom = visBottom;

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
export function findReceiptBandsRimi(inputLines: RimiLine[]): RimiReceiptBandPlan {
    const rawLines = normalizeRimiLines(inputLines);
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
export function traceReceiptBandsRimi(inputLines: RimiLine[]): string {
    const rawLines = normalizeRimiLines(inputLines);
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
    /** Printed line total of a deliberately SKIPPED band (bag / deposit-only /
     *  non-catalog) — the item is not emitted as a product but its money IS in
     *  the printed Mokėti (78B94F81: the 0,01 bag broke reconciliation by one
     *  cent). parseRimiReceipt adds this to the reconciliation sum. */
    skippedLineTotal?: number;
    /** Printed anchor total of a weighed-no-ppu product whose price was
     *  ZEROED by the poison guard — the €/kg is unrecoverable but the line's
     *  money is known and belongs in the reconciliation sum. */
    zeroedLineTotal?: number;
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
    // Weighed-hint state: a weight-SHAPED line was seen but every
    // weight regex failed on it (WEIGHT_HINT_RE). Drives the price-
    // poisoning guard after the loop; hintKgQty keeps the printed kg
    // quantity when at least that half of the garbled line survived,
    // so €/kg can be re-derived from the anchor total.
    let weighedHint = false;
    let hintKgQty: number | null = null;
    let hintText: string | null = null;
    const nameFragments: string[] = [];
    const fusedNameFragments: string[] = [];

    const allEntries: Array<{ entry: RimiBandLineEntry; isPreName: boolean }> = [
        ...internal.preName.map((e) => ({ entry: e, isPreName: true })),
        ...internal.postAnchor.map((e) => ({ entry: e, isPreName: false })),
    ];
    for (let ei = 0; ei < allEntries.length; ei++) {
        const { entry, isPreName } = allEntries[ei];
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
            /Gal[uūü]t\s*[.,:;]?\s*k?aina\s*([\dOoIl]+[.,]\s?[\dOoIl]{1,2})/i,
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
        // Fallback for OCR'd weight-lines where `kg` between qty and X
        // is missing but the `EUR/kg` rate suffix is intact (e.g.
        // "0,524 .24 x 23,99 EUR/kg" — the salmon row on receipt 56
        // band 10). The `/kg` suffix can't co-occur with multi-buy
        // lines, so this branch is safe to try after WEIGHT_RE.
        const rateOnlyMatch = stripped.match(WEIGHT_RATE_ONLY_RE);
        if (rateOnlyMatch && pricePerUnit === null) {
            quantity = parseNumLoose(rateOnlyMatch[1]);
            pricePerUnit = parseNumLoose(rateOnlyMatch[2]);
            unit = 'kg';
            continue;
        }
        // Split weight-line lookahead: when the anchor's sort-order
        // separates two weight-line halves so mergeRowFragments can't
        // join them (e.g. "0,986 .27" + "X 1,39 EUR/kg" — the anchor
        // "1,37 A" sorted between them by yTop and prevented the merge),
        // try combining this preName entry with the immediately following
        // preName entry. If the joined text matches WEIGHT_RE or
        // WEIGHT_RATE_ONLY_RE, consume both and skip the next entry.
        //
        // Guard: only attempt when the CURRENT entry is a numeric fragment
        // (digits, OCR-substitute letters O/o/I/l/L/i, and punctuation).
        // A product-name line like "Bananai Cavendish, 20+cm lkg" has
        // real alphabetic content and must NOT be consumed as the first
        // half of a weight-line — that would leave nameFragments empty
        // and trigger skip:no-name for the band.
        const isNumericFragment = /^[\dOoIlLi\s.,+:/-]*$/.test(text.trim());
        if (isPreName && pricePerUnit === null && isNumericFragment) {
            const nextItem = allEntries[ei + 1];
            if (nextItem?.isPreName) {
                const combined = normalizeForNumberRegex(
                    `${text} ${nextItem.entry.line.text.trim()}`,
                );
                const wm2 = combined.match(WEIGHT_RE);
                const ro2 = combined.match(WEIGHT_RATE_ONLY_RE);
                const m2 = wm2 ?? ro2;
                if (m2) {
                    quantity = parseNumLoose(m2[1]);
                    pricePerUnit = parseNumLoose(m2[2]);
                    unit = 'kg';
                    ei++; // consume the next entry too
                    continue;
                }
            }
        }
        const multiMatch = stripped.match(MULTI_RE);
        if (multiMatch && pricePerUnit === null) {
            quantity = parseInt(multiMatch[1], 10);
            pricePerUnit = parseNumLoose(multiMatch[2]);
            unit = 'vnt';
            continue;
        }
        // Weighed-hint capture: the row is weight-SHAPED ("kg ×" body
        // or "EUR/kg" rate suffix) but too garbled for any weight
        // regex above (e.g. a non-foldable letter inside the €/kg
        // digits: "0,978 kg X 1,b9 EUR/kg"). Remember the hint, try
        // to salvage the printed kg quantity for €/kg re-derivation,
        // and NEVER let the fragment into the displayed name.
        if (WEIGHT_HINT_RE.test(stripped)) {
            weighedHint = true;
            if (hintKgQty === null) {
                const km = stripped.match(/(\d+[.,]\s?\d{1,3})\s*kg\b/i);
                if (km) {
                    const q = parseNumLoose(km[1]);
                    if (q > 0) hintKgQty = q;
                }
            }
            if (hintText === null) hintText = stripped;
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
        // Split fused-box tail: the previous discount row's printed Galut
        // value, restored to this band's own territory by the splitter.
        if (entry.line.fusedSplitTail) {
            if (finalPrice === null) {
                const v = parseNumLoose(text);
                if (v > 0 && v < price - 0.009) {
                    finalPrice = v;
                    warnings.push(`Galut. kaina ${v.toFixed(2)} recovered from a fused-box tail`);
                }
            }
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
        // FUSED-ROW QUARANTINE: this box is two printed rows OCR'd into one
        // garbled string (see RimiLine.fusedRow). Its text is part-this-
        // product, part-next-product and part-noise — letting it into the
        // name poisons matching (guaranteed orphan). Excluded unless it is
        // the ONLY name source (a garbled name still beats an empty one,
        // which would get prod-hidden).
        if (entry.line.fusedRow) {
            fusedNameFragments.push(text);
            warnings.push(`fused-row quarantined from name: "${text.slice(0, 40)}"`);
            continue;
        }
        // Include slices that carry product text (letters) OR pure-digit
        // size hints (e.g. "%, 1 1" — the OCR-mangled volume slot on
        // milk receipts where the size hint is on its own slice with no
        // letters; was previously dropped entirely, leaving the volume
        // unrecoverable by extractPackSize). The slice classifier
        // already excludes price/discount/weight/multi rows, so what
        // reaches here is either product text or trailing size info.
        let nameText = text;
        // Strip a trailing "…kaina X,XX" suffix that leaked into a preName
        // slice when OCR fused the product-name continuation with a
        // Galut.kaina fragment (e.g. "mėlynėnis alut. kaina 0,39" where
        // the leading 'G' of "Galut." was lost). Capture the finalPrice
        // if not yet set.
        const kainaInName = nameText.match(
            /\s+(?:\S{1,8}\s+)?kaina\s+([\dOoIl]+[.,]\s?[\dOoIl]{1,2})\s*$/i,
        );
        if (kainaInName) {
            if (finalPrice === null) {
                finalPrice = parseNumLoose(kainaInName[1]);
            }
            nameText = nameText.slice(0, nameText.length - kainaInName[0].length).trim();
        }
        // Strip a trailing "…WORD.? -N,NN" savings fragment that leaked
        // when OCR mangled "Nuol. -N,NN" beyond classifier recognition
        // (e.g. "RIP. -1,92" read where the receipt printed "Nuol. -1,92").
        // Cents are EXACTLY two digits: printed Nuol amounts always are, and
        // one-digit tolerance made a produce GRADE token + a wrapped size
        // digit ("…C2-3, 1" on ios-55 citrinos) read as savings 3,10 — a
        // phantom discount on a discount-less product.
        const savingsInName = nameText.match(
            /(?:^|\s+)\S{1,8}\.?\s*-\s*([\dOoIl]+[.,]\s?[\dOoIl]{2})\s*$/i,
        );
        if (savingsInName) {
            if (savings === null) {
                savings = parseNumLoose(savingsInName[1]);
            }
            nameText = nameText.slice(0, nameText.length - savingsInName[0].length).trim();
        }
        // A bare trailing "EUR" with no amount in front of it is qty-row
        // bleed from a sagging double-read ("ant ib., 500 g EUR" on
        // ios-55) — currency never ends a name row on its own. Amounts
        // keep theirs ("2 vnt. X 3,49 EUR" is not a name row anyway).
        const eurTail = nameText.match(/^(.*?)[\s,]+EUR$/i);
        if (eurTail && !/\d[.,]?\d*\s*$/.test(eurTail[1])) {
            nameText = eurTail[1].trim();
        }
        if (/[a-zA-Z\dąčęėįšųūžĄČĘĖĮŠŲŪŽ]/.test(nameText)) {
            nameFragments.push(nameText);
        }
    }

    // MULTI-CORROBORATED ANCHOR HEAL: the anchor total sometimes garbles a
    // single LEADING digit while the multi-buy line reads clean — ios-56
    // printed "2,78 A" for "2 vnt. X 1,39 EUR" but OCR gave "0,78A". When
    // ppu × qty differs from the anchor by exactly a leading-digit
    // substitution, the receipt's own arithmetic corroborates the fix
    // (Maxima-parser parity: broken-tail cents solve). Never fires when a
    // Galut. kaina is present (the promo lane owns that math).
    if (pricePerUnit !== null && quantity > 1 && finalPrice === null) {
        const expected = Math.round(pricePerUnit * quantity * 100) / 100;
        if (Math.abs(expected - price) > 0.009) {
            const expStr = expected.toFixed(2);
            const gotStr = price.toFixed(2);
            if (expStr.length === gotStr.length && expStr.slice(1) === gotStr.slice(1) && expStr[0] !== gotStr[0]) {
                warnings.push(`anchor HEALED ${gotStr} → ${expStr} (${pricePerUnit.toFixed(2)} × ${quantity} corroborates)`);
                price = expected;
            }
        }
    }

    let rawName = nameFragments.join(' ').trim();
    // Cleaned fused text = the garble minus any trailing price it swallowed
    // (that price belongs to the PREVIOUS product's discount row — see the
    // Galut salvage in parseRimiReceipt).
    const cleanedFused = fusedNameFragments.join(' ')
        .replace(/\s*\d+[.,]\s?\d{2}\s*[AB]?\s*$/, '')
        .trim();
    if (!rawName && fusedNameFragments.length) {
        // Every name line was a fused box — keep the garble over an empty
        // name (empty → skip:no-name → the product vanishes entirely).
        rawName = cleanedFused || fusedNameFragments.join(' ').trim();
        warnings.push('name is a fused-row garble (no clean name line survived)');
    } else if (
        rawName && cleanedFused
        && rawName.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length < 8
    ) {
        // Only a short continuation survived (letters of "BASIC, 400 g" =
        // "BASICg") — a fused box holds the real first name line; garbled
        // beats truncated for matching (rimi-30-04-2026-2 Lazdynų).
        rawName = `${cleanedFused} ${rawName}`;
        warnings.push('fused-row text kept in name (clean name too short without it)');
    }
    if (!rawName) {
        return { product: null, warnings: ['skip:no-name'] };
    }
    // Skipped-but-PAID bands surface their printed total for reconciliation —
    // the bag's 0,01 is in the Mokėti even though no product is emitted.
    // Deposit-only bands deliberately DON'T (rimiReceiptAdjustments books
    // every Užstatas line once; adding here would double-count).
    const paidSkipTotal = (finalPrice != null && finalPrice > 0 ? finalPrice : price) || 0;
    if (NON_CATALOG_PATTERN.test(rawName)) {
        return {
            product: null,
            warnings: [`skip:non-catalog "${rawName.slice(0, 60)}"`],
            skippedLineTotal: paidSkipTotal,
        };
    }
    // FUZZY bag fallback: heavy OCR garble ("Rimi maigagA" for "Rimi maišelis")
    // defeats the pattern above, but a "mai…"-stem token combined with a
    // bag-priced anchor (≤ €0.60) is unambiguous — no real product is both.
    if (/\bmai[sšžzg]\w{0,6}\b/i.test(rawName) && price <= 0.6) {
        return {
            product: null,
            warnings: [`skip:non-catalog fuzzy-bag "${rawName.slice(0, 60)}" (price ${price.toFixed(2)})`],
            skippedLineTotal: paidSkipTotal,
        };
    }
    if (DEPOSIT_PATTERN.test(rawName)) {
        return {
            product: null,
            warnings: [`skip:deposit-only "${rawName.slice(0, 60)}"`],
        };
    }

    // Extract pack size BEFORE cleanProductName (which strips trailing
    // size tokens, losing the signal we need for size-aware matching).
    // The result drives parsedAmount + parsedUnit, which the client
    // forwards to /api/store-products/match so the matcher can prefer
    // SPs of the right pack size when multiple same-named variants exist.
    let { amount: parsedAmount, unit: parsedUnit, strippedName: nameAfterPackExtract } =
        extractPackSize(rawName);

    // WEIGHED PRICE-POISONING GUARD (IKI-parser parity, "show it,
    // never write price"): the band carries a kg signal but ALL of
    // the weight regexes failed, so no €/kg was established. Two
    // kg-signal sources:
    //   - weighedHint: a weight-SHAPED line was seen in the band but
    //     was too garbled to parse (receipt-55/56 shapes);
    //   - a bare ", kg" name tail with no pack-size digits ("Švieži
    //     kalakutų filė, kg") — the per-kg reference suffix — when
    //     OCR dropped the weight row entirely. Fixed packs print a
    //     digit before kg ("1 kg") which extractPackSize captures
    //     and strips, so they never reach this test.
    // Recovery first: when the printed kg quantity survived on the
    // hint line, €/kg = anchor total ÷ qty. When unrecoverable the
    // item must NOT fall back to unit=vnt with the anchor line total
    // as its price — that total is for a FRACTION of a kg and would
    // poison the per-unit reference price. Keep the item (unit 'kg'
    // so it still SHOWS on the receipt) but zero its price and null
    // its €/kg → the server's price ingestion skips `price <= 0` and
    // never writes a reference price.
    let weighedNoPpu = false;
    const bareKgTail =
        parsedAmount === null && /,\s*kg\s*$/i.test(nameAfterPackExtract);
    if (pricePerUnit === null && (weighedHint || bareKgTail)) {
        if (hintKgQty !== null && hintKgQty > 0) {
            const derived = round2(price / hintKgQty);
            if (derived > 0 && derived < 1000) {
                pricePerUnit = derived;
                quantity = hintKgQty;
                unit = 'kg';
                warnings.push(
                    `weighed RECOVERED: €/kg=${derived.toFixed(2)} (price=${price.toFixed(2)} ÷ kg=${hintKgQty})`,
                );
            }
        }
        // GARBLED-PPU recovery (ios-55 paprikos): the mushed hint line still
        // CONTAINS the printed €/kg digits right before the EUKG marker —
        // "46g429 EUKG" ← "0,406 kg X 4,29 EUR/kg". Take the 3-4 digit run
        // before the marker as X,XX / XX,XX, derive qty = anchor ÷ €/kg, and
        // accept ONLY with corroboration: the qty is a plausible weighed
        // amount AND the hint's LEADING digits appear (in order) inside the
        // derived qty's digits ("46" ⊆ "0406"). Both numbers come from the
        // printed line — this is recovery, not fabrication.
        if (pricePerUnit === null && hintText !== null && price > 0) {
            const ppuM = hintText.match(/(\d{3,4})\s*E[UO]?KG\b/i);
            if (ppuM) {
                const d = ppuM[1];
                const ppuCand = parseFloat(`${d.slice(0, d.length - 2)}.${d.slice(-2)}`);
                if (ppuCand > 0) {
                    const qtyCand = Math.round((price / ppuCand) * 1000) / 1000;
                    const leadM = hintText.match(/^\D*(\d+)/);
                    const leadDigits = leadM ? leadM[1] : '';
                    const qtyDigits = qtyCand.toFixed(3).replace(/\D/g, '');
                    const isSubseq = (needle: string, hay: string): boolean => {
                        let i = 0;
                        for (const ch of hay) if (ch === needle[i]) i++;
                        return i >= needle.length;
                    };
                    if (qtyCand >= 0.02 && qtyCand <= 25 && leadDigits.length >= 2 && isSubseq(leadDigits, qtyDigits)) {
                        pricePerUnit = ppuCand;
                        quantity = qtyCand;
                        unit = 'kg';
                        warnings.push(
                            `weighed RECOVERED from garble: €/kg=${ppuCand.toFixed(2)}, kg=${qtyCand} (anchor ${price.toFixed(2)} corroborates "${hintText.slice(0, 24)}")`,
                        );
                    }
                }
            }
        }
        if (pricePerUnit === null) {
            weighedNoPpu = true;
            unit = 'kg';
            if (hintKgQty !== null && hintKgQty > 0) quantity = hintKgQty;
            warnings.push(
                'weighed NO-PPU: kg signal but €/kg unrecoverable — price zeroed (never a unit reference)',
            );
        }
    }

    // Inference layer: when extractPackSize returned null we still have
    // two high-confidence guesses we can make from receipt-line context.
    //
    // (G) Weighable line — `unit === 'kg'` means the receipt printed a
    // per-kg rate and a weighed quantity. The catalog's weighable
    // candidate is stored as `amount: 1, unit: 'kg'`. Defaulting to
    // 1/kg here lets the matcher prefer the weighable variant over
    // similarly-named fixed-pack siblings. Observed on receipt 55's
    // "Česnakai, kg" — the name has no `\d` before `kg` so the regex
    // can't catch it, but the line's unit is enough signal.
    if (parsedAmount === null && unit === 'kg') {
        parsedAmount = 1;
        parsedUnit = 'kg';
        // Strip the trailing "kg" suffix that the receipt prints as the
        // per-kg reference (e.g. "Česnakai, kg" → "Česnakai"). It's now
        // captured in parsedUnit so leaving it in the name would
        // double-count and clutter the displayed product name.
        // cleanProductName below only strips digit-prefixed unit tokens;
        // bare "kg" / ", kg" needs this step.
        nameAfterPackExtract = nameAfterPackExtract
            .replace(/[,;]?\s*kg\s*$/i, '')
            .trim();
    }

    // (F) Non-weighable line with a bare trailing number — most often
    // the case where the unit suffix (typically `g`) got dropped in OCR.
    // Observed on receipts 55/56 as "MALSENA, 300" and "BARILLA FUSILLI,
    // 400". Range-guarded (50-5000) so single-digit codes / year-like
    // 4-digit values can't pollute the matcher. Only fires for
    // non-weighable lines because weighables wouldn't print a bare-pack
    // number after the kg suffix.
    if (parsedAmount === null && unit === 'vnt') {
        // Negative lookbehind: the comma must NOT be preceded by a digit
        // (decimal separator like the `,5` in "1,51" must not trigger this).
        // Without the guard, "NATURA, 1,51" matches `,51` → amount=51 g.
        const tail = nameAfterPackExtract.match(/(?<!\d),\s*(\d{2,4})\s*$/);
        if (tail) {
            const num = parseInt(tail[1], 10);
            if (Number.isFinite(num) && num >= 30 && num <= 5000) {
                parsedAmount = num;
                parsedUnit = 'g';
                nameAfterPackExtract = nameAfterPackExtract
                    .replace(/(?<!\d),\s*\d{2,4}\s*$/, '')
                    .trim();
            }
        }
    }

    const name = cleanProductName(nameAfterPackExtract);

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
            // Galut. kaina is the PRINTED final price — when it's plausible it
            // wins and the mismatch means the Nuol AMOUNT was misread (OCR digit
            // garble, kvitas rimi-30-04-2026 p1: "-0,50" for a real "-0,90").
            // A NOTE, not a WARN: the committed value is trustworthy, and the
            // batch UI flags WARN-prefixed lines as issues.
            if (finalPrice! > 0 && finalPrice! < price) {
                warnings.push(
                    `Nuol amount likely misread (price ${price.toFixed(2)} − savings ${savings!.toFixed(2)} ≠ ` +
                        `Galut ${finalPrice!.toFixed(2)}) — printed Galut. kaina committed`,
                );
            } else {
                warnings.push(
                    `reconcile MISMATCH: price=${price.toFixed(2)} − savings=${savings!.toFixed(2)} = ` +
                        `${expected.toFixed(2)} but Galut.kaina=${finalPrice!.toFixed(2)} (Δ=${delta.toFixed(2)})`,
                );
            }
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

    // DISCOUNT PLAUSIBILITY CLAMP (IKI-parser parity): a discount can
    // never exceed the line total, and a promo can never exceed the
    // base price — paid must satisfy 0 ≤ Galut.kaina ≤ price. A
    // violation means the discount row was mis-attributed or OCR-
    // mangled, so DROP the discount (keep the base price) rather than
    // ship a negative or inflated promo. Weighed-no-ppu items carry no
    // promo at all — their price is zeroed, so a promo would be
    // nonsensical (same rule as IKI's weighedNoPpu).
    let promoPrice = weighedNoPpu ? null : finalPrice;
    if (promoPrice !== null && (promoPrice < 0 || promoPrice > price)) {
        warnings.push(
            `discount DROPPED: implausible Galut.kaina=${promoPrice.toFixed(2)} vs price=${price.toFixed(2)}`,
        );
        promoPrice = null;
    }

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
            // WEIGHED-QTY HEAL (mirror of the multi-corroborated anchor
            // heal): the weighed line can garble a single leading digit of
            // the QUANTITY while ppu and the anchor total read clean —
            // ios-55 printed "0,390 kg X 2,49 EUR/kg" with total "0,97 A"
            // but OCR gave "8,390 kg", minting 8.39 kg of lemons. When
            // anchor ÷ ppu lands on a quantity that differs from the OCR
            // read by exactly a leading-digit substitution, the receipt's
            // own arithmetic corroborates the fix. kg only: integer vnt
            // counts have no printed decimals to corroborate against.
            const derivedQty = unit === 'kg' && pricePerUnit > 0
                ? Math.round((price / pricePerUnit) * 1000) / 1000
                : null;
            const qtyHealOk = (): boolean => {
                if (derivedQty === null || derivedQty <= 0) return false;
                if (Math.abs(Math.round(derivedQty * pricePerUnit! * 100) / 100 - price) > RECONCILE_TOLERANCE_EUR) return false;
                const e = derivedQty.toFixed(3);
                const g = quantity.toFixed(3);
                return e.length === g.length && e.slice(1) === g.slice(1) && e[0] !== g[0];
            };
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
            } else if (qtyHealOk()) {
                warnings.push(
                    `reconcile HEALED: qty ${quantity.toFixed(3)} → ${derivedQty!.toFixed(3)} kg ` +
                        `(price=${price.toFixed(2)} ÷ ppu=${pricePerUnit.toFixed(2)} corroborates)`,
                );
                quantity = derivedQty!;
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
            // Weighed-no-ppu: price 0 (not the fraction-of-kg line
            // total) — the server skips price<=0 writes, so the item
            // shows on the receipt without minting a reference price.
            price: weighedNoPpu ? 0 : price,
            promoPrice,
            quantity,
            unit,
            pricePerUnit: weighedNoPpu ? null : pricePerUnit,
            // Priced per kg → weighable (per-piece rows emit false).
            // Threaded to the server matcher by the coordinator.
            isWeighable: unit === 'kg',
            rawLines,
            region,
            parsedAmount,
            parsedUnit,
        },
        warnings,
        // The MONEY is still known even when the €/kg isn't — the anchor is
        // the printed line total. Reconciliation books it via this side
        // channel so a weighed-no-ppu item doesn't fail the whole receipt's
        // arithmetic (price stays 0: the poison guard is about REFERENCE
        // prices, not about the receipt's own books).
        zeroedLineTotal: weighedNoPpu && price > 0 ? price : undefined,
    };
}

/**
 * Per-band extraction trace, copy-paste-friendly. Companion to
 * `traceReceiptBandsRimi` for step 2.
 */
export function traceRimiExtract(inputLines: RimiLine[]): string {
    const rawLines = normalizeRimiLines(inputLines);
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
        const packSize = product.parsedAmount != null && product.parsedUnit
            ? `[${product.parsedAmount} ${product.parsedUnit}]`
            : '[?]';
        out.push(
            `band ${bandNum}: ${status}  name="${TRUNC(product.name, 60)}" ${packSize}  ` +
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
export function parseRimiReceipt(inputLines: RimiLine[]): RimiParseResult {
    const rawLines = normalizeRimiLines(inputLines);
    const ctx = computeBandsContext(rawLines);
    const header = parseHeader(rawLines.slice(0, ctx.headerEnd));
    const footer = parseFooter(rawLines.slice(ctx.footerStart));
    const products: RimiProduct[] = [];
    // Printed line totals BEFORE per-unit normalization — Galut-aware and
    // exact (no ×qty re-multiplication rounding), the left side of the
    // receipt-level reconciliation equation. Weighed-no-ppu items contribute
    // 0, which correctly FAILS reconciliation (the parse has a hole).
    let lineTotalSum = 0;
    for (const internal of ctx.productInternals) {
        const { product, skippedLineTotal, zeroedLineTotal } = extractRimiProduct(internal);
        if (skippedLineTotal) lineTotalSum += skippedLineTotal;
        if (zeroedLineTotal) lineTotalSum += zeroedLineTotal;
        if (!product) continue;
        const printedLineTotal = (product.promoPrice != null ? product.promoPrice : product.price) ?? 0;
        if (printedLineTotal > 0) lineTotalSum += printedLineTotal;
        if (product.pricePerUnit !== null && product.quantity > 0) {
            product.price = product.pricePerUnit;
            if (product.promoPrice !== null) {
                product.promoPrice =
                    Math.round((product.promoPrice / product.quantity) * 100) / 100;
            }
        }
        products.push(product);
    }
    lineTotalSum = round2(lineTotalSum);

    // (The old cross-band "fused-box Galut salvage" post-pass is gone: the
    // fused-box SPLITTER in mergeRowFragmentsRimi now returns the swallowed
    // Galut value to the previous band's own territory as a fusedSplitTail
    // line, and extractRimiProduct reads it in-band — hard walls intact.)

    // RECEIPT-LEVEL RECONCILIATION: Σ printed line totals + adjustments
    // (MANO RIMI pinigai / deposits / rounding) = printed Mokėti. The
    // expected total also powers the fallback below — the OLD fallback used
    // the raw item sum and wrote a WRONG total whenever wallet money was
    // spent and the Mokėti row was garbled (rimi-30-04-2026-15: printed
    // "0,44" OCR'd as "44" → fallback minted 1.62 instead of 1.62−1.18).
    // (No unlabeled-amount salvage here on purpose: the one receipt that
    // seemed to need it — ios-55's bare "-0,33" — turned out to be a LABEL
    // GARBLE ("Ppinigai"), fixed in the pinigai regex above. Booking bare
    // block amounts by residual-matching can mask a dropped per-item
    // discount as reconciled; without corpus evidence it stays out.)
    const adjustments = rimiReceiptAdjustments(rawLines).total;
    const expectedTotal = round2(lineTotalSum + adjustments);

    // TOTAL SANITY (IKI-parser parity): the to-pay total must be in the
    // ballpark of the expected total. A garbled payment block can leave the
    // total missing OR pin it to a stray tiny value. Only fires on a gross
    // mismatch (< half), so a correctly-read total is never overwritten.
    let totalDerived = false;
    if (expectedTotal > 0 && (footer.total === null || footer.total < expectedTotal * 0.5)) {
        footer.total = expectedTotal;
        totalDerived = true;
    }

    // Reconciled ONLY against a total actually read off the receipt — a
    // derived total would be self-fulfilling. Strict tolerance: the printed
    // numbers are exact; a 1-cent mismatch means a misread digit somewhere
    // and MUST flag (the ensemble second opinion is the cheap insurance).
    footer.reconDelta = !totalDerived && footer.total !== null && products.length > 0
        ? round2(lineTotalSum + adjustments - footer.total) + 0 // + 0 folds JS -0 to 0
        : null;
    footer.reconciled = footer.reconDelta !== null && Math.abs(footer.reconDelta) < 0.005;
    // The synthetic receipt-id fallback needs a total — when the total
    // only became available via the item-sum fallback above, mint the
    // id here with the exact same key parseFooter would have used.
    if (!footer.receiptNo && footer.date && footer.time && footer.total !== null) {
        footer.receiptNo = syntheticReceiptNo(footer.date, footer.time, footer.total);
    }

    return { header, products, footer };
}

export function parseRimiHeaderOnly(inputLines: RimiLine[]): RimiHeader {
    const rawLines = normalizeRimiLines(inputLines);
    const headerEnd = findHeaderEnd(rawLines);
    return parseHeader(rawLines.slice(0, headerEnd));
}
