/**
 * Norfa Receipt Parser
 *
 * Targets the electronic-receipt format from the Norfa online portal
 * (UAB NORFOS MAŽMENA). Layout differs from Rimi/Maxima in three
 * notable ways:
 *
 *   1. Price suffix is `M1` (21 % VAT) or `M5` (0 % / reduced / deposit),
 *      not Maxima/Rimi's `A`/`B`.
 *   2. Weighables print on ONE line: `<weight>x<unit_price> <total> M1`
 *      (e.g. `0,316x3,85 1,22 M1`) rather than splitting into a
 *      separate weight row.
 *   3. Per-item discounts aren't printed in the body. A `*` prefix on
 *      a product name indicates "on sale" but the shown price is the
 *      paid price, so there's no promoPrice distinction per line. The
 *      aggregate `NUOLAIDA PREKIŲ SUMAI` lives in the footer.
 *
 * OCR tolerances:
 *   - `M[15]` sometimes reads as M plus whitespace or a stray char;
 *     regexes allow `\s*` inside.
 *   - Decimal numerics sometimes have a stray space (`1, 22` instead
 *     of `1,22`) — same `[.,]\s?` pattern as the Maxima parser.
 */

import type { RegionKind, LabeledRegion } from './rimiParser';

export interface Region {
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface NorfaLine {
    text: string;
    yTop: number;
    yBottom: number;
    xLeft: number;
    xRight: number;
}

export interface NorfaProduct {
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
export interface NorfaHeader {
    chainName: string;
    storeCode: string;
    storeAddress: string;
    pvmCode: string;
    rawText: string;
    region: Region;
    lineRegions: LabeledRegion[];
}

export interface NorfaFooter {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
    region: Region;
    lineRegions: LabeledRegion[];
}

export interface NorfaParseResult {
    header: NorfaHeader;
    products: NorfaProduct[];
    footer: NorfaFooter;
}

// ───────── regexes ─────────

// Digit class that tolerates common MLKit letter-for-digit swaps on
// faded thermal prints: `O`/`o` for `0`, `l`/`I`/`L` for `1`. Same
// family of tolerances used by the Maxima parser.
const D = '[\\d0OoIlL]';
// `0,85 M1` / `1,22 M5`. Standalone total-price line. `\s?` inside the
// decimal to tolerate OCR's occasional `1, 22`.
const PRICE_RE = new RegExp(`^(\\d+[.,]\\s?${D}{1,2})\\s*M\\s*[15]\\s*$`, 'i');
// `0,316x3,85 1,22 M1` — inline weighable. Captures:
//   1 = quantity (e.g. 0,316)
//   2 = unit price (e.g. 3,85)
//   3 = total (e.g. 1,22)
// Digit class allows OCR variants; without this, `0,666xl,25 0,83 M1`
// (OCR read `1` as `l`) fails to match and bananas disappear.
const WEIGHABLE_RE = new RegExp(
    `^\\s*(\\d+[.,]\\s?${D}{1,3})\\s*[xX]\\s*(${D}+[.,]\\s?${D}{1,2})\\s+(${D}+[.,]\\s?${D}{1,2})\\s*M\\s*[15]\\s*$`,
    'i'
);
// `*UŽstatas už pakuote PET` — bottle deposit. We don't surface
// deposits as catalog products (same policy as Maxima/Rimi parsers).
const DEPOSIT_RE = /u[žz]stat[ao]s?\s+u[žz]\s+pakuot/i;
// `Lojalumo kortelė * * …` — loyalty card row. Not a product; used
// only as a footer-start marker.
const LOYALTY_RE = /lojalumo\s+kortel/i;
// Receipt-number label header — two known printed forms:
//   `# Kvito numeris 67833 #` or `# Kvito numeri 60748 #` (OCR drops
//   trailing s sometimes), AND
//   `Kvito Nr. 12345` (short label form, seen at the top and bottom
//   on some Norfa receipts).
// Everything before this line is header.
const RECEIPT_NO_HEADER_RE = /kvito\s+(?:numeri|nr\.?)/i;
// Capture form for the receipt number itself — same alternation,
// with the number captured. Used by parseFooter + the top-scan
// fallback to extract the value.
const RECEIPT_NO_CAPTURE_RE = /kvito\s+(?:numeri\S*|nr\.?)\s+(\d+)/i;
// Non-catalog checkout items (plastic bags). Same policy as other
// parsers — skip them entirely. Two routes catch the bag rows:
//
//   1. `NORFA PE mai…` — the chain-brand prefix Norfa always prints
//      on bag rows. Caught even when OCR mangles the `š` letter
//      (seen in the wild: `maiğelis` with `ğ` from š's caron getting
//      mistaken for a breve).
//   2. `mai[sšžzğç]\w*` — generic match for Lithuanian
//      `maišelis`/`maišas` plural / declension forms with a tolerant
//      letter class for the š position. `maiš-` prefixed words
//      outside checkout contexts are virtually non-existent on
//      grocery receipts, so false-positives are negligible.
const NON_CATALOG_RE = /NORFA\s+PE\s+mai\w*|\bmai[sšžzğç]\w*\b/i;
// "Size continuation" line — a product-name suffix like `50 %, 1 l`
// that receipts print on the row below the main name when the full
// name is too long to fit. During walk-back these appear BEFORE the
// head of the name in sort order (smaller y), so joining them
// prepends garbage like `50 %, 1 1 *Raud. greipfr. nekt. …`. The
// class intentionally covers only digits / percent / comma / period
// / whitespace / the OCR letter-variants for 1 (`l/I/L`) — real
// product-name words always contain letters outside that set, so
// false-positives are practically impossible. An optional trailing
// unit (`g`, `kg`, `ml`, `l`, `vnt`, `rit`) is allowed so lines like
// `200 g` match wholly here instead of falling into the leading-
// prefix peeler that would otherwise split off "200 " and leave "g"
// as a stray name fragment.
const SIZE_CONTINUATION_RE = /^[\d\s%,.lIL]+(?:g|kg|ml|l|vnt\.?|rit\.?)?\s*$/i;

/** Map OCR letter-for-digit confusions back to digits before parseFloat. */
function sanitizeNumStr(s: string): string {
    return s.replace(/[Oo]/g, '0').replace(/[IlL]/g, '1');
}

function parseNum(str: string): number {
    return parseFloat(sanitizeNumStr(str).replace(',', '.').replace(/\s/g, ''));
}

/**
 * Sorted-token normalisation. Lowercase + diacritic-strip, split
 * by non-alnum, sort tokens, rejoin. Used by the V2 extractor's
 * nameLines dedup to fold MLKit's occasional double-emission of
 * the same OCR box even when token order shifted.
 */
function sortedTokenNorm(s: string): string {
    return s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .sort()
        .join('');
}

/**
 * Self-repeat dedup. MLKit occasionally emits the same product name
 * twice inside ONE OCR box. Two flavours seen in the wild:
 *
 *   "Želė DR. OETKER, … 72 g Želė DR. OETKER, … 72 g"
 *   "*Baltagūžiai kopūstai, lkg 1,714x0,29 0,50 M1 *Baltagūžiai kopūstai, lkg"
 *
 * The second flavour has anchor noise (qty x ppu, total M1) jammed
 * BETWEEN the two name copies, so a halves-similarity check alone
 * doesn't trip the threshold.
 *
 * Strategy:
 *   1. Find a re-occurrence of the leading token at index ≥ ⅓ into
 *      the token list (so we don't trip on legit short repeats near
 *      the start).
 *   2. Confirm with a token-PREFIX match — the next 2-3 tokens at
 *      the re-occurrence must match the first 2-3 tokens by their
 *      diacritic-stripped, alnum-only normalisation. This rules out
 *      coincidental brand-name repeats inside legit product names.
 *   3. Return everything BEFORE the re-occurrence, then iteratively
 *      strip trailing weighable / anchor / bare-price tokens —
 *      they're noise from the corrupted middle, not part of the
 *      product name.
 */
function dedupRepeatedText(text: string): string {
    const trimmed = text.trim();
    if (trimmed.length < 20) return trimmed;
    const tokens = trimmed.split(/\s+/);
    if (tokens.length < 4) return trimmed;
    const norm = (s: string) =>
        s
            .toLowerCase()
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]/g, '');
    const firstWordNorm = norm(tokens[0]);
    if (firstWordNorm.length < 3) return trimmed;
    const startSearchIdx = Math.max(2, Math.floor(tokens.length / 3));
    for (let i = startSearchIdx; i < tokens.length; i++) {
        if (norm(tokens[i]) !== firstWordNorm) continue;
        // Confirm with a prefix-match: the first 2-3 tokens must
        // repeat at this position (normalised, so `*Baltagūžiai`
        // equals `Baltagūžiai` and OCR diacritic noise doesn't trip).
        const headTokens = Math.min(3, i, tokens.length - i);
        const headNorm = tokens.slice(0, headTokens).map(norm).join('');
        const tailNorm = tokens.slice(i, i + headTokens).map(norm).join('');
        if (headNorm !== tailNorm || headNorm.length < 6) continue;

        let before = tokens.slice(0, i).join(' ').trim();
        // Iteratively strip trailing weighable / anchor / bare-price
        // noise from `before` — when the dupe is "name + anchor noise
        // + name", we want just the name back.
        for (let pass = 0; pass < 3; pass++) {
            const prev = before;
            // X,YY M[15] anchor remnant
            before = before
                .replace(
                    /\s+[\d0OoIlL]+[.,]\s?[\d0OoIlL]{1,2}\s*M\s*[15]\s*$/i,
                    '',
                )
                .trim();
            // qty x unit_price (decimal qty)
            before = before
                .replace(
                    /\s+[\d0OoIlL]+[.,][\s\d0OoIlL]*[\d0OoIlL]\s*x\s*[\d0OoIlL]+[.,][\s\d0OoIlL]*[\d0OoIlL]\s*$/i,
                    '',
                )
                .trim();
            // qty x unit_price (integer qty)
            before = before
                .replace(
                    /\s+[\d0OoIlL]+\s*x\s*[\d0OoIlL]+[.,][\s\d0OoIlL]*[\d0OoIlL]\s*$/i,
                    '',
                )
                .trim();
            // bare X,YY
            before = before
                .replace(/\s+[\d0OoIlL]+[.,]\s?[\d0OoIlL]{1,2}\s*$/i, '')
                .trim();
            if (before === prev) break;
        }
        return before;
    }
    return trimmed;
}

function regionOf(lines: NorfaLine[]): Region {
    if (lines.length === 0) return { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
    return {
        yTop: Math.min(...lines.map((l) => l.yTop)),
        yBottom: Math.max(...lines.map((l) => l.yBottom)),
        xLeft: Math.min(...lines.map((l) => l.xLeft)),
        xRight: Math.max(...lines.map((l) => l.xRight)),
    };
}

// ───────── detection ─────────

export function isNorfaReceipt(lines: string[]): boolean {
    // Some Norfa e-receipts omit `UAB NORFOS MAŽMENA` from the top
    // and the chain name only appears later inside product names
    // (e.g. `Maišeliai NORFA 40X10X64`). Scan the whole text — no
    // other Lithuanian grocery chain has `NORF` as a substring, so
    // false-positive collision with Maxima/Rimi/IKI is safe.
    const full = lines.join(' ').toUpperCase();
    return /NORF/.test(full);
}

// ───────── boundaries ─────────

function findHeaderEnd(lines: NorfaLine[]): number {
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        if (RECEIPT_NO_HEADER_RE.test(lines[i].text)) return i + 1;
    }
    // Fallback: first standalone price line.
    for (let i = 0; i < lines.length; i++) {
        if (PRICE_RE.test(lines[i].text.trim()) || WEIGHABLE_RE.test(lines[i].text.trim())) {
            return Math.max(0, i - 1);
        }
    }
    return Math.min(7, lines.length);
}

function findFooterStart(lines: NorfaLine[], afterIdx: number): number {
    for (let i = afterIdx; i < lines.length; i++) {
        const t = lines[i].text;
        if (LOYALTY_RE.test(t)) return i;
        if (/^kvito\s+suma/i.test(t.trim())) return i;
        if (/\d{4}\s+met[ųu]\s+pirkin/i.test(t)) return i;   // "2025 metų pirkinių"
        if (/tarpin[ėe]\s+suma/i.test(t)) return i;
        if (/^\*{3,}/.test(t.trim())) return i;               // `**** **** ****`
    }
    return lines.length;
}

// ───────── header ─────────

function parseHeader(lines: NorfaLine[]): NorfaHeader {
    let storeAddress = '';
    let storeCode = '';
    let pvmCode = '';

    // Per-line region tracker — tagged with `kind` for per-field
    // colour + label.
    const seen = new Set<string>();
    const lineRegions: LabeledRegion[] = [];
    const trackLine = (line: NorfaLine | undefined, kind: RegionKind) => {
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

    for (let idx = 0; idx < lines.length; idx++) {
        const t = lines[idx].text.trim();
        // Reuse the V2 tagged-band address detector — it tolerates a
        // missing `g.` street suffix (e.g. `Pramonės 6, Šiauliai`)
        // and OCR-lowercased city names. The original strict regex
        // here required `g.<digit>` and missed those receipts.
        if (!storeAddress) {
            const m = t.match(NORFA_ADDRESS_LINE_RE);
            if (m && m.index !== undefined) {
                storeAddress = t.slice(m.index).trim();
                trackLine(lines[idx], 'storeAddress');
                // Multi-line address: when the matched line ends
                // with a trailing comma, the next line is its
                // continuation.
                if (storeAddress.endsWith(',') && idx + 1 < lines.length) {
                    const next = lines[idx + 1].text.trim();
                    if (
                        next &&
                        !/^[*-]/.test(next) &&
                        !/kvito|laukiame/i.test(next)
                    ) {
                        storeAddress = `${storeAddress} ${next}`;
                        trackLine(lines[idx + 1], 'storeAddress');
                    }
                }
                storeAddress = storeAddress.replace(/,\s*$/, '');
            }
        }
        if (!storeCode && /KASA\s*Nr/i.test(t)) {
            storeCode = t.replace(/^.*KASA\s*Nr\.?/i, '').trim();
            trackLine(lines[idx], 'storeCode');
        }
        if (!pvmCode && /PVM\s*mok/i.test(t)) pvmCode = t;
    }
    lineRegions.sort((a, b) => a.yTop - b.yTop);
    return {
        chainName: 'NORFA',
        storeCode,
        storeAddress,
        pvmCode,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
        lineRegions,
    };
}

// ───────── footer ─────────

function parseFooter(lines: NorfaLine[]): NorfaFooter {
    let total: number | null = null;
    let date = '';
    let time = '';
    let receiptNo = '';
    let totalSavings: number | null = null;

    // Per-line region tracker — tagged with `kind` for per-field
    // colour + label.
    const seen = new Set<string>();
    const lineRegions: LabeledRegion[] = [];
    const trackLine = (line: NorfaLine | undefined, kind: RegionKind) => {
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

        if (/^suma\b/i.test(t)) {
            const m = t.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
            if (m) {
                total = parseNum(m[1]);
                trackLine(lines[i], 'total');
            }
        }
        if (total === null && /^kvito\s+suma/i.test(t)) {
            const sameLine = t.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
            if (sameLine) {
                total = parseNum(sameLine[1]);
                trackLine(lines[i], 'total');
            } else {
                const neighbour = lines[i - 1]?.text ?? lines[i + 1]?.text ?? '';
                const m = neighbour.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
                if (m) {
                    total = parseNum(m[1]);
                    trackLine(lines[i], 'total');
                    // Track the actual neighbour we read from.
                    if (lines[i - 1] && /(\d+[.,]\s?\d{1,2})\s*EUR/i.test(lines[i - 1].text)) {
                        trackLine(lines[i - 1], 'total');
                    } else {
                        trackLine(lines[i + 1], 'total');
                    }
                }
            }
        }
        // `NUOLAIDA PREKIŲ SUMAI` — total discount across all items.
        if (/nuolaida\s+preki/i.test(t)) {
            const sameLine = t.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
            if (sameLine) {
                totalSavings = parseNum(sameLine[1]);
            } else {
                const neighbour = lines[i - 1]?.text ?? lines[i + 1]?.text ?? '';
                const m = neighbour.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
                if (m) totalSavings = parseNum(m[1]);
            }
        }
        // Date/time block: `2026-01-07 15:29` (no label).
        const dtMatch = t.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
        if (dtMatch) {
            date = dtMatch[1];
            time = dtMatch[2];
            trackLine(lines[i], 'dateTime');
        }
        // Receipt number at footer tail — accepts both "Kvito numeris"
        // and "Kvito Nr." label forms.
        if (!receiptNo) {
            const rnMatch = t.match(RECEIPT_NO_CAPTURE_RE);
            if (rnMatch) {
                receiptNo = rnMatch[1];
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
 * Convention (matches Rimi V2): rows with a weight or multi-buy
 * line have their `price` and `promoPrice` normalized to PER-UNIT
 * values here. Downstream code recovers the line total as
 * `price × quantity`. Single-pack rows (quantity = 1) keep `price`
 * as the line total.
 *
 * Internally uses the V2 hard-walled band detector
 * (`findReceiptBandsNorfa`) + per-band extractor
 * (`extractNorfaProduct`).
 */
export function parseNorfaReceipt(rawLines: NorfaLine[]): NorfaParseResult {
    const headerEnd = findHeaderEnd(rawLines);
    const footerStart = findFooterStart(rawLines, headerEnd);
    const header = parseHeader(rawLines.slice(0, headerEnd));
    const footer = parseFooter(rawLines.slice(footerStart));
    // Some Norfa receipts print `# Kvito numeris N #` ONLY at the
    // top (inside the header slice that parseFooter doesn't see).
    // Scan the whole receipt as a fallback so headerEnd is included.
    // When the fallback hits, also push the source line's bbox into
    // footer.lineRegions so the photo view bands it — without this
    // the receipt-no field reads but its band silently disappears.
    if (!footer.receiptNo) {
        for (const l of rawLines) {
            const m = l.text.match(RECEIPT_NO_CAPTURE_RE);
            if (m) {
                footer.receiptNo = m[1];
                footer.lineRegions.push({
                    kind: 'receiptNo',
                    yTop: l.yTop,
                    yBottom: l.yBottom,
                    xLeft: l.xLeft,
                    xRight: l.xRight,
                });
                footer.lineRegions.sort((a, b) => a.yTop - b.yTop);
                break;
            }
        }
    }
    const plan = findReceiptBandsNorfa(rawLines);
    const products: NorfaProduct[] = [];
    for (const internal of plan.productInternals) {
        const { product } = extractNorfaProduct(internal);
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

export function parseNorfaHeaderOnly(lines: NorfaLine[]): NorfaHeader {
    const headerEnd = findHeaderEnd(lines);
    return parseHeader(lines.slice(0, headerEnd));
}

// ─────────────────────────────────────────────────────────────────
// V2 step 1: hard-walled bands
// ─────────────────────────────────────────────────────────────────
//
// Same architecture as the Rimi V2 parser:
//   1. Find anchors (any line that satisfies PRICE_RE or
//      WEIGHABLE_RE — Norfa anchors are `N,NN M1`/`M5` or the
//      fused weighable `0,316x3,85 1,22 M1`).
//   2. For each anchor, scan downward and collect tail-eligible
//      content (discount-header `Nuolaida 33%` and discount-EUR
//      `-0,78 EUR`). Tail's max yBottom defines the band's
//      effective bottom.
//   3. Wall between bands = midpoint between (this band's tail
//      yBottom) and the yTop of the first line below it.
//   4. Lines are assigned to bands by strict y-CENTER membership
//      against (topWall, bottomWall]. Nothing crosses a wall.
//
// Step 1 (this commit): produce typed bands for the dev-tool
// overlay + per-line classification trace. Per-product content
// extraction (step 2) and analize integration (step 3) come
// after the bands are visually validated.

export type NorfaBandKind =
    | 'store-name'
    | 'store-address'
    | 'product'
    | 'receipt-no'
    | 'datetime'
    | 'total';

// Header-band detectors. Both run on the header slice only, so
// product-name lines containing `NORFA …` (e.g. "NORFA PE maišelis")
// can't false-match into the store-name band.
//
// STORE_NAME — matches the chain marker `UAB NORFOS MAŽMENA` or its
// fragments. Uses a Ž/Z class because OCR sometimes strips diacritics.
const NORFA_STORE_NAME_LINE_RE = /NORFOS|MA[ŽZ]MENA|UAB\s+NORF/i;

// ADDRESS — looks for the shape `<word> <number>, <word>` where the
// number is preceded by an optional `g[.,]?` street suffix. Tolerant
// of the suffix being completely missing (MLKit drops `g.` on faded
// thermal prints — `"Pramonės 6, šiauliai"` is the actual OCR for
// `"Pramonės g. 6, Šiauliai"`), of OCR-lowercased city names, and
// of OCR letter-for-digit confusions in the house number (the same
// `[\d0OoIlL]` class used for product prices — seen in the wild:
// `Vilties g.l, Dainų kaimas` where MLKit read `1` as lowercase `l`).
const NORFA_ADDRESS_LINE_RE =
    /[A-ZĄČĘĖĮŠŲŪŽa-ząčęėįšųūž]{3,}\s*(?:g[.,]?\s*)?[\d0OoIlL]+[A-Za-z]?(?:[-/][\d0OoIlL]+[A-Za-z]?)?\s*,\s*[A-ZĄČĘĖĮŠŲŪŽa-ząčęėįšųūž]{3,}/;

export interface NorfaReceiptBand {
    kind: NorfaBandKind;
    yTop: number;
    yBottom: number;
    /** `#1`/`#2` for product bands; `addr`/`nr`/`date`/`sum` otherwise. */
    label: string;
}

export type NorfaLineReason =
    | 'name'
    | 'anchor'
    | 'discount-header'
    | 'discount-eur'
    | 'weighable'
    | 'deposit'
    | 'other';

export interface NorfaBandLineEntry {
    line: NorfaLine;
    sliceIdx: number;
    reason: NorfaLineReason;
}

export interface NorfaBandInternal {
    bandIdx: number;
    anchor: NorfaBandLineEntry;
    preName: NorfaBandLineEntry[];
    postAnchor: NorfaBandLineEntry[];
}

export interface NorfaReceiptBandPlan {
    bands: NorfaReceiptBand[];
    productInternals: NorfaBandInternal[];
}

interface NorfaProductBandInternal {
    anchorIdx: number;
    /** Lines with center > topWall belong here. */
    topWall: number;
    /** Lines with center <= bottomWall belong here. */
    bottomWall: number;
}

const isPositivePriceLine = (line: NorfaLine): boolean => {
    const t = line.text.trim();
    return PRICE_RE.test(t) || WEIGHABLE_RE.test(t);
};

// Fused-anchor tail regexes — match the anchor portion at the END of
// a line that starts with product-name text. MLKit on Norfa receipts
// frequently emits a single OCR line containing "name … qty x unit
// total M1" or "name … total M1". Without splitting these the only
// anchor the scanner finds is the next product's bare price line, so
// 3-4 distinct products collapse into one mega-band.
//
// `\s+` before the tail anchors the boundary (so a name that happens
// to end in digits doesn't false-match), and `\s*$` requires the
// tail to be at the literal end of the line.
const FUSED_WEIGHABLE_TAIL_RE = new RegExp(
    `\\s+(${D}+[.,]\\s?${D}{1,3}\\s*x\\s*${D}+[.,]\\s?${D}{1,2}\\s+${D}+[.,]\\s?${D}{1,2}\\s*M\\s*[15])\\s*$`,
    'i'
);
const FUSED_PRICE_TAIL_RE = new RegExp(
    `\\s+(${D}+[.,]\\s?${D}{1,2}\\s*M\\s*[15])\\s*$`,
    'i'
);

// Partial-buy tail — `qty x unit_price` glued onto the END of a
// name line WITHOUT the total + M-suffix. The total lives on the
// next OCR line as a bare PRICE_RE anchor.
//
// Two separate regex pairs (decimal-qty for weighables, integer-
// qty for multi-buys) instead of one with an optional decimal
// portion: Hermes (React Native's JS engine) sometimes struggles
// with `(?:[.,]…)?` inside a complex partial pattern — it works on
// V8/Node but the optional group doesn't fire on device, leaving
// integer-qty multi-buys un-split. Separate regexes are simpler
// and Hermes-compatible.
//
// PRICE_TOK is a digit token tolerant of stray whitespace WITHIN
// the digit groups — OCR routinely fragments `0,806` into
// `0, 80 6` (two stray spaces). parseNum strips those spaces back
// out before parseFloat. Inner character class is inlined (not
// `[\s${D}]`) because nesting `${D}` inside another `[…]` produces
// an invalid pattern.
const D_INNER = '\\d0OoIlL';
const PRICE_TOK = `[${D_INNER}]+[.,][\\s${D_INNER}]*[${D_INNER}]`;

// Decimal qty x unit-price (weighable shape).
const PARTIAL_DEC_TAIL_RE = new RegExp(
    `\\s+(${PRICE_TOK}\\s*x\\s*${PRICE_TOK})\\s*$`,
    'i'
);
const PARTIAL_DEC_LINE_RE = new RegExp(
    `^${PRICE_TOK}\\s*x\\s*${PRICE_TOK}\\s*$`,
    'i'
);
const PARTIAL_DEC_PARTS_RE = new RegExp(
    `(${PRICE_TOK})\\s*x\\s*(${PRICE_TOK})`,
    'i'
);

// Integer qty x unit-price (multi-buy shape, e.g. `2x1,67`).
const PARTIAL_INT_TAIL_RE = new RegExp(
    `\\s+([${D_INNER}]+\\s*x\\s*${PRICE_TOK})\\s*$`,
    'i'
);
const PARTIAL_INT_LINE_RE = new RegExp(
    `^[${D_INNER}]+\\s*x\\s*${PRICE_TOK}\\s*$`,
    'i'
);
const PARTIAL_INT_PARTS_RE = new RegExp(
    `([${D_INNER}]+)\\s*x\\s*(${PRICE_TOK})`,
    'i'
);

const splitFusedAnchorLine = (line: NorfaLine): [NorfaLine, NorfaLine] | null => {
    const trimmed = line.text.trim();
    // Already a clean anchor — nothing to split.
    if (PRICE_RE.test(trimmed)) return null;
    if (WEIGHABLE_RE.test(trimmed)) return null;

    // Weighable tail wins over price tail since it's the more
    // specific pattern (qty x unit + total + M). Partial-buy
    // tail (qty x unit, no total/M) is the lowest-priority match
    // and covers BOTH decimal-qty weighables and integer-qty
    // multi-buys via the unified PARTIAL_BUY_TAIL_RE.
    let match = trimmed.match(FUSED_WEIGHABLE_TAIL_RE);
    if (!match) match = trimmed.match(FUSED_PRICE_TAIL_RE);
    if (!match) match = trimmed.match(PARTIAL_DEC_TAIL_RE);
    if (!match) match = trimmed.match(PARTIAL_INT_TAIL_RE);
    if (!match) return null;

    const namePart = trimmed.slice(0, match.index).trim();
    const tailPart = match[1];
    if (!namePart) return null;
    // Name must contain at least one letter — otherwise the leading
    // section is just digits and we'd be cutting a legit single-line
    // weighable in half.
    if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/.test(namePart)) return null;

    return [
        { ...line, text: namePart },
        { ...line, text: tailPart },
    ];
};

// Relaxed (un-anchored) discount detector used by the V2 tail
// extension. The V1 DISCOUNT_HEADER_RE / DISCOUNT_EUR_RE require
// the WHOLE line to be the header or the EUR amount, but MLKit
// sometimes joins the two halves onto a single OCR row in either
// order:
//   "Nuolaida 33% -0,78 EUR"  (label-first)
//   "-0,78 EUR Nuolaida 33%"  (price-first — happens when the right-
//                              column EUR box sorts a few px above
//                              the left-column label)
// Either token alone or both together count as a discount line for
// band-tail purposes.
const NUOLAIDA_TOKEN_RE = /\bnuolaid[aos]?/i;
const DISCOUNT_AMOUNT_RE = /-\s*\d+[.,]\s?\d{1,2}\s*EUR/i;
const isDiscountLineV2 = (line: NorfaLine): boolean =>
    NUOLAIDA_TOKEN_RE.test(line.text) || DISCOUNT_AMOUNT_RE.test(line.text);

const isDepositLine = (line: NorfaLine): boolean =>
    DEPOSIT_RE.test(line.text);

const classifyLineReason = (line: NorfaLine): NorfaLineReason => {
    // Order matters — a combined "Nuolaida 33% -0,78 EUR" line
    // matches both NUOLAIDA_TOKEN_RE and DISCOUNT_AMOUNT_RE, so we
    // tag it by whichever appears FIRST in the text.
    const t = line.text;
    const nuolMatch = NUOLAIDA_TOKEN_RE.exec(t);
    const eurMatch = DISCOUNT_AMOUNT_RE.exec(t);
    if (nuolMatch || eurMatch) {
        if (nuolMatch && eurMatch) {
            return nuolMatch.index <= eurMatch.index
                ? 'discount-header'
                : 'discount-eur';
        }
        return nuolMatch ? 'discount-header' : 'discount-eur';
    }
    if (WEIGHABLE_RE.test(line.text.trim())) return 'weighable';
    if (isDepositLine(line)) return 'deposit';
    return 'name';
};

/**
 * Same-row consolidation step modelled after the Rimi parser's
 * mergeRowFragments. MLKit splits a row's left-column name and
 * right-column price into separate text boxes; without merging
 * here, the per-line classifiers see only fragments and the band
 * loop drifts. Anchor (`N,NN M1`) and weighable lines stay as
 * their own entries; plain text on the same physical row gets
 * spliced BEFORE the price/weighable in slice order so the wrap
 * lands in preName.
 */
const ROW_MERGE_YTOP_THRESHOLD_PX = 30;
const ROW_MERGE_CENTER_RATIO = 0.4;

const mergeRowFragments = (rawLines: NorfaLine[]): NorfaLine[] => {
    const sorted = [...rawLines].sort((a, b) => a.yTop - b.yTop);
    const out: NorfaLine[] = [];
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
        const lineIsPrice = isPositivePriceLine(line);
        const lastIsPrice = isPositivePriceLine(last);
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
        // Both plain text on the same row → merge.
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

const findProductAnchorsV2 = (productSlice: NorfaLine[]): number[] => {
    const centerOf = (line: NorfaLine) => (line.yTop + line.yBottom) / 2;
    const anchors: number[] = [];
    for (let i = 0; i < productSlice.length; i++) {
        if (!isPositivePriceLine(productSlice[i])) continue;
        // Skip the deposit's own M5 price line — its previous line
        // (after mergeRowFragments has spliced the column-split row)
        // is the `*Užstatas už pakuotę PET` deposit-name marker.
        // The whole deposit row should attach to the PREVIOUS product
        // (the bottle/can) as tail content, not stand alone as its
        // own band.
        const prev = i > 0 ? productSlice[i - 1] : null;
        if (prev && isDepositLine(prev)) continue;

        // Drop near-duplicate anchors. MLKit sometimes emits the same
        // physical row's anchor as TWO separate boxes (e.g. one
        // matching WEIGHABLE_RE for `1,924x0,77 1,48 M1` and another
        // matching PRICE_RE for `1,48 M1` alone). Both register here;
        // keeping both creates two product bands competing for the
        // same lines and the second band ends up nameless. The first
        // accepted anchor wins — WEIGHABLE_RE precedes PRICE_RE in
        // OCR sort order on these receipts and carries qty/ppu, so
        // it's the more informative pick.
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
 * postAnchor lines (discount-header, discount-eur, deposit). Wall
 * placed at midpoint between tail bottom and first next line top.
 */
const findProductBandsInternalV2 = (
    productSlice: NorfaLine[]
): NorfaProductBandInternal[] => {
    const anchorIdxs = findProductAnchorsV2(productSlice);
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
            if (isDiscountLineV2(line) || isDepositLine(line)) {
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            // Deposit's own M5 price line. findProductAnchorsV2
            // already filtered it out of anchorIdxs (so the
            // `anchorIdxs.includes(k)` guard above doesn't fire),
            // and we recognise it here by `prev is deposit-name`.
            const prev = k > 0 ? productSlice[k - 1] : null;
            if (
                isPositivePriceLine(line) &&
                prev &&
                isDepositLine(prev)
            ) {
                lastBottom = Math.max(lastBottom, line.yBottom);
                continue;
            }
            break;
        }
        tailBottoms.push(lastBottom);
    }

    const bands: NorfaProductBandInternal[] = [];
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

interface NorfaBandsContext {
    headerEnd: number;
    footerStart: number;
    productSlice: NorfaLine[];
    bands: NorfaReceiptBand[];
    productInternals: NorfaBandInternal[];
}

const computeBandsContextV2 = (rawLines: NorfaLine[]): NorfaBandsContext => {
    const headerEnd = findHeaderEnd(rawLines);
    const footerStart = findFooterStart(rawLines, headerEnd);
    const headerSlice = rawLines.slice(0, headerEnd);
    // Two-stage normalisation:
    //   1. mergeRowFragments — consolidate same-row OCR fragments
    //      and splice left-column wraps before their right-column
    //      anchors so band-detection sees clean shapes.
    //   2. splitFusedAnchorLine — split lines that fuse product-name
    //      text with the weighable/price + M-suffix tail into two
    //      virtual lines (name + anchor).
    // Order matters: merge MUST run first. The split's two halves
    // inherit the source line's y-coords, so if merge ran second
    // it would see them as same-row text and concatenate them
    // straight back, undoing the split.
    const rawProductSlice = rawLines.slice(headerEnd, footerStart);
    const mergedProductSlice = mergeRowFragments(rawProductSlice);
    const productSlice: NorfaLine[] = [];
    for (const line of mergedProductSlice) {
        const split = splitFusedAnchorLine(line);
        if (split) productSlice.push(split[0], split[1]);
        else productSlice.push(line);
    }
    const footerSlice = rawLines.slice(footerStart);

    const bands: NorfaReceiptBand[] = [];

    // Header bands — store-name (UAB NORFOS MAŽMENA chain marker)
    // and store-address (street + number + city). Each emits at
    // most one band, picked from the first matching header line.
    for (const line of headerSlice) {
        if (NORFA_STORE_NAME_LINE_RE.test(line.text)) {
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
        if (NORFA_ADDRESS_LINE_RE.test(line.text)) {
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
    const internal = findProductBandsInternalV2(productSlice);
    const productBands: NorfaReceiptBand[] = [];
    const productInternals: NorfaBandInternal[] = [];
    const sliceTop = productSlice.length > 0
        ? Math.min(...productSlice.map((l) => l.yTop))
        : 0;
    const sliceBottom = productSlice.length > 0
        ? Math.max(...productSlice.map((l) => l.yBottom))
        : 0;
    const centerOf = (line: NorfaLine) => (line.yTop + line.yBottom) / 2;

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

        const preName: NorfaBandLineEntry[] = [];
        const postAnchor: NorfaBandLineEntry[] = [];
        for (const k of memberIdxs) {
            if (k === band.anchorIdx) continue;
            const line = productSlice[k];
            const entry: NorfaBandLineEntry = {
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

    // Footer bands (visual only — receipt-no, datetime, total).
    for (const line of footerSlice) {
        const t = line.text.trim();
        if (/kvito\s+numeri/i.test(t) || /^\d{4,}\s*#?\s*$/.test(t)) {
            bands.push({
                kind: 'receipt-no',
                yTop: line.yTop,
                yBottom: line.yBottom,
                label: 'nr',
            });
            break;
        }
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
    for (const line of footerSlice) {
        if (/^kvito\s+suma/i.test(line.text.trim())) {
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
export function findReceiptBandsNorfa(rawLines: NorfaLine[]): NorfaReceiptBandPlan {
    const ctx = computeBandsContextV2(rawLines);
    return { bands: ctx.bands, productInternals: ctx.productInternals };
}

/** Copy-paste-friendly trace of the band layout + per-line classification. */
export function traceReceiptBandsNorfa(rawLines: NorfaLine[]): string {
    const ctx = computeBandsContextV2(rawLines);
    const out: string[] = [];
    const TRUNC = (s: string, n = 80): string =>
        s.length <= n ? s : s.slice(0, n - 1) + '…';
    const fmtY = (line: NorfaLine): string =>
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
    for (const band of ctx.bands) {
        out.push(
            `── band kind=${band.kind} label=${band.label} y=${Math.round(band.yTop)}..${Math.round(band.yBottom)} (Δ ${Math.round(band.yBottom - band.yTop)} px)`,
        );
    }

    const internal = findProductBandsInternalV2(ctx.productSlice);
    const anchorSet = new Set(internal.map((b) => b.anchorIdx));
    const inBand = new Map<number, number>();
    const centerOf = (line: NorfaLine) => (line.yTop + line.yBottom) / 2;
    for (let bi = 0; bi < internal.length; bi++) {
        const band = internal[bi];
        for (let k = 0; k < ctx.productSlice.length; k++) {
            const c = centerOf(ctx.productSlice[k]);
            if (c > band.topWall && c <= band.bottomWall) inBand.set(k, bi + 1);
        }
    }
    const tag = (line: NorfaLine, sliceIdx: number): string => {
        const tags: string[] = [];
        if (anchorSet.has(sliceIdx)) tags.push('anchor');
        if (PRICE_RE.test(line.text.trim())) tags.push('+price');
        if (WEIGHABLE_RE.test(line.text.trim())) tags.push('weighable');
        // Use the relaxed (un-anchored) detectors so combined lines
        // like "Nuolaida 33% -0,78 EUR" tag correctly. The strict V1
        // regexes above would miss them.
        if (NUOLAIDA_TOKEN_RE.test(line.text)) tags.push('disc-header');
        if (DISCOUNT_AMOUNT_RE.test(line.text)) tags.push('disc-eur');
        if (DEPOSIT_RE.test(line.text)) tags.push('deposit');
        return tags.length > 0 ? tags.join(',') : '?';
    };

    out.push('');
    out.push('— products slice —');
    for (let i = 0; i < ctx.productSlice.length; i++) {
        const line = ctx.productSlice[i];
        const bandLabel = inBand.has(i) ? `b${inBand.get(i)}` : 'b-';
        out.push(
            `  slice[${i}] ${fmtY(line)} ${bandLabel} ${tag(line, i)} "${TRUNC(line.text)}"`,
        );
    }
    return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────
// V2 step 2: per-band content extraction
// ─────────────────────────────────────────────────────────────────
//
// Convert one classified Norfa product band into a NorfaProduct (or
// skip). Rules:
//   - Anchor parses to total price + (when WEIGHABLE) qty + ppu.
//   - preName lines build the name. Leading `*` (Norfa's on-sale
//     marker) is stripped. Size-continuation tails (digits/percent
//     only — typically the product's pack size split onto the row
//     above the head name in the printed receipt) get appended to
//     the end of the name rather than prepended.
//   - postAnchor `Nuolaida 33% / -0,78 EUR` lines (or the combined
//     forms) drive promoPrice = anchor.price - discount.eur.
//   - Bag (`Maišeliai NORFA …`) and bottle-deposit (`*Užstatas už
//     pakuotę PET`) bands are SKIPPED (consistent with V1's policy).
//   - Deposit-anchor lines that got folded into the previous band
//     by the V2 wall logic don't contribute to the parent product's
//     price — V1 didn't count them either, and the customer-facing
//     line price is just the bottle/can.

export interface NorfaExtractResult {
    product: NorfaProduct | null;
    warnings: string[];
}

export function extractNorfaProduct(internal: NorfaBandInternal): NorfaExtractResult {
    const warnings: string[] = [];
    const anchorText = internal.anchor.line.text.trim();

    // Parse the anchor: WEIGHABLE shape (qty x unit total M[15]) wins
    // over the bare PRICE shape because it's strictly more specific.
    let price: number;
    let quantity = 1;
    let unit = 'vnt';
    let pricePerUnit: number | null = null;

    const weighMatch = anchorText.match(WEIGHABLE_RE);
    if (weighMatch) {
        quantity = parseNum(weighMatch[1]);
        pricePerUnit = parseNum(weighMatch[2]);
        price = parseNum(weighMatch[3]);
        unit = quantity % 1 !== 0 ? 'kg' : 'vnt';
    } else {
        const priceMatch = anchorText.match(PRICE_RE);
        if (!priceMatch) {
            return {
                product: null,
                warnings: [`skip:anchor-parse-failed "${anchorText}"`],
            };
        }
        price = parseNum(priceMatch[1]);
    }

    // Walk preName: collect name fragments, separate out size-suffix
    // tails (number/percent only — printed BELOW the head name on
    // the receipt but emitted ABOVE it in y-sort because the box
    // sorts higher). Skip leading discount/deposit fragments.
    const nameLines: string[] = [];
    const sizeSuffixes: string[] = [];
    let promoPrice: number | null = null;

    const extractDiscountEur = (text: string): number | null => {
        const m = text.match(/-\s*(\d+[.,]\s?\d{1,2})\s*EUR/i);
        return m ? parseNum(m[1]) : null;
    };

    // Leading-size-prefix detector. MLKit y-sorts the size wrap line
    // (`50 %, 1 1`) ABOVE its head row when the wrap's bbox sits a
    // few pixels higher than the head's. The current preName entry
    // arrives as `"50 %, 1 1 *Raud. greipfr. nekt. ELMENHORSTER,"` —
    // size content + space + actual name. Greedy `[\d\s%,.lIL]+`
    // captures the leading run; the remainder must start with a `*`
    // or letter (the real name's first non-noise char). The captured
    // size piece queues into sizeSuffixes so it appends AFTER the
    // head, matching the printed order on the receipt.
    const LEADING_SIZE_PREFIX_RE = /^([\d\s%,.lIL]+)([*A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž].*)$/;

    for (const entry of internal.preName) {
        let text = entry.line.text.trim();
        if (!text) continue;
        // A discount line sitting in preName means the previous
        // product's discount got y-sorted ahead of this one's name.
        // It belongs to that previous product, not us — drop it.
        // (Pull the EUR amount only if we somehow have no discount
        // captured yet; defensive — the postAnchor pass below is
        // the canonical source.)
        if (NUOLAIDA_TOKEN_RE.test(text) || DISCOUNT_AMOUNT_RE.test(text)) {
            const d = extractDiscountEur(text);
            if (d !== null && promoPrice === null) {
                promoPrice = Math.round((price - d) * 100) / 100;
            }
            continue;
        }
        if (DEPOSIT_RE.test(text)) continue;

        // Standalone partial-buy line — split off from a fused
        // name+partial line by splitFusedAnchorLine. Drives qty/ppu
        // for the band when the anchor is a bare PRICE_RE (the total
        // sits on the anchor row, the partial is its own line above).
        // Two shapes, two regex pairs:
        //   "1,05x0,99"  → decimal qty → kg unit
        //   "2x1,67"     → integer qty → vnt unit
        if (PARTIAL_DEC_LINE_RE.test(text)) {
            if (pricePerUnit === null) {
                const m = text.match(PARTIAL_DEC_PARTS_RE);
                if (m) {
                    quantity = parseNum(m[1]);
                    pricePerUnit = parseNum(m[2]);
                    unit = quantity % 1 !== 0 ? 'kg' : 'vnt';
                }
            }
            continue;
        }
        if (PARTIAL_INT_LINE_RE.test(text)) {
            if (pricePerUnit === null) {
                const m = text.match(PARTIAL_INT_PARTS_RE);
                if (m) {
                    quantity = parseNum(m[1]);
                    pricePerUnit = parseNum(m[2]);
                    unit = 'vnt';
                }
            }
            continue;
        }

        if (SIZE_CONTINUATION_RE.test(text)) {
            sizeSuffixes.push(text);
            continue;
        }

        // Self-repeat dedup: MLKit occasionally emits the same name
        // twice inside one OCR box (`"Želė DR. OETKER, … 72 g Želė
        // DR. OETKER, … 72 g"`). Find the first re-occurrence of
        // the leading token in the line; if the two halves are
        // ≥70 % similar (diacritic-stripped, alnum-only) keep just
        // the first half.
        text = dedupRepeatedText(text);

        // Asterisk-mid-line correction. `*` is Norfa's on-sale
        // marker that ALWAYS starts a product name on the receipt.
        // When MLKit clumps two physical rows into one text box in
        // reverse order, the size/wrap continuation from the row
        // BELOW gets prepended to the head row's `*…`. Result on
        // device:
        //   "sėmen., čiobrel., *Duoniukai SELGA Su saulėgr.,"
        //                      ^ head should start here
        // Split: queue "sėmen., čiobrel.," as a wrap continuation
        // (so it appends after the head per Norfa's printed order),
        // keep "*Duoniukai SELGA Su saulėgr.," as the head.
        const starIdx = text.indexOf('*');
        if (starIdx > 0) {
            const beforeStar = text.slice(0, starIdx).trim();
            if (beforeStar) sizeSuffixes.push(beforeStar);
            text = text.slice(starIdx).trim();
        }

        // `*`-prefix promotion: when this line starts with `*`
        // (Norfa's on-sale marker = always head row), anything we
        // pushed to nameLines from EARLIER preName entries was a
        // wrap continuation that y-sorted above the head. Re-route
        // it to sizeSuffixes so the printed order ("head first,
        // wrap second") is restored after joining.
        if (text.startsWith('*') && nameLines.length > 0) {
            sizeSuffixes.push(...nameLines);
            nameLines.length = 0;
        }

        // Safety net: strip a trailing `qty x unit_price` partial
        // off the name even when splitFusedAnchorLine didn't fire.
        // splitFusedAnchorLine SHOULD have peeled this off into its
        // own slice, but Hermes (RN's JS engine) sometimes evaluates
        // the splitter's regex differently from V8/Node, leaving
        // `žemaičių blynas 150 g 2x0,99` un-split on device. Doing
        // the strip here as well guarantees the same result whatever
        // the engine.
        const partialDecMatch = text.match(
            new RegExp(
                `\\s+(${PRICE_TOK})\\s*x\\s*(${PRICE_TOK})\\s*$`,
                'i',
            ),
        );
        const partialIntMatch =
            partialDecMatch === null
                ? text.match(
                      new RegExp(
                          `\\s+([${D_INNER}]+)\\s*x\\s*(${PRICE_TOK})\\s*$`,
                          'i',
                      ),
                  )
                : null;
        const partialMatch = partialDecMatch ?? partialIntMatch;
        if (partialMatch) {
            if (pricePerUnit === null) {
                quantity = parseNum(partialMatch[1]);
                pricePerUnit = parseNum(partialMatch[2]);
                unit =
                    partialDecMatch && quantity % 1 !== 0 ? 'kg' : 'vnt';
            }
            text = text.slice(0, partialMatch.index).trim();
        }

        // Cross-line digit merge. OCR routinely splits a long size
        // number across the row boundary — `250 ml` becomes `25` at
        // the end of one row and `0 ml` at the start of the next.
        // If the previous nameLine ends in a digit AND the current
        // text starts with a digit run, glue the run onto the prev
        // nameLine and drop it from the front of `text`.
        if (nameLines.length > 0) {
            const prev = nameLines[nameLines.length - 1];
            if (/[\d0OoIlL]$/.test(prev)) {
                const m = text.match(/^([\d0OoIlL]+)(.*)$/);
                if (m && m[1].length > 0) {
                    nameLines[nameLines.length - 1] = prev + m[1];
                    text = m[2].trim();
                }
            }
        }

        // Leading size-prefix on a name line — split it off so the
        // suffix appends AFTER the head and the head reads naturally.
        // The size part must contain at least one digit or `%`,
        // otherwise the gate trips on bare leading letters that
        // happen to be in the OCR-confusable `[lIL]` class — the
        // first "L" of "Lietuviškos" would otherwise be peeled off
        // and reattached at the end of the name.
        const leadMatch = text.match(LEADING_SIZE_PREFIX_RE);
        if (leadMatch) {
            const sizePart = leadMatch[1].trim();
            if (
                sizePart &&
                SIZE_CONTINUATION_RE.test(sizePart) &&
                /[\d%]/.test(sizePart)
            ) {
                sizeSuffixes.push(sizePart);
                text = leadMatch[2].trim();
            }
        }

        if (text) nameLines.push(text);
    }

    // Dedupe consecutive identical / near-identical name lines.
    // MLKit sometimes emits the same OCR text twice in one band's
    // preName (different bbox, same content) and we don't want it
    // joined twice in the name.
    if (nameLines.length > 1) {
        const deduped: string[] = [];
        const seen = new Set<string>();
        for (const line of nameLines) {
            const key = sortedTokenNorm(line);
            if (seen.has(key)) continue;
            seen.add(key);
            deduped.push(line);
        }
        nameLines.length = 0;
        nameLines.push(...deduped);
    }

    // Forward-walk fallback: if preName produced no name, scan
    // postAnchor for the first name-like line. Catches the case
    // where MLKit y-sorts the right-column anchor box ahead of the
    // left-column name on the same physical row, leaving preName
    // empty.
    if (nameLines.length === 0) {
        for (const entry of internal.postAnchor) {
            let t = entry.line.text.trim();
            if (!t) continue;
            if (NUOLAIDA_TOKEN_RE.test(t) || DISCOUNT_AMOUNT_RE.test(t)) continue;
            if (DEPOSIT_RE.test(t)) continue;
            if (PARTIAL_DEC_LINE_RE.test(t)) continue;
            if (PARTIAL_INT_LINE_RE.test(t)) continue;
            if (PRICE_RE.test(t)) continue;
            if (WEIGHABLE_RE.test(t)) continue;
            t = t.replace(/^\*+\s*/, '');
            if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{3,}/.test(t)) continue;
            nameLines.push(t);
            break;
        }
    }

    // postAnchor: discount tail (`Nuolaida 33%` + `-0,78 EUR`, in
    // any order, possibly combined onto one line) and deposit lines
    // that got folded in by the V2 wall logic.
    for (const entry of internal.postAnchor) {
        const text = entry.line.text.trim();
        if (!text) continue;
        if (NUOLAIDA_TOKEN_RE.test(text) || DISCOUNT_AMOUNT_RE.test(text)) {
            const d = extractDiscountEur(text);
            if (d !== null && promoPrice === null) {
                promoPrice = Math.round((price - d) * 100) / 100;
            }
            continue;
        }
        // Deposit name + deposit price — both fold into the band
        // for visual completeness but neither contributes to the
        // displayed product price. Ignored.
    }

    // Strip Norfa's leading `*` on-sale marker, then append any
    // size-suffix tails after the head name.
    const headName = nameLines.join(' ').replace(/^\s*\*+\s*/, '').trim();
    const tailName = sizeSuffixes.join(' ').trim();
    const name = [headName, tailName].filter(Boolean).join(' ').trim();

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

/** Per-band extraction trace, copy-paste-friendly companion to traceReceiptBandsNorfa. */
export function traceNorfaExtract(rawLines: NorfaLine[]): string {
    const ctx = computeBandsContextV2(rawLines);
    const out: string[] = [];
    out.push(`bands=${ctx.productInternals.length}`);
    for (let i = 0; i < ctx.productInternals.length; i++) {
        const internal = ctx.productInternals[i];
        const { product, warnings } = extractNorfaProduct(internal);
        if (!product) {
            out.push(
                `band ${i + 1}: SKIP  ${warnings[0] ?? 'unknown'}`,
            );
            continue;
        }
        const promoStr =
            product.promoPrice === null ? 'null' : product.promoPrice.toFixed(2);
        const ppuStr =
            product.pricePerUnit === null ? 'null' : product.pricePerUnit.toFixed(2);
        const reconcile =
            product.promoPrice !== null
                ? `${product.price.toFixed(2)} − discount = ${product.promoPrice.toFixed(2)}`
                : 'n/a';
        const warningTail =
            warnings.length > 0 ? `  (${warnings.join('; ')})` : '';
        out.push(
            `band ${i + 1}: OK  name="${product.name}"  ` +
                `price=${product.price.toFixed(2)}  promo=${promoStr}  ` +
                `qty=${product.quantity}  unit=${product.unit}  ppu=${ppuStr}  ` +
                `reconcile:${reconcile}${warningTail}`,
        );
    }
    return out.join('\n');
}
