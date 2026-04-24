/**
 * Maxima Receipt Parser
 *
 * Mirrors the shape of rimiParser.ts (same Region/Product/Header/Footer
 * interfaces) so the receipt-process screen can branch on chain and reuse
 * the same downstream flow.
 *
 * Key format differences the parser has to handle:
 *  - Discount header is `AČIŪ nuolaida prekei:<name>` and the savings line
 *    `-X,XX A` comes on the next OCR row. OCR regularly corrupts the Ū
 *    diacritic, so we detect by `/nuolaida\s+prekei/i` instead of by word.
 *  - Discount header + savings are sometimes merged into a single OCR row.
 *  - The weighable indicator (`unit_price X weight kg`) comes *after* the
 *    product's price line — reversed vs Rimi — and stores the unit price
 *    on the left of the X, the weight on the right.
 *  - Name + price can also be merged into a single OCR row.
 *
 * Before line-by-line parsing, a preprocessing pass splits any merged
 * "<name-or-discount-text> <price>" lines into two pseudo-lines at the
 * same y-position, so the downstream logic can treat each field separately.
 */

export interface Region {
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

export interface MaximaLine {
  text: string;
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

export interface MaximaProduct {
  name: string;
  price: number;
  promoPrice: number | null;
  quantity: number;
  unit: string;
  pricePerUnit: number | null;
  rawLines: string[];
  region: Region;
}

export interface MaximaHeader {
  chainName: string;
  storeCode: string;
  storeAddress: string;
  pvmCode: string;
  rawText: string;
  region: Region;
}

export interface MaximaFooter {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
}

export interface MaximaParseResult {
  header: MaximaHeader;
  products: MaximaProduct[];
  footer: MaximaFooter;
}

// ───────── regexes ─────────

const PRICE_RE = /(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const STANDALONE_PRICE_RE = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const SAVINGS_RE = /^-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const INLINE_SAVINGS_RE = /-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
// Looser savings pattern — the trailing A/B letter is sometimes lost
// by OCR (seen `-0,50` instead of `-0,50 A`). Used only as a
// walking-back stop-condition, not for extracting the savings value
// (the strict form is kept for that to avoid false positives on
// price-like tokens elsewhere).
const SAVINGS_LOOSE_RE = /^-\s*\d+[.,]\s?\d{1,2}\s*[AB]?\s*$/;
// `unit_price X quantity unit` — unit price on left, quantity+unit on
// right. Covers both weighables (`1,59 X 0,430 kg`) and multi-pack
// (`1,59 X 2 maiŠ.`). Quantity decimal optional since pack counts are
// whole numbers.
//
// OCR tolerances folded in:
//   - unit: `kq` or `ka` for `kg` (q and a both commonly mistaken
//     for g on faded thermal prints)
//   - numbers: accept `O/o` for `0`, `l/I/L` for `1` — Maxima's
//     thermal-print kerning confuses MLKit on these letters. Without
//     this, a line like `11,99 X O,388 kq` wasn't recognised as a
//     unit line, so the walking-back loop glued two products' text
//     into the next product's name.
const DIGIT_OR_OCR = '[\\d0OoIlL]';
// `[.,]\\s?` inside each decimal group tolerates OCR stray whitespace
// between the comma and the digits (`1, 100` instead of `1,100` —
// seen on bananas' unit line). Without this the regex fails and the
// whole line flows backward into the next product's name.
const UNIT_LINE_RE = new RegExp(
  `(\\d+[.,]\\s?${DIGIT_OR_OCR}{1,2})\\s*[xX×]\\s*(${DIGIT_OR_OCR}+(?:[.,]\\s?${DIGIT_OR_OCR}{1,3})?)\\s*(k[gqa]|mai[sšŠ]\\.?|vnt\\.?|pak\\.?)`,
  'i'
);

/**
 * Map OCR's letter-digit confusions back to digits so parseNum can
 * handle captures from the relaxed regexes above.
 */
function sanitizeNumStr(s: string): string {
  return s.replace(/[Oo]/g, '0').replace(/[IlL]/g, '1');
}
// `3 vnt už 1,19 eur` — multi-buy bundle, the bundle discount is on another line
const MULTI_RE = /(\d+)\s*vnt\.?\s*u[zž]\s*(\d+[.,]\d{1,2})\s*eur/i;
// `3,59 X 2 <product-name>` — Maxima prefixes a multi-item purchase
// line with `unit_price X qty` and the product name follows on the
// same line. Unlike UNIT_LINE_RE this has no `kg`/`vnt`/`pak` suffix
// — the next token is the product-name letter. Without this, the
// qty/unit-price gets absorbed into the name and we lose the
// effective €7.18 for `3.59 × 2` (parser just sees the total).
const LEADING_QTY_PRICE_RE = /^(\d+[.,]\s?\d{1,2})\s*[xX×]\s*(\d+)\s+(?=[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž])/;
// Per-item discount header. Two variants live in the wild:
//   - `AČIŪ nuolaida prekei:<name>` — older "AČIŪ kortelė" loyalty line.
//   - `Sutaupėte: <name> [ -X,XX` — newer e-receipt format from Mano
//     Maxima. "Sutaupėte:" at receipt-body granularity means "you saved"
//     on this specific item; the whole-receipt total uses the same word
//     but lives in the footer region, already sliced off by
//     findFooterStart before parseProducts runs.
//
// OCR tolerance: MLKit frequently splits long Lithuanian compound
// words at arbitrary positions (seen `nuo laida`, `nuola idos`,
// `nuolai da`). `\s*` in the middle lets the regex still catch all
// of them. Without this, splitMergedLines doesn't split header+
// savings rows and parseProducts treats the whole blob as a product
// with the savings amount as its price.
// `sutaup[eė]t` with the ė alternative matters because `/i` flag only
// case-folds ASCII — raw OCR text keeps `Sutaupėte` with the Lithuanian
// ė, which doesn't equal `e` unless we include it explicitly or
// pre-normalize the string. Without this, splitMergedLines quietly
// fails to split `Sutaupėte:... -1,14 A` rows and parseProducts
// captures the whole header+savings blob as a phantom product.
const DISCOUNT_HEADER_RE = /(?:nuo\s*la\s*ida\s+prekei|sutaup[eė]t)/i;
// Deposit lines: `PET (depozitinis) 0,10 EUR 0,10` and `Skardinė
// (depozitinė) 0,10 EUR 0,10`. These are bottle/can deposits and
// don't represent catalog products. We treat them as their own rows
// so they don't smoosh into the next product, but drop them from the
// products array entirely since they have no StoreProduct counterpart.
// Deposit headers come in two gendered forms: `PET (depozitinis)` for
// plastic bottles (male -inis suffix) and `Skardinė (depozitinė)` for
// aluminium cans (female -inė). We accept both suffixes + both
// gender plurals (`depozitiniai` / `depozitinės`). Missing this
// caused burger-patty rows to absorb the PET deposit header as their
// name prefix.
const DEPOSIT_LINE_RE = /\b(?:pet|skardin[eė])\s*\(depozitin[eėi][sa]?[is]?\)/i;
// Checkout-only non-catalog items: disposable bags (maišelis) and
// reusable shopping bags (maišas — "Didelis pirkinių maišas MAXIMA").
// Charged per piece but not products a shopper "buys" in the price-
// comparison sense. Treated like deposits — stop walk-back on them
// and skip them if they end up as a row's name.
const NON_CATALOG_LINE_RE = /\b(?:vienkartinis|didelis|pirkini[uų])?\s*(?:plastikinis|popierinis)?\s*mai[sš](?:elis|as)\b/i;

// ───────── helpers ─────────

function parseNum(str: string): number {
  return parseFloat(sanitizeNumStr(str).replace(",", ".").replace(/\s/g, ""));
}

function regionOf(lines: MaximaLine[]): Region {
  if (lines.length === 0) return { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
  return {
    yTop: Math.min(...lines.map((l) => l.yTop)),
    yBottom: Math.max(...lines.map((l) => l.yBottom)),
    xLeft: Math.min(...lines.map((l) => l.xLeft)),
    xRight: Math.max(...lines.map((l) => l.xRight)),
  };
}

// ───────── detection ─────────

export function isMaximaReceipt(lines: string[]): boolean {
  const head = lines.slice(0, 15).join(" ").toUpperCase();
  return head.includes("MAXIMA");
}

// ───────── preprocessing ─────────

/**
 * Split OCR rows that have a price trailing at the end into two pseudo-lines
 * so downstream parsing sees name/discount and price/savings separately.
 */
function splitMergedLines(lines: MaximaLine[]): MaximaLine[] {
  const out: MaximaLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    // Already standalone price or savings — keep as is.
    if (STANDALONE_PRICE_RE.test(text) || SAVINGS_RE.test(text)) {
      out.push(line);
      continue;
    }

    const priceMatch = text.match(PRICE_RE);
    const savingsMatch = text.match(INLINE_SAVINGS_RE);

    // Inline discount: "AČIŪ nuolaida prekei:<name> -X,XX A"
    if (DISCOUNT_HEADER_RE.test(text) && savingsMatch) {
      const savingsStart = text.lastIndexOf(savingsMatch[0]);
      const left = text.slice(0, savingsStart).trim();
      const right = text.slice(savingsStart).trim();
      out.push({ ...line, text: left });
      out.push({ ...line, text: right });
      continue;
    }

    // Merged product line: "<name> X,XX A"
    if (priceMatch && !DISCOUNT_HEADER_RE.test(text)) {
      const priceStart = text.lastIndexOf(priceMatch[0]);
      const left = text.slice(0, priceStart).trim();
      const right = text.slice(priceStart).trim();
      if (left.length > 0) {
        out.push({ ...line, text: left });
        out.push({ ...line, text: right });
        continue;
      }
    }

    out.push(line);
  }
  return out;
}

// ───────── section boundaries ─────────

/**
 * Strip combining diacritics so `bazėje`, `bazèje`, `bazéje` etc. all
 * collapse to `bazeje` for pattern matching. Without this, one OCR run
 * misspelling ė as è leaks the whole header block into parseProducts
 * and the first header line becomes the product name (seen on
 * kvitas_2026-02-23: `Kvitas bazèje: 93/363` captured as product #1).
 */
const stripDiacritics = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function findHeaderEnd(lines: MaximaLine[]): number {
  // Products start after `Kvitas bazėje:` or at the first standalone price.
  for (let i = 0; i < Math.min(lines.length, 25); i++) {
    if (/kvitas\s+bazeje/.test(stripDiacritics(lines[i].text))) return i + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    if (STANDALONE_PRICE_RE.test(lines[i].text.trim())) {
      return Math.max(0, i - 1);
    }
  }
  return Math.min(7, lines.length);
}

function findFooterStart(lines: MaximaLine[], afterIdx: number): number {
  for (let i = afterIdx; i < lines.length; i++) {
    const text = lines[i].text;
    if (/suteiktos\s+naudos/i.test(text)) return i;
    if (/^A[ČCČ][IÍ][ŪÜŪÖU]\s+nuolaidos/i.test(text)) return i;
    if (/^Kvito\s+suma/i.test(text)) return i;
    if (/^f1Mok[eėé]tina/i.test(text)) return i;
    if (/^Mok[eė]tina\s+suma/i.test(text)) return i;
    if (/^={10,}/.test(text)) return i; // separator lines near the footer
  }
  return lines.length;
}

// ───────── header ─────────

function parseHeader(lines: MaximaLine[]): MaximaHeader {
  let storeCode = "";
  let storeAddress = "";
  let pvmCode = "";

  for (const line of lines) {
    const text = line.text.trim();

    const pvmMatch = text.match(/(LT|LV|EE)\d{9,12}/);
    if (pvmMatch) pvmCode = pvmMatch[0];

    // Address lines typically contain `g.`, `pr.`, `al.`, `pl.` and `Kasa` or a comma+city.
    if (
      !storeAddress &&
      /\b(g|pr|al|pl)\.\s/i.test(text) &&
      !/UAB|MAXIMA|PVM/i.test(text)
    ) {
      // Strip trailing "Kasa Nr. N" — it's a cashier counter, not part of the
      // address, and leaving it in the string tanks the Levenshtein ratio
      // against a clean DB address and breaks the store match.
      storeAddress = text.replace(/,?\s*Kasa\s+Nr\.?\s*\d+.*$/i, "").trim();
    }

    // Occasional "X-NNN MAXIMA" legacy store code — used only as a display label
    // since store matching is done via address.
    const codeMatch = text.match(/\b([A-Z]-\d{3,4})\s+MAXIMA\b/i);
    if (codeMatch) storeCode = codeMatch[1].toUpperCase();
  }

  return {
    chainName: "MAXIMA",
    storeCode,
    storeAddress,
    pvmCode,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

// ───────── products ─────────

function parseProducts(lines: MaximaLine[]): MaximaProduct[] {
  const products: MaximaProduct[] = [];

  // Collect indices of standalone (non-savings) price lines — these anchor
  // each product. Savings lines (-X,XX A) are handled separately.
  const priceIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (STANDALONE_PRICE_RE.test(t) && !SAVINGS_RE.test(t)) {
      priceIndices.push(i);
    }
  }

  const usedLines = new Set<number>();

  for (let pi = 0; pi < priceIndices.length; pi++) {
    const priceIdx = priceIndices[pi];
    const priceLine = lines[priceIdx];
    const priceText = priceLine.text.trim();
    const priceMatch = priceText.match(STANDALONE_PRICE_RE)!;
    let price = parseNum(priceMatch[1]);

    if (usedLines.has(priceIdx)) continue;
    usedLines.add(priceIdx);

    const consumedLines: MaximaLine[] = [priceLine];
    const rawLines: string[] = [];

    let quantity = 1;
    let unit = "vnt";
    let pricePerUnit: number | null = null;
    let promoPrice: number | null = null;

    const prevPriceIdx = pi > 0 ? priceIndices[pi - 1] : -1;

    // Look backward for name lines.
    const nameLines: string[] = [];
    // When the backward walk breaks because the preceding line is a
    // deposit/bag row (the current price belongs to that non-catalog
    // row), we must NOT trigger the forward-walk fallback — doing so
    // would grab whatever junk sits after the price (a separator like
    // `=========`, a trailing `Suteiktos naudos` header, etc.) and
    // promote it into a phantom product.
    let skippedNonCatalog = false;
    let lookback = priceIdx - 1;
    while (lookback > prevPriceIdx && nameLines.length < 4) {
      const prev = lines[lookback];
      const prevText = prev.text.trim();

      if (!prevText || usedLines.has(lookback)) {
        lookback--;
        continue;
      }
      if (STANDALONE_PRICE_RE.test(prevText)) break;
      // Discount header or savings line belong to the PREVIOUS product, not this one.
      if (DISCOUNT_HEADER_RE.test(prevText) || SAVINGS_RE.test(prevText)) break;
      // Bare savings fragment `-0,50` without trailing A/B — OCR drops
      // the letter on some thermal prints. Same semantics as SAVINGS_RE
      // for walk-back purposes: stop, don't absorb.
      if (SAVINGS_LOOSE_RE.test(prevText)) break;
      // Unit/weight line salvage: if the pattern appears WITHIN a
      // bigger OCR line (not at the start), that means the line is
      // actually a previous-product-unit + this-product-name smoosh.
      // Keep the text AFTER the unit match as a recovered name
      // fragment, then stop walking — everything before belongs to
      // the previous product.
      const unitMatchInside = prevText.match(UNIT_LINE_RE);
      if (unitMatchInside) {
        const matchEnd = (unitMatchInside.index ?? 0) + unitMatchInside[0].length;
        const afterUnit = prevText.slice(matchEnd).trim();
        if (afterUnit && matchEnd < prevText.length) {
          nameLines.unshift(afterUnit);
          consumedLines.push(prev);
          usedLines.add(lookback);
        }
        break;
      }
      // Deposit lines (PET/Skardinė (depozitinė)) are their own items —
      // don't let them get glued onto the next product's name.
      if (DEPOSIT_LINE_RE.test(prevText)) {
        skippedNonCatalog = true;
        break;
      }
      // Same deal for checkout-only plastic/paper bags.
      if (NON_CATALOG_LINE_RE.test(prevText)) {
        skippedNonCatalog = true;
        break;
      }
      // Bare `N,NN` companion line to a deposit header (seen: `0,10`
      // at y=294 after `PET (depozitinis) 0,10 EUR` at y=293 —
      // deposit-total-value line). Same class: not product name, not
      // unit, not discount. Only break when the immediately preceding
      // line is a deposit header so we don't over-eager-break on a
      // real `0,99 A` style scrap elsewhere.
      if (/^\d+[.,]\s?\d{1,2}$/.test(prevText)) {
        const twoAbove = lookback > 0 ? lines[lookback - 1].text.trim() : '';
        if (DEPOSIT_LINE_RE.test(twoAbove)) break;
      }

      nameLines.unshift(prevText);
      consumedLines.push(prev);
      usedLines.add(lookback);
      lookback--;
    }

    // Fallback: forward walk when backward walk yielded no name.
    // Happens on receipts where MLKit emits price ABOVE name in y-
    // order (price in right column, name in left — same visual row
    // but the right-column block sorts first). Without this the
    // single-product receipt surfaces as "0 products parsed".
    //
    // Skip the fallback when walk-back intentionally broke on a
    // deposit/bag row: the current price belongs to that row and the
    // right move is to skip this product entirely, not rescue a name
    // from whatever text happens to sit after the price.
    if (nameLines.length === 0 && !skippedNonCatalog) {
        const nextPriceIdxFwd =
            pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;
        for (let j = priceIdx + 1; j < Math.min(priceIdx + 4, nextPriceIdxFwd); j++) {
            if (usedLines.has(j)) continue;
            const next = lines[j];
            const nextText = next.text.trim();
            if (!nextText) continue;
            if (STANDALONE_PRICE_RE.test(nextText)) break;
            if (SAVINGS_RE.test(nextText)) break;
            if (SAVINGS_LOOSE_RE.test(nextText)) break;
            if (DISCOUNT_HEADER_RE.test(nextText)) break;
            // Defensive: refuse pure non-alphabetic fragments
            // (`=========`, `--`, `## 00 ##`). A real product name
            // always has at least a few consecutive Lithuanian/Latin
            // letters. Without this the first separator after a
            // skipped bag row gets promoted to a phantom product.
            if (!/[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{3,}/.test(nextText)) continue;
            // Treat the text as name only if it doesn't LOOK like a
            // unit/deposit line — those are metadata we don't want in
            // the product name.
            if (UNIT_LINE_RE.test(nextText)) continue;
            if (DEPOSIT_LINE_RE.test(nextText)) continue;
            nameLines.push(nextText);
            consumedLines.push(next);
            usedLines.add(j);
            break; // one-line name is enough for single-row products
        }
    }

    let name = nameLines.join(" ").trim();
    rawLines.push(...nameLines);
    rawLines.push(priceText);

    // Skip non-product artefacts occasionally captured as prices.
    if (!name) continue;
    if (/^\d+[.,]?\d*$/.test(name)) continue;
    // Deposit rows (PET/Skardinė at €0.10) aren't catalog products
    // — the resolver has no StoreProduct for "bottle deposit" and
    // trying to match against a chain yields garbage. Drop entirely.
    if (DEPOSIT_LINE_RE.test(name)) continue;
    // Same for checkout-only bag charges.
    if (NON_CATALOG_LINE_RE.test(name)) continue;

    // `3,59 X 2 <product>` multi-buy prefix embedded in the name.
    // Extract qty + unit price and strip the prefix so the name is
    // clean for matching. Only applied when we haven't already pulled
    // a quantity from a trailing UNIT_LINE_RE row, to avoid
    // double-counting.
    const leadMatch = name.match(LEADING_QTY_PRICE_RE);
    if (leadMatch && pricePerUnit === null && quantity === 1) {
        pricePerUnit = parseNum(leadMatch[1]);
        quantity = parseInt(leadMatch[2], 10);
        name = name.replace(LEADING_QTY_PRICE_RE, '').trim();
    }

    // Look FORWARD for weight indicator and discount pair.
    const nextPriceIdx =
      pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;

    for (let j = priceIdx + 1; j < Math.min(priceIdx + 5, nextPriceIdx); j++) {
      if (usedLines.has(j)) continue;
      const next = lines[j];
      const nextText = next.text.trim();
      if (!nextText) continue;

      const unitMatch = nextText.match(UNIT_LINE_RE);
      if (unitMatch) {
        pricePerUnit = parseNum(unitMatch[1]);
        quantity = parseNum(unitMatch[2]);
        const rawUnit = unitMatch[3].toLowerCase().replace(/\./g, "");
        // Normalize pack/bag/piece to vnt; kg stays kg.
        // `kg`, `kq`, `ka` all mean kg — UNIT_LINE_RE's `k[gqa]` class
        // accepts the OCR variants; the downstream normalizer has to
        // collapse them back, otherwise a weighable row reports as
        // `vnt` (seen on paprika with `3,99 X 0,514 ka`).
        unit = /^k[gqa]$/.test(rawUnit) ? "kg" : "vnt";
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        continue;
      }

      // Discount header — expect a savings line right after (or already on
      // this line if preprocessing caught it). Checked BEFORE the standalone
      // multi-buy regex because Maxima often inlines multi-buy info inside
      // the discount header ("AČIŪ nuolaida prekei:Sūrelis MAGIJA; 3 vnt už
      // 1,19 eur") — if MULTI_RE ran first it would swallow the header and
      // the -0,XX savings row would be orphaned.
      if (DISCOUNT_HEADER_RE.test(nextText)) {
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        // Look at the immediately following line for the savings amount.
        for (let k = j + 1; k < Math.min(j + 3, nextPriceIdx); k++) {
          if (usedLines.has(k)) continue;
          const savText = lines[k].text.trim();
          if (!savText) continue;
          const savMatch = savText.match(SAVINGS_RE);
          if (savMatch) {
            const savings = parseNum(savMatch[1]);
            // promoPrice is the per-line effective price = price - savings.
            // For weighable items, price and savings are both totals, so this
            // still holds. We'll normalize to per-unit below if weighable.
            promoPrice = Math.round((price - savings) * 100) / 100;
            rawLines.push(savText);
            consumedLines.push(lines[k]);
            usedLines.add(k);
            break;
          }
          // If the "next" line isn't savings, stop looking.
          break;
        }
        continue;
      }

      // Standalone multi-buy indicator (no discount header) — informational
      // only; quantity stays 1 and the bundle effect reports via a separate
      // savings row handled above.
      const multiMatch = nextText.match(MULTI_RE);
      if (multiMatch) {
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        continue;
      }

      // Anything else — stop looking forward for this product.
      break;
    }

    // For weighable items, normalize to per-unit pricing for DB consistency
    // (matches what rimiParser does).
    if (pricePerUnit !== null) {
      price = pricePerUnit;
      if (promoPrice !== null && quantity > 0) {
        promoPrice = Math.round((promoPrice / quantity) * 100) / 100;
      }
    }

    name = cleanProductName(name);
    if (!name) continue;

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

function cleanProductName(name: string): string {
  let cleaned = name;
  cleaned = cleaned.replace(/,?\s*\d+[\.,]?\d*\s*(g|kg|ml|l|vnt\.?)\s*$/i, "").trim();
  cleaned = cleaned.replace(/,\s*$/, "").trim();
  return cleaned;
}

// ───────── footer ─────────

function parseFooter(lines: MaximaLine[]): MaximaFooter {
  let total: number | null = null;
  let date = "";
  let time = "";
  let receiptNo = "";
  let totalSavings: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();

    // Kvito suma 71,44  — same line or on the next.
    const sumaMatch = text.match(/Kvito\s+suma\s+(\d+[.,]\s?\d{2})/i);
    if (sumaMatch) total = parseNum(sumaMatch[1]);
    if (/^Kvito\s+suma\s*$/i.test(text) && i + 1 < lines.length) {
      const m = lines[i + 1].text.trim().match(/(\d+[.,]\s?\d{2})/);
      if (m) total = parseNum(m[1]);
    }

    // Fallback: `Mokėtina suma 71,44` or `f1Mokėtina suma 71,44`.
    if (total === null) {
      const mok = text.match(/Mok[eė]tina\s+suma\s+(\d+[.,]\s?\d{2})/i);
      if (mok) total = parseNum(mok[1]);
    }

    // Receipt datetime. Maxima prints this several ways depending on
    // the POS template + OCR noise:
    //   `Data ir laikas 2026-04-04 14:49:30`       (canonical)
    //   `LAIKAS 2026-04-04 18:15:30`               (shorter template)
    //   `2026-04-15 18:15:30 LAIKAS`               (OCR reversed order)
    //   `2026-04-24 12:44:55 +****5775`            (bare, on the card row)
    //
    // Match broadly: any `YYYY-MM-DD HH:MM:SS` tuple on a line that
    // also mentions `LAIKAS` / `Data ir laikas`, OR — as a fallback
    // when the label is missing — take the FIRST bare timestamp in
    // the footer. Prefer the labelled form if both exist (LAIKAS line
    // is the transaction time; bare timestamps may be receipt-check
    // stamps that differ by seconds-to-days).
    const labelledDt = text.match(
      /(?:LAIKAS|Data\s+ir\s+laikas)[^\d]*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/i,
    );
    const reversedDt = text.match(
      /(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(?:LAIKAS|Data\s+ir\s+laikas)/i,
    );
    const bareDt = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    // Priority: labelled → reversed-labelled → bare (only if nothing else found).
    if (labelledDt) {
      date = labelledDt[1];
      time = labelledDt[2];
    } else if (reversedDt) {
      date = reversedDt[1];
      time = reversedDt[2];
    } else if (!date && bareDt) {
      date = bareDt[1];
      time = bareDt[2];
    }

    // Kvito Nr. 363753  — single number, possibly followed by more tokens.
    const nrMatch = text.match(/Kvito\s+Nr\.?\s+(\S+)/i);
    if (nrMatch && !receiptNo) receiptNo = nrMatch[1];

    // Sutaupėte 13,40
    if (/sutaup[eėè]te/i.test(text)) {
      const s = text.match(/(\d+[.,]\s?\d{2})/);
      if (s) totalSavings = parseNum(s[1]);
      else if (i + 1 < lines.length) {
        const ns = lines[i + 1].text.trim().match(/(\d+[.,]\s?\d{2})/);
        if (ns) totalSavings = parseNum(ns[1]);
      }
    }
  }

  return {
    total,
    date,
    time,
    receiptNo,
    totalSavings,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

// ───────── public entry points ─────────

export function parseMaximaReceipt(lines: MaximaLine[]): MaximaParseResult {
  const processed = splitMergedLines(lines);
  const headerEnd = findHeaderEnd(processed);
  const footerStart = findFooterStart(processed, headerEnd);

  return {
    header: parseHeader(processed.slice(0, headerEnd)),
    products: parseProducts(processed.slice(headerEnd, footerStart)),
    footer: parseFooter(processed.slice(footerStart)),
  };
}

export function parseMaximaHeaderOnly(lines: MaximaLine[]): MaximaHeader {
  const processed = splitMergedLines(lines);
  const headerEnd = findHeaderEnd(processed);
  return parseHeader(processed.slice(0, headerEnd));
}
