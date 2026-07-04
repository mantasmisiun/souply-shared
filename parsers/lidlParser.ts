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
    // A by-WEIGHT line (sold per kg) is weighable. Set on EVERY product
    // (true for unit==='kg', false per-piece) so the server resolver
    // keeps a weighable catalog SP instead of treating the missing flag
    // as a form mismatch — same contract as ikiParser's IkiProduct.
    isWeighable?: boolean;
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
// UNIT_LINE_RE. Capture groups (head: ppu; tail: qty + unit suffix)
// feed extractLidlProduct's split-half recovery — without it the
// halves leaked into the product NAME and the qty (and, for
// weighables, the kg signal) was lost.
const UNIT_HEAD_RE = new RegExp(`^\\s*(\\d+[.,_]\\s?${D}{1,2})\\s*[>×|]?\\s*[xkXК]\\s*$`);
const UNIT_TAIL_RE = new RegExp(
    `^\\s*(${D}+(?:[.,_]\\s?${D}{1,3})?)\\s*(kg|[€£]\\s*/\\s*vnt\\.?|[€£]\\s*/\\s*kg)\\s*$`,
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
// the prefix and drop the trailing garbage. The qty terminator is
// `(?![\d.,])` rather than `\b` — the garbage is usually glued
// straight onto the digits ("10,000yimo": digit→letter is NOT a \b
// boundary, so the old \b could never match its own motivating
// example). More digits/separators after the captured qty still
// abort (ambiguous longer number → leave the line alone).
const UNIT_LENIENT_RE = new RegExp(
    `^\\s*(\\d+[.,_]\\s?${D}{1,2})\\s*[xkXК]\\s*(\\d+[.,_]\\s?${D}{1,3})(?![\\d.,])`,
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
// TAISYMAS correction section — Lidl prints a `---- TAISYMAS ----`
// block with a negative refund price when a cashier voids/corrects
// a line. Its separator dashes must not trigger findFooterStart, and
// the whole block must be excluded from the product slice.
const TAISYMAS_RE = /\bTAISYMAS\b/i;
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
// ── date/time bail hardening (IKI T_DATE_RE / T_TIME_RE idioms) ──
// Lidl prints `YYYY-MM-DD HH:MM` on ONE footer line and parseFooter's
// combined same-line regex stays the FIRST preference. But a single
// garbled character in either half used to lose BOTH (→ the app-level
// RETAKE bail for the whole receipt), so date and time are additionally
// scanned INDEPENDENTLY:
//   date — separators may DOUBLE ("2025-06--18") or read as dots, and
//   OCR may inject a space around them. The year is pinned to `20\d{2}`
//   and month/day are range-checked at the call site so footer codes
//   ("SM-000022355", loterija ids) can't masquerade as a date.
const DATE_TOLERANT_RE =
    /(20\d{2})\s?[-.]{1,2}\s?(\d{2})\s?(?:[-.]{1,2}|\s)\s?(\d{2})(?!\d)/;
//   time — Lidl prints HH:MM (no seconds). A seconds-bearing form is
//   tried first with IKI's tolerant FIRST separator ("12-20:35" — the
//   strict second colon keeps dates from misreading as times); the bare
//   HH:MM form keeps its colon REQUIRED (a dot would match prices) but
//   tolerates the OCR space after it ("18: 33"). Hour/minute are
//   range-checked at the call site.
const TIME_SECONDS_TOLERANT_RE = /(\d{1,2})[:.\-]\s?(\d{2})\s?:\s?(\d{2})(?!\d)/;
const TIME_TOLERANT_RE = /(?:^|[^\d:])(\d{1,2})\s?:\s?(\d{2})(?!\d)/;
// Weighed-quantity signal that survives unit-line garble: Lidl prints
// weighed quantities with THREE decimals ("4,032 kg", "0,343 kg") while
// packaged sizes inside product names use 0-2 ("1 kg", "1,5 kg") — the
// 3-decimal fraction is the discriminator that keeps a packaged product
// from being flipped to weighable. OCR digit class on both sides.
const KG_WEIGHED_QTY_RE = new RegExp(
    `(${D}+[.,_]\\s?${D}{3})\\s*kg\\b`,
    'i',
);

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
    // Bare price (no VAT letter) — used by the look-back below to
    // detect a footer marker's value that MLKit emitted as a separate
    // box at near-same y. PRICE_RE accepts the same shape but with an
    // optional VAT letter, which is too generous for the look-back —
    // we want only the strict bare form here.
    const BARE_PRICE_RE = /^\s*\d+[.,]\s?\d{1,2}\s*$/;
    for (let i = afterIdx; i < lines.length; i++) {
        // NFD-stripped copy for markers where OCR may have replaced
        // `ė` with `è`/`é`/`ê` — e.g. `Tarpinè suma` instead of the
        // canonical `Tarpinė suma`. Without stripping, the marker is
        // missed and the whole footer region stays in the product
        // slice, generating phantom products for `Tarpinè suma`,
        // `Mokėti`, `NUolalda`, PVM tables, etc.
        const t = stripDiacritics(lines[i].text);
        let matched = false;
        if (/^\s*tarpine\s+sum/.test(t)) matched = true;
        else if (/^\s*moketi\b/.test(t)) matched = true;
        else if (/^\s*mokejimas\s+kortele/.test(t)) matched = true;
        else if (/^\s*bekontak/.test(t)) matched = true;
        // Dashed (`---`) or equal-sign (`===`) separator — Lidl
        // prints `===========` between the product list and the
        // PVM table. Catching it here keeps the visual band of
        // the LAST product from extending down into the
        // separator row when the V2 fold accepts everything to
        // the end of productSlice.
        // Skip separators that belong to a TAISYMAS correction block
        // (e.g. `---- TAISYMAS ----` or the dashes surrounding it).
        else if (/^[=-]{5,}$/.test(t.trim())) {
            const prev = i > 0 ? lines[i - 1].text : '';
            const next = i + 1 < lines.length ? lines[i + 1].text : '';
            if (!TAISYMAS_RE.test(prev) && !TAISYMAS_RE.test(next)) matched = true;
        }
        if (!matched) continue;
        // iOS MLKit emits the footer-marker value (e.g. "24,89" for
        // "Tarpinė suma 24,89") as a separate OCR box at near-same y
        // but a few px above. Without including it in the footer slice
        // it sits in the product slice and PRICE_RE — which permits
        // the VAT letter to be absent — anchors it as a phantom
        // product with the previous line as the name. Look back from
        // the matched marker; if the preceding line(s) are bare-price
        // at near-same y, include them in the footer.
        let start = i;
        for (let j = i - 1; j >= afterIdx; j--) {
            if (Math.abs(lines[j].yTop - lines[i].yTop) > 10) break;
            if (BARE_PRICE_RE.test(lines[j].text)) {
                start = j;
                continue;
            }
            break;
        }
        return start;
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

/**
 * Resolve the Lidl document / receipt number from a set of OCR lines.
 *
 * Lidl prints it in up to three forms, and MLKit frequently line-splits the
 * labelled one — which is why the old same-line-only capture returned null and
 * receipt numbers came back missing:
 *   1. "Dokumento numeris:"   — value often on the NEXT line   (most authoritative)
 *   2. "Kvitas NNNNN/NN"      — header row, can also split across two lines
 *   3. "#00NNNNN" / "00NNNNN" — zero-padded document line (header + VMI footer block)
 *
 * Every candidate is collected and the value the MOST sources agree on wins, so a
 * single garbled read (e.g. "80151269" for "00151269") can't take over; ties break
 * by the priority order above. Returns null when no source yields a number.
 */
export function extractReceiptNo(lines: LidlLine[]): { value: string; line: LidlLine } | null {
    const cands: { value: string; line: LidlLine; priority: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.trim();

        // (1) Dokumento numeris — same line, else the digits on the next line.
        if (/dokumento\s+numeris/i.test(t)) {
            const same = t.match(/dokumento\s+numeris\s*:?\s*(\d{4,})/i);
            if (same) {
                cands.push({ value: same[1], line: lines[i], priority: 0 });
            } else {
                const nx = lines[i + 1];
                const m = nx?.text.match(/(\d{4,})/);
                if (m && nx) cands.push({ value: m[1], line: nx, priority: 0 });
            }
        }

        // (2) Kvitas NNNNN/NN — same line, else "NNNNN/NN" on the next line.
        const kv = t.match(/^kvitas\s+(\d{4,})\s*\/\s*\d+/i);
        if (kv) {
            cands.push({ value: kv[1], line: lines[i], priority: 1 });
        } else if (/^kvitas$/i.test(t)) {
            const nx = lines[i + 1];
            const m = nx?.text.match(/^\s*(\d{4,})\s*\/\s*\d+/);
            if (m && nx) cands.push({ value: m[1], line: nx, priority: 1 });
        }

        // (3) Zero-padded document line "#00NNNNN" / "00NNNNN". Strip the pad and
        //     keep only 4–7 digit results, so the 10-digit merchant number
        //     ("0017300621") and other long ids can't masquerade as the doc number.
        const doc = t.match(/^#?(0{2,}\d{2,})$/);
        if (doc) {
            const v = doc[1].replace(/^0+/, '');
            if (v.length >= 4 && v.length <= 7) {
                cands.push({ value: v, line: lines[i], priority: 2 });
            }
        }
    }
    if (!cands.length) return null;

    // Self-heal: the value with the most corroborating sources wins; ties break
    // by the most authoritative source (Dokumento numeris > Kvitas > #00NNNNN).
    const byValue = new Map<string, { count: number; priority: number; line: LidlLine }>();
    for (const c of cands) {
        const e = byValue.get(c.value);
        if (!e) {
            byValue.set(c.value, { count: 1, priority: c.priority, line: c.line });
        } else {
            e.count++;
            if (c.priority < e.priority) { e.priority = c.priority; e.line = c.line; }
        }
    }
    let best: { value: string; count: number; priority: number; line: LidlLine } | null = null;
    for (const [value, e] of byValue) {
        if (!best || e.count > best.count
            || (e.count === best.count && e.priority < best.priority)) {
            best = { value, count: e.count, priority: e.priority, line: e.line };
        }
    }
    return best ? { value: best.value, line: best.line } : null;
}

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
    }

    // Date/time bail hardening: the combined same-line match above stays
    // the first preference, but ONE garbled character in either half used
    // to lose BOTH fields → app-level RETAKE bail. Re-scan the footer for
    // each field INDEPENDENTLY with OCR-tolerant separators (doubled
    // hyphens, dots, spaces around separators, split date/time boxes).
    // Range checks keep footer codes from masquerading as dates/times.
    if (!date || !time) {
        for (const l of lines) {
            const t = l.text.trim();
            if (!date) {
                const m = t.match(DATE_TOLERANT_RE);
                if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) {
                    date = `${m[1]}-${m[2]}-${m[3]}`;
                    trackLine(l, 'date');
                }
            }
            if (!time) {
                const m = t.match(TIME_SECONDS_TOLERANT_RE) ?? t.match(TIME_TOLERANT_RE);
                if (m && +m[1] <= 23 && +m[2] <= 59) {
                    time = `${m[1]}:${m[2]}`;
                    trackLine(l, 'time');
                }
            }
            if (date && time) break;
        }
    }

    // Receipt number via the multi-source, self-healing resolver. Handles MLKit
    // splitting the "Dokumento numeris" label from its value onto separate lines
    // (the old same-line `\d+` capture missed it) and cross-checks the zero-padded
    // document line, so the band lands on whichever line actually carries it.
    const rn = extractReceiptNo(lines);
    if (rn) {
        receiptNo = rn.value;
        trackLine(rn.line, 'receiptNo');
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
export function parseLidlReceipt(
    rawLines: LidlLine[],
    options: LidlParseOptions = {},
): LidlParseResult {
    const headerEnd = findHeaderEnd(rawLines);
    const footerStart = findFooterStart(rawLines, headerEnd);
    const header = parseHeader(rawLines.slice(0, headerEnd));
    const footer = parseFooter(rawLines.slice(footerStart));

    // Self-heal: if the footer yielded no receipt number (the whole "Dokumento
    // numeris" block cropped or garbled), recover it from the header — the
    // "Kvitas NNNNN/NN" / "#00NNNNN" rows carry the same document number.
    if (!footer.receiptNo) {
        const rn = extractReceiptNo(rawLines.slice(0, headerEnd));
        if (rn) footer.receiptNo = rn.value;
    }
    // LAST RESORT (IKI idiom): no printed identifier survived OCR but
    // date + time + total did — synthesise a stable dedup id from them
    // so a readable receipt never RETAKE-bails on the missing receipt
    // number alone. Shape mirrors ikiParser's synthetic fallback.
    if (!footer.receiptNo && footer.date && footer.time && footer.total !== null) {
        footer.receiptNo =
            `${footer.date.replace(/-/g, '')}-${footer.time.replace(/:/g, '')}` +
            `-${Math.round(footer.total * 100)}-lidl-receipt`;
    }
    const plan = findReceiptBandsLidl(rawLines, options);
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
        } else if (
            product.pricePerUnit === null &&
            product.price > 0 &&
            product.quantity > 0 &&
            product.quantity !== 1
        ) {
            // OCR dropped the unit-line's per-unit number ("<ppu> x <qty> vnt") but the
            // qty survived: `price` here is still the LINE TOTAL, and emitting it as-is
            // with quantity > 1 breaks the per-unit contract every other chain honors —
            // the server would write the multi-buy TOTAL as the SP's reference price.
            // Derive the unit price instead (total ÷ qty — same convention as IKI's
            // multi-buy recovery). Holds for weighed lines too: total ÷ kg-qty = €/kg —
            // including FRACTION-of-a-kg quantities (0,343 kg), which the old
            // `quantity > 1` gate missed, leaving the fraction's line total as the
            // "price" (a poisoned €/kg reference).
            const unit = Math.round((product.price / product.quantity) * 100) / 100;
            if (product.unit === 'kg' && (unit <= 0 || unit >= 1000)) {
                // PRICE-POISONING GUARD: the derived €/kg is implausible — the kg
                // quantity must be OCR-garbled. Show the line, never write price
                // (server skips price<=0 writes; see the ikiParser guard).
                product.price = 0;
                product.pricePerUnit = null;
                product.promoPrice = null;
            } else {
                product.pricePerUnit = unit;
                product.price = unit;
                if (product.promoPrice !== null) {
                    product.promoPrice =
                        Math.round((product.promoPrice / product.quantity) * 100) / 100;
                }
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
    // TAISYMAS correction-section markers are structural noise, not products.
    if (TAISYMAS_RE.test(t)) return 'other';
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

// Mid-line anchor with barcode at start. Handles the case where two
// rows got merged together because of duplicate OCR readings, and
// the first product's `X,YY A` anchor ended up sandwiched in the
// middle of a long fused string rather than at head or tail. Pattern:
//
//   `<barcode> <name> X,YY A <trailing>`
//
// Examples seen in the wild on iOS Lidl receipts:
//   - "0153420 Soft cake apels. skonio Cake dpe. .SKOT 0,83 A 3"
//     (qty `3` got merged in as trailing noise)
//   - "6717699 Jav.baton. su ban.ir šok. Jav.Datonl.SU Odn. I SoK. 0,29 A 2"
//   - "0011941 ...Rūkyta paukštienos dešra 1,49 A ,49"
//
// The leading barcode is the strong context signal that this is a
// structured product line, not free-form text that happens to
// contain digits. Without it the pattern is too generous and over-
// splits legitimate names that contain decimals (`Vyno 9,5 % 4,99 A`).
//
// Capture groups: 1 = barcode + name (everything before anchor),
// 2 = the X,YY A anchor itself, 3 = trailing content after the
// anchor (typically OCR noise, qty fragments, or the next row's
// content if cluster contamination occurred).
const FUSED_PRICE_MID_BARCODE_RE = new RegExp(
    `^(${BC}{4,10}\\s+.+?\\S)\\s+(\\d+[.,]\\s?${D}{1,2}\\s*[A-Z])\\s+(\\S.*)$`,
);

// Split a barcode-prefixed line whose `X,YY A` anchor sits embedded
// in the middle (rather than at head/tail). Used after the standard
// splitter when two rows' contents got fused into one OCR line by
// duplicate readings. Returns three parts:
//   [0] barcode + name (before anchor)
//   [1] anchor itself
//   [2] trailing content (next row's name fragments, qty noise, etc.)
// Returning null preserves the line unchanged when no mid-anchor is
// detected, so this is safe to chain after splitFusedAnchorLineLidl.
const splitMidAnchorLidl = (line: LidlLine): [LidlLine, LidlLine, LidlLine] | null => {
    const trimmed = line.text.trim();
    // Don't split clean anchors or anything already splittable by the
    // head/tail logic — those are handled upstream.
    if (PRICE_RE.test(trimmed)) return null;
    if (PRICE_OCR_RE.test(trimmed)) return null;
    if (PRICE_DEPOSIT_RE.test(trimmed)) return null;
    if (FUSED_PRICE_TAIL_RE.test(trimmed)) return null;
    if (FUSED_DEPOSIT_TAIL_RE.test(trimmed)) return null;
    if (FUSED_PRICE_HEAD_RE.test(trimmed)) return null;
    if (FUSED_DEPOSIT_HEAD_RE.test(trimmed)) return null;
    const m = trimmed.match(FUSED_PRICE_MID_BARCODE_RE);
    if (!m) return null;
    const before = m[1].trim();
    const anchor = m[2].trim();
    const after = m[3].trim();
    // Sanity: the "before" half must contain at least one letter, and
    // "after" should be non-trivial (not just a single digit). Single-
    // digit trailing fragments are usually OCR noise from the anchor's
    // own row — keeping them as their own line is fine; they'll be
    // ignored by name/anchor classifiers downstream.
    if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(before)) return null;
    return [
        { ...line, text: before },
        { ...line, text: anchor },
        { ...line, text: after },
    ];
};

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

const mergeRowFragmentsLidl = (
    rawLines: LidlLine[],
    options: { iosOcr?: boolean } = {},
): LidlLine[] => {
    if (options.iosOcr) {
        return mergeRowFragmentsLidlIosOrdered(rawLines);
    }
    // ─── Android path (unchanged) ─────────────────────────────────
    // In-place growing-cluster merge in encounter order. Keeps
    // bit-identical behaviour for the Android pipeline.
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

/**
 * iOS-only: cluster by y-proximity AND order each cluster's fragments
 * by `xLeft` before concatenating. MLKit on iOS splits each physical
 * row into 2-4 boxes that arrive in MLKit's reading order — which is
 * NOT left-to-right within a row. Without xLeft sorting, the merged
 * text reads `<price> <name> <barcode> <VAT>` and no fused-anchor
 * regex matches it. With xLeft sorting, the merged text reads as on
 * the physical receipt (`<barcode> <name> <price> <VAT>` for Lidl)
 * which the existing `FUSED_PRICE_TAIL_RE` already handles.
 */
const mergeRowFragmentsLidlIosOrdered = (rawLines: LidlLine[]): LidlLine[] => {
    if (rawLines.length === 0) return [];
    // First pass: build clusters from already-y-sorted input. Two
    // adjacent lines join the same cluster when their y-centers fall
    // within ROW_MERGE_CENTER_RATIO * smaller-height. Compared against
    // the growing cluster's bbox (not just the previous raw line) so
    // a tall fragment can still pull in shorter neighbours.
    const clusters: LidlLine[][] = [];
    let curBbox: { yTop: number; yBottom: number } | null = null;
    for (const line of rawLines) {
        if (!curBbox) {
            clusters.push([line]);
            curBbox = { yTop: line.yTop, yBottom: line.yBottom };
            continue;
        }
        const minH = Math.min(
            line.yBottom - line.yTop,
            curBbox.yBottom - curBbox.yTop,
        );
        const lineCenter = (line.yTop + line.yBottom) / 2;
        const clusterCenter = (curBbox.yTop + curBbox.yBottom) / 2;
        const yDiff = Math.abs(line.yTop - curBbox.yTop);
        const sameRow =
            yDiff < ROW_MERGE_YTOP_THRESHOLD_PX &&
            minH > 0 &&
            Math.abs(lineCenter - clusterCenter) < minH * ROW_MERGE_CENTER_RATIO;
        if (sameRow) {
            clusters[clusters.length - 1].push(line);
            curBbox.yTop = Math.min(curBbox.yTop, line.yTop);
            curBbox.yBottom = Math.max(curBbox.yBottom, line.yBottom);
        } else {
            clusters.push([line]);
            curBbox = { yTop: line.yTop, yBottom: line.yBottom };
        }
    }

    const out: LidlLine[] = [];
    for (const cluster of clusters) {
        if (cluster.length === 1) {
            out.push({ ...cluster[0] });
            continue;
        }
        // In-cluster dedup. MLKit on iOS occasionally emits two boxes
        // for the SAME physical column with slightly different
        // character recognition. Three patterns observed:
        //
        //   (1) Whitespace/case noise: "Bande]es Su šokoladu" vs
        //       "Bandelės su šokoladu" — same word, OCR mistakes.
        //   (2) Heavy corruption: "UOTTy4| KuKy Ld paUKSTIenos" vs
        //       "Rūkyta paukštienos dešra" — barely recognisable
        //       text similarity, but same physical row.
        //   (3) Whitespace-only: "Baltym. batonėl..." vs
        //       "Baltym.batonėl..." — pure space difference.
        //
        // The dedup uses TWO independent triggers so each pattern
        // catches:
        //   - High text similarity (case-insensitive, whitespace-
        //     stripped position-aligned compare). Handles (1) and (3).
        //   - Very high x-overlap (>0.7) regardless of text sim,
        //     since duplicate column readings always sit in the same
        //     x-range. Handles (2) — heavy OCR mangling can't fool
        //     the spatial signal.
        //
        // When dedup fires, KEEP the cleaner reading per a quality
        // score (fraction of recognisable letters + spaces). Pure
        // alphanumeric/space content scores higher than text full of
        // `|`, `]`, digit/letter substitutions.
        const normForSim = (s: string): string =>
            s.replace(/\s+/g, '').toLowerCase();
        const qualityScore = (s: string): number => {
            if (s.length === 0) return 0;
            let score = 0;
            let letters = 0;
            let digits = 0;
            for (const ch of s) {
                // Lithuanian diacritics get a bonus — they're unique
                // to the language and a strong signal that this is
                // the "clean" OCR reading rather than the corrupted
                // twin (which usually loses diacritics, e.g.
                // "ŠVž. sūrio užtepėlė" vs "SVZ.SurTo UZtepele").
                if (/[ĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(ch)) { score += 1.5; letters++; }
                else if (/[A-Za-z]/.test(ch)) { score += 1; letters++; }
                else if (/\d/.test(ch)) { score += 1; digits++; }
                else if (/[\s.,'\-%]/.test(ch)) score += 0.5;
                // Special chars (`|`, `]`, etc.) contribute 0 —
                // penalises OCR-mangled twins like "Bande]es" or
                // "UOTTy4|" that interleave noise punctuation with
                // legitimate text.
            }
            // ABSOLUTE score — longer cleaner reading wins. But
            // penalize letter intrusions inside a mostly-numeric
            // string: barcodes are digit-only, and a stray letter
            // (e.g. "b7004 72" instead of "6700472", "001g160"
            // instead of "0019160") is OCR garbage that shouldn't
            // beat the clean numeric form just because it added a
            // character of length.
            if (digits > 4 && digits > letters * 3) {
                score -= letters * 2;
            }
            return score;
        };
        // Two structurally-distinct dedup cases in the wild:
        //
        // (A) SAME-COLUMN DUPLICATE: two boxes cover the same physical
        //     column (similar xLeft AND xRight, similar widths). MLKit
        //     emitted two readings of the same word. Example:
        //     "Bandelės su šokoladu" + "Bande]es Su šokoladu" both at
        //     xLeft~60, xRight~700, both wide. Keep the cleaner.
        //
        // (B) MIDDLE-CONTAINED CORRUPTED FRAGMENT: a small box sits
        //     inside a larger box's x-range but NOT at its left edge.
        //     MLKit double-detected part of the row, producing a
        //     short corrupted fragment that "shadows" the middle of
        //     the clean wide reading. Example: "Cake dpe." (xLeft=300,
        //     short) inside "Soft cake apels. skonio" (xLeft=60, wide).
        //     Drop the shorter fragment.
        //
        // CRITICALLY: barcodes (`"0153420"`, narrow, at xLeft~50) sit
        // to the LEFT of names. Their x-range is contained in the
        // name's wide range by coincidence, but they start at the
        // same xLeft as the row's leftmost edge. Case (B) must require
        // the small box to start STRICTLY INSIDE the larger box, not
        // at its left edge — otherwise barcodes get incorrectly
        // dropped.
        const deduped: LidlLine[] = [];
        for (const box of cluster) {
            const boxText = box.text.trim();
            const boxNorm = normForSim(boxText);
            const boxW = box.xRight - box.xLeft;
            let dupAction: { kind: 'drop' | 'replace'; idx: number } | null = null;
            for (let di = 0; di < deduped.length; di++) {
                const seen = deduped[di];
                const seenText = seen.text.trim();
                const seenNorm = normForSim(seenText);
                const seenW = seen.xRight - seen.xLeft;

                // Case (A): same-column. Both xLeft and xRight close,
                // similar widths (>50% length ratio).
                const xLeftDist = Math.abs(box.xLeft - seen.xLeft);
                const xRightDist = Math.abs(box.xRight - seen.xRight);
                const widthRatio = Math.min(boxW, seenW) /
                    Math.max(boxW, seenW || 1);
                const sameColumn =
                    xLeftDist < 100 && xRightDist < 100 && widthRatio > 0.5;
                if (sameColumn) {
                    // Pick the cleaner reading by quality score.
                    if (qualityScore(boxText) > qualityScore(seenText)) {
                        dupAction = { kind: 'replace', idx: di };
                    } else {
                        dupAction = { kind: 'drop', idx: di };
                    }
                    break;
                }

                // Case (B): box is contained in seen but starts inside
                // (not at the left edge). Smaller corrupted fragment.
                const xLeftOffset = box.xLeft - seen.xLeft;
                const xRightOverhang = box.xRight - seen.xRight;
                const boxIsMidContained =
                    xLeftOffset > 50 &&
                    xRightOverhang < 20 &&
                    boxW < seenW * 0.7;
                if (boxIsMidContained) {
                    dupAction = { kind: 'drop', idx: di };
                    break;
                }
                // Mirror: seen contained inside box.
                const seenLeftOffset = seen.xLeft - box.xLeft;
                const seenRightOverhang = seen.xRight - box.xRight;
                const seenIsMidContained =
                    seenLeftOffset > 50 &&
                    seenRightOverhang < 20 &&
                    seenW < boxW * 0.7;
                if (seenIsMidContained) {
                    dupAction = { kind: 'replace', idx: di };
                    break;
                }

                // Substring containment: when one normalized text is
                // contained inside the other (and the smaller is
                // non-trivially long), the smaller is a sub-reading
                // of the larger. Common on iOS Lidl with qty rows:
                // MLKit emits "1,59 x" (left half) AND "2,000 €/vnt."
                // (right half) AND "1,59 x 2,000 €/vnt." (full)
                // as three boxes for one physical row. The full
                // reading subsumes the two halves. Drop the smaller
                // reading(s); keep the largest.
                if (seenNorm.length > 4 && boxNorm.length > 4) {
                    if (boxNorm !== seenNorm) {
                        if (seenNorm.includes(boxNorm)) {
                            dupAction = { kind: 'drop', idx: di };
                            break;
                        }
                        if (boxNorm.includes(seenNorm)) {
                            dupAction = { kind: 'replace', idx: di };
                            break;
                        }
                    }
                }

                // Whitespace-normalized similarity fallback. Two
                // separate thresholds:
                //   - 0.7 when boxes are at unrelated x-positions
                //     (e.g. one tiny matching fragment elsewhere)
                //   - 0.5 when both boxes start at similar xLeft
                //     (same left-column duplicate where MLKit
                //     character-substituted heavily — "Virtas
                //     kiaulienos kumpis riek." vs "VIrtdS Kldullenos
                //     KUmpLS" scores ~63% position-aligned because
                //     several letters got swapped to similar shapes;
                //     anchored to the same column, this is still a
                //     duplicate, not a different product).
                const minLen = Math.min(seenNorm.length, boxNorm.length);
                const maxLen = Math.max(seenNorm.length, boxNorm.length);
                if (maxLen > 0) {
                    let matches = 0;
                    for (let k = 0; k < minLen; k++) {
                        if (seenNorm[k] === boxNorm[k]) matches++;
                    }
                    const sim = matches / maxLen;
                    const simThreshold = xLeftDist < 100 ? 0.5 : 0.7;
                    if (sim > simThreshold) {
                        if (qualityScore(boxText) > qualityScore(seenText)) {
                            dupAction = { kind: 'replace', idx: di };
                        } else {
                            dupAction = { kind: 'drop', idx: di };
                        }
                        break;
                    }
                }
            }
            if (dupAction?.kind === 'replace') {
                deduped[dupAction.idx] = { ...box };
            } else if (dupAction?.kind === 'drop') {
                // Don't add box.
            } else {
                deduped.push({ ...box });
            }
        }

        // Post-pass: drop any entry whose normalized text is fully
        // contained in another entry's normalized text. Catches the
        // case where smaller fragments were added EARLIER, before the
        // larger superset arrived in iteration. The in-loop substring
        // check only triggers when comparing a NEW box to existing
        // entries — it doesn't retroactively remove the now-subsumed
        // smaller entries. Iterate in reverse so splice indices stay
        // valid.
        for (let i = deduped.length - 1; i >= 0; i--) {
            const iNorm = normForSim(deduped[i].text);
            if (iNorm.length <= 4) continue;
            for (let j = 0; j < deduped.length; j++) {
                if (i === j) continue;
                const jNorm = normForSim(deduped[j].text);
                if (jNorm.length > iNorm.length && jNorm.includes(iNorm)) {
                    deduped.splice(i, 1);
                    break;
                }
            }
        }

        const ordered = deduped.slice().sort((a, b) => a.xLeft - b.xLeft);
        out.push({
            text: ordered
                .map((l) => l.text.trim())
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim(),
            yTop: Math.min(...ordered.map((l) => l.yTop)),
            yBottom: Math.max(...ordered.map((l) => l.yBottom)),
            xLeft: Math.min(...ordered.map((l) => l.xLeft)),
            xRight: Math.max(...ordered.map((l) => l.xRight)),
        });
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

export interface LidlParseOptions {
    /** True when the OCR source is iOS MLKit. Switches the row-fragment
     *  merger to xLeft-sorted clustering so multi-fragment rows
     *  re-assemble in physical reading order. Off by default. */
    iosOcr?: boolean;
}

const computeBandsContextLidlV2 = (
    rawLines: LidlLine[],
    options: LidlParseOptions = {},
): LidlBandsContext => {
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
    const mergedProductSlice = mergeRowFragmentsLidl(rawProductSlice, options);
    const productSlice: LidlLine[] = [];
    for (const line of mergedProductSlice) {
        const split = splitFusedAnchorLineLidl(line);
        if (split) {
            productSlice.push(split[0], split[1]);
            continue;
        }
        // No head/tail fused-anchor pattern. Try the mid-line splitter
        // for the case where duplicate row readings concatenated two
        // products into one cluster line with the first product's
        // anchor sandwiched in the middle.
        const midSplit = splitMidAnchorLidl(line);
        if (midSplit) {
            productSlice.push(midSplit[0], midSplit[1], midSplit[2]);
            continue;
        }
        productSlice.push(line);
    }

    // Strip TAISYMAS correction blocks. A block starts at a TAISYMAS
    // marker (the `---- TAISYMAS ----` line or a surrounding dash line)
    // and ends at the next separator or at the next product anchor,
    // whichever comes first. We find TAISYMAS marker lines by index and
    // remove everything from the nearest preceding separator (or the
    // marker itself) through the next separator (inclusive).
    {
        let i = 0;
        while (i < productSlice.length) {
            if (TAISYMAS_RE.test(productSlice[i].text)) {
                // Walk back to include a leading dash-separator on the same block.
                let blockStart = i;
                if (blockStart > 0 && /^[=-]{5,}$/.test(productSlice[blockStart - 1].text.trim())) {
                    blockStart--;
                }
                // Walk forward past the correction lines to include the
                // trailing dash-separator and the refund price line.
                let blockEnd = i + 1;
                while (blockEnd < productSlice.length) {
                    const txt = productSlice[blockEnd].text.trim();
                    // Stop after a closing separator line.
                    if (/^[=-]{5,}$/.test(txt)) { blockEnd++; break; }
                    // Stop at the next product anchor (positive price with VAT letter).
                    if (/^\d+[.,]\s?\d{1,2}\s*[A-Z]$/.test(txt)) break;
                    blockEnd++;
                }
                productSlice.splice(blockStart, blockEnd - blockStart);
                i = blockStart;
            } else {
                i++;
            }
        }
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
    // Datetime band: clean combined `YYYY-MM-DD HH:MM` line first; fall
    // back to any footer line carrying an OCR-tolerant date (doubled/
    // dotted separators) so the band still renders when the printed
    // datetime is garbled but recoverable (see DATE_TOLERANT_RE).
    let dtBandLine: LidlLine | null = null;
    for (const line of footerSlice) {
        if (/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/.test(line.text)) {
            dtBandLine = line;
            break;
        }
    }
    if (!dtBandLine) {
        for (const line of footerSlice) {
            if (DATE_TOLERANT_RE.test(line.text.trim())) {
                dtBandLine = line;
                break;
            }
        }
    }
    if (dtBandLine) {
        bands.push({
            kind: 'datetime',
            yTop: dtBandLine.yTop,
            yBottom: dtBandLine.yBottom,
            label: 'date',
        });
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
export function findReceiptBandsLidl(
    rawLines: LidlLine[],
    options: LidlParseOptions = {},
): LidlReceiptBandPlan {
    const ctx = computeBandsContextLidlV2(rawLines, options);
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
    // kg-signal tracking for the weighed price-poisoning guard.
    //   weighed     — ANY surviving kg signal: clean unit line, split
    //                 tail half, Cat X lenient tail, orphan `€/kg`, or
    //                 a 3-decimal "N,NNN kg" weight inside a name line.
    //   kgQtyKnown  — a usable kg quantity was actually parsed. This
    //                 distinguishes a REAL "1,000 kg" (total == €/kg,
    //                 fine) from the DEFAULT quantity=1 of a weighed
    //                 line whose numbers all rotted (poisoning case).
    //   unitResolved — an explicit unit line decided kg-vs-vnt; blocks
    //                 the weaker in-name weight signal from overriding.
    let weighed = false;
    let kgQtyKnown = false;
    let unitResolved = false;
    const nameLines: string[] = [];
    // Discount plausibility clamp (IKI idiom): a discount can never
    // exceed the line total — a negative paid means the discount was
    // OCR-inflated or mis-attributed. DROP the promo (keep the base
    // price) rather than ship a negative/implausible promo price.
    const applyDiscount = (text: string) => {
        const d = extractDiscountAmount(text);
        if (d === null || promoPrice !== null || d <= 0) return;
        const paid = Math.round((price - d) * 100) / 100;
        if (paid >= 0) promoPrice = paid;
    };

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
        // promo if it's the first one seen (plausibility-clamped).
        if (DISCOUNT_HEADER_RE.test(text) || DISCOUNT_RE.test(text)) {
            applyDiscount(text);
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
            unitResolved = true;
            if (unit === 'kg') {
                weighed = true;
                kgQtyKnown = quantity > 0;
            }
            continue;
        }
        // OCR-split unit-line halves. The band walk already recognises
        // them ('unit' reason) but extraction used to drop them into
        // the NAME — losing the qty and, for weighables, the whole kg
        // signal. Head `0,59 x` carries the per-unit price; tail
        // `4,032 kg` / `2,000 €/vnt.` carries qty + unit. A kg tail
        // must carry the weighed 3-decimal fraction so a packaged size
        // fragment ("1 kg") can never flip a per-piece product.
        const headMatch = text.match(UNIT_HEAD_RE);
        if (headMatch) {
            if (pricePerUnit === null) pricePerUnit = parseNum(headMatch[1]);
            continue;
        }
        const tailMatch = text.match(UNIT_TAIL_RE);
        if (tailMatch) {
            const isKg = /kg/i.test(tailMatch[2]);
            if (!isKg || KG_WEIGHED_QTY_RE.test(text)) {
                const q = parseNum(tailMatch[1]);
                if (q > 0) quantity = q;
                unitResolved = true;
                if (isKg) {
                    unit = 'kg';
                    weighed = true;
                    kgQtyKnown = q > 0;
                }
                continue;
            }
            // kg tail WITHOUT the weighed fraction — likely a packaged
            // size fragment; fall through to the name path unchanged.
        }
        // Cat HH — unit line whose `€/vnt.`/`kg` suffix was lost or
        // mashed with the next row's text ("0,35 x 10,000yimo
        // spaustuvai 4"): capture ppu + qty from the leading
        // `N,NN x N,NNN` and drop the trailing garbage instead of
        // leaking the whole string into the name.
        const lenientMatch = text.match(UNIT_LENIENT_RE);
        if (lenientMatch) {
            if (pricePerUnit === null) pricePerUnit = parseNum(lenientMatch[1]);
            const q = parseNum(lenientMatch[2]);
            if (q > 0) quantity = q;
            continue;
        }
        // Cat X — weighable tail with a garbled PREFIX ("CEoX 0,343
        // kg"): the x-marker + weight tail survive even when the
        // leading €/kg rotted. Same 3-decimal gate as the tail half.
        const weightLenient = text.match(UNIT_WEIGHT_LENIENT_RE);
        if (weightLenient) {
            const isKg = /kg/i.test(weightLenient[2]);
            if (!isKg || KG_WEIGHED_QTY_RE.test(text)) {
                const q = parseNum(weightLenient[1]);
                if (q > 0) quantity = q;
                unitResolved = true;
                if (isKg) {
                    unit = 'kg';
                    weighed = true;
                    kgQtyKnown = q > 0;
                }
                continue;
            }
        }
        // Bare unit-fragment (`€/vnt.` alone) and pure-barcode
        // lines — neither contributes to the name. An orphan `€/kg`
        // is additionally a kg SIGNAL: the weighed row's numbers all
        // dropped, so weighed-ness must be flagged here or the line
        // total (a fraction of a kg) poisons the €/kg reference.
        if (UNIT_ORPHAN_RE.test(text)) {
            if (/kg/i.test(text) && !unitResolved) {
                weighed = true;
                unit = 'kg';
            }
            continue;
        }
        if (BARCODE_ONLY_RE.test(text)) continue;
        // Lenient price-like fragment (".99", "O, 90 A", ",29 A") —
        // an OCR-mangled price that lost its anchor shape. It can't
        // rescue a lost anchor on its own, but it must not pollute
        // the product name either.
        if (PRICE_LIKE_RE.test(text)) continue;

        // kg-signal that survives unit-line garble: a weighed
        // 3-decimal weight ("0,343 kg") embedded in a line that reads
        // as name text (the unit line mashed into the name / too
        // rotted for the unit regexes). Signal + qty only — the text
        // still contributes to the name so nothing visible is lost.
        if (!unitResolved) {
            const wm = text.match(KG_WEIGHED_QTY_RE);
            if (wm) {
                weighed = true;
                unit = 'kg';
                const q = parseNum(wm[1]);
                if (q > 0 && !kgQtyKnown) {
                    quantity = q;
                    kgQtyKnown = true;
                }
            }
        }
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
            applyDiscount(text);
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

    // PRICE-POISONING GUARD ("show it, never write price" — IKI idiom):
    // a WEIGHED line (kg signal seen) whose €/kg is unrecoverable — no
    // per-kg price survived AND no kg quantity to derive one from
    // (total ÷ kg). The anchor total covers a FRACTION of a kg, so
    // emitting it as the price would let the server write it as the
    // per-kg reference. Emit price=0 / pricePerUnit=null instead — the
    // server skips price<=0 writes; the item still SHOWS on the receipt
    // (unit 'kg', isWeighable true).
    const weighedNoPpu = weighed && pricePerUnit === null && !kgQtyKnown;
    if (weighedNoPpu) warnings.push(`weighed-no-ppu "${name.slice(0, 40)}"`);

    return {
        product: {
            name,
            price: weighedNoPpu ? 0 : price,
            promoPrice: weighedNoPpu ? null : promoPrice,
            quantity: weighedNoPpu ? 1 : quantity,
            unit,
            pricePerUnit,
            // Emitted on EVERY product (true = sold by weight) so the
            // server resolver can gate weighable-vs-packaged matching.
            isWeighable: unit === 'kg',
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
