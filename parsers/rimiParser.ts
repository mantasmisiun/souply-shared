/**
 * Rimi Receipt Parser v3
 *
 * Based on actual MLKit OCR output from Rimi receipts.
 * Carries pixel regions through parsing so the UI can crop the source
 * image to show the user which part of the receipt each field came from.
 */

export interface Region {
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
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
}

export interface RimiFooter {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
}

export interface RimiParseResult {
  header: RimiHeader;
  products: RimiProduct[];
  footer: RimiFooter;
}

function parseNum(str: string): number {
  return parseFloat(str.replace(",", ".").replace(/\s/g, ""));
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

export function isRimiReceipt(lines: string[]): boolean {
  const first15 = lines.slice(0, 15).join(" ").toUpperCase();
  return first15.includes("RIMI");
}

const PRICE_PATTERN = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const WEIGHT_PATTERN =
  /(\d+[.,]\s?\d{1,3})\s*kg\s*[xX×]\s*(\d+[.,]\s?\d{1,2})\s*(EUR|€)/i;
// The OCR sometimes produces `Galut,` (comma) instead of `Galut.`, and
// stuffs a space inside decimals like `1, 10`. Tolerating both prevents the
// next product's lookback from swallowing this discount row as a name line.
const DISCOUNT_PATTERN =
  /Nuo[li]\s*\.?\s*-(\d+[.,]\s?\d{2})\s+Gal[uūü]t\s*[.,]?\s*k?aina\s*(\d+[.,]\s?\d{2})/i;
const MULTI_PATTERN = /(\d+)\s*vnt\s*\.?\s*[xX×]\s*(\d+[.,]\s?\d{1,2})\s*(EUR)?/i;
const DEPOSIT_PATTERN = /[uūü]žstat/i;
// Checkout-only non-catalog items: disposable bags (maišelis) and
// reusable shopping bags (maišas). Charged per piece but not
// something shoppers compare prices on.
const NON_CATALOG_PATTERN = /\b(?:vienkartinis|didelis|pirkini[uų])?\s*(?:plastikinis|popierinis)?\s*mai[sš](?:elis|as)\b/i;

export function parseRimiReceipt(lines: RimiLine[]): RimiParseResult {
  const headerEndIdx = findHeaderEnd(lines);
  const footerStartIdx = findFooterStart(lines, headerEndIdx);

  return {
    header: parseHeader(lines.slice(0, headerEndIdx)),
    products: parseProducts(lines.slice(headerEndIdx, footerStartIdx)),
    footer: parseFooter(lines.slice(footerStartIdx)),
  };
}

export function parseRimiHeaderOnly(lines: RimiLine[]): RimiHeader {
  const headerEndIdx = findHeaderEnd(lines);
  return parseHeader(lines.slice(0, headerEndIdx));
}

function findHeaderEnd(lines: RimiLine[]): number {
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const text = lines[i].text.toUpperCase();
    if (/PIRK[EĖÈE]JAS/i.test(text)) {
      return i + 1;
    }
  }
  for (let i = 0; i < lines.length; i++) {
    if (PRICE_PATTERN.test(lines[i].text.trim())) {
      return Math.max(0, i - 2);
    }
  }
  return Math.min(8, lines.length);
}

function findFooterStart(lines: RimiLine[], afterIdx: number): number {
  for (let i = afterIdx; i < lines.length; i++) {
    const upper = lines[i].text.toUpperCase().replace(/\s+/g, "");
    if (
      upper.includes("SUTEIKTOSNUOLAI") ||
      upper.includes("SUTEIKTOSNUOLAIDOS")
    )
      return i;
    if (/J[UŪÜÚ]SSUTAUP/.test(upper)) return i;
    if (/^MOK[ĖEÈ]JIMAS/i.test(lines[i].text.trim())) return i;
  }
  return lines.length;
}

function parseHeader(lines: RimiLine[]): RimiHeader {
  let storeCode = "";
  let storeAddress = "";
  let pvmCode = "";

  for (const line of lines) {
    const text = line.text.trim();
    const codeMatch = text.match(/\bT(\d{3,4})\b/);
    if (codeMatch && /RIMI|LIETUVA/i.test(text)) storeCode = "T" + codeMatch[1];

    const pvmMatch = text.match(/(LT|IT)\d{9,12}/);
    if (pvmMatch) pvmCode = pvmMatch[0];

    if (
      /\b(g|pr|al|pl|a)\.\s/i.test(text) &&
      !/UAB|RIMI|PVM|PIRK/i.test(text)
    ) {
      storeAddress = text;
    }
  }

  return {
    chainName: "RIMI",
    storeCode,
    storeAddress,
    pvmCode,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

function parseProducts(lines: RimiLine[]): RimiProduct[] {
  const products: RimiProduct[] = [];

  const priceIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (PRICE_PATTERN.test(lines[i].text.trim())) {
      priceIndices.push(i);
    }
  }

  const usedLines = new Set<number>();

  for (let pi = 0; pi < priceIndices.length; pi++) {
    const priceIdx = priceIndices[pi];
    const priceLine = lines[priceIdx];
    const priceText = priceLine.text.trim();
    const priceMatch = priceText.match(PRICE_PATTERN)!;
    let price = parseNum(priceMatch[1]);
    const rawLines: string[] = [];
    const consumedLines: RimiLine[] = [priceLine];

    usedLines.add(priceIdx);

    let quantity = 1;
    let unit = "vnt";
    let pricePerUnit: number | null = null;
    let promoPrice: number | null = null;

    const prevPriceIdx = pi > 0 ? priceIndices[pi - 1] : -1;

    const nameLines: string[] = [];
    let lookback = priceIdx - 1;

    while (lookback > prevPriceIdx && nameLines.length < 4) {
      const prev = lines[lookback];
      const prevText = prev.text.trim();

      if (!prevText || usedLines.has(lookback)) {
        lookback--;
        continue;
      }
      if (PRICE_PATTERN.test(prevText)) break;
      if (DISCOUNT_PATTERN.test(prevText)) {
        lookback--;
        continue;
      }

      const weightMatch = prevText.match(WEIGHT_PATTERN);
      if (weightMatch) {
        quantity = parseNum(weightMatch[1]);
        pricePerUnit = parseNum(weightMatch[2]);
        unit = "kg";
        rawLines.push(prevText);
        consumedLines.push(prev);
        usedLines.add(lookback);
        lookback--;
        continue;
      }

      const multiMatch = prevText.match(MULTI_PATTERN);
      if (multiMatch) {
        quantity = parseInt(multiMatch[1]);
        pricePerUnit = parseNum(multiMatch[2]);
        unit = "vnt";
        rawLines.push(prevText);
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

    let name = nameLines.join(" ").trim();
    rawLines.unshift(...nameLines);
    rawLines.push(priceText);

    if (DEPOSIT_PATTERN.test(name)) continue;
    if (NON_CATALOG_PATTERN.test(name)) continue;
    if (/^\d+[.,]?\d*$/.test(name)) continue;

    // Look forward for discount
    const nextPriceIdx =
      pi + 1 < priceIndices.length ? priceIndices[pi + 1] : lines.length;

    for (let j = priceIdx + 1; j < Math.min(priceIdx + 3, nextPriceIdx); j++) {
      const next = lines[j];
      const nextText = next.text.trim();
      if (usedLines.has(j)) continue;

      const discountMatch = nextText.match(DISCOUNT_PATTERN);
      if (discountMatch) {
        promoPrice = parseNum(discountMatch[2]);
        rawLines.push(nextText);
        consumedLines.push(next);
        usedLines.add(j);
        continue;
      }
    }

    // Use per-unit pricing when we have a unit-price indicator (multi-buy or weighable).
    // The receipt shows totals, but we normalize everything to per-unit for DB consistency.
    if (pricePerUnit !== null) {
      price = pricePerUnit;
      if (promoPrice !== null && quantity > 0) {
        promoPrice = Math.round((promoPrice / quantity) * 100) / 100;
      }
    }

    name = cleanProductName(name);

    if (name) {
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
  }

  return products;
}

/**
 * Strip "previous-item residue" from the start of a product name.
 *
 * When a per-item discount row (`Nuol. -X,XX Galut. kaina Y,YY`) OCRs
 * onto the same line as the next product's name, the walking-back
 * logic lumps it all into the name. Same happens with the Mano Rimi
 * loyalty-card masked PAN (`XXXXXXXXXXXXXXX9631`) at the very start
 * of the receipt body.
 *
 * Strategy: find the last occurrence of a discount marker and cut
 * everything up through it — the product name starts right after.
 * Leaves names without any marker untouched. Tolerates both orders
 * (`Nuol` before `Galut` and vice versa) and OCR substitutions like
 * `l` for `1` in prices (`Galut. kaina l,43`).
 */
function stripLeadingDiscountNoise(name: string): string {
    let s = name;
    // Loyalty-card mask. Tolerances:
    //   - Leading `K` when OCR reads the first X as K (`KXXXXX0767`)
    //   - Only 4+ X's needed (seen `XXXX963 1` — OCR dropped some)
    //   - Digits may include `O`/`I` letter confusions
    // Followed by optional stray digit group.
    s = s.replace(/^[KX][KXжk]{3,}\s*[\dOIl]{0,8}(?:\s+\d)?\s*/i, '');
    // Last discount marker's end = beginning of real product name.
    const markerRe = /(Nuol\s*\.?\s*-?\s*\d+[.,]\s?\d+|Gal[uūü]t\s*\.?\s*k?aina\s*[\dl][.,]\s?\d+)/gi;
    let lastEnd = -1;
    let m: RegExpExecArray | null;
    while ((m = markerRe.exec(s)) !== null) {
        lastEnd = m.index + m[0].length;
    }
    if (lastEnd > 0) s = s.slice(lastEnd);
    return s.trim();
}

function cleanProductName(name: string): string {
  let cleaned = stripLeadingDiscountNoise(name);
  cleaned = cleaned
    .replace(/,?\s*\d+[\.,]?\d*\s*(g|kg|ml|l|vnt\.?|rit\.?)\s*$/i, "")
    .trim();
  cleaned = cleaned.replace(/\s+\d+(kg|g|ml|l)\s*$/i, "").trim();
  cleaned = cleaned.replace(/,\s*$/, "").trim();
  return cleaned;
}

function parseFooter(lines: RimiLine[]): RimiFooter {
  let total: number | null = null;
  let date = "";
  let time = "";
  let receiptNo = "";
  let totalSavings: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text.trim();

    // OCR sometimes reads `1` as `l` (lowercase L) or `I`, so "Mokėti 16,89"
    // comes through as "Mokėti l6,89". Tolerate those in the amount capture.
    const moketiMatch = text.match(/Mok[eėèé]ti\s+([lI\d]+)[.,\s]+(\d{2})/i);
    if (moketiMatch) {
      const intStr = moketiMatch[1].replace(/[lI]/gi, "1");
      const intVal = parseInt(intStr, 10);
      if (!isNaN(intVal)) total = parseFloat(intVal + "." + moketiMatch[2]);
    }

    if (/^Mok[eėèé]ti$/i.test(text) && i + 1 < lines.length) {
      const m = lines[i + 1].text.trim().match(/([lI\d]+)[.,\s]+(\d{2})/);
      if (m) {
        const intStr = m[1].replace(/[lI]/gi, "1");
        const intVal = parseInt(intStr, 10);
        if (!isNaN(intVal)) total = parseFloat(intVal + "." + m[2]);
      }
    }

    // Date/time can appear either before or after the "LAIKAS" word; the
    // common pattern is `YYYY-MM-DD HH:MM:SS LAIKAS`. Match the date/time
    // pattern directly — any line that contains it counts.
    if (!date) {
      const dt = text.match(
        /(\d{4}-\d{2}-\d{2})\s+(\d{2}\s?:\s?\d{2}\s?:\s?\d{2})/,
      );
      if (dt) {
        date = dt[1];
        time = dt[2].replace(/\s/g, "");
      }
    }

    const nrMatch = text.match(/Kvito\s+Nr\.?\s*(.+)/i);
    if (nrMatch) {
      // Strip trailing "Kasa NNNN" cashier counter — it's not part of the
      // receipt number, and leaving it in bloats the stored value.
      receiptNo = nrMatch[1]
        .replace(/\s*Kasa\s+\d+.*$/i, "")
        .replace(/\s+/g, "")
        .trim();
    }

    const numMatch = text.match(/Kvito\s+numeris\s+(\d+)/i);
    if (numMatch && !receiptNo) receiptNo = numMatch[1];

    if (/sutaup[eėèé]te/i.test(text)) {
      const s = text.match(/(\d+[.,]\d{2})/);
      if (s) totalSavings = parseNum(s[1]);
      else if (i + 1 < lines.length) {
        const ns = lines[i + 1].text.trim().match(/(\d+[.,]\d{2})/);
        if (ns) totalSavings = parseNum(ns[1]);
      }
    }
  }
  console.log('=== PARSEFOOTER RESULT ===');
    console.log('total:', total, 'date:', date, 'receiptNo:', receiptNo);
    console.log('Lines containing "okėti":');
    lines.forEach((l, i) => {
        if (/ok[eėèé]ti/i.test(l.text)) console.log(`  [${i}] "${l.text}"`);
    });
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
