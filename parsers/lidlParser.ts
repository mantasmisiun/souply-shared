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

import type { RegionKind, LabeledRegion } from './rimiParser.js';

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

/** Per-line bbox tracking — see rimiParser for the rationale. */
export interface LidlHeader {
    chainName: string;
    storeCode: string;
    storeAddress: string;
    pvmCode: string;
    rawText: string;
    region: Region;
    lineRegions: LabeledRegion[];
}

export interface LidlFooter {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
    region: Region;
    lineRegions: LabeledRegion[];
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
//
// `[>×|]?\s*` BEFORE the `x` multiplier — phone-photo OCR
// frequently prepends a stray `>` to the multiplier (seen in the
// wild: `0,37 >x 6,000 €/vnt.` and `0,29 >X 2,000 €/vnt.`). The
// `?` keeps the legit `<ppu> x <qty>` shape matching unchanged;
// the optional noise just absorbs OCR drift. Without this the
// unit-line classifies as 'name', leaks into the product name,
// and qty stays 1 (so a multi-buy of 6 reads as quantity=1).
const UNIT_LINE_RE = new RegExp(
    `^\\s*(?:(\\d+[.,_]\\s?${D}{1,2})\\s*)?[>×|]?\\s*[xkXК]\\s*(\\d+(?:[.,_]\\s?${D}{1,3})?)\\s*(kg|[€£]\\s*/\\s*vnt\\.?|[€£]\\s*/\\s*kg)`,
    'i'
);
// OCR-split unit line halves. Decimal optional in both (integer
// quantities like `x 2 €/vnt.` happen). Same `>` tolerance as
// UNIT_LINE_RE.
const UNIT_HEAD_RE = new RegExp(`^\\s*\\d+[.,_]\\s?${D}{1,2}\\s*[>×|]?\\s*[xkXК]\\s*$`);
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
// Non-catalog checkout bags. Match the bag word anywhere on the
// line so OCR-fragmented forms (`irk.maišeli`, `Pop-pr` + bag
// tail) still trip the skip. The stem suffix is required —
// `el(is|iai|i)?`, `as`, or `ai` — so packaging abbreviations
// (`Grikių kruopos maiš.`) and unrelated `maiš-` words
// (`maišyti` to mix, `maišinim` mixing-noun, `maišelyje` locative
// of `maišelis` — though that one's still about bags, just a
// rarer case) don't false-match.
//
// Forms matched:
//   maišel, maišelis, maišeli, maišeliai, maišelio, … (diminutive)
//   maišas, maišai                                    (plain bag)
//
// Forms intentionally NOT matched:
//   maiš.        — packaging-abbreviation suffix on real products
//   maišyti      — verb "to mix"
//   maišinim*    — mixing-related noun
const NON_CATALOG_RE = /\bmai[sš](?:el|as|ai)\w*/i;
// Discount-header line. Tolerates `Nuolalda` (i↔l swap on low-
// contrast OCR) alongside canonical `Nuolaida`, and the standalone
// `LIDL PLUS kupono` form (where the line has the loyalty prefix
// but no `nuolaida` word — the nuolaida value sits on the NEXT
// row). Either token alone is enough to mark the line as a
// discount-cluster member: `lidl plus` or `nuolaida`.
const DISCOUNT_HEADER_RE = /(?:lidl\s*plus|nuo[li]a[li]d[aos]?)/i;
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
        // Dashed (`---`) or equal-sign (`===`) separator — Lidl
        // prints `===========` between the product list and the
        // PVM table. Catching it here keeps the visual band of
        // the LAST product from extending down into the
        // separator row when the V2 fold accepts everything to
        // the end of productSlice.
        if (/^[=-]{5,}$/.test(t.trim())) return i;
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
    const seen = new Set<string>();
    const lineRegions: LabeledRegion[] = [];
    const trackLine = (line: LidlLine, kind: RegionKind) => {
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

    for (const l of lines) {
        const t = l.text.trim();
        if (!storeAddress && ADDRESS_STRICT_RE.test(t)) {
            storeAddress = t;
            trackLine(l, 'storeAddress');
        } else if (!storeAddress && ADDRESS_LENIENT_RE.test(t) && !/PVM/i.test(t)) {
            storeAddress = t;
            trackLine(l, 'storeAddress');
        }
        if (!pvmCode && /PVM\s*mok/i.test(t)) pvmCode = t;
    }
    lineRegions.sort((a, b) => a.yTop - b.yTop);
    return {
        chainName: 'LIDL',
        storeCode: '',
        storeAddress,
        pvmCode,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
        lineRegions,
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


// ───────── footer ─────────

function parseFooter(lines: LidlLine[]): LidlFooter {
    let total: number | null = null;
    let totalSavings: number | null = null;
    let date = '';
    let time = '';
    let receiptNo = '';

    const seen = new Set<string>();
    const lineRegions: LabeledRegion[] = [];
    const trackLine = (line: LidlLine | undefined, kind: RegionKind) => {
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

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.trim();

        if (/^mok[eė]ti\b/i.test(t)) {
            const sameLine = t.match(/(\d+[.,]\s?\d{1,2})/);
            if (sameLine) {
                total = parseNum(sameLine[1]);
                trackLine(lines[i], 'total');
            } else {
                const next = lines[i + 1];
                const prev = lines[i - 1];
                const nextMatch = next?.text.match(/(\d+[.,]\s?\d{1,2})/);
                const prevMatch = prev?.text.match(/(\d+[.,]\s?\d{1,2})/);
                if (nextMatch) {
                    total = parseNum(nextMatch[1]);
                    trackLine(lines[i], 'total');
                    trackLine(next, 'total');
                } else if (prevMatch) {
                    total = parseNum(prevMatch[1]);
                    trackLine(lines[i], 'total');
                    trackLine(prev, 'total');
                }
            }
        }
        if (/^nuolaid[aos]?\s*$/i.test(t)) {
            const neighbour = lines[i + 1]?.text ?? lines[i - 1]?.text ?? '';
            const m = neighbour.match(/(\d+[.,]\s?\d{1,2})/);
            if (m) totalSavings = parseNum(m[1]);
        }
        const dtMatch = t.match(/(\d{4}-\d{2}-?\s?\d{2})\s+(\d{1,2}:\s?\d{2})/);
        if (dtMatch) {
            date = dtMatch[1].replace(/\s/g, '');
            time = dtMatch[2].replace(/\s/g, '');
            trackLine(lines[i], 'dateTime');
        }
        if (!receiptNo) {
            const rn = t.match(/dokumento\s+numeris\s*:?\s*(\d+)/i);
            if (rn) {
                receiptNo = rn[1];
                trackLine(lines[i], 'receiptNo');
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

// ───────── public entry points ─────────

/**
 * Full receipt parse: header + products + footer.
 *
 * Convention (matches Rimi V2 / Norfa V2): rows with a multi-buy
 * or weighable unit-line have their `price` and `promoPrice`
 * normalized to PER-UNIT values here. Downstream code recovers
 * the line total as `price × quantity`. Single-pack rows
 * (quantity = 1) keep `price` as the line total.
 *
 * Internally uses the V2 hard-walled band detector
 * (`findReceiptBandsLidl`) + per-band extractor
 * (`extractLidlProduct`).
 */
export function parseLidlReceipt(rawLines: LidlLine[]): LidlParseResult {
    const headerEnd = findHeaderEnd(rawLines);
    const footerStart = findFooterStart(rawLines, headerEnd);
    const header = parseHeader(rawLines.slice(0, headerEnd));
    const footer = parseFooter(rawLines.slice(footerStart));
    const plan = findReceiptBandsLidl(rawLines);
    const products: LidlProduct[] = [];
    for (const internal of plan.productInternals) {
        const { product } = extractLidlProduct(internal);
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

export function parseLidlHeaderOnly(lines: LidlLine[]): LidlHeader {
    const headerEnd = findHeaderEnd(lines);
    return parseHeader(lines.slice(0, headerEnd));
}

// ─────────────────────────────────────────────────────────────────
// V2 step 1: hard-walled bands
// ─────────────────────────────────────────────────────────────────
//
// Same architecture as Rimi/Norfa V2:
//   1. Find anchors (lines matching PRICE_RE or PRICE_OCR_RE — Lidl
//      anchors are bare prices like `2,49 A` or OCR-mangled `1 29 A`,
//      always at the END of a product's row group). Deposit rows
//      with a `!` suffix (PRICE_DEPOSIT_RE) are NOT anchored — they
//      attach to the PREVIOUS product (the bottle/can).
//   2. No per-product tail content. Unlike Norfa (per-row Nuolaida)
//      Lidl prints discounts AGGREGATED at the bottom of the receipt
//      (`Lidl Plus nuolaida` + `-X,XX A`), so a band's effective
//      bottom is just its anchor.yBottom plus any deposit row that
//      attaches to it.
//   3. Wall between bands = midpoint between (this band's last
//      bottom) and the yTop of the next anchor.
//   4. Lines are assigned to bands by strict y-CENTER membership
//      against (topWall, bottomWall]. Nothing crosses a wall.
//
// Step 1 (this commit): produce typed bands for the dev-tool
// overlay + per-line classification trace. Per-band content
// extraction (step 2) and Analize integration (step 3) come after
// the bands are visually validated against staged Lidl receipts.

export type LidlBandKind =
    | 'store-name'
    | 'store-address'
    | 'product'
    | 'receipt-no'
    | 'datetime'
    | 'total';

// Header-band detectors. Both run on the header slice only, so a
// product-name line containing the word `Lidl` (rare but possible)
// can't false-match into the store-name band.
//
// STORE_NAME — matches the chain marker `LIDL`/`LDL`/`UAB "Lidl`
// (V1's isLidlReceipt accepts the same set tolerantly).
const LIDL_STORE_NAME_LINE_RE = /\bLID?L\b|LIDL\s+LIETUVA|UAB\s*"?\s*LIDL/i;

// ADDRESS — same shape as Norfa's: `<word> <number>, <word>` with
// optional `g.` street suffix and OCR letter-for-digit tolerance on
// the house number. Lidl addresses are typically `Gedimino g. 35,
// Radviliškis` or — when OCR drops the `g.` — `Gedimino .35.
// Radviliškis`. The lenient form (no comma) is handled by the V1
// ADDRESS_LENIENT_RE; here we go with the same comma-anchored
// pattern as Norfa for consistency.
const LIDL_ADDRESS_LINE_RE =
    /[A-ZĄČĘĖĮŠŲŪŽa-ząčęėįšųūž]{3,}\s*(?:g[.,]?\s*)?[\d0OoIlL]+(?:[-/][\d0OoIlL]+)?\s*,\s*[A-ZĄČĘĖĮŠŲŪŽa-ząčęėįšųūž]{3,}/;

export interface LidlReceiptBand {
    kind: LidlBandKind;
    yTop: number;
    yBottom: number;
    /** `#1`/`#2` for product bands; `addr`/`nr`/`date`/`sum` otherwise. */
    label: string;
}

export type LidlLineReason =
    | 'name'
    | 'anchor'
    | 'unit'
    | 'barcode'
    | 'deposit'
    | 'discount-header'
    | 'discount-eur'
    | 'other';

export interface LidlBandLineEntry {
    line: LidlLine;
    sliceIdx: number;
    reason: LidlLineReason;
}

export interface LidlBandInternal {
    bandIdx: number;
    anchor: LidlBandLineEntry;
    preName: LidlBandLineEntry[];
    postAnchor: LidlBandLineEntry[];
}

export interface LidlReceiptBandPlan {
    bands: LidlReceiptBand[];
    productInternals: LidlBandInternal[];
}

interface LidlProductBandInternal {
    anchorIdx: number;
    /** Lines with center > topWall belong here. */
    topWall: number;
    /** Lines with center <= bottomWall belong here. */
    bottomWall: number;
}

// Anchor predicate. Accepts both clean (`2,49 A`) and OCR-mangled
// (`1 29 A`) price lines. Rejects deposit rows (`0,10 !`) — those
// fold into the previous product's band as tail content, not as
// their own anchor.
const isPositivePriceLineV2 = (line: LidlLine): boolean => {
    const t = line.text.trim();
    if (PRICE_DEPOSIT_RE.test(t)) return false;
    return PRICE_RE.test(t) || PRICE_OCR_RE.test(t);
};

// Deposit row — bottle/can deposit price line `0,10 !` OR a leading
// deposit-name line `*Užstatas …`. Either form folds into the
// previous product's band (since deposits aren't standalone
// catalog products on Lidl).
const isDepositRow = (line: LidlLine): boolean => {
    const t = line.text.trim();
    return PRICE_DEPOSIT_RE.test(t) || DEPOSIT_RE.test(t);
};

const classifyLineReasonV2 = (line: LidlLine): LidlLineReason => {
    const t = line.text.trim();
    if (PRICE_RE.test(t) || PRICE_OCR_RE.test(t)) return 'anchor';
    if (PRICE_DEPOSIT_RE.test(t) || DEPOSIT_RE.test(t)) return 'deposit';
    if (UNIT_LINE_RE.test(t) || UNIT_HEAD_RE.test(t) || UNIT_TAIL_RE.test(t)) return 'unit';
    // Pure-barcode line ONLY. A name line that happens to start with
    // a barcode prefix (`7600526 Sviyturys …`) classifies as 'name'
    // because the prefix is part of the OCR'd name we want to emit.
    if (BARCODE_ONLY_RE.test(t)) return 'barcode';
    if (DISCOUNT_HEADER_RE.test(t)) return 'discount-header';
    if (DISCOUNT_RE.test(t)) return 'discount-eur';
    return /[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{3,}/.test(t) ? 'name' : 'other';
};

// Fused-anchor tail regexes — match the price portion at the END of
// a name+price row. Lidl prints product rows in two visually separate
// columns (name on left, price on right) but MLKit reads them as a
// single OCR line on phone-photographed thermal prints. Without this
// split, every PRICE_RE/PRICE_OCR_RE check fails (the line is the
// whole row, not just the price tail) and the V2 band detector
// produces zero anchors → zero product bands.
//
// VAT letter is REQUIRED in the price tail (PRICE_RE allows it
// optional, but for fused-tail extraction we lean on it as a guard
// against false-matches: a name ending in `0,5` (e.g. `Pienas 0,5 l`)
// must NOT be split. The VAT letter is a reliable Lidl-specific
// terminator that doesn't appear inside product names.
//
// Deposit tail (`!` suffix) gets its own regex — it serves as the
// trigger for folding the deposit row into the previous product's
// band tail. Without splitting the deposit's `0,60 !` off, the row's
// `Užstatas` keyword sits glued to the unit-line text and the V2
// pipeline can't see it as a separate deposit half.
const FUSED_DEPOSIT_TAIL_RE = new RegExp(
    `\\s+(\\d+[.,]\\s?${D}{1,2}\\s*!)\\s*$`,
);
const FUSED_PRICE_TAIL_RE = new RegExp(
    `\\s+(\\d+[.,]\\s?${D}{1,2}\\s*[A-Z])\\s*$`,
);
// OCR-mangled price tail — comma read as whitespace (`1 29 A`).
// Trailing VAT letter still required.
const FUSED_PRICE_TAIL_OCR_RE = new RegExp(
    `\\s+(${D}{1,2}\\s+${D}{2}\\s*[A-Z])\\s*$`,
);

// Fused-anchor HEAD regexes — match the price portion at the START
// of a name+price row. MLKit OCR on phone-photographed Lidl
// receipts sometimes sorts the right-column price box BEFORE the
// left-column name within an OCR line group (seen in the wild:
// `0,39 A 7609624 Akmens druska`, `1,99 A 7610767 Lyd. sūris …`).
// Without head-split these lines classify as 'name', the embedded
// anchor is missed, and adjacent products collapse into one band.
//
// Same VAT-letter / `!` terminator as the tail variants — guards
// against false-matches where a name happens to start with a
// decimal-looking token (`0,5 l Pienas …`).
const FUSED_DEPOSIT_HEAD_RE = new RegExp(
    `^(\\d+[.,]\\s?${D}{1,2}\\s*!)\\s+`,
);
const FUSED_PRICE_HEAD_RE = new RegExp(
    `^(\\d+[.,]\\s?${D}{1,2}\\s*[A-Z])\\s+`,
);
const FUSED_PRICE_HEAD_OCR_RE = new RegExp(
    `^(${D}{1,2}\\s+${D}{2}\\s*[A-Z])\\s+`,
);

// Fused-anchor MIDDLE regexes — price wedged between name and an
// adjacent barcode. Two MLKit orderings seen in the wild:
//
//   tail-with-barcode: `<name> <price> <VAT> <barcode>`
//     (`Viskis 40 % 22,99 F 7602419`,
//      `Grikių kruopos maiš. 1,89 A 7601585`)
//
//   head-with-barcode: `<barcode> <price> <VAT> <name>`
//     (`0080227 1,29 A Obuoliai fasuoti`)
//
// Plain head/tail splitters miss these because the price isn't at a
// terminal position. The barcode flanking is the strong context
// signal that the middle token IS a price (and not e.g. a digit-
// looking fragment inside the name).
//
// Capture group layout differs from plain head/tail: middle-tail
// captures price (group 1) + trailing barcode (group 2) so we can
// reattach the barcode to the name half.
const FUSED_DEPOSIT_TAIL_BARCODE_RE = new RegExp(
    `\\s+(\\d+[.,]\\s?${D}{1,2}\\s*!)\\s+(${BC}{4,10})\\s*$`,
);
const FUSED_PRICE_TAIL_BARCODE_RE = new RegExp(
    `\\s+(\\d+[.,]\\s?${D}{1,2}\\s*[A-Z])\\s+(${BC}{4,10})\\s*$`,
);
const FUSED_DEPOSIT_HEAD_BARCODE_RE = new RegExp(
    `^(${BC}{4,10})\\s+(\\d+[.,]\\s?${D}{1,2}\\s*!)\\s+`,
);
const FUSED_PRICE_HEAD_BARCODE_RE = new RegExp(
    `^(${BC}{4,10})\\s+(\\d+[.,]\\s?${D}{1,2}\\s*[A-Z])\\s+`,
);

const splitFusedAnchorLineLidl = (line: LidlLine): [LidlLine, LidlLine] | null => {
    const trimmed = line.text.trim();
    // Already a clean anchor / deposit price — nothing to split.
    if (PRICE_RE.test(trimmed)) return null;
    if (PRICE_OCR_RE.test(trimmed)) return null;
    if (PRICE_DEPOSIT_RE.test(trimmed)) return null;

    // Deposit tail wins over price tail since the `!` is a more
    // specific terminator (PRICE_RE allows trailing `[A-Z]?`, so a
    // VAT-letter price tail won't false-match `!`). PRICE_TAIL_OCR
    // is the lowest-priority match because its space-separated
    // decimal can shadow legitimate digit-letter sequences in names.
    let tailMatch = trimmed.match(FUSED_DEPOSIT_TAIL_RE);
    if (!tailMatch) tailMatch = trimmed.match(FUSED_PRICE_TAIL_RE);
    if (!tailMatch) tailMatch = trimmed.match(FUSED_PRICE_TAIL_OCR_RE);
    if (tailMatch) {
        const namePart = trimmed.slice(0, tailMatch.index).trim();
        const tailPart = tailMatch[1];
        if (!namePart) return null;
        // Name must contain at least one letter — otherwise the
        // leading section is just digits and we'd be cutting a
        // legit standalone price line in half.
        if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(namePart)) return null;
        return [
            { ...line, text: namePart },
            { ...line, text: tailPart },
        ];
    }

    // Tail-with-barcode — `<name> <price> <VAT> <barcode>$`. The
    // barcode at end gets reattached to the name half so the
    // remaining text reads naturally for downstream extraction.
    let tailBcMatch = trimmed.match(FUSED_DEPOSIT_TAIL_BARCODE_RE);
    if (!tailBcMatch) tailBcMatch = trimmed.match(FUSED_PRICE_TAIL_BARCODE_RE);
    if (tailBcMatch) {
        const before = trimmed.slice(0, tailBcMatch.index).trim();
        const tailPart = tailBcMatch[1];
        const barcode = tailBcMatch[2];
        const namePart = `${before} ${barcode}`.trim();
        if (!before) return null;
        if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(before)) return null;
        return [
            { ...line, text: namePart },
            { ...line, text: tailPart },
        ];
    }

    // Head split — same VAT/`!` requirement as tail variants. Both
    // halves keep the source line's y-coords; the slice ends up with
    // namePart at idx N and headPart at idx N+1, so anchorIdx points
    // to the head and the wall logic still correctly assigns the
    // name-half (same y-center) to the same band.
    let headMatch = trimmed.match(FUSED_DEPOSIT_HEAD_RE);
    if (!headMatch) headMatch = trimmed.match(FUSED_PRICE_HEAD_RE);
    if (!headMatch) headMatch = trimmed.match(FUSED_PRICE_HEAD_OCR_RE);
    if (headMatch) {
        const headPart = headMatch[1];
        const namePart = trimmed.slice(headMatch[0].length).trim();
        if (!namePart) return null;
        if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(namePart)) return null;
        return [
            { ...line, text: namePart },
            { ...line, text: headPart },
        ];
    }

    // Head-with-barcode — `^<barcode> <price> <VAT> <name>`. The
    // leading barcode gets reattached to the name half.
    let headBcMatch = trimmed.match(FUSED_DEPOSIT_HEAD_BARCODE_RE);
    if (!headBcMatch) headBcMatch = trimmed.match(FUSED_PRICE_HEAD_BARCODE_RE);
    if (headBcMatch) {
        const barcode = headBcMatch[1];
        const headPart = headBcMatch[2];
        const after = trimmed.slice(headBcMatch[0].length).trim();
        const namePart = `${barcode} ${after}`.trim();
        if (!after) return null;
        if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(after)) return null;
        return [
            { ...line, text: namePart },
            { ...line, text: headPart },
        ];
    }

    return null;
};

// Same-row OCR consolidation. MLKit on phone-photographed Lidl
// receipts sometimes emits the price tail as a separate box from
// its product name even though they're on the same physical row.
// Without merging, the price box becomes its own anchor and the
// preceding name box ends up in the previous band, swapping names
// across products. Threshold mirrors Norfa's: yTop diff < 30 px AND
// the smaller box's center sits inside the larger box's vertical
// span.
const ROW_MERGE_YTOP_THRESHOLD_PX = 30;
const ROW_MERGE_CENTER_RATIO = 0.4;

const mergeRowFragmentsLidl = (rawLines: LidlLine[]): LidlLine[] => {
    const out: LidlLine[] = [];
    for (const line of rawLines) {
        const last = out.length > 0 ? out[out.length - 1] : null;
        if (!last) {
            out.push({ ...line });
            continue;
        }
        const yDiff = Math.abs(line.yTop - last.yTop);
        const minH = Math.min(
            line.yBottom - line.yTop,
            last.yBottom - last.yTop,
        );
        const lineCenter = (line.yTop + line.yBottom) / 2;
        const lastCenter = (last.yTop + last.yBottom) / 2;
        const sameRow =
            yDiff < ROW_MERGE_YTOP_THRESHOLD_PX &&
            minH > 0 &&
            Math.abs(lineCenter - lastCenter) < minH * ROW_MERGE_CENTER_RATIO;
        if (!sameRow) {
            out.push({ ...line });
            continue;
        }
        last.text = `${last.text.trim()} ${line.text.trim()}`
            .replace(/\s+/g, ' ')
            .trim();
        last.yTop = Math.min(last.yTop, line.yTop);
        last.yBottom = Math.max(last.yBottom, line.yBottom);
        last.xLeft = Math.min(last.xLeft, line.xLeft);
        last.xRight = Math.max(last.xRight, line.xRight);
    }
    return out;
};

const findProductAnchorsLidlV2 = (productSlice: LidlLine[]): number[] => {
    const centerOf = (line: LidlLine) => (line.yTop + line.yBottom) / 2;
    const anchors: number[] = [];
    for (let i = 0; i < productSlice.length; i++) {
        if (!isPositivePriceLineV2(productSlice[i])) continue;
        // Skip deposit's own price line — folded into the previous
        // band as tail content (same policy as Norfa). isPositivePrice
        // already rejects PRICE_DEPOSIT (`0,10 !`); this guard catches
        // the case where the deposit-name marker (`*Užstatas …`)
        // immediately precedes a CLEAN price line on the next OCR
        // row.
        const prev = i > 0 ? productSlice[i - 1] : null;
        if (prev && isDepositRow(prev)) continue;

        // Drop near-duplicate anchors (MLKit double-emit). Same
        // policy as Norfa V2: if a previous anchor's center is
        // within minH * 0.5 px of this candidate, treat as dup.
        const myCenter = centerOf(productSlice[i]);
        const myH = productSlice[i].yBottom - productSlice[i].yTop;
        let isDup = false;
        for (let a = anchors.length - 1; a >= 0; a--) {
            const prevAnchorIdx = anchors[a];
            const prevCenter = centerOf(productSlice[prevAnchorIdx]);
            const prevH =
                productSlice[prevAnchorIdx].yBottom -
                productSlice[prevAnchorIdx].yTop;
            const minH = Math.min(myH, prevH);
            const dist = Math.abs(myCenter - prevCenter);
            if (dist < minH * 0.5) {
                isDup = true;
                break;
            }
            if (minH > 0 && dist > minH * 5) break;
        }
        if (isDup) continue;
        anchors.push(i);
    }
    return anchors;
};

/**
 * Build hard-walled product bands. Tail = anchor.yBottom plus any
 * deposit row that immediately follows. Wall placed at midpoint
 * between tail bottom and the next non-deposit line top.
 */
const findProductBandsInternalLidlV2 = (
    productSlice: LidlLine[],
): LidlProductBandInternal[] => {
    const anchorIdxs = findProductAnchorsLidlV2(productSlice);
    if (anchorIdxs.length === 0) return [];

    const tailBottoms: number[] = [];
    for (let bi = 0; bi < anchorIdxs.length; bi++) {
        const anchorIdx = anchorIdxs[bi];
        const anchor = productSlice[anchorIdx];
        const nextAnchorTop = bi + 1 < anchorIdxs.length
            ? productSlice[anchorIdxs[bi + 1]].yTop
            : Number.POSITIVE_INFINITY;

        let lastBottom = anchor.yBottom;
        for (let k = anchorIdx + 1; k < productSlice.length; k++) {
            const line = productSlice[k];
            if (line.yTop >= nextAnchorTop) break;
            if (anchorIdxs.includes(k)) break;
            // Specific accept-list — fold ONLY recognised post-
            // product content categories. A bare 'name' line
            // between two anchors is the next product's name (a
            // multi-line product whose unit-half sits one row
            // BELOW its name) and must NOT be absorbed into the
            // current band; rejecting it lets the wall settle
            // between the anchor and the name, and the name then
            // lands in the next band's preName.
            //
            // Categories accepted:
            //
            // 1. Unit-lines — multi-buy / weighable continuation
            //    BELOW an anchor (`7604564 Šv.alus 5%  2,90 F` +
            //    `1,45 x 2,000 €/vnt.`), and the unit-half of a
            //    multi-OCR-line deposit row (`0,10 x 6 €/vnt.`).
            // 2. Deposit markers — `*Užstatas …` name lines, the
            //    `Išimta (Užstatas) + 0001015 grąžinimas` deposit-
            //    return cluster, and bare deposit-price lines
            //    (`0,60 !`).
            // 3. Per-item discount cluster — `Lidl Plus nuolaida`
            //    header, the `LIDL PLUS kupono` coupon header
            //    (DISCOUNT_HEADER_RE was widened to match either
            //    `lidl plus` OR `nuolaida` so both forms fold),
            //    and the companion `Nuolaida -X,XX A` value line
            //    (or its bare `-X,XX A` half when MLKit splits).
            //
            // Termination is tight: clean anchors are filtered
            // out via `anchorIdxs.includes(k)`, and a head-fused
            // name half sits at the same y as its anchor so
            // `line.yTop >= nextAnchorTop` catches it before the
            // walk leaks into the next product.
            const t = line.text.trim();
            if (
                isDepositRow(line) ||
                UNIT_LINE_RE.test(t) ||
                UNIT_HEAD_RE.test(t) ||
                UNIT_TAIL_RE.test(t) ||
                PRICE_DEPOSIT_RE.test(t) ||
                DISCOUNT_HEADER_RE.test(t) ||
                DISCOUNT_RE.test(t)
            ) {
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            break;
        }
        tailBottoms.push(lastBottom);
    }

    const bands: LidlProductBandInternal[] = [];
    for (let bi = 0; bi < anchorIdxs.length; bi++) {
        const anchorIdx = anchorIdxs[bi];
        const topWall =
            bi === 0
                ? Number.NEGATIVE_INFINITY
                : bands[bi - 1].bottomWall;

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
};

interface LidlBandsContext {
    headerEnd: number;
    footerStart: number;
    productSlice: LidlLine[];
    bands: LidlReceiptBand[];
    productInternals: LidlBandInternal[];
}

const computeBandsContextLidlV2 = (rawLines: LidlLine[]): LidlBandsContext => {
    const headerEnd = findHeaderEnd(rawLines);
    const footerStart = findFooterStart(rawLines, headerEnd);
    const headerSlice = rawLines.slice(0, headerEnd);
    // Two-stage normalisation:
    //   1. mergeRowFragments — consolidate same-row OCR fragments
    //      (left-column name + right-column price emitted as two
    //      separate boxes).
    //   2. splitFusedAnchorLine — split lines that fuse name + VAT-
    //      letter price tail into two virtual lines (name + anchor).
    // Order matters: merge MUST run first. The split's two halves
    // inherit y-coords from the source line, so if merge ran second
    // it would see them as same-row text and concatenate them
    // straight back, undoing the split.
    const rawProductSlice = rawLines.slice(headerEnd, footerStart);
    const mergedProductSlice = mergeRowFragmentsLidl(rawProductSlice);
    const productSlice: LidlLine[] = [];
    for (const line of mergedProductSlice) {
        const split = splitFusedAnchorLineLidl(line);
        if (split) productSlice.push(split[0], split[1]);
        else productSlice.push(line);
    }
    const footerSlice = rawLines.slice(footerStart);

    const bands: LidlReceiptBand[] = [];

    // Header bands — store-name and store-address.
    for (const line of headerSlice) {
        if (LIDL_STORE_NAME_LINE_RE.test(line.text)) {
            bands.push({
                kind: 'store-name',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'store',
            });
            break;
        }
    }
    for (const line of headerSlice) {
        if (LIDL_ADDRESS_LINE_RE.test(line.text)) {
            bands.push({
                kind: 'store-address',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'addr',
            });
            break;
        }
    }

    // Product bands.
    const internal = findProductBandsInternalLidlV2(productSlice);
    const productBands: LidlReceiptBand[] = [];
    const productInternals: LidlBandInternal[] = [];
    const sliceTop = productSlice.length > 0
        ? Math.min(...productSlice.map((l) => l.yTop))
        : 0;
    const sliceBottom = productSlice.length > 0
        ? Math.max(...productSlice.map((l) => l.yBottom))
        : 0;
    const centerOf = (line: LidlLine) => (line.yTop + line.yBottom) / 2;

    for (let bi = 0; bi < internal.length; bi++) {
        const band = internal[bi];
        const memberIdxs: number[] = [];
        for (let k = 0; k < productSlice.length; k++) {
            const c = centerOf(productSlice[k]);
            if (c > band.topWall && c <= band.bottomWall) memberIdxs.push(k);
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

        const preName: LidlBandLineEntry[] = [];
        const postAnchor: LidlBandLineEntry[] = [];
        for (const k of memberIdxs) {
            if (k === band.anchorIdx) continue;
            const line = productSlice[k];
            const entry: LidlBandLineEntry = {
                line,
                sliceIdx: k,
                reason: classifyLineReasonV2(line),
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

    // Receipt-no band — Lidl prints it at the TOP (`Kvitas N/N
    // #00NNNNN`), unlike Norfa where it sits at the bottom. Scan
    // headerSlice first; fall back to footerSlice for receipts
    // where the header row got eaten by an aggressive headerEnd
    // boundary. Prefer KVITAS_ROW_RE (`Kvitas 48263/232`) over
    // RECEIPT_NO_RE (`#00048263`) because the Kvitas row is the
    // user-readable form; if MLKit fused them onto one OCR line
    // KVITAS_ROW_RE still wins (it's the leading token).
    let receiptNoLine: LidlLine | null = null;
    for (const line of headerSlice) {
        if (KVITAS_ROW_RE.test(line.text)) {
            receiptNoLine = line;
            break;
        }
    }
    if (!receiptNoLine) {
        for (const line of headerSlice) {
            if (RECEIPT_NO_RE.test(line.text.trim())) {
                receiptNoLine = line;
                break;
            }
        }
    }
    if (!receiptNoLine) {
        for (const line of footerSlice) {
            const t = line.text.trim();
            if (KVITAS_ROW_RE.test(t) || RECEIPT_NO_RE.test(t)) {
                receiptNoLine = line;
                break;
            }
        }
    }
    if (receiptNoLine) {
        bands.push({
            kind: 'receipt-no',
            yTop: receiptNoLine.yTop,
            yBottom: receiptNoLine.yBottom,
            label: 'nr',
        });
    }
    for (const line of footerSlice) {
        if (/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/.test(line.text)) {
            bands.push({
                kind: 'datetime',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'date',
            });
            break;
        }
    }
    // Total band — prefer `Mokėti` (final amount paid) over
    // `Tarpinė suma` (subtotal before discounts/redemptions). On
    // receipts where Lidl Plus discounts are aggregated at the
    // bottom or Lidl-points are redeemed, the two values diverge
    // and Mokėti is the canonical "what the customer paid" line.
    // Two-pass: prefer Mokėti, fall back to Tarpinė suma if
    // Mokėti isn't present.
    let totalLine: LidlLine | null = null;
    for (const line of footerSlice) {
        if (/^\s*moketi\b/.test(stripDiacritics(line.text))) {
            totalLine = line;
            break;
        }
    }
    if (!totalLine) {
        for (const line of footerSlice) {
            if (/^\s*tarpine\s+sum/.test(stripDiacritics(line.text))) {
                totalLine = line;
                break;
            }
        }
    }
    if (totalLine) {
        bands.push({
            kind: 'total',
            yTop: totalLine.yTop,
            yBottom: totalLine.yBottom,
            label: 'sum',
        });
    }

    return {
        headerEnd,
        footerStart,
        productSlice,
        bands,
        productInternals,
    };
};

/**
 * Step 1 entry point: produce typed bands for the dev-tool overlay.
 * Per-band content extraction (step 2) lands as a separate function
 * once these bands are visually validated against staged receipts.
 */
export function findReceiptBandsLidl(rawLines: LidlLine[]): LidlReceiptBandPlan {
    const ctx = computeBandsContextLidlV2(rawLines);
    return { bands: ctx.bands, productInternals: ctx.productInternals };
}

/** Copy-paste-friendly trace of the band layout + per-line classification. */
export function traceReceiptBandsLidl(rawLines: LidlLine[]): string {
    const ctx = computeBandsContextLidlV2(rawLines);
    const out: string[] = [];
    const TRUNC = (s: string, n = 80): string =>
        s.length <= n ? s : s.slice(0, n - 1) + '…';
    const fmtY = (line: LidlLine): string =>
        `y=${Math.round(line.yTop)}..${Math.round(line.yBottom)}`;

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

    out.push(`bands=${ctx.productInternals.length}`);
    for (let i = 0; i < ctx.productInternals.length; i++) {
        const internal = ctx.productInternals[i];
        const bandNum = internal.bandIdx + 1;
        out.push(`band ${bandNum}:`);
        for (const e of internal.preName) {
            out.push(`  pre  [${e.reason.padEnd(15)}] ${fmtY(e.line)} "${TRUNC(e.line.text)}"`);
        }
        out.push(
            `  ANC  [anchor         ] ${fmtY(internal.anchor.line)} "${TRUNC(internal.anchor.line.text)}"`,
        );
        for (const e of internal.postAnchor) {
            out.push(`  post [${e.reason.padEnd(15)}] ${fmtY(e.line)} "${TRUNC(e.line.text)}"`);
        }
    }
    return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// V2 step 2: per-band extraction
// ─────────────────────────────────────────────────────────────────

export interface LidlExtractResult {
    product: LidlProduct | null;
    warnings: string[];
}

// Deposit-return cluster (`Išimta (Užstatas)` + `0001015 Užstato
// grąžinimas -0,90 !`) — refund for returned empties from a
// previous trip. Per project policy, drop entirely during step 2:
// not a product, doesn't apply to product price, doesn't surface
// anywhere downstream. Both header and the negative price-half
// caught here.
const DEPOSIT_RETURN_RE = /(?:i[sš]imta|gr[aą][zž]inima)/i;
// Bare negative deposit-return price `-0,90 !` — the price-half
// after splitFusedAnchorLine peels it off the cluster name. None
// of the standard regexes (PRICE_RE, PRICE_DEPOSIT_RE, DISCOUNT_RE)
// match this exact shape (negative + `!` suffix), so it gets a
// dedicated detector.
const NEGATIVE_DEPOSIT_PRICE_RE = new RegExp(
    `^-\\s*\\d+[.,]\\s?${D}{1,2}\\s*!\\s*$`,
);

const extractDiscountAmount = (text: string): number | null => {
    // Capture a `-N,NN` token anywhere in the line. Used for both
    // `Nuolaida -0,32 A` (label + value on one row) and the bare
    // `-0,32 A` half. parseNum drops the negation.
    const m = text.match(/-\s*(\d+[.,]\s?\d{1,2})/);
    return m ? parseNum(m[1]) : null;
};

export function extractLidlProduct(internal: LidlBandInternal): LidlExtractResult {
    const warnings: string[] = [];
    const anchorText = internal.anchor.line.text.trim();

    // Parse the anchor: clean PRICE_RE (`N,NN A`) wins, fall back
    // to PRICE_OCR_RE (`N NN A` — comma read as whitespace by OCR).
    let price: number;
    const strict = anchorText.match(PRICE_RE);
    if (strict) {
        price = parseNum(strict[1]);
    } else {
        const ocr = anchorText.match(PRICE_OCR_RE);
        if (!ocr) {
            return {
                product: null,
                warnings: [`skip:anchor-parse-failed "${anchorText}"`],
            };
        }
        price = parseNum(`${ocr[1]}.${ocr[2]}`);
    }

    let quantity = 1;
    let unit = 'vnt';
    let pricePerUnit: number | null = null;
    let promoPrice: number | null = null;
    const nameLines: string[] = [];

    // preName walk: collect the product name and detect the
    // multi-buy / weighable unit-line. Lidl's UNIT_LINE_RE shape
    // is `<ppu> x <qty> <€/vnt.|kg>` (opposite ordering from
    // Norfa's qty-first weighable). Discount lines that y-sorted
    // ahead of the name go into promoPrice; deposit / deposit-
    // return clusters are dropped silently.
    for (const entry of internal.preName) {
        const text = entry.line.text.trim();
        if (!text) continue;
        if (DEPOSIT_RETURN_RE.test(text)) continue;
        if (NEGATIVE_DEPOSIT_PRICE_RE.test(text)) continue;
        if (DEPOSIT_RE.test(text)) continue;
        if (PRICE_DEPOSIT_RE.test(text)) continue;
        // Discount fragment that y-sorted ahead of the name (rare
        // for Lidl; the usual position is postAnchor). Capture
        // promo if it's the first one seen.
        if (DISCOUNT_HEADER_RE.test(text) || DISCOUNT_RE.test(text)) {
            const d = extractDiscountAmount(text);
            if (d !== null && promoPrice === null) {
                promoPrice = Math.round((price - d) * 100) / 100;
            }
            continue;
        }
        // Product unit-line: `<ppu> x <qty> <unit>`. Captures qty
        // (group 2) + ppu (group 1) + unit suffix (group 3). The
        // suffix tells us `kg` vs `vnt`.
        const unitMatch = text.match(UNIT_LINE_RE);
        if (unitMatch) {
            if (unitMatch[1] && pricePerUnit === null) {
                pricePerUnit = parseNum(unitMatch[1]);
            }
            quantity = parseNum(unitMatch[2]);
            unit = /kg/i.test(unitMatch[3] || '') ? 'kg' : 'vnt';
            continue;
        }
        // Bare unit-fragment (`€/vnt.` alone) and pure-barcode
        // lines — neither contributes to the name.
        if (UNIT_ORPHAN_RE.test(text)) continue;
        if (BARCODE_ONLY_RE.test(text)) continue;

        nameLines.push(text);
    }

    // postAnchor walk: only the discount value matters here for
    // the product's promoPrice. Everything else (deposit cluster,
    // deposit's own unit-line, deposit-return cluster) is dropped.
    for (const entry of internal.postAnchor) {
        const text = entry.line.text.trim();
        if (!text) continue;
        if (DEPOSIT_RETURN_RE.test(text)) continue;
        if (NEGATIVE_DEPOSIT_PRICE_RE.test(text)) continue;
        if (DISCOUNT_HEADER_RE.test(text) || DISCOUNT_RE.test(text)) {
            const d = extractDiscountAmount(text);
            if (d !== null && promoPrice === null) {
                promoPrice = Math.round((price - d) * 100) / 100;
            }
            continue;
        }
        // Deposit name + bare deposit-price + deposit unit-line —
        // present in the band for visual completeness but contribute
        // nothing to the displayed product. Ignored.
    }

    // Build name. After fused-anchor splitting the barcode can land
    // either at the start (`7600526 Švyturys …`) or end (`Viskis
    // 40 % 7602419` / `Vištų kiaušiniai L 7610894`) of the joined
    // text. Strip both ends.
    let head = nameLines.join(' ').replace(/\s+/g, ' ').trim();
    head = stripBarcodePrefix(head);
    head = head.replace(new RegExp(`\\s+${BC}{4,10}\\s*$`), '').trim();
    const name = head;

    if (!name) {
        return { product: null, warnings: ['skip:no-name'] };
    }
    if (NON_CATALOG_RE.test(name)) {
        return {
            product: null,
            warnings: [`skip:non-catalog "${name.slice(0, 60)}"`],
        };
    }
    if (DEPOSIT_RE.test(name)) {
        return {
            product: null,
            warnings: [`skip:deposit-only "${name.slice(0, 60)}"`],
        };
    }
    if (/^\d+[.,]?\d*$/.test(name)) {
        return {
            product: null,
            warnings: [`skip:numeric-only-name "${name}"`],
        };
    }

    const allLines = [
        ...internal.preName.map((e) => e.line),
        internal.anchor.line,
        ...internal.postAnchor.map((e) => e.line),
    ];

    return {
        product: {
            name,
            price,
            promoPrice,
            quantity,
            unit,
            pricePerUnit,
            rawLines: allLines.map((l) => l.text),
            region: regionOf(allLines),
        },
        warnings,
    };
}

/** Per-band extraction trace, copy-paste-friendly companion to traceReceiptBandsLidl. */
export function traceLidlExtract(rawLines: LidlLine[]): string {
    const ctx = computeBandsContextLidlV2(rawLines);
    const out: string[] = [];
    const TRUNC = (s: string, n = 60): string =>
        s.length <= n ? s : s.slice(0, n - 1) + '…';
    out.push(`bands=${ctx.productInternals.length}`);
    for (let i = 0; i < ctx.productInternals.length; i++) {
        const internal = ctx.productInternals[i];
        const { product, warnings } = extractLidlProduct(internal);
        if (!product) {
            out.push(`band ${i + 1}: SKIP  ${warnings[0] ?? 'unknown'}`);
            continue;
        }
        const promo = product.promoPrice === null ? 'null' : product.promoPrice.toFixed(2);
        const ppu = product.pricePerUnit === null ? 'null' : product.pricePerUnit.toFixed(2);
        const status = warnings.length > 0 ? 'NOTE' : 'OK';
        out.push(
            `band ${i + 1}: ${status}  name="${TRUNC(product.name)}"  ` +
                `price=${product.price.toFixed(2)}  promo=${promo}  ` +
                `qty=${product.quantity}  unit=${product.unit}  ppu=${ppu}`,
        );
        for (const w of warnings) out.push(`        ${w}`);
    }
    return out.join('\n');
}
