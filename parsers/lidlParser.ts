/**
 * Lidl Receipt Parser — first pass.
 *
 * Lidl receipts are phone-photographed thermal prints (not electronic
 * PDFs like Maxima/Norfa), so OCR quality is rougher than the other
 * chains. The parser leans heavily on OCR tolerance:
 *   - `A` VAT suffix is optional (alcohol/deposit lines often lack it)
 *   - decimal separator can be `,` or `.`
 *   - digit-letter swaps (`l`↔`1`, `O`↔`0`) on numerics
 *   - barcodes (4-7 digits) appear in three positions: standalone
 *     line, prefix on name, or suffix on price. All handled.
 *
 * Weighable / multi-buy format:
 *     `0,59 x 4,032 kg`          — weighable (kg)
 *     `0,39 x 3,000 €/vnt.`      — multi-buy (count)
 * Both sit between the name and the price line. OCR sometimes reads
 * `x` as `k` — accepted.
 *
 * Discounts on Lidl are aggregated at the bottom of the product list
 * as `Lidl Plus nuolaida` header + `-X,XX A` value, applying to the
 * whole receipt rather than per item. They're detected but NOT split
 * onto individual rows — the receipt's Tarpinė suma reconciles against
 * the sum of gross prices.
 *
 * No scraped Lidl catalog exists → matcher relies on cross-chain
 * fallback (already wired). Each receipt bootstraps new Lidl
 * StoreProducts pointing at existing Maxima/Rimi/IKI Products.
 */

export interface Region {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface LidlLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface LidlProduct {
    name: string;
    price: number;
    promoPrice: number | null;
    quantity: number;
    unit: string;
    pricePerUnit: number | null;
    rawLines: string[];
    region: Region;
}

export interface LidlHeader {
    chainName: string;
    storeCode: string;
    storeAddress: string;
    pvmCode: string;
    rawText: string;
    region: Region;
}

export interface LidlFooter {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
    region: Region;
}

export interface LidlParseResult {
    header: LidlHeader;
    products: LidlProduct[];
    footer: LidlFooter;
}

// ───────── regexes ─────────

// Digit class — includes OCR variants: `O`/`o`→0, `I`/`l`/`L`→1,
// `|`→1 (pipe read as 1 on faded thermal prints).
const D = '[\\d0OoIlL|]';
// Barcode char class — wider: adds Z↔7, S↔5, B↔8, G↔6, z↔2, D↔0,
// E↔3 (seen on `D553404` variants). OCR mangles barcodes more
// readily than prices.
const BC = '[\\d0OoIlLZzSsBbGgDdEe|]';

// Strict price line — used to ANCHOR products (priceIndices). Must
// have a decimal separator, optional A-Z suffix. Note the `!` suffix
// is handled via PRICE_DEPOSIT_RE below, not here — deposit rows are
// skipped, not anchored as products.
//   `2,49 A` / `6.79` / `22,99`
const PRICE_RE = new RegExp(`^(\\d+[.,]\\s?${D}{1,2})\\s*[A-Z]?\\s*$`);
// OCR-damaged price anchor (Cat AA) — space as decimal separator.
// Seen when OCR reads the comma as whitespace: `1 29 A`, `0 59 A`.
// Trailing VAT letter REQUIRED to suppress false positives against
// unrelated `N NN` digit pairs (VAT totals, terminal serials, dates).
// Capture group 1 = integer part, group 2 = fractional part — price
// reconstructed as `${g1}.${g2}`.
const PRICE_OCR_RE = new RegExp(
    `^(${D}{1,2})\\s+(${D}{2})\\s*([A-Z])\\s*$`
);
// Deposit-indicator price: same price shape but with a `!` suffix.
// Lidl uses `!` on bottle-deposit rows (`0,10 !`, `0,60 !`). These
// should skip as non-catalog even when DEPOSIT_RE doesn't match a
// preceding line due to OCR fragmentation.
const PRICE_DEPOSIT_RE = new RegExp(`^(\\d+[.,]\\s?${D}{1,2})\\s*!\\s*$`);
// Lenient price-like fragment — used ONLY as a walk-back STOP
// condition, never as a priceIdx anchor. Catches OCR-mangled variants
// that shouldn't leak into a neighbour's name:
//   `.99`             (leading digit dropped)
//   `0 59 A`          (comma read as space)
//   `049 A`           (decimal separator lost entirely)
//   `O,43_`           (O for 0, stray trailing char)
//   `,29 A`           (leading zero dropped → starts with comma)
//   `|69 A`           (pipe for 1)
//   `-0,88 A`         (negative price-like)
//   `O_43 A`          (`_` as OCR-variant decimal separator)
//   `O, 90 A`         (Cat Z — internal whitespace after the separator)
// Middle separator is `[\s.,_]+` (one OR MORE of space / punct) so
// that `, ` (comma + space) and `.  ` (decimal + double-space) also
// trigger the walk-back stop.
const PRICE_LIKE_RE = new RegExp(
    `^-?\\s*[.,_]?${D}{1,3}[\\s.,_]+${D}{1,3}\\s*[A-Z!_-]?\\s*$`
);
// Discount-value line (aggregated receipt-wide discount near footer).
const DISCOUNT_RE = new RegExp(`^-\\s*(\\d+[.,]\\s?${D}{1,2})\\s*[A-Z]?\\s*$`);
// Weighable or multi-buy — full unit × quantity-or-weight on ONE line.
//     `0,59 x 4,032 kg`       → unit=0.59/kg, qty=4.032 kg, unit=kg
//     `0,39 x 3,000 €/vnt.`   → unit=0.39, qty=3 (per count), unit=vnt
//     `0,10 x 2 €/vnt.`       → unit=0.10, qty=2 (INTEGER — decimal optional!)
//     `k 5,000 €/vnt.`        → OCR dropped unit price, qty=5 still extractable
//     `50_X 2000 €/vnt.`      → `_` as OCR-variant comma (Cat T)
//     `7o000o £/vnt.`         → `£` as OCR-variant `€` (Cat V)
// Leading unit-price group is optional. Quantity decimal is also
// optional (some multi-buy rows have integer counts like `x 2`).
// `[.,_]` accepts `_` as an OCR-mangled decimal separator.
// `[€£]` accepts `£` as an OCR variant of `€` (thermal receipts
// frequently ghost the `€` glyph into `£`).
const UNIT_LINE_RE = new RegExp(
    `^\\s*(?:(\\d+[.,_]\\s?${D}{1,2})\\s*)?[xkXК]\\s*(\\d+(?:[.,_]\\s?${D}{1,3})?)\\s*(kg|[€£]\\s*/\\s*vnt\\.?|[€£]\\s*/\\s*kg)`,
    'i'
);
// OCR-split unit line halves. Decimal optional in both (integer
// quantities like `x 2 €/vnt.` happen).
const UNIT_HEAD_RE = new RegExp(`^\\s*\\d+[.,_]\\s?${D}{1,2}\\s*[xkXК]\\s*$`);
const UNIT_TAIL_RE = new RegExp(
    `^\\s*${D}+(?:[.,_]\\s?${D}{1,3})?\\s*(kg|[€£]\\s*/\\s*vnt\\.?|[€£]\\s*/\\s*kg)\\s*$`,
    'i'
);
// Orphan unit suffix — `€/vnt.` / `£/vnt.` / `€/kg` WITHOUT leading
// digits. Seen when OCR drops the qty+pricePerUnit numeric prefix
// entirely, leaving only the tail fragment on its own line. If not
// consumed, the bare `€/vnt.` string gets pushed as the product name
// and flukes a high-confidence char-similarity match against some
// short catalog entry. Walk-back consumes without extracting qty.
const UNIT_ORPHAN_RE = /^\s*[€£]\s*\/\s*(?:vnt\.?|kg)\s*$/i;
// Cat HH — lenient unit line: `N,NN x N,NNN` prefix WITHOUT the
// `€/vnt.` / `kg` suffix. OCR sometimes mashes the next product's
// name onto the unit line (`0,35 x 10,000yimo spaustuvai 4` =
// unit `0,35 × 10,000` + garbage `yimo spaustuvai 4`). UNIT_LINE_RE
// fails (no clean suffix) so the whole string leaks into name.
// With UNIT_LENIENT_RE we still capture unit price + quantity from
// the prefix and drop the trailing garbage.
const UNIT_LENIENT_RE = new RegExp(
    `^\\s*(\\d+[.,_]\\s?${D}{1,2})\\s*[xkXК]\\s*(\\d+[.,_]\\s?${D}{1,3})\\b`,
    'i'
);
// Cat X — weighable-style tail with garbage PREFIX. `CEoX 0,343 kg`
// — OCR turned the leading unit-price into letters but kept the
// recognizable weight tail. We require an `x`/`X` marker somewhere
// in the line (differentiates from real product names ending in
// `NNN kg`) and capture the trailing `\d+[.,]\d{1,3} (kg|€/vnt.)`.
const UNIT_WEIGHT_LENIENT_RE = new RegExp(
    `[xXкК×].*?(\\d+[.,_]\\s?${D}{1,3})\\s*(kg|[€£]\\s*/\\s*vnt\\.?|[€£]\\s*/\\s*kg)\\s*$`,
    'i'
);
// Cat W — multi-buy qty + name-continuation smoosh: OCR merged the
// quantity from a broken unit line (`2,000`) with the tail of a
// wrapped product name (`Su ban.` = "with banana"). Pattern: digits
// with weight-style decimal at the START, then whitespace, then a
// Lithuanian continuation word (su|ir|be|iš|po|prie). Consume the
// qty, keep only the continuation tail as name.
const MULTIBUY_CONTINUATION_RE = new RegExp(
    `^(\\d+[.,_]\\s?${D}{1,3})\\s+((?:su|ir|be|i[sš]|po|prie)\\s+.+)$`,
    'i'
);
// Barcode at start of a name line: `0080575 Arbūzai mažai sėklu`.
// OCR letter-for-digit variants (`Z606390 uoglene …`) included via BC.
const BARCODE_PREFIX_RE = new RegExp(`^(${BC}{4,10})\\s+(.+)$`);
// Pure-barcode line. Same OCR-tolerant digit class. Also accepts a
// trailing `€/vnt.` / `£/kg` fragment (seen as `D553404 €/vnt.`) —
// OCR occasionally concatenates the next line's orphan unit suffix
// onto the barcode row. Without this, the composite line slips past
// walk-back as a name candidate.
const BARCODE_ONLY_RE = new RegExp(
    `^${BC}{4,10}\\s*(?:[A-Za-z]|[€£]\\s*/\\s*(?:vnt\\.?|kg))?\\s*$`
);
// Deposit lines (bottle deposit + deposit-return). OCR frequently
// mangles the lead character or inserts stray punctuation inside the
// word (`UŽstatas` → `1>statas` / `o02000 1>statas`). The `\W?`
// between the lead char and `stat` tolerates that.
const DEPOSIT_RE = /(?:u[žz]stat[ao]|[i1l]\W?stat[o0]|[i1l]\W?statas?)/i;
// Non-catalog checkout bags. Broadened from the prefix-anchored form
// to match the bag noun anywhere — OCR routinely fragments the line
// into pieces (`irk.maišeli`, `Pop-pr`) where the prefix isn't on
// the same fragment as the `maišeli` tail.
const NON_CATALOG_RE = /\bmai[sš]\w*/i;
// Discount summary header. Tolerates `Nuolalda` (i↔l swap seen on
// low-contrast OCR) alongside the canonical `Nuolaida`. Also matches
// the Lidl Plus loyalty prefix.
const DISCOUNT_HEADER_RE = /(?:lidl\s*plus\s+)?nuo[li]a[li]d[aos]?/i;
// Header end marker. Either the `#00NNNNN` document-number line OR
// the `Kvitas NNNNN/NN` row — whichever comes LATER. Some receipts
// put `#00NNNNN` before `Kvitas N/N` (seen on 08-29, 08-20, 09-13),
// and if findHeaderEnd stops at `#00NNNNN` alone, the `Kvitas N/N`
// row lands inside the product slice and gets absorbed by the first
// product's walk-back (`Kvitas 47989/258 Drėgn. šluost. namams…`).
// Also used as a walk-back stop condition so even if one escapes
// findHeaderEnd's reach, it won't get absorbed.
const RECEIPT_NO_RE = /^#\d{4,}/;
const KVITAS_ROW_RE = /^\s*kvitas\s+\d+\s*\/\s*\d+/i;

/**
 * NFD-strip diacritics before matching footer markers. OCR reads the
 * Lithuanian `ė` as `è` (grave) on some receipts, so `Tarpinè suma`
 * wasn't matching `/tarpin[eė]\s+sum/i`. Stripping the combining-
 * mark layer collapses `ė`/`è`/`é`/`ê` to `e` for the regex test.
 */
function stripDiacritics(s: string): string {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function parseNum(str: string): number {
    const clean = str
        .replace(/[Oo]/g, '0')
        .replace(/[IlL|]/g, '1')
        .replace(/_/g, '.')
        .replace(',', '.')
        .replace(/\s/g, '');
    return parseFloat(clean);
}

function regionOf(lines: LidlLine[]): Region {
    if (lines.length === 0) return { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
    return {
        yTop: Math.min(...lines.map((l) => l.yTop)),
        yBottom: Math.max(...lines.map((l) => l.yBottom)),
        xLeft: Math.min(...lines.map((l) => l.xLeft)),
        xRight: Math.max(...lines.map((l) => l.xRight)),
    };
}

// ───────── detection ─────────

export function isLidlReceipt(lines: string[]): boolean {
    const full = lines.join(' ').toUpperCase();
    // Tolerant: `LIDL`, `LDL` (first-letter dropped on some receipts'
    // header `LDL Verta.`), `UAB "Lidl`. No other Lithuanian grocery
    // chain matches any of these substrings.
    return /\bLID?L\b|LIDL\s+LIETUVA/.test(full);
}

// ───────── boundaries ─────────

function findHeaderEnd(lines: LidlLine[]): number {
    // Two possible header-tail rows: `#00NNNNN` and `Kvitas NNNNN/NN`.
    // They're adjacent but their order varies by receipt layout — some
    // emit `#` first then `Kvitas`, others the reverse. We return the
    // index AFTER whichever comes LATER, so both rows end up in the
    // header slice regardless of order. Without this, the row that
    // lands after findHeaderEnd's anchor gets absorbed as product
    // name text (seen `Kvitas 47989/258 Drėgn. šluost…` smoosh).
    let latestHeaderRow = -1;
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const t = lines[i].text.trim();
        if (RECEIPT_NO_RE.test(t) || KVITAS_ROW_RE.test(t)) {
            latestHeaderRow = i;
        }
    }
    if (latestHeaderRow >= 0) return latestHeaderRow + 1;
    for (let i = 0; i < lines.length; i++) {
        if (PRICE_RE.test(lines[i].text.trim())) return Math.max(0, i - 1);
    }
    return Math.min(7, lines.length);
}

function findFooterStart(lines: LidlLine[], afterIdx: number): number {
    for (let i = afterIdx; i < lines.length; i++) {
        // NFD-stripped copy for markers where OCR may have replaced
        // `ė` with `è`/`é`/`ê` — e.g. `Tarpinè suma` instead of the
        // canonical `Tarpinė suma`. Without stripping, the marker is
        // missed and the whole footer region stays in the product
        // slice, generating phantom products for `Tarpinè suma`,
        // `Mokėti`, `NUolalda`, PVM tables, etc.
        const t = stripDiacritics(lines[i].text);
        if (/^\s*tarpine\s+sum/.test(t)) return i;
        if (/^\s*moketi\b/.test(t)) return i;
        if (/^\s*mokejimas\s+kortele/.test(t)) return i;
        if (/^\s*bekontak/.test(t)) return i;
        if (/^-{5,}$/.test(t.trim())) return i;
    }
    return lines.length;
}

// ───────── header ─────────

// Cat II — store address matcher, two fallbacks:
//   1. Strict: starts with a capital Lithuanian letter, has `g.`
//      (street abbreviation) followed by a house number.
//      `Gedimino g. 35, Radviliškis` → matches.
//   2. Lenient: OCR dropped the `g.` (seen as `Gedimino .35. Radvili&kis`).
//      Starts with a capital Lithuanian letter, contains a house
//      number anywhere, and has at least one more capitalised word
//      (the city) somewhere on the line.
const ADDRESS_STRICT_RE = /^[A-ZĄČĘĖĮŠŲŪŽ].+g\.\s*\d/i;
const ADDRESS_LENIENT_RE =
    /^[A-ZĄČĘĖĮŠŲŪŽ][a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ]+.+?\d{1,4}.+?[A-ZĄČĘĖĮŠŲŪŽ][a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ&]+/;

function parseHeader(lines: LidlLine[]): LidlHeader {
    let storeAddress = '';
    let pvmCode = '';
    for (const l of lines) {
        const t = l.text.trim();
        if (!storeAddress && ADDRESS_STRICT_RE.test(t)) storeAddress = t;
        else if (!storeAddress && ADDRESS_LENIENT_RE.test(t) && !/PVM/i.test(t)) {
            storeAddress = t;
        }
        if (!pvmCode && /PVM\s*mok/i.test(t)) pvmCode = t;
    }
    return {
        chainName: 'LIDL',
        storeCode: '',
        storeAddress,
        pvmCode,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
    };
}

// ───────── products ─────────

/**
 * Strip a leading barcode from a name line. Receipts sometimes emit
 * the barcode in-line with the name (`0080575 Arbūzai mažai sėklu`)
 * rather than on a separate OCR line. Without stripping, every such
 * product's name starts with digits and doesn't match any catalog.
 */
function stripBarcodePrefix(name: string): string {
    const m = name.match(BARCODE_PREFIX_RE);
    return m ? m[2].trim() : name;
}

function parseProducts(lines: LidlLine[]): LidlProduct[] {
    const products: LidlProduct[] = [];
    const priceIndices: number[] = [];
    // Deposit priceIdx set — `0,10 !` / `0,60 !` rows use `!` instead
    // of a VAT letter. Collect separately so walk-back from the NEXT
    // priceIdx stops at them (they're non-catalog, shouldn't leak
    // into a real product's name), but we DON'T create a product row
    // for them.
    const depositIndices = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.trim();
        if (PRICE_DEPOSIT_RE.test(t)) {
            depositIndices.add(i);
            continue;
        }
        if (DISCOUNT_RE.test(t)) continue;
        if (PRICE_RE.test(t) || PRICE_OCR_RE.test(t)) priceIndices.push(i);
    }

    const usedLines = new Set<number>();

    for (let pi = 0; pi < priceIndices.length; pi++) {
        const priceIdx = priceIndices[pi];
        if (usedLines.has(priceIdx)) continue;

        const priceLine = lines[priceIdx];
        const priceText = priceLine.text.trim();
        const strictMatch = priceText.match(PRICE_RE);
        let price: number;
        if (strictMatch) {
            price = parseNum(strictMatch[1]);
        } else {
            // PRICE_OCR_RE anchor (Cat AA) — space-separator price.
            // Reconstruct value as `${intPart}.${fracPart}`.
            const ocrMatch = priceText.match(PRICE_OCR_RE)!;
            price = parseNum(`${ocrMatch[1]}.${ocrMatch[2]}`);
        }

        usedLines.add(priceIdx);

        let quantity = 1;
        let unit = 'vnt';
        let pricePerUnit: number | null = null;

        const prevPriceIdx = pi > 0 ? priceIndices[pi - 1] : -1;
        const nextPriceIdx =
            pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;
        const rawLines: string[] = [];
        const consumedLines: LidlLine[] = [priceLine];
        const nameLines: string[] = [];
        let lookback = priceIdx - 1;
        let skippedNonCatalog = false;
        // Cat FF / Cat GG — post-price forward scan at same-y (±20 px).
        // OCR sometimes emits `name → barcode → price` in that order
        // but SORTS same-y lines by x-position, so barcode (left column)
        // and unit line (center) can land AFTER price (right column) in
        // the array. Backward walk-back never sees them. Forward-scan
        // here pre-seeds barcodesConsumed (FF) and captures qty + ppu
        // from post-price unit lines (GG) before walk-back starts.
        let barcodesConsumed = 0;
        const priceY = priceLine.yTop;
        const POST_PRICE_Y_TOL = 20;
        const postScanEnd = Math.min(priceIdx + 4, nextPriceIdx);
        for (let k = priceIdx + 1; k < postScanEnd; k++) {
            if (usedLines.has(k)) continue;
            if (lines[k].yTop - priceY > POST_PRICE_Y_TOL) break;
            const kText = lines[k].text.trim();
            if (!kText) continue;
            if (BARCODE_ONLY_RE.test(kText)) {
                // Cat FF: count the barcode so Cat M can fire during
                // walk-back. Mark used so Cat CC (forward-walk fallback)
                // and subsequent priceIdx passes don't re-read it.
                if (barcodesConsumed === 0) barcodesConsumed = 1;
                usedLines.add(k);
                consumedLines.push(lines[k]);
                continue;
            }
            const unitMatchPost = kText.match(UNIT_LINE_RE);
            if (unitMatchPost) {
                // Cat GG: post-price unit line belongs to THIS product.
                if (unitMatchPost[1] && pricePerUnit === null) {
                    pricePerUnit = parseNum(unitMatchPost[1]);
                }
                if (quantity === 1) quantity = parseNum(unitMatchPost[2]);
                if (unit === 'vnt' && /kg/i.test(unitMatchPost[3])) unit = 'kg';
                usedLines.add(k);
                consumedLines.push(lines[k]);
                continue;
            }
            const lenientPost = kText.match(UNIT_LENIENT_RE);
            if (lenientPost) {
                // Cat HH post-price variant — lenient unit-line prefix
                // without a clean suffix. Capture qty + ppu, consume so
                // the trailing garbage doesn't leak anywhere.
                if (pricePerUnit === null) pricePerUnit = parseNum(lenientPost[1]);
                if (quantity === 1) quantity = parseNum(lenientPost[2]);
                usedLines.add(k);
                consumedLines.push(lines[k]);
                continue;
            }
            // Unrecognised — don't consume, and don't keep scanning
            // (next satellites live further from priceY anyway).
            break;
        }
        // `barcodesConsumed` tracks whether walk-back (or Cat FF pre-
        // seed) has seen the price's OWN barcode. Lidl products are
        // typically name → barcode → price, so seeing a SECOND barcode
        // during walk-back after ≥1 name line means we've crossed into
        // the PREVIOUS product's block (Cat M). Pre-seeded above from
        // post-price scan so same-y OCR order doesn't break the check.

        while (lookback > prevPriceIdx && nameLines.length < 3) {
            const prev = lines[lookback];
            const prevText = prev.text.trim();

            if (!prevText || usedLines.has(lookback)) {
                lookback--;
                continue;
            }
            if (PRICE_RE.test(prevText)) break;
            // PRICE_OCR_RE — space-decimal variant (Cat AA). Same
            // STOP semantics as strict PRICE_RE.
            if (PRICE_OCR_RE.test(prevText)) break;
            // Deposit price row (`0,10 !`) — same STOP semantics as
            // regular price, plus we already skipped it in the
            // priceIdx loop via depositIndices.
            if (PRICE_DEPOSIT_RE.test(prevText)) break;
            if (DISCOUNT_RE.test(prevText)) break;
            if (DISCOUNT_HEADER_RE.test(prevText)) break;
            // Header-tail `Kvitas N/N` that escaped findHeaderEnd
            // (e.g. when `#NNNNN` and `Kvitas N/N` are both in the
            // first 20 lines but sort order differs from expected):
            // treat as absolute stop.
            if (KVITAS_ROW_RE.test(prevText)) break;
            if (DEPOSIT_RE.test(prevText)) {
                skippedNonCatalog = true;
                break;
            }
            if (NON_CATALOG_RE.test(prevText)) {
                skippedNonCatalog = true;
                break;
            }
            // Lenient price-like fragment (OCR-mangled `.99`, `0 59 A`,
            // `049 A`, `O,43_`, `,29 A`, `|69 A`). Treat as walk-back
            // stop — the previous product's (broken) price shouldn't
            // leak into our name even when we can't extract its value.
            if (PRICE_LIKE_RE.test(prevText)) break;

            // Unit/weight line: capture quantity + pricePerUnit and
            // DON'T add to name. Capture group 1 (unit price) is
            // optional — when OCR drops it, we still get qty and unit.
            const unitMatch = prevText.match(UNIT_LINE_RE);
            if (unitMatch) {
                if (unitMatch[1]) pricePerUnit = parseNum(unitMatch[1]);
                quantity = parseNum(unitMatch[2]);
                unit = /kg/i.test(unitMatch[3]) ? 'kg' : 'vnt';
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }
            // Unit-line fragments — OCR split a single unit line into
            // two rows (`1,29 x` + `2,000 €/vnt.`). Consume either
            // half as metadata, don't absorb into name. If we see
            // both halves we'll have already captured the pricePerUnit
            // from whichever came with the leading numeric group.
            if (UNIT_HEAD_RE.test(prevText)) {
                const headMatch = prevText.match(/(\d+[.,]\s?\d{1,2})/);
                if (headMatch && pricePerUnit === null) {
                    pricePerUnit = parseNum(headMatch[1]);
                }
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }
            if (UNIT_TAIL_RE.test(prevText)) {
                const tailMatch = prevText.match(/(\d+[.,_]\s?\d{1,3})\s*(kg|[€£])/i);
                if (tailMatch && quantity === 1) {
                    quantity = parseNum(tailMatch[1]);
                    unit = /kg/i.test(tailMatch[2]) ? 'kg' : 'vnt';
                }
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }
            // Bare `€/vnt.` / `£/vnt.` / `€/kg` orphan (Cat V) — consume
            // as metadata without extracting qty/unit so it doesn't get
            // pushed as a product name.
            if (UNIT_ORPHAN_RE.test(prevText)) {
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }
            // Cat X — weighable with garbage PREFIX (e.g. `CEoX 0,343 kg`).
            // Capture qty + unit from the tail, discard the letter
            // prefix. Only triggered when the cleaner UNIT_* regexes
            // above already failed.
            const weightLenient = prevText.match(UNIT_WEIGHT_LENIENT_RE);
            if (weightLenient) {
                if (quantity === 1) {
                    quantity = parseNum(weightLenient[1]);
                    unit = /kg/i.test(weightLenient[2]) ? 'kg' : 'vnt';
                }
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }
            // Cat HH — unit-line prefix with trailing garbage (typical
            // cause: OCR mashed the next product's name onto the unit
            // line). Extract qty + ppu from the clean prefix, consume
            // the whole line so nothing leaks into name.
            const lenientMatch = prevText.match(UNIT_LENIENT_RE);
            if (lenientMatch) {
                if (pricePerUnit === null) pricePerUnit = parseNum(lenientMatch[1]);
                if (quantity === 1) quantity = parseNum(lenientMatch[2]);
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }
            // Cat W — multi-buy qty smooshed with a name continuation
            // (`2,000 Su ban.`). OCR merged the quantity from a broken
            // unit line with the tail of a wrapped name. Capture the
            // qty, push ONLY the continuation tail as name.
            const multibuyContMatch = prevText.match(MULTIBUY_CONTINUATION_RE);
            if (multibuyContMatch) {
                if (quantity === 1) quantity = parseNum(multibuyContMatch[1]);
                const tail = multibuyContMatch[2].trim();
                // Respect Cat M + Cat DD before pushing (same checks
                // as the regular name path below).
                if (!(barcodesConsumed >= 1 && nameLines.length >= 1)) {
                    nameLines.unshift(tail);
                }
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }

            // Pure-barcode line: consume without adding to name.
            // If we've already captured a name AND this is a SECOND
            // barcode, stop — we're straddling two products.
            if (BARCODE_ONLY_RE.test(prevText)) {
                if (barcodesConsumed >= 1 && nameLines.length >= 1) break;
                barcodesConsumed++;
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }

            // Regular name line (possibly with leading inline barcode
            // — strip it). When the line had an inline barcode we
            // count it against `barcodesConsumed` the same way a
            // standalone barcode would — otherwise Cat M's break
            // below misses the receipt-09-13 case where the first
            // product's barcode is inline with its name.
            const stripped = stripBarcodePrefix(prevText);
            const hadInlineBarcode = stripped !== prevText;
            // Cat M: after a barcode has been consumed (standalone OR
            // inline) AND we've already collected ≥1 name line, any
            // further name push means we've crossed into the PREVIOUS
            // product. Stop before absorbing. Catches:
            //   - Kakav/Sūrelis smoosh (y=500 / y=510 same-y layout)
            //   - Silkių/Virtos smoosh (same pattern)
            //   - Kvitas-absorption when `#NNNNN` + `Kvitas N/N` +
            //     inline-barcode-first-product all line up
            if (barcodesConsumed >= 1 && nameLines.length >= 1) break;
            // Cat DD: inline-barcode line with name already collected
            // → this line belongs to the PREVIOUS product (whose own
            // price anchor is lost to OCR). Stop before absorbing so
            // the two products' names don't merge. The orphaned
            // barcode+name will be picked up by the forward-walk
            // fallback (Cat CC) on the previous price anchor.
            if (hadInlineBarcode && nameLines.length >= 1) break;
            if (hadInlineBarcode) barcodesConsumed++;
            nameLines.unshift(stripped);
            consumedLines.push(prev);
            usedLines.add(lookback);
            lookback--;
        }

        if (skippedNonCatalog) continue;

        // Cat CC: forward-walk fallback. When walk-back yielded no
        // name (priceIdx sits directly after another priceIdx with
        // nothing in between), scan FORWARD from priceIdx+1 looking
        // for an inline-barcode+name or bare name line. Bounds:
        //   - stop at next priceIdx
        //   - stop at any stop-condition line (unit line OK to skip)
        //   - stop after 4 lines forward (hard cap)
        // Used by OCR'd receipts where price column and name column
        // misalign — the name for price P1 ends up BELOW P1 and
        // ABOVE the next price P2 (inline with P2's barcode line).
        if (nameLines.length === 0) {
            const nextPriceIdx =
                pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;
            const hardCap = Math.min(priceIdx + 5, nextPriceIdx);
            for (let fwd = priceIdx + 1; fwd < hardCap; fwd++) {
                if (usedLines.has(fwd)) continue;
                const fwdText = lines[fwd].text.trim();
                if (!fwdText) continue;
                if (PRICE_RE.test(fwdText) || PRICE_OCR_RE.test(fwdText)) break;
                if (PRICE_DEPOSIT_RE.test(fwdText)) break;
                if (DISCOUNT_RE.test(fwdText)) break;
                if (DISCOUNT_HEADER_RE.test(fwdText)) break;
                if (DEPOSIT_RE.test(fwdText)) break;
                if (NON_CATALOG_RE.test(fwdText)) break;
                if (PRICE_LIKE_RE.test(fwdText)) break;
                // Skip unit/barcode-only lines — they're metadata, not names.
                if (
                    UNIT_LINE_RE.test(fwdText) ||
                    UNIT_HEAD_RE.test(fwdText) ||
                    UNIT_TAIL_RE.test(fwdText) ||
                    UNIT_ORPHAN_RE.test(fwdText) ||
                    BARCODE_ONLY_RE.test(fwdText)
                ) {
                    continue;
                }
                // Candidate name line — strip inline barcode prefix.
                const nameCandidate = stripBarcodePrefix(fwdText);
                if (!nameCandidate || /^\d+[.,]?\d*$/.test(nameCandidate)) break;
                nameLines.push(nameCandidate);
                consumedLines.push(lines[fwd]);
                usedLines.add(fwd);
                break;
            }
        }

        const name = nameLines.join(' ').trim();
        rawLines.push(...nameLines, priceText);

        if (!name) continue;
        if (/^\d+[.,]?\d*$/.test(name)) continue;
        if (NON_CATALOG_RE.test(name)) continue;
        if (DEPOSIT_RE.test(name)) continue;

        products.push({
            name,
            price,
            promoPrice: null,
            quantity,
            unit,
            pricePerUnit,
            rawLines,
            region: regionOf(consumedLines),
        });
    }

    return products;
}

// ───────── footer ─────────

function parseFooter(lines: LidlLine[]): LidlFooter {
    let total: number | null = null;
    let totalSavings: number | null = null;
    let date = '';
    let time = '';
    let receiptNo = '';

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.trim();

        // `Mokėti` + `N,NN` on separate lines or same.
        if (/^mok[eė]ti\b/i.test(t)) {
            const neighbour = lines[i + 1]?.text ?? lines[i - 1]?.text ?? '';
            const m = neighbour.match(/(\d+[.,]\s?\d{1,2})/);
            if (m) total = parseNum(m[1]);
        }
        // Aggregated discount (`Nuolaida 0,68`).
        if (/^nuolaid[aos]?\s*$/i.test(t)) {
            const neighbour = lines[i + 1]?.text ?? lines[i - 1]?.text ?? '';
            const m = neighbour.match(/(\d+[.,]\s?\d{1,2})/);
            if (m) totalSavings = parseNum(m[1]);
        }
        const dtMatch = t.match(/(\d{4}-\d{2}-?\s?\d{2})\s+(\d{1,2}:\s?\d{2})/);
        if (dtMatch) {
            date = dtMatch[1].replace(/\s/g, '');
            time = dtMatch[2].replace(/\s/g, '');
        }
        if (!receiptNo) {
            const rn = t.match(/dokumento\s+numeris\s*:?\s*(\d+)/i);
            if (rn) receiptNo = rn[1];
        }
    }

    return {
        total,
        date,
        time,
        receiptNo,
        totalSavings,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
    };
}

/**
 * Lithuanian receipts wrap long product names to a second line, and
 * the second line typically starts with a preposition / conjunction
 * (`su` = "with", `ir` = "and", `be` = "without"). When walk-back
 * from a price can't cross the previous product's price line to
 * grab the wrapped-name head, the orphan tail ends up as its own
 * product with a gibberish-fragment name like `su karam. įdaru`.
 *
 * Post-pass: if a product name starts with a continuation word, use
 * the PREVIOUS product's name as a prefix so the matcher sees the
 * full name (`Vanil.plombyras vafl.puodelyje su karam. įdaru`)
 * instead of the bare fragment. The two products stay separate —
 * they may be genuinely distinct SKUs at different unit prices.
 */
// Cat Y — leading punctuation allowed before the continuation word.
// OCR sometimes keeps a stray period/comma from the prior line as a
// prefix on the wrapped tail (`.ir šok` from a name ending in `...šok.`),
// which previously prevented the prefix match and let the 6-char
// fragment fluke high-confidence char-similarity matches in the catalog.
const CONTINUATION_LEADING_PUNCT_RE = /^[\s.,:;\-]+/;
const CONTINUATION_HEAD_RE = /^[\s.,:;\-]*(su|ir|be|i[sš]|po|prie|j[eiaouy]|i)\s+/i;
function prefixOrphanContinuations(products: LidlProduct[]): LidlProduct[] {
    for (let i = 1; i < products.length; i++) {
        const name = products[i].name.trim();
        if (CONTINUATION_HEAD_RE.test(name)) {
            const cleaned = name.replace(CONTINUATION_LEADING_PUNCT_RE, '');
            products[i].name = `${products[i - 1].name} ${cleaned}`.trim();
        }
    }
    return products;
}

// ───────── public entry points ─────────

export function parseLidlReceipt(lines: LidlLine[]): LidlParseResult {
    const headerEnd = findHeaderEnd(lines);
    const footerStart = findFooterStart(lines, headerEnd);
    return {
        header: parseHeader(lines.slice(0, headerEnd)),
        products: prefixOrphanContinuations(
            parseProducts(lines.slice(headerEnd, footerStart))
        ),
        footer: parseFooter(lines.slice(footerStart)),
    };
}

export function parseLidlHeaderOnly(lines: LidlLine[]): LidlHeader {
    const headerEnd = findHeaderEnd(lines);
    return parseHeader(lines.slice(0, headerEnd));
}
