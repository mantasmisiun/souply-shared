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

export interface NorfaHeader {
    chainName: string;
    storeCode: string;
    storeAddress: string;
    pvmCode: string;
    rawText: string;
    region: Region;
}

export interface NorfaFooter {
    total: number | null;
    date: string;
    time: string;
    receiptNo: string;
    totalSavings: number | null;
    rawText: string;
    region: Region;
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
// Per-item discount header (`Nuolaida 33%`) and the companion
// discount-value line (`-0,78 EUR`). Some receipts OCR the % sign as
// `8` (seen `Nuolaida 338` for `Nuolaida 33%`), hence the `[%\d]?`
// tolerance. Used both as walk-back stop (so the next product
// doesn't absorb them as name) and as forward-walk absorption
// markers (so promoPrice gets set on the product they belong to).
const DISCOUNT_HEADER_RE = /^\s*nuolaid[aos]?\s*\d+\s*[%\d]?\s*$/i;
const DISCOUNT_EUR_RE = /^\s*-\s*(\d+[.,]\s?\d{1,2})\s*EUR\s*$/i;
// `Lojalumo kortelė * * …` — loyalty card row. Not a product; used
// only as a footer-start marker.
const LOYALTY_RE = /lojalumo\s+kortel/i;
// `# Kvito numeris 67833 #` or `# Kvito numeri 60748 #` (OCR drops
// trailing s sometimes). Everything before this line is header.
const RECEIPT_NO_HEADER_RE = /kvito\s+numeri/i;
// Non-catalog checkout items (plastic bags). Same policy as other
// parsers — skip them entirely. The suffix class allows Lithuanian
// plural / declension forms (`maišelis`, `maišeliai`, `maišelį`,
// `maišas`, `maišą`) — `mai[sš]\w*` is broad but `maiš-` prefixed
// words outside checkout contexts are virtually non-existent on
// grocery receipts, so the false-positive risk is negligible.
const NON_CATALOG_RE = /\bmai[sš]\w*\b/i;
// "Size continuation" line — a product-name suffix like `50 %, 1 l`
// that receipts print on the row below the main name when the full
// name is too long to fit. During walk-back these appear BEFORE the
// head of the name in sort order (smaller y), so joining them
// prepends garbage like `50 %, 1 1 *Raud. greipfr. nekt. …`. The
// class intentionally covers only digits / percent / comma / period
// / whitespace / the OCR letter-variants for 1 (`l/I/L`) — real
// product-name words always contain letters outside that set, so
// false-positives are practically impossible.
const SIZE_CONTINUATION_RE = /^[\d\s%,.lIL]+$/;

/** Map OCR letter-for-digit confusions back to digits before parseFloat. */
function sanitizeNumStr(s: string): string {
    return s.replace(/[Oo]/g, '0').replace(/[IlL]/g, '1');
}

function parseNum(str: string): number {
    return parseFloat(sanitizeNumStr(str).replace(',', '.').replace(/\s/g, ''));
}

/**
 * Name similarity used by the Norfa merge step. Character-level
 * Levenshtein on a SORTED-TOKEN representation: split by non-alnum,
 * sort tokens, rejoin. This makes the score robust to the word-order
 * flips we see on Norfa receipts (`50 %, 11 *Raud. qreipfr. …` on
 * one row vs `*Raud. qreipfr. … 50 %, 1 1` on another) which char-
 * level Levenshtein would score at ~0.74 because the numeric
 * fragment shifted across the string.
 *
 * The sorted-token join deliberately drops separators (`11` token
 * from one receipt and split `1 1` from another both concat to
 * `11` after sort+join). That's the point — OCR whitespace and
 * punctuation noise shouldn't affect the similarity score. Paired
 * with the same-unit-price guard in mergeNorfaDuplicates, cross-SKU
 * false positives are practically impossible.
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

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    let curr = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
        curr[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[b.length];
}

function nameSimilarity(a: string, b: string): number {
    const na = sortedTokenNorm(a);
    const nb = sortedTokenNorm(b);
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return 1;
    return 1 - levenshtein(na, nb) / maxLen;
}

/**
 * Norfa-specific post-parse deduplication.
 *
 * Unlike Maxima/Rimi (multi-buy printed as `2 vnt X 0,65 EUR` → one
 * row with qty=N) and IKI, Norfa prints every repeat of an SKU as
 * its own receipt line. A customer buying 5 juice cartons produces
 * 5 separate `*Juice 2,37 M1` rows plus 5 `Nuolaida 33% -0,78 EUR`
 * pairs. The matcher doesn't know they're the same SKU and surfaces
 * them as separate products, which bloats the comparison view.
 *
 * Merge policy (deliberately conservative):
 *   - Unit price must agree within €0.01 (accumulated total / qty
 *     compared to new entry's own total). Prevents same-family
 *     different-size variants from merging.
 *   - Names must score ≥0.90 similarity on the diacritic-stripped
 *     alnum representation. Absorbs OCR noise within a single SKU
 *     (`qreipfr` vs `greipfr`, `, 1 1` vs `, 1l`) without risking a
 *     cross-SKU merge on vaguely-similar names.
 * Either criterion failing → no merge, new entry added as separate.
 */
function mergeNorfaDuplicates(products: NorfaProduct[]): NorfaProduct[] {
    const merged: NorfaProduct[] = [];
    for (const p of products) {
        const existing = merged.find((m) => {
            const mUnit = m.price / (m.quantity || 1);
            const pUnit = p.price / (p.quantity || 1);
            if (Math.abs(mUnit - pUnit) > 0.01) return false;
            return nameSimilarity(m.name, p.name) >= 0.9;
        });
        if (existing) {
            existing.quantity += p.quantity;
            existing.price = Math.round((existing.price + p.price) * 100) / 100;
            if (p.promoPrice !== null || existing.promoPrice !== null) {
                const ePromo = existing.promoPrice ?? existing.price;
                const pPromo = p.promoPrice ?? p.price;
                existing.promoPrice = Math.round((ePromo + pPromo) * 100) / 100;
            }
            existing.rawLines.push(...p.rawLines);
            // Keep price as the aggregate total (reconcile logic
            // sums it), but expose the unit price separately for UI
            // display so the merged row reads as "€2.37 × 3 vnt"
            // rather than "€7.11 × 3 vnt" (ambiguous).
            if (existing.quantity > 1) {
                existing.pricePerUnit = Math.round((existing.price / existing.quantity) * 100) / 100;
            }
        } else {
            merged.push({ ...p, rawLines: [...p.rawLines] });
        }
    }
    return merged;
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
    for (const l of lines) {
        const t = l.text.trim();
        if (!storeAddress && /^[A-ZĄČĘĖĮŠŲŪŽ].*g\.\s*\d/i.test(t)) storeAddress = t;
        if (!storeCode && /KASA\s*Nr/i.test(t)) storeCode = t.replace(/^.*KASA\s*Nr\.?/i, '').trim();
        if (!pvmCode && /PVM\s*mok/i.test(t)) pvmCode = t;
    }
    return {
        chainName: 'NORFA',
        storeCode,
        storeAddress,
        pvmCode,
        rawText: lines.map((l) => l.text).join('\n'),
        region: regionOf(lines),
    };
}

// ───────── products ─────────

function parseProducts(lines: NorfaLine[]): NorfaProduct[] {
    const products: NorfaProduct[] = [];
    // Anchor indices: every line that carries a total-price (either a
    // bare `N,NN M1` or an inline weighable tail). Walk back from each
    // anchor to pick up the product name.
    const priceIndices: number[] = [];
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.trim();
        if (PRICE_RE.test(t) || WEIGHABLE_RE.test(t)) priceIndices.push(i);
    }

    const usedLines = new Set<number>();

    for (let pi = 0; pi < priceIndices.length; pi++) {
        const priceIdx = priceIndices[pi];
        if (usedLines.has(priceIdx)) continue;

        const priceLine = lines[priceIdx];
        const priceText = priceLine.text.trim();

        // Extract price + weighable data if applicable.
        let price = 0;
        let quantity = 1;
        let unit = 'vnt';
        let pricePerUnit: number | null = null;

        const weighMatch = priceText.match(WEIGHABLE_RE);
        if (weighMatch) {
            quantity = parseNum(weighMatch[1]);
            pricePerUnit = parseNum(weighMatch[2]);
            price = parseNum(weighMatch[3]);
            // Heuristic: Norfa prints weighables by weight in kg when
            // the receipt's base unit is kg (`Bananai, lkg`); pack
            // counts would normally be integers with no decimal, so
            // any fractional quantity is treated as kg.
            unit = quantity % 1 !== 0 ? 'kg' : 'vnt';
        } else {
            const priceMatch = priceText.match(PRICE_RE)!;
            price = parseNum(priceMatch[1]);
        }

        usedLines.add(priceIdx);

        const prevPriceIdx = pi > 0 ? priceIndices[pi - 1] : -1;
        const rawLines: string[] = [];
        const consumedLines: NorfaLine[] = [priceLine];
        const nameLines: string[] = [];
        // Collected separately so they can be appended AFTER the real
        // name parts — a receipt-wrapping size tail (`50 %, 1 l`)
        // visually sits below the name's head row, but y-sort puts it
        // higher in the line list, so walk-back encounters it first.
        // Prepending it via nameLines.unshift would give `50 %, 1 1
        // *Raud. greipfr. nekt. ELMENHORSTER,` instead of the correct
        // `*Raud. greipfr. nekt. ELMENHORSTER, 50 %, 1 l`.
        const sizeSuffixes: string[] = [];
        let lookback = priceIdx - 1;
        let skippedNonCatalog = false;

        while (lookback > prevPriceIdx && nameLines.length + sizeSuffixes.length < 4) {
            const prev = lines[lookback];
            const prevText = prev.text.trim();

            if (!prevText || usedLines.has(lookback)) {
                lookback--;
                continue;
            }
            // Another price line = previous product, stop.
            if (PRICE_RE.test(prevText) || WEIGHABLE_RE.test(prevText)) break;
            // Don't absorb the receipt-number header line into a name.
            if (RECEIPT_NO_HEADER_RE.test(prevText)) break;
            // Deposit lines and non-catalog bag rows are skipped
            // entirely — flag so the forward-walk fallback won't
            // rescue them into a phantom product.
            if (DEPOSIT_RE.test(prevText)) {
                skippedNonCatalog = true;
                break;
            }
            if (NON_CATALOG_RE.test(prevText)) {
                skippedNonCatalog = true;
                break;
            }
            // Previous product's discount-header/value pair (`Nuolaida
            // 33%` + `-0,78 EUR`). These belong to the product BEFORE
            // us — stop before absorbing them as name.
            if (DISCOUNT_HEADER_RE.test(prevText) || DISCOUNT_EUR_RE.test(prevText)) break;

            // Size-continuation tail: save to append after the name,
            // don't prepend via unshift.
            if (SIZE_CONTINUATION_RE.test(prevText)) {
                sizeSuffixes.unshift(prevText);
                consumedLines.push(prev);
                usedLines.add(lookback);
                lookback--;
                continue;
            }

            nameLines.unshift(prevText);
            consumedLines.push(prev);
            usedLines.add(lookback);
            lookback--;
        }

        // Forward-walk fallback when backward walk came back empty.
        // Happens when MLKit sorts the price block ABOVE the name
        // block in y-space (`2,99 M1` at y=218 before the tea name at
        // y=218 — same visual row, right-column price sorts first).
        // Without this the first product of every Norfa receipt gets
        // dropped and its name floats into the second product's
        // walk-back as a smooshed prefix.
        const nextPriceIdxFwd =
            pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;
        if (nameLines.length === 0 && !skippedNonCatalog) {
            for (let j = priceIdx + 1; j < Math.min(priceIdx + 4, nextPriceIdxFwd); j++) {
                if (usedLines.has(j)) continue;
                const next = lines[j];
                const nextText = next.text.trim();
                if (!nextText) continue;
                if (PRICE_RE.test(nextText)) break;
                if (WEIGHABLE_RE.test(nextText)) break;
                // Deposit / non-catalog lines adjacent to THIS price
                // mean the current price belongs to that non-product
                // row — stop the fallback and mark the product for
                // skip. Without the `break`, we'd keep scanning and
                // grab the NEXT product's name as the rescue for
                // THIS price (the `Maišeliai` at y=77 / greipfr at
                // y=92 confusion on downloadfile.PDF).
                if (DEPOSIT_RE.test(nextText)) {
                    skippedNonCatalog = true;
                    break;
                }
                if (NON_CATALOG_RE.test(nextText)) {
                    skippedNonCatalog = true;
                    break;
                }
                // Reject pure-punctuation fragments (`****`, `---`).
                if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{3,}/.test(nextText)) continue;
                nameLines.push(nextText);
                consumedLines.push(next);
                usedLines.add(j);
                break;
            }
        }

        // Forward absorption of the `Nuolaida N%` + `-N,NN EUR`
        // discount pair that follows a product's price. Captures the
        // discount EUR amount as promoPrice = price - discount so the
        // reconcile metric tracks what the customer actually paid
        // (receipt footer shows the net total, not gross).
        let promoPrice: number | null = null;
        for (let j = priceIdx + 1; j < Math.min(priceIdx + 5, nextPriceIdxFwd); j++) {
            if (usedLines.has(j)) continue;
            const next = lines[j];
            const nextText = next.text.trim();
            if (!nextText) continue;
            if (PRICE_RE.test(nextText)) break;
            if (WEIGHABLE_RE.test(nextText)) break;

            if (DISCOUNT_HEADER_RE.test(nextText)) {
                // Header line — absorb, then look for the `-N,NN EUR`
                // within the next couple of lines.
                usedLines.add(j);
                consumedLines.push(next);
                continue;
            }
            const eurMatch = nextText.match(DISCOUNT_EUR_RE);
            if (eurMatch) {
                const discount = parseNum(eurMatch[1]);
                promoPrice = Math.round((price - discount) * 100) / 100;
                usedLines.add(j);
                consumedLines.push(next);
                break;
            }
        }

        // Leading `*` on Norfa product names just means "discount
        // applied" (`*Dantu šepetėlis …`). Strip it — it's a marker,
        // not part of the name and not something the matcher should
        // see.
        // Head parts joined in walk-back order, then size-suffix tails
        // appended. Leading `*` (Norfa's "on sale" marker) stripped.
        const headName = nameLines.join(' ').replace(/^\s*\*+\s*/, '').trim();
        const tailName = sizeSuffixes.join(' ').trim();
        let name = [headName, tailName].filter(Boolean).join(' ').trim();
        rawLines.push(...nameLines, ...sizeSuffixes, priceText);

        if (skippedNonCatalog) continue;
        if (!name) continue;
        if (/^\d+[.,]?\d*$/.test(name)) continue;
        if (NON_CATALOG_RE.test(name)) continue;
        if (DEPOSIT_RE.test(name)) continue;

        products.push({
            name,
            price,
            promoPrice,
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

function parseFooter(lines: NorfaLine[]): NorfaFooter {
    let total: number | null = null;
    let date = '';
    let time = '';
    let receiptNo = '';
    let totalSavings: number | null = null;

    for (let i = 0; i < lines.length; i++) {
        const t = lines[i].text.trim();

        // `KVITO SUMA` followed (usually on the prev line in OCR
        // order) by `N,NN EUR`. Try both neighbours.
        if (/^kvito\s+suma/i.test(t)) {
            const neighbour = lines[i - 1]?.text ?? lines[i + 1]?.text ?? '';
            const m = neighbour.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
            if (m) total = parseNum(m[1]);
        }
        // `NUOLAIDA PREKIŲ SUMAI` — total discount across all items.
        if (/nuolaida\s+preki/i.test(t)) {
            const neighbour = lines[i - 1]?.text ?? lines[i + 1]?.text ?? '';
            const m = neighbour.match(/(\d+[.,]\s?\d{1,2})\s*EUR/i);
            if (m) totalSavings = parseNum(m[1]);
        }
        // Date/time block: `2026-01-07 15:29` (no label).
        const dtMatch = t.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})/);
        if (dtMatch) {
            date = dtMatch[1];
            time = dtMatch[2];
        }
        // Receipt number at footer tail — `67833` alone, or
        // `# Kvito numeris 67833 #` if we didn't catch it earlier.
        if (!receiptNo) {
            const rnMatch = t.match(/kvito\s+numeri\S*\s+(\d+)/i);
            if (rnMatch) receiptNo = rnMatch[1];
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

// ───────── public entry points ─────────

export function parseNorfaReceipt(lines: NorfaLine[]): NorfaParseResult {
    const headerEnd = findHeaderEnd(lines);
    const footerStart = findFooterStart(lines, headerEnd);

    return {
        header: parseHeader(lines.slice(0, headerEnd)),
        products: mergeNorfaDuplicates(parseProducts(lines.slice(headerEnd, footerStart))),
        footer: parseFooter(lines.slice(footerStart)),
    };
}

export function parseNorfaHeaderOnly(lines: NorfaLine[]): NorfaHeader {
    const headerEnd = findHeaderEnd(lines);
    return parseHeader(lines.slice(0, headerEnd));
}
