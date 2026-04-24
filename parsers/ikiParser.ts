/**
 * IKI Receipt Parser
 *
 * Targets the IKI mobile app's digital-receipt screenshot. IKI doesn't let
 * users download receipts, so shoppers screenshot the in-app receipt view
 * and upload those images. This differs from a printed register receipt:
 *  - Each product is a 4-column table: `VNT. KAINA | VNT. | NUOLAIDA | SUMA`
 *  - The receipt number is not shown in the app view, so footer.receiptNo
 *    stays empty — no reliable anchor to extract.
 *  - Date/time is in the HEADER (`YYYY MM DD  HH:MM`), not the footer.
 *  - Product names are preceded by `$` to mark sale items (stripped when
 *    cleaning so the name matches DB entries).
 *
 * Expected layout per product:
 *     <name line(s)>
 *     VNT. KAINA  VNT.   NUOLAIDA  SUMA    <-- header row
 *     <price> €  <qty>   <discount> €  <total> €
 *
 * Footer layout:
 *     VISO
 *     Pirkinių suma: X,XX €     (subtotal before rounding)
 *     Apvalinimo suma: X,XX €   (rounding correction)
 *     Mokėta suma: X,XX €       (total paid — this is our `total`)
 *     Sutaupyta: X,XX €         (total savings)
 *
 * A long IKI receipt won't fit in one screenshot; the existing multi-page
 * OCR path (one image per page, yOffset-accumulated) handles stitched
 * screenshot stacks the same way it handles PDF pages.
 */

export interface Region {
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

export interface IkiLine {
  text: string;
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
}

export interface IkiProduct {
  name: string;
  price: number;
  promoPrice: number | null;
  quantity: number;
  unit: string;
  pricePerUnit: number | null;
  rawLines: string[];
  region: Region;
}

export interface IkiHeader {
  chainName: string;
  storeCode: string;
  storeName: string;
  storeAddress: string;
  pvmCode: string;
  rawText: string;
  region: Region;
}

export interface IkiFooter {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
}

export interface IkiParseResult {
  header: IkiHeader;
  products: IkiProduct[];
  footer: IkiFooter;
}

// ───────── regexes ─────────

// Column-header detector — order-agnostic. MLKit merges same-row text from
// different blocks, and the within-row order it produces varies per receipt
// (observed both `VNT. KAINA VNT. NUOLAIDA SUMA` and the reverse). So the
// detector just requires all four labels to be present on the line.
function isColumnHeader(text: string): boolean {
  return (
    /VNT/i.test(text) &&
    /KAINA/i.test(text) &&
    /NUOLAIDA/i.test(text) &&
    /SUMA/i.test(text)
  );
}
const DATE_ONLY_RE = /(\d{4})\s+(\d{2})\s+(\d{2})/;
const TIME_ONLY_RE = /\b(\d{2}):\s?(\d{2})\b/;
const STORE_HEADER_RE = /^\s*IKI\s*[-–—]\s*(.+)$/i;
const PIRKINIU_RE = /Pirkini[uųy]\s+suma:?\s*(\d+[.,]\s?\d{2})/i;
const MOKETA_RE = /Mok[eė]ta\s+suma:?\s*(\d+[.,]\s?\d{2})/i;
const SUTAUPYTA_RE = /Sutaup[yį]ta:?\s*(\d+[.,]\s?\d{2})/i;

// ───────── helpers ─────────

function parseNum(str: string): number {
  return parseFloat(str.replace(",", ".").replace(/\s/g, ""));
}

function regionOf(lines: IkiLine[]): Region {
  if (lines.length === 0) return { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };
  return {
    yTop: Math.min(...lines.map((l) => l.yTop)),
    yBottom: Math.max(...lines.map((l) => l.yBottom)),
    xLeft: Math.min(...lines.map((l) => l.xLeft)),
    xRight: Math.max(...lines.map((l) => l.xRight)),
  };
}

function cleanProductName(name: string): string {
  return name
    .replace(/^\$+\s*/, "") // strip leading $ sale marker
    .replace(/\s+/g, " ")
    .trim();
}

// ───────── detection ─────────

export function isIkiReceipt(lines: string[]): boolean {
  const head = lines.slice(0, 10).join(" ").toUpperCase();
  // Either the IKI store header line or any column-header row is a strong
  // signal — much stronger than a bare "IKI" which could appear elsewhere.
  if (/\bIKI\s*[-–—]/.test(head)) return true;
  return lines.slice(0, 30).some(isColumnHeader);
}

// ───────── section boundaries ─────────

function findFirstColumnHeader(lines: IkiLine[]): number {
  for (let i = 0; i < lines.length; i++) {
    if (isColumnHeader(lines[i].text)) return i;
  }
  return -1;
}

function findFooterStart(lines: IkiLine[], after: number): number {
  for (let i = Math.max(0, after); i < lines.length; i++) {
    const t = lines[i].text;
    if (/^\s*VISO\s*$/i.test(t)) return i;
    if (PIRKINIU_RE.test(t)) return i;
    if (MOKETA_RE.test(t)) return i;
  }
  return lines.length;
}

// ───────── header ─────────

function parseHeader(lines: IkiLine[]): IkiHeader {
  let storeName = "";
  let storeAddress = "";

  for (const line of lines) {
    const text = line.text.trim();
    const storeMatch = text.match(STORE_HEADER_RE);
    if (storeMatch) {
      // "LYRA TURGUS - LYROS G. 5A" — store-name and address share the line,
      // separated by " - ". Split on last " - " so the address is the tail
      // and whatever precedes it is the store name.
      const rest = storeMatch[1].trim();
      const dashIdx = rest.lastIndexOf(" - ");
      if (dashIdx >= 0) {
        storeName = rest.slice(0, dashIdx).trim();
        storeAddress = rest.slice(dashIdx + 3).trim();
      } else {
        storeAddress = rest;
      }
      break;
    }
  }

  return {
    chainName: "IKI",
    storeCode: "",
    storeName,
    storeAddress,
    pvmCode: "",
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

// ───────── products ─────────

/**
 * Parse a values row into (unit, qty, discount, total) without relying on
 * MLKit's within-row ordering. Strategy:
 *   1. Tokenize numbers; remember which had `€` attached.
 *   2. qty = first token without `€` (plain integer or decimal).
 *   3. The three `€` values are unit/discount/total in some order. Pick the
 *      permutation where `unit * qty - discount == total` and discount ≥ 0,
 *      preferring the one with the smallest discount (handles the common
 *      discount=0 case where unit and total are equal and any of several
 *      assignments would balance).
 */
function parseValuesRow(
  valuesText: string,
): { unit: number; qty: number; discount: number; total: number } | null {
  const tokens: { value: number; hasEuro: boolean }[] = [];
  const tokenRe = /(\d+(?:[.,]\s?\d+)?)(\s*€)?/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(valuesText))) {
    if (!m[1]) continue;
    const v = parseNum(m[1]);
    if (!Number.isFinite(v)) continue;
    tokens.push({ value: v, hasEuro: !!m[2] });
  }
  if (tokens.length < 4) return null;

  // qty: first non-euro token.
  let qty = 1;
  let qtyIdx = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (!tokens[i].hasEuro) {
      qty = tokens[i].value;
      qtyIdx = i;
      break;
    }
  }
  if (qtyIdx < 0) return null;

  const euroValues = tokens
    .filter((_, i) => i !== qtyIdx)
    .map((t) => t.value);
  if (euroValues.length < 3) return null;

  // Try all (unit, discount, total) orderings of the first three euro values.
  const [a, b, c] = euroValues;
  const perms = [
    { unit: a, discount: b, total: c },
    { unit: a, discount: c, total: b },
    { unit: b, discount: a, total: c },
    { unit: b, discount: c, total: a },
    { unit: c, discount: a, total: b },
    { unit: c, discount: b, total: a },
  ];

  let best: { unit: number; discount: number; total: number } | null = null;
  for (const p of perms) {
    if (p.discount < -0.005) continue;
    const expected = p.unit * qty - p.discount;
    if (Math.abs(expected - p.total) > 0.02) continue;
    if (!best || p.discount < best.discount) best = p;
  }
  if (!best) return null;
  return { ...best, qty };
}

function parseProducts(
  lines: IkiLine[],
  absoluteStartIdx: number,
): IkiProduct[] {
  const products: IkiProduct[] = [];

  const headerIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isColumnHeader(lines[i].text)) headerIndices.push(i);
  }

  for (let hi = 0; hi < headerIndices.length; hi++) {
    const headerIdx = headerIndices[hi];
    const valuesIdx = headerIdx + 1;
    if (valuesIdx >= lines.length) break;

    const headerLine = lines[headerIdx];
    const valuesLine = lines[valuesIdx];
    const valuesText = valuesLine.text.trim();
    const parsed = parseValuesRow(valuesText);
    if (!parsed) continue;

    const { unit: unitPrice, qty, discount, total } = parsed;

    // Name = everything between the previous values row (or products-section
    // start) and this column header.
    const nameStart =
      hi > 0 ? headerIndices[hi - 1] + 2 /* skip prior values row */ : 0;
    const nameLines: string[] = [];
    const nameRegionLines: IkiLine[] = [];
    for (let ni = nameStart; ni < headerIdx; ni++) {
      const t = lines[ni].text.trim();
      if (!t) continue;
      // Skip header-section content that slipped past boundary detection.
      if (hi === 0 && DATE_ONLY_RE.test(t)) continue;
      if (hi === 0 && STORE_HEADER_RE.test(t)) continue;
      nameLines.push(t);
      nameRegionLines.push(lines[ni]);
    }

    const rawLines = [...nameLines, headerLine.text, valuesText];
    const name = cleanProductName(nameLines.join(" "));
    if (!name) continue;

    // Discount is a per-line absolute amount (EUR). Effective per-unit price
    // = total / qty. If discount is 0, promoPrice is null.
    const promoPrice =
      discount > 0 && qty > 0
        ? Math.round((total / qty) * 100) / 100
        : null;

    const regionLines = [...nameRegionLines, headerLine, valuesLine];

    products.push({
      name,
      price: unitPrice,
      promoPrice,
      quantity: qty,
      unit: "vnt",
      pricePerUnit: unitPrice,
      rawLines,
      region: regionOf(regionLines),
    });
  }

  void absoluteStartIdx; // reserved for future multi-page disambiguation
  return products;
}

// ───────── footer ─────────

function parseFooter(lines: IkiLine[]): IkiFooter {
  let total: number | null = null;
  let totalSavings: number | null = null;

  for (const line of lines) {
    const text = line.text;

    // Prefer "Mokėta suma" (what was actually paid) as the headline total.
    // Falls back to "Pirkinių suma" if "Mokėta suma" is not present.
    const mokMatch = text.match(MOKETA_RE);
    if (mokMatch) total = parseNum(mokMatch[1]);

    if (total === null) {
      const pirkMatch = text.match(PIRKINIU_RE);
      if (pirkMatch) total = parseNum(pirkMatch[1]);
    }

    const sutMatch = text.match(SUTAUPYTA_RE);
    if (sutMatch) totalSavings = parseNum(sutMatch[1]);
  }

  return {
    total,
    date: "",
    time: "",
    receiptNo: "",
    totalSavings,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
  };
}

// ───────── public entry points ─────────

export function parseIkiReceipt(lines: IkiLine[]): IkiParseResult {
  // Date/time are in the header area on IKI; we still surface them via the
  // footer object to match the Rimi/Maxima interface the downstream UI reads.
  // Order can be either `YYYY MM DD HH:MM` or `HH:MM YYYY MM DD` — parse them
  // independently so either layout works.
  let date = "";
  let time = "";
  for (const line of lines.slice(0, 8)) {
    if (!date) {
      const d = line.text.match(DATE_ONLY_RE);
      if (d) date = `${d[1]}-${d[2]}-${d[3]}`;
    }
    if (!time) {
      const t = line.text.match(TIME_ONLY_RE);
      if (t) time = `${t[1]}:${t[2]}`;
    }
    if (date && time) break;
  }

  const firstColHeader = findFirstColumnHeader(lines);
  // Products section starts at the line immediately before the first column
  // header (name of the first product). Walk backward past up to 4 non-empty
  // lines to include multi-line names.
  let productsStart = firstColHeader;
  if (firstColHeader > 0) {
    let walked = 0;
    for (let i = firstColHeader - 1; i >= 0 && walked < 4; i--) {
      const t = lines[i].text.trim();
      if (!t) continue;
      if (DATE_ONLY_RE.test(t)) break;
      if (STORE_HEADER_RE.test(t)) break;
      productsStart = i;
      walked++;
    }
  }

  // When the column header isn't detected anywhere (typically a scrambled
  // OCR from photographing a screen instead of selecting the screenshot),
  // fall back to 0 so we still return an empty-products parse rather than
  // crashing. The header/footer halves can still surface useful data.
  const headerEnd = Math.max(0, productsStart);
  const footerStart = findFooterStart(
    lines,
    Math.max(0, firstColHeader >= 0 ? firstColHeader : headerEnd),
  );

  const header = parseHeader(lines.slice(0, headerEnd));
  const products = parseProducts(
    lines.slice(headerEnd, footerStart),
    headerEnd,
  );
  const footer = parseFooter(lines.slice(footerStart));

  if (date) footer.date = date;
  if (time) footer.time = time;

  // IKI's in-app receipt view doesn't expose a receipt number, so there's no
  // natural unique key. Synthesize one from date+time+total: the same receipt
  // photographed again yields the same synthetic number, letting the backend
  // reject it as a duplicate instead of creating parallel records. Only set
  // when all three parts are available — otherwise duplicate detection would
  // collide across different receipts that happen to share a partial key.
  if (footer.date && footer.time && footer.total !== null) {
    const d = footer.date.replace(/-/g, "");
    const t = footer.time.replace(/:/g, "");
    const cents = Math.round(footer.total * 100);
    footer.receiptNo = `${d}-${t}-${cents}-iki-receipt`;
  }

  return { header, products, footer };
}

export function parseIkiHeaderOnly(lines: IkiLine[]): IkiHeader {
  const firstColHeader = findFirstColumnHeader(lines);
  let productsStart = firstColHeader;
  if (firstColHeader > 0) {
    let walked = 0;
    for (let i = firstColHeader - 1; i >= 0 && walked < 4; i--) {
      const t = lines[i].text.trim();
      if (!t) continue;
      if (DATE_ONLY_RE.test(t)) break;
      if (STORE_HEADER_RE.test(t)) break;
      productsStart = i;
      walked++;
    }
  }
  return parseHeader(lines.slice(0, productsStart));
}
