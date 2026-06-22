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

import type { RegionKind, LabeledRegion } from './rimiParser.js';

export interface Region {
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
  // Optional skew: top/bottom Y at the band's LEFT vs RIGHT edge, so the photo
  // overlay can draw a parallelogram that follows a tilted receipt. Absent →
  // render as the axis-aligned rectangle (yTop/yBottom). Currently produced only
  // by the IKI photographed (thermal) parser.
  yLeftTop?: number;
  yRightTop?: number;
  yLeftBottom?: number;
  yRightBottom?: number;
  // Optional MID-COLUMN connection (column engine's two-box band): when present,
  // the band is a 6-point polygon — a NAME box on the left [xLeft..xMid] joined to
  // a PRICE box on the right [xMid..xRight]. The left half rides the name curve,
  // the right half rides the price curve, connected at xMid. Lets the right edge
  // sit on the price row while the left edge sits on the name row (no diagonal
  // clip of the middle rows). Absent → ordinary quad from the four corners.
  xMid?: number;
  yMidTop?: number;
  yMidBottom?: number;
}

export interface IkiWord {
  text: string;
  xLeft: number;
  xRight: number;
  yTop: number;
  yBottom: number;
}

export interface IkiLine {
  text: string;
  yTop: number;
  yBottom: number;
  xLeft: number;
  xRight: number;
  // Skew-aware edge Y from MLKit cornerPoints (optional).
  yLeftTop?: number;
  yRightTop?: number;
  yLeftBottom?: number;
  yRightBottom?: number;
  // Per-word boxes (MLKit elements), for word-anchored bands.
  words?: IkiWord[];
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

/** Per-line bbox tracking — see rimiParser for the rationale. */
export interface IkiHeader {
  chainName: string;
  storeCode: string;
  storeName: string;
  storeAddress: string;
  pvmCode: string;
  rawText: string;
  region: Region;
  lineRegions: LabeledRegion[];
}

export interface IkiFooter {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
  lineRegions: LabeledRegion[];
}

export interface IkiParseResult {
  header: IkiHeader;
  products: IkiProduct[];
  footer: IkiFooter;
  /** Coupon / bag / loyalty-points lines in the product section: shown as
   *  distinct (grey) bands in the photo view but never counted as products. */
  skippedRegions?: LabeledRegion[];
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

// The ONLY diacritics Lithuanian uses. Anything else (É, Ü, Ä, Ñ, Ô…) is an OCR
// hallucination on a thermal scan and must never reach a product name.
const LT_DIACRITICS = new Set('ąčęėįšųūžĄČĘĖĮŠŲŪŽ'.split(''));
// Fold every NON-Lithuanian accent down to its base ASCII letter while KEEPING the
// Lithuanian ones. Decompose (NFD) so each letter splits into base + combining
// marks; recompose just that one cluster — keep it only if the result is a
// Lithuanian letter, otherwise drop the marks and keep the bare base.
function foldForeignDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/([A-Za-z])([̀-ͯ]+)/g, (_m, base: string, marks: string) => {
      const c = (base + marks).normalize('NFC');
      return LT_DIACRITICS.has(c) ? c : base;
    })
    .replace(/[̀-ͯ]/g, '')   // stray marks not attached to a base letter
    .normalize('NFC');
}

function cleanProductName(name: string): string {
  return foldForeignDiacritics(name)
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
  // Thermal POS receipts open with "IKI Lietuva, UAB" (no column header).
  if (/\bIKI\s+LIETUVA\b/.test(head)) return true;
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
  const lineRegions: LabeledRegion[] = [];

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
      // Both store name and address come from the same OCR line on IKI
      // receipts, so a single bbox covers them — label the band as
      // storeAddress (matches the legend rendering elsewhere).
      lineRegions.push({
        kind: 'storeAddress',
        yTop: line.yTop,
        yBottom: line.yBottom,
        xLeft: line.xLeft,
        xRight: line.xRight,
      });
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
    lineRegions,
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

  // Per-line tracker. IKI's footer parser only captures `total` from this
  // function (date/time/receiptNo live in the parent — see parseIkiReceipt
  // below — and are tracked there, not here). Tagged with `kind` for
  // per-field colour + label.
  const seen = new Set<string>();
  const lineRegions: LabeledRegion[] = [];
  const trackLine = (line: IkiLine, kind: RegionKind) => {
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
    const text = line.text;

    // Prefer "Mokėta suma" (what was actually paid) as the headline total.
    // Falls back to "Pirkinių suma" if "Mokėta suma" is not present.
    const mokMatch = text.match(MOKETA_RE);
    if (mokMatch) {
      total = parseNum(mokMatch[1]);
      trackLine(line, 'total');
    }

    if (total === null) {
      const pirkMatch = text.match(PIRKINIU_RE);
      if (pirkMatch) {
        total = parseNum(pirkMatch[1]);
        trackLine(line, 'total');
      }
    }

    const sutMatch = text.match(SUTAUPYTA_RE);
    if (sutMatch) totalSavings = parseNum(sutMatch[1]);
  }

  lineRegions.sort((a, b) => a.yTop - b.yTop);
  return {
    total,
    date: "",
    time: "",
    receiptNo: "",
    totalSavings,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
    lineRegions,
  };
}

// ════════════════════════ THERMAL POS FORMAT ════════════════════════
// Physical scanned IKI receipts use a single-column THERMAL layout — totally
// different from the A4 e-invoice table above. Each product is: NAME line, then
// an optional weight line (`X,XXX kg X Y,YY EUR/kg`), then the line-total
// (`N,NN A`), then an optional `NUOLAIDA … -X,XX` discount line. Used when no
// column header is present (see parseIkiReceipt dispatch).

const T_PRICE_RE = /^-?\s*\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s*$/;          // "3,29 A" | "-7, 48 A"
const T_POS_PRICE_RE = /^\s*\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s*$/;        // positive only (a line total)
const T_BARE_NEG_RE = /^-\s?\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s*$/;        // "-7, 48 A" — a bare discount
const T_WEIGHT_LOOSE_RE = /\bkg\b\s*[xXyY×*].*EUR/i;                  // any "… kg X … EUR/kg" row (OCR reads the × as X/Y/*)
// A weighed QUANTITY token ("0,470 kg", "2,090 kg") — 3-decimal kg. Survives even
// when OCR drops the "X €/kg" tail (so the EUR-based weight test above misses it).
// Every weighed IKI item prints exactly ONE, so a SECOND one = a new product.
const T_KG_QTY_RE = /\d[.,]\s?\d{3}\s*kg\b/i;
const T_PERKG_RE = /(\d{1,4}[.,]\s?\d+)\s*[:;.]?\s*EUR/i;             // €/kg = number before EUR (tolerate a stray ":" OCR adds, "3,4: EUR")
// "NUOLAIDA" but OCR-tolerant: the middle letters are routinely mangled on
// thermal photos — "NUOLA1DA" (I→1), "NUOLAI DA" (one space), "NUOLA I DA"
// (two spaces, 4 chars between NUOL and DA), "NUOLAlDA". Match NUOL + up to 4
// anything + D + A/4. Missing this turns a discount line into a phantom product
// (a new name-start) AND drops the real product's discount entirely.
// "NUOLAIDA" with OCR rot tolerated: a DROPPED leading N ("UOLAIDA"), O↔C↔Q↔D↔0
// (NUCLAIDA/NUQLAIDA/NUDLAIDA), I↔Ī↔1. Diacritics are stripped before matching
// (isTDiscount), so a horned/accented O ("NUỚL") also matches. The gap is .{0,4} so OCR
// can split the word with spaces ("NUOL AT DA"). Catching these stops a garbled discount
// LABEL from becoming a phantom product or fusing into the next name.
const T_DISCOUNT_RE = /N?[UV][OCQD0][LI1].{0,4}D[A4]/i;
const T_NEG_RE = /-\s?(\d{1,4}[.,]\s?\d{2})/;
// coupons, plastic bags, points lines. These words are heavily OCR-garbled on
// photos: the coupon "KU" can drop entirely ("xKUPONAS" → "JPONAS"/"PONAS"), and
// "Taškais" (IKI loyalty points) loses its tail ("Taškals" with i→l, "Taškai").
// Match the STABLE stems — "KUPON" / "…PONAS" for coupons, "MAI[SŠ]ELIS" for
// bags, and "TA[SŠ]KA" for points — so none slips through as a phantom product.
const T_SKIP_NAME_RE = /KUPON|\b[A-Z]{0,2}PONAS\b|MAI[SŠ]ELIS|TA[SŠ]KA/i;
const T_LEAD_DISC_RE = /^(-\s?\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s+(\S.*)$/;        // "-0,72 A RAUDONOSIOS PAPRIKOS"
const T_LEAD_PRICE_RE = /^(\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s*-?\s*(\S.*)$/;      // "18,15 A- 1,068 kg X 16,99 EUR/kg"
const T_DISC_NAME_RE = /^(NUOL.{0,4}D[A4](?:\s+SU\s+KORTELE)?)\s+(.+)$/i;      // "NUOLAIDA 2A RAUDONOS IOS PAPRIKOS" (label fused w/ next name)
const T_TRAIL_PRICE_RE = /^(.*?[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž].*?)\s+(\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s*$/; // "NAME 1,99 A"
// "<NAME1> <price> A <NAME2>" — two products fused on ONE OCR row, separated by a
// line-total's VAT-class token. e.g. "LYDYTAS TEPAWAS RIS 99 A LIETUW1SKI POMIDORAI"
// (the integer of "1,99" is dropped by OCR, leaving "99 A"). The "<digits> A"
// can only be a price, so whatever follows it starts a NEW product. The price
// digits are loose (OCR drops the integer/decimal) — the VAT letter is the anchor.
const T_MID_PRICE_NAME_RE = /^(.+?)\s+(\d{1,4}(?:[.,]\s?\d{0,2})?)\s*([ABC])\s+(.+)$/;
const T_PRODUCTS_END_RE = /Prekiautojo\s+ID|^\s*Pardavimas\b|MASTERCARD|^\s*SUMA\b|Mok[eė]ti\b/i;
const T_DATE_RE = /(\d{4})-(\d{2})-(\d{2})/;
const T_TIME_RE = /(\d{2}):(\d{2}):(\d{2})/;
const T_RECEIPTNO_RE = /Kvito\s+Nr[.,]?\s*([0-9/]+)/i;   // OCR reads "Nr." or "Nr,"
// Canonical total line, amount on EITHER side of SUMA — OCR flips the order:
// "SUMA 26,52 EUR" and "26,52 EUR SUMA" both seen. Requires EUR so the multi-
// column VAT header ("…Suma su PVM Be PVM…") with no EUR can't false-match.
const T_SUMA_RE = /\bSUMA\b\s*(\d{1,4}[.,]\s?\d{2})\s*EUR|(\d{1,4}[.,]\s?\d{2})\s*EUR\s+SUMA\b/i;
const T_SAVINGS_RE = /sutaup[eė]te\s+(\d+[.,]\s?\d{2})/i;
const T_LETTER_RE = /[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const isTPrice = (t: string) => T_PRICE_RE.test(t.trim());
const isTPosPrice = (t: string) => T_POS_PRICE_RE.test(t.trim());
const isTWeight = (t: string) => T_WEIGHT_LOOSE_RE.test(t);
const isTSkip = (t: string) => T_SKIP_NAME_RE.test(t);
// A discount line: the "NUOLAIDA" label (with or without an amount) OR a bare
// negative amount (the leading "-X,XX A" that OCR often fuses onto the next row).
// Strip combining diacritics so OCR-garbled accents on the discount label (e.g. the
// horned/accented O in "NUỚL") still match the plain "NUOLAIDA" skeleton.
const stripDiacritics = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const isTDiscount = (t: string) => T_DISCOUNT_RE.test(stripDiacritics(t)) || T_BARE_NEG_RE.test(t.trim());
// Only a real product NAME can start a product — never a price / weight /
// discount / coupon-bag-points marker / digit-only noise. Requires ≥2 letters
// so OCR crumbs like a lone "A" (the leftover of a mangled points line) never
// become a phantom product.
const isNameStart = (t: string) =>
  !!t && !isTPrice(t) && !isTWeight(t) && !isTDiscount(t) && !isTSkip(t) &&
  t.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length >= 2;

const extractPerKg = (t: string): number | null => {
  const m = t.match(T_PERKG_RE);
  const v = m ? parseNum(m[1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : null;
};
// The kg quantity at the START of a weight row: "0,720 kg X …" → "0,720".
// Returns null if there's no "<number> kg". A result WITHOUT a decimal (e.g. "0")
// is a degenerate kg — the signature of OCR splitting "0,720 kg" into "0,72" +
// "0 kg", where the real quantity is the decimal fragment on the preceding line.
const T_KG_LEAD_RE = /(\d{1,4}(?:[.,]\s?\d+)?)\s*kg\b/i;
const leadingKg = (t: string): string | null => {
  const m = t.match(T_KG_LEAD_RE);
  return m ? m[1].trim() : null;
};

interface ThermalTok { text: string; src: IkiLine; }

// Split a fused OCR line's bbox into a top and bottom half (skew-aware), so two
// stacked rows that MLKit merged into one tall box can each carry their own
// vertical slice. Without this, a "-0,72 A <next name>" fusion would give the
// discount and the next product's name the SAME y — the band seam would then
// land at the top of the fused row and the discount (P_n) would fall inside
// P_n+1's band. Halving the box puts the discount in the top half (→ P_n) and
// the name in the bottom half (→ P_n+1), so the seam lands between them.
function splitLineVert(line: IkiLine): { top: IkiLine; bottom: IkiLine } {
  const lt = line.yLeftTop ?? line.yTop, rt = line.yRightTop ?? line.yTop;
  const lb = line.yLeftBottom ?? line.yBottom, rb = line.yRightBottom ?? line.yBottom;
  const lm = (lt + lb) / 2, rm = (rt + rb) / 2, midY = (line.yTop + line.yBottom) / 2;
  return {
    top: { ...line, yBottom: midY, yLeftBottom: lm, yRightBottom: rm },
    bottom: { ...line, yTop: midY, yLeftTop: lm, yRightTop: rm },
  };
}

// Photographed thermal OCR frequently FUSES adjacent rows: a discount + the next
// product name ("-0,72 A RAUDONOSIOS PAPRIKOS"), or a name + its price
// ("PIENAS 1,49 A"). Explode such lines back into atomic tokens so the
// assembler below sees clean, single-purpose rows.
function explodeThermalLine(line: IkiLine): ThermalTok[] {
  const t = line.text.trim();
  // "-N,NN A <rest>" → discount token + <rest> (the NEXT product's name or a
  // discount label). NOT split when <rest> is a coupon/bag/points line — there
  // the leading negative is a points redemption, not a product discount.
  // The bbox is halved so the discount (top) and the next name (bottom) get
  // distinct y — the band seam then falls BETWEEN them, not above both.
  const lead = t.match(T_LEAD_DISC_RE);
  if (lead && T_LETTER_RE.test(lead[2]) && !isTSkip(lead[2])) {
    const { top, bottom } = splitLineVert(line);
    return [{ text: lead[1].trim(), src: top }, ...explodeThermalLine({ ...bottom, text: lead[2] })];
  }
  // "18,15 A- 1,068 kg X 16,99 EUR/kg" → the line TOTAL fused onto the FRONT of
  // a weight row. Split the leading total off (same product, same y → keep the
  // shared bbox) so it's pickable as the product's line price; the weight row
  // alone carries only €/kg. Without this the whole thing reads as a weight row,
  // the total never registers, and the product is dropped for lack of a price.
  const leadPrice = t.match(T_LEAD_PRICE_RE);
  if (leadPrice && isTWeight(leadPrice[2])) {
    return [{ text: leadPrice[1].trim(), src: line }, ...explodeThermalLine({ ...line, text: leadPrice[2] })];
  }
  // "NUOLAIDA <amount?> <NEXT PRODUCT NAME>" → a discount LABEL fused onto the
  // next product's name (no leading minus → T_LEAD_DISC_RE misses it). Strip the
  // label + any (often garbled) amount off the front; if a real name remains,
  // split it off as its own token so that product isn't swallowed by the band
  // above. Halve the bbox so the seam lands between them.
  const discName = t.match(T_DISC_NAME_RE);
  if (discName) {
    const tail = discName[2].replace(/^[-*\d.,A%xX ]+/i, '').trim();
    const tailLetters = tail.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length;
    // Guard: a bare "NUOLAIDA SU KORTELE" backtracks to tail="SU KORTELE" — that
    // is the label's own continuation, NOT a product name. Reject label tails so
    // only a genuine fused product name (e.g. "RAUDONOS IOS PAPRIKOS") splits off.
    // Tolerate OCR garbles: "ŠU" (Š for S) and "KORTELt"/"KORTELĖ" (KORTEL + any).
    const isLabelTail = /^([SŠ]U\b|KORTEL)/i.test(tail);
    if (tail && tailLetters >= 3 && !isLabelTail && !isTSkip(tail) && !T_DISCOUNT_RE.test(tail)) {
      const discPart = t.slice(0, t.length - tail.length).trim();
      const { top, bottom } = splitLineVert(line);
      return [{ text: discPart, src: top }, ...explodeThermalLine({ ...bottom, text: tail })];
    }
  }
  // "<NAME1> <price> A <NAME2>" → two products fused on one row, split by a line-
  // total's VAT letter. The "<num> A" is NAME1's total; NAME2 starts a fresh
  // product. Both sides must look like real product names (≥2 letters, not a
  // price/weight/discount/coupon) so this never fires on a normal "NAME 1,99 A"
  // (nothing after the letter) or a fused discount/weight row. Halve the bbox so
  // the seam falls BETWEEN the two stacked rows.
  const mid = t.match(T_MID_PRICE_NAME_RE);
  if (mid && !isTWeight(t)) {
    const name1 = mid[1].trim(), priceTok = `${mid[2].trim()} ${mid[3]}`, name2 = mid[4].trim();
    if (isNameStart(name1) && isNameStart(name2) && !isTSkip(name2) && !T_DISCOUNT_RE.test(name2)) {
      const { top, bottom } = splitLineVert(line);
      return [
        { text: name1, src: top },
        { text: priceTok, src: top },
        ...explodeThermalLine({ ...bottom, text: name2 }),
      ];
    }
  }
  // "<name> 1,99 A" → name + price. Positive, well-formed price only; never split
  // a weight row, a discount label, or a coupon/bag line.
  const trail = t.match(T_TRAIL_PRICE_RE);
  if (trail && !isTWeight(trail[1]) && !T_DISCOUNT_RE.test(trail[1]) && !isTSkip(trail[1])) {
    return [{ text: trail[1].trim(), src: line }, { text: trail[2].trim(), src: line }];
  }
  return [{ text: t, src: line }];
}

// ════════════════════════════════════════════════════════════════════════════
// COLUMN ENGINE (flag-gated) — rebuilds physical ROWS from per-word boxes, then
// assembles products off the right-column price LADDER. Robust to OCR line
// fusion/splits AND column scramble (it matches name↔price by Y, not OCR order).
// Spec: memory project_iki_column_engine_rewrite.md. The dispatcher falls back to
// parseThermalProducts when per-word data is sparse or this yields nothing.
// ════════════════════════════════════════════════════════════════════════════
const USE_COLUMN_ENGINE = true;

interface EWord { text: string; xLeft: number; xRight: number; yTop: number; yBottom: number; slope: number; line: number; }
interface ERow {
  words: EWord[]; leftText: string;
  total: number | null; perKg: number | null; discount: number; isSkip: boolean;
  kgQty: boolean;                                                     // row bears a weighed-quantity token
  topY: number; botY: number; leftX: number; slope: number;
}
const T_TRAIL_AMT_RE = /(-?\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s*$/;       // a line's trailing amount
// A price the OCR mangled — the decimal/euros were dropped but the trailing VAT
// letter (A/B/C) still marks "this is a price". "48 A" was "-7,48 A"; "49 A" was
// "1,49 A". The VAT letter is REQUIRED here (that's the real signal), so plain
// numbers in names ("2,5%") are never mistaken for prices.
const T_AMT_VAT_RE = /(-?\d{1,4}(?:[.,]\s?\d{1,2})?)\s*([ABC])\s*$/;
function matchVatAmt(text: string): number | null {
  const m = text.match(T_AMT_VAT_RE);
  if (!m) return null;
  const tok = m[1].replace(/\s+/g, '');
  const neg = tok.startsWith('-');
  let v: number;
  if (/[.,]/.test(tok)) v = Math.abs(parseNum(tok));
  else { const d = tok.replace(/\D/g, ''); if (!d) return null; v = parseInt(d, 10) / 100; } // bare digits → cents
  return neg ? -v : v;
}
const emedian = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Enough of the product section carries real per-word data to run the engine?
function ikiHasWords(lines: IkiLine[], start: number, end: number): boolean {
  let withWords = 0, n = 0;
  for (let i = start; i < end; i++) { n++; if (lines[i].words && lines[i].words!.length) withWords++; }
  return n > 0 && withWords / n >= 0.6;
}

// Flatten every word in the product section. Each word carries its source line's
// tilt (the local receipt slope) — we ignore MLKit's line GROUPING, not its tilt.
function ikiCollectWords(lines: IkiLine[], start: number, end: number): EWord[] {
  const out: EWord[] = [];
  for (let i = start; i < end; i++) {
    const l = lines[i];
    const w = (l.xRight - l.xLeft) || 1;
    const slope = ((l.yRightTop ?? l.yTop) - (l.yLeftTop ?? l.yTop)) / w;
    if (l.words && l.words.length) {
      for (const wd of l.words) {
        if (!wd.text.trim()) continue;
        out.push({ text: wd.text, xLeft: wd.xLeft, xRight: wd.xRight, yTop: wd.yTop, yBottom: wd.yBottom, slope, line: i });
      }
    } else {
      out.push({ text: l.text, xLeft: l.xLeft, xRight: l.xRight, yTop: l.yTop, yBottom: l.yBottom, slope, line: i });
    }
  }
  return out;
}

// Curve-normalized row clustering: de-bend by the median slope, group words whose
// normalized Y is within ~½ a line-height (= median word height).
function ikiClusterRows(words: EWord[], lineH: number, medSlope: number): EWord[][] {
  const norm = (w: EWord) => (w.yTop + w.yBottom) / 2 - medSlope * ((w.xLeft + w.xRight) / 2);
  const sorted = [...words].sort((a, b) => norm(a) - norm(b));
  const rows: EWord[][] = [];
  let cur: EWord[] = [], sum = 0;
  for (const w of sorted) {
    const n = norm(w);
    if (cur.length && n - sum / cur.length > lineH * 0.6) { rows.push(cur); cur = []; sum = 0; }
    cur.push(w); sum += n;
  }
  if (cur.length) rows.push(cur);
  for (const r of rows) r.sort((a, b) => a.xLeft - b.xLeft);
  return rows;
}

// Type a row + split left text from the trailing amount. Reuses the same row
// predicates the legacy parser uses, so values stay consistent.
function ikiClassifyRow(ws: EWord[], lines: IkiLine[]): ERow {
  const text = ws.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
  // MLKit routinely keeps an amount / €-kg in the LINE text but drops it from the
  // per-word boxes, so `text` (built only from words) misses it. The LEFTMOST word's
  // source line still carries that trailing value — use it to recover scalar VALUES
  // ONLY (a discount amount, a €/kg), never geometry (bands still come from words).
  const firstSrc = (ws.length ? lines[ws[0].line]?.text : '') ?? '';
  const topY = Math.min(...ws.map((w) => w.yTop));
  const botY = Math.max(...ws.map((w) => w.yBottom));
  const slope = emedian(ws.map((w) => w.slope));
  const base: ERow = { words: ws, leftText: '', total: null, perKg: null, discount: 0, isSkip: false, kgQty: T_KG_QTY_RE.test(text), topY, botY, leftX: ws[0].xLeft, slope };
  if (isTSkip(text)) return { ...base, isSkip: true, leftText: text };
  const srcPerKg = extractPerKg(firstSrc);
  // WEIGHT row — straight from the words, OR RECOVERED when OCR shattered the
  // "kg X … EUR" tokens (only the leading kg-quantity survived as a word, the "kg"
  // itself even mis-read — salmon "1,068 KORTELL X 16.99 EUR/ kg" kept only "1,068")
  // but the source line still holds the €/kg. Lead with a 3-decimal quantity + a €/kg
  // on the line ⇒ a weighed item whose calc was otherwise lost.
  if (isTWeight(text) || (srcPerKg != null && /^\d{1,4}[.,]\s?\d{3}\b/.test(text))) {
    // A weight row can carry the product NAME fused before the quantity
    // ("BE GAL 1,068 kg X …") AND the line TOTAL fused after it ("… EUR/kg 18,15 A").
    // Keep both so the product gets its name and its total.
    const lead = text.match(/^([A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž][A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž .]+?)\s+\d/);
    const tm = text.match(T_TRAIL_AMT_RE);
    const tot = tm && parseNum(tm[1]) > 0 ? parseNum(tm[1]) : null;
    return { ...base, perKg: extractPerKg(text) ?? srcPerKg, total: tot, leftText: lead ? lead[1].trim() : '' };
  }
  const tm = text.match(T_TRAIL_AMT_RE);
  let amt = tm ? parseNum(tm[1]) : null;
  const cleanDecimal = amt != null;                   // matched the strict "1,49" decimal form
  let amtRe = T_TRAIL_AMT_RE;                         // pattern to strip from leftText
  if (amt == null) {
    const lv = matchVatAmt(text);                     // OCR dropped the decimal but kept the VAT letter
    if (lv != null) { amt = lv; amtRe = T_AMT_VAT_RE; }
  }
  // A CLEAN positive decimal is always a TOTAL — even when a discount LABEL got fused
  // onto the line ("NUOLAIDA ŠU 18,15" = a label + the total from the line above, an
  // MLKit mis-group on a tilted receipt). Discounts always print a minus; a positive
  // decimal is never a discount. (A decimal-LESS loose amount like "48 A" stays a
  // discount on a NUOLAIDA line — there the minus was just dropped by OCR.)
  if (cleanDecimal && amt! > 0) return { ...base, total: amt, leftText: text.replace(amtRe, '').trim() };
  if (isTDiscount(text) || (amt != null && amt < 0)) {
    // recover a word-dropped discount amount from the source line ("NUOLAIDA" word
    // survived, "-0,30 A" did not — but it's still in the line text)
    const d = text.match(T_NEG_RE) ?? firstSrc.match(T_NEG_RE);
    const dv = d ? parseNum(d[1]) : (amt != null ? Math.abs(amt) : 0);
    return { ...base, discount: dv, leftText: text.replace(amtRe, '').replace(T_DISCOUNT_RE, '').trim() };
  }
  if (amt != null && amt > 0) return { ...base, total: amt, leftText: text.replace(amtRe, '').trim() };
  return { ...base, leftText: text };
}

// "SU KORTELĖ" discount-label tails (OCR-garbled: "SU K HT", "ŠU KORTEL.") must
// NEVER be mistaken for a product name — they create phantom products.
const ikiLabelTail = (s: string) => /^[SŠ]U\b/i.test(s.trim()) || /KORTEL/i.test(s);
// Text usable as (part of) a product name: real letters, not a label tail, not a
// NUOLAIDA discount label (so "NUOLAIDA ŠU" left of a fused total isn't a name).
const ikiNameText = (s: string) => !ikiLabelTail(s) && !isTDiscount(s) && /[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{2}/.test(s);
// A name strong enough to START a product / stand alone (boundary + guarded recovery).
const ikiStrongName = (s: string) =>
  isNameStart(s) && !ikiLabelTail(s) && s.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length >= 4;

// Column split X: just LEFT of where the right-aligned price block begins (numeric
// amounts / VAT-letter words), clamped to a sane band. One value for the whole
// section — used to split columns AND to draw the two-box bands.
const ikiColumnSplit = (words: EWord[], X0: number, X1: number): number => {
  const W = (X1 - X0) || 1;
  const amts = words.filter((w) => /^-?\d{1,4}[.,]\s?\d{2}$/.test(w.text.trim()) || /^[ABC]$/.test(w.text.trim()));
  if (!amts.length) return X0 + 0.6 * W;
  return Math.max(X0 + 0.4 * W, Math.min(X0 + 0.82 * W, Math.min(...amts.map((w) => w.xLeft)) - 0.02 * W));
};

// PER-COLUMN row reconstruction. Cluster the LEFT column (names/weights/labels) and
// the RIGHT column (prices/amounts) SEPARATELY — each is narrow in x, so its Y is
// clean. Then re-attach every right-column amount cluster to a left row:
//   1) by SHARED MLKit SOURCE LINE — if MLKit already grouped the amount with that
//      left text (e.g. "UOLAIDA ŠU  18,15"), trust it. This is tilt-PROOF: it needs
//      no Y math, so a wrong global slope can't orphan the price (the receipt-50 bug
//      where 6 right-column prices were dropped and 6 products fused into one).
//   2) else by curve-normalized Y proximity — handles the case where MLKit split a
//      physical row into a separate left line and right line (receipt-47 scramble).
//   3) else the amount stands as its own row (a price whose name was lost upstream).
function ikiBuildRows(words: EWord[], lineH: number, medSlope: number, xMid: number): EWord[][] {
  const left: EWord[] = [], right: EWord[] = [];
  for (const w of words) ((w.xLeft + w.xRight) / 2 < xMid ? left : right).push(w);
  const norm = (ws: EWord[]) => emedian(ws.map((w) => (w.yTop + w.yBottom) / 2 - medSlope * ((w.xLeft + w.xRight) / 2)));
  const linesOf = (ws: EWord[]) => new Set(ws.map((w) => w.line));
  const hosts = ikiClusterRows(left, lineH, medSlope).map((ws) => ({ ws, lines: linesOf(ws) }));
  const standalone: EWord[][] = [];
  for (const amt of ikiClusterRows(right, lineH, medSlope)) {
    const aLines = linesOf(amt);
    let host = hosts.find((h) => [...aLines].some((ln) => h.lines.has(ln)));   // (1) MLKit grouped them
    if (!host) {                                                               // (2) nearest by tilt-corrected Y
      const aN = norm(amt); let bestD = lineH * 0.6;
      for (const h of hosts) { const d = Math.abs(norm(h.ws) - aN); if (d < bestD) { bestD = d; host = h; } }
    }
    if (host) host.ws.push(...amt);
    else standalone.push(amt);                                                 // (3) price with no name
  }
  const rows = [...hosts.map((h) => h.ws), ...standalone];
  rows.sort((a, b) => norm(a) - norm(b));
  for (const r of rows) r.sort((a, b) => a.xLeft - b.xLeft);
  return rows;
}

function parseIkiColumnar(lines: IkiLine[], start: number, end: number): IkiProduct[] {
  const words = ikiCollectWords(lines, start, end);
  if (words.length < 2) return [];
  const lineH = emedian(words.map((w) => w.yBottom - w.yTop).filter((h) => h > 0)) || 24;
  const medSlope = emedian(words.map((w) => w.slope));
  const X0 = Math.min(...words.map((w) => w.xLeft));
  const X1 = Math.max(...words.map((w) => w.xRight));
  const Xmid = ikiColumnSplit(words, X0, X1);
  const rows = ikiBuildRows(words, lineH, medSlope, Xmid).map((ws) => ikiClassifyRow(ws, lines));

  // ── assemble: accumulate a product's rows until the NEXT product starts. The
  //    positive `X,XX A` total anchors a product; a discount FOLLOWS its total in
  //    IKI, so it attaches to the current product (not the next). A name fused onto
  //    a weight/total/discount row is recovered: on a discount row that name starts
  //    the NEXT product. Guarded recovery for a trailing name with no total. ──
  interface Cur { nameParts: string[]; perKg: number | null; total: number | null; discount: number; top: ERow | null; price: ERow | null; rows: ERow[]; aCount: number; kgRows: number; }
  const out: { p: IkiProduct; top: ERow; price: ERow | null; rows: ERow[] }[] = [];
  const fresh = (): Cur => ({ nameParts: [], perKg: null, total: null, discount: 0, top: null, price: null, rows: [], aCount: 0, kgRows: 0 });
  const rowText = (r: ERow) => r.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
  let cur = fresh();
  const flush = () => {
    const c = cur; cur = fresh();
    if (!c.top) return;
    const name = c.nameParts.map((s) => s.trim()).filter(Boolean).join(' ');
    if (c.total == null && !ikiStrongName(name)) return; // guarded recovery
    const lt = c.total ?? 0;
    const quantity = c.perKg != null && c.perKg > 0 && c.total != null ? round3(c.total / c.perKg) : 1;
    const unitPrice = c.perKg ?? lt;
    const paid = round2(lt - c.discount);
    out.push({
      top: c.top, price: c.price, rows: c.rows.slice(),
      p: {
        name: cleanProductName(name || '?'),
        price: unitPrice,
        promoPrice: c.discount > 0 && quantity > 0 ? round2(paid / quantity) : null,
        quantity,
        unit: c.perKg != null ? 'kg' : 'vnt',
        pricePerUnit: unitPrice,
        // FULL row text per product, so all parsed info lands in rawData even when
        // a band/coordinate is imperfect.
        rawLines: c.rows.map(rowText).filter(Boolean),
        region: { yTop: c.top.topY, yBottom: c.top.botY, xLeft: c.top.leftX, xRight: c.top.leftX },
      },
    });
  };
  for (const r of rows) {
    if (r.isSkip) {
      // A coupon/bag/points marker CLOSES the current product: it's the trailer
      // section, so a trailing points amount (e.g. "IKI Taškais -0,05 A", whose
      // skip word didn't survive into the row's words) can't attach to the last
      // real product as a phantom discount.
      if (cur.total != null) flush();
      continue;
    }
    const name = r.leftText && ikiNameText(r.leftText) ? r.leftText : '';   // usable name text
    const strong = !!name && ikiStrongName(name);                          // can START a product
    const carriesAmt = r.total != null || r.discount > 0;                  // an A-terminated price
    // SELF-HEAL (user rule): an IKI product has AT MOST two A-prices — one total
    // and one discount. A 3rd A-price proves two products were merged, so the 3rd
    // one opens a new product. This catches over-absorption even when a fused
    // next-name was lost upstream (the boundary still fires on the extra price).
    if (carriesAmt && cur.aCount >= 2) flush();
    // SELF-HEAL: a weighed IKI item prints exactly ONE "X,XXX kg" quantity. A SECOND
    // one while a product is open proves the prior product ended — even when its own
    // total + €/kg were OCR-destroyed and its successor's NAME was dropped (the only
    // case with no other anchor). Stops one band covering two weighed products
    // (POMIDORAI 0,720 kg fusing RAUDONOSIOS 0,470 kg into a single box).
    if (r.kgQty && cur.kgRows >= 1) flush();
    // A discount row whose LEFT side is the next product's name → the discount
    // belongs to the current product; the name opens the NEXT one.
    if (r.discount > 0 && strong) {
      // Split the fused row's WORDS by x: the right-aligned discount AMOUNT stays
      // with the current product; the left-aligned NEXT name opens a new product.
      // This keeps each product's BAND over only its own words (the name's box no
      // longer leaks onto the prior product, nor the price-only box onto the next).
      const amtX = Math.min(Infinity, ...r.words.filter((w) => /^-?[\d]/.test(w.text.trim())).map((w) => w.xLeft));
      const nameWs = r.words.filter((w) => w.xRight <= amtX - 1);
      const amtWs = r.words.filter((w) => w.xRight > amtX - 1);
      const mkRow = (ws: EWord[]): ERow => ({
        ...r, words: ws.length ? ws : r.words,
        topY: Math.min(...(ws.length ? ws : r.words).map((w) => w.yTop)),
        botY: Math.max(...(ws.length ? ws : r.words).map((w) => w.yBottom)),
        leftX: Math.min(...(ws.length ? ws : r.words).map((w) => w.xLeft)),
      });
      cur.discount += r.discount; cur.aCount++; cur.top ??= r;
      cur.rows.push(amtWs.length ? { ...mkRow(amtWs), leftText: '' } : r);
      flush();
      cur.nameParts.push(name);
      const nr = nameWs.length ? { ...mkRow(nameWs), leftText: name, discount: 0, total: null } : r;
      cur.top = nr; cur.rows.push(nr);
      continue;
    }
    if (r.discount > 0) { cur.discount += r.discount; cur.aCount++; cur.top ??= r; cur.rows.push(r); continue; }
    // A fresh strong name, or a SECOND total, begins a new product. A strong name
    // ALSO ends the current product when it already has a weight (perKg) even with
    // NO total — IKI dropped the total on this scan, but a new named product still
    // means the old one is done (prevents POMIDORAI absorbing RAUDONOSIOS).
    if ((strong || r.total != null) && cur.total != null) flush();
    else if (strong && cur.perKg != null) flush();
    if (name) cur.nameParts.push(name);
    if (r.perKg != null) cur.perKg = r.perKg;
    if (r.total != null) { cur.total = r.total; cur.price = r; cur.aCount++; }
    if (r.kgQty) cur.kgRows++;
    cur.top ??= r; cur.rows.push(r);
  }
  flush();
  if (out.length === 0) return [];

  out.sort((a, b) => a.top.topY - b.top.topY);

  // ── NAME RECOVERY (runs BEFORE banding so the name's words feed the box): IKI
  //    prints the NEXT product's name fused onto the prior product's discount line
  //    ("-0,72 A RAUDONOSIOS PAPRIKOS"). When the per-word clustering drops that
  //    name, the product survives as "?" with only its price row. Recover the name
  //    from the MLKit line, AND fold that line's NAME words into the product's rows
  //    so the band covers the name too (band ≡ content — never just the price). ──
  // Products whose name was recovered from the PRIOR product's discount line — their
  // band must "claim" that whole line (the seam goes ABOVE it) so the name isn't cut.
  const claimed = new Set<typeof out[number]>();
  const nameless = out.filter((o) => o.p.name === '?' || o.p.name === '');
  if (nameless.length) {
    const lead = /^\s*-\s?\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s+(.+)$/;
    const isAmtTok = (t: string) => /^-?[\d.,]+$/.test(t.trim()) || /^[ABC]$/.test(t.trim());
    const have = new Set(out.map((o) => o.p.name).filter((n) => n && n !== '?'));
    const cands: { name: string; y: number; li: number; used: boolean }[] = [];
    for (let i = start; i < end; i++) {
      const m = lines[i].text.match(lead);
      if (!m) continue;
      const nm = m[1].trim();
      if (!isNameStart(nm) || isTSkip(nm) || isTWeight(nm) || ikiLabelTail(nm)) continue;
      const clean = cleanProductName(nm);
      if (have.has(clean)) continue;                       // it already made it into a product
      cands.push({ name: clean, y: (lines[i].yTop + lines[i].yBottom) / 2, li: i, used: false });
    }
    for (const o of nameless) {
      // Anchor on the product's TOP (placeholder region = its first row): the fused
      // name sits on the PRIOR product's discount line, just ABOVE this product's
      // first row. A midpoint anchor drifts down to the NEXT product's fused name
      // and mis-pairs (e.g. Fasuoti onto RAUDONOSIOS's box).
      const oy = o.p.region.yTop ?? o.top.topY;
      let best = -1, bestD = lineH * 4;                    // pair only with a nearby leftover name
      for (let k = 0; k < cands.length; k++) {
        if (cands[k].used) continue;
        const d = Math.abs(cands[k].y - oy);
        if (d < bestD) { bestD = d; best = k; }
      }
      if (best < 0) continue;
      cands[best].used = true;
      o.p.name = cands[best].name;
      // Fold the recovered name into this product as a row so the band includes the
      // name's location. Prefer the real NAME words; if MLKit dropped them (the line
      // kept only its amount), SYNTHESISE a box over the line's LEFT portion (where
      // the name physically is — left of the amount). Either way, claim the line.
      const src = lines[cands[best].li];
      const nw = (src.words ?? []).filter((w) => w.text.trim() && !isAmtTok(w.text));
      let ews: EWord[];
      if (nw.length) {
        ews = nw.map((w) => ({ text: w.text, xLeft: w.xLeft, xRight: w.xRight, yTop: w.yTop, yBottom: w.yBottom, slope: 0, line: cands[best].li }));
      } else {
        const amts = (src.words ?? []).filter((w) => isAmtTok(w.text));
        const amtX = amts.length ? Math.min(...amts.map((w) => w.xLeft)) : src.xRight;
        ews = [{ text: cands[best].name, xLeft: src.xLeft, xRight: Math.max(src.xLeft + 1, amtX - 10), yTop: src.yTop, yBottom: src.yBottom, slope: 0, line: cands[best].li }];
      }
      o.rows.unshift({
        words: ews, leftText: cands[best].name, total: null, perKg: null, discount: 0, isSkip: false, kgQty: false,
        topY: Math.min(...ews.map((w) => w.yTop)), botY: Math.max(...ews.map((w) => w.yBottom)),
        leftX: Math.min(...ews.map((w) => w.xLeft)), slope: 0,
      });
      o.p.rawLines = [cands[best].name, ...o.p.rawLines];
      claimed.add(o);
    }
  }

  // ── band ≡ NAME (covers EVERY product, however its name was assigned): if no row
  //    already carries the recognised name's letters — e.g. the name was fused onto a
  //    neighbour's line and only the price row survived (band would be a sliver over
  //    the price column) — find the MLKit line bearing the name and fold its NAME
  //    words in, so the box always includes the name, not just the price. ──
  const letters = (s: string) => s.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').toUpperCase();
  const isAmt = (t: string) => /^-?[\d.,]+$/.test(t.trim()) || /^[ABC]$/.test(t.trim());
  for (const o of out) {
    const key = letters(o.p.name);
    if (key.length < 4) continue;                                // "?", numerics, OCR crumbs
    const probe = key.slice(0, 6);
    if (o.rows.some((r) => letters(r.words.map((w) => w.text).join('')).includes(probe))) continue;
    for (let i = start; i < end; i++) {
      const ws = lines[i].words;
      if (!ws || !ws.length) continue;
      const nw = ws.filter((w) => w.text.trim() && !isAmt(w.text));
      if (!nw.length) continue;
      const lk = letters(nw.map((w) => w.text).join(''));
      if (lk.length < 4 || !(lk.includes(probe) || key.includes(lk.slice(0, 6)))) continue;
      const ews: EWord[] = nw.map((w) => ({ text: w.text, xLeft: w.xLeft, xRight: w.xRight, yTop: w.yTop, yBottom: w.yBottom, slope: 0, line: i }));
      o.rows.unshift({
        words: ews, leftText: o.p.name, total: null, perKg: null, discount: 0, isSkip: false, kgQty: false,
        topY: Math.min(...ews.map((w) => w.yTop)), botY: Math.max(...ews.map((w) => w.yBottom)),
        leftX: Math.min(...ews.map((w) => w.xLeft)), slope: 0,
      });
      if (!o.p.rawLines.some((l) => letters(l).includes(probe))) o.p.rawLines = [o.p.name, ...o.p.rawLines];
      break;
    }
  }

  // ── bands: each product's box is the STRICT bounding parallelogram of the OCR
  //    WORDS that produced it (o.rows → words, including any recovered name). Band ≡
  //    extracted content: both come from the SAME rows, so they CANNOT diverge. The
  //    box uses ONE receipt tilt `g` (so boxes stay parallel and don't cut across
  //    rows) and tightly contains every word of the product. ──
  const W = (X1 - X0) || 1;
  // ONE receipt skew, measured from WIDE rows (a real physical line = left text +
  // right price). That Δy/Δx is the true rotation — reliable, unlike per-line
  // corners. Median over such rows, clamped to a sane receipt tilt.
  const wide: number[] = [];
  for (const r of rows) {
    if (r.isSkip || r.words.length < 2) continue;
    const lw = r.words.reduce((a, b) => (b.xLeft < a.xLeft ? b : a));
    const rw = r.words.reduce((a, b) => (b.xRight > a.xRight ? b : a));
    const lx = (lw.xLeft + lw.xRight) / 2, rx = (rw.xLeft + rw.xRight) / 2;
    if (rx - lx > 0.4 * W) wide.push((rw.yTop - lw.yTop) / (rx - lx));
  }
  const g = Math.max(-0.06, Math.min(0.06, emedian(wide)));
  const cx = (w: EWord) => (w.xLeft + w.xRight) / 2;
  const dT = (w: EWord) => w.yTop - g * cx(w);        // de-skewed top (g·x removed)
  const dB = (w: EWord) => w.yBottom - g * cx(w);     // de-skewed bottom
  // Per product: the de-skewed OVERALL content range [aTop,aBot]. Bands are PARALLEL-
  // OGRAMS (both edges share the ONE receipt tilt g), so a band can never twist or
  // invert and every product's box contains all of its own words.
  const metas = out.map((o) => {
    const ws = o.rows.flatMap((r) => r.words);
    return { o, aTop: Math.min(...ws.map(dT)), aBot: Math.max(...ws.map(dB)) };
  });
  metas.sort((a, b) => a.aTop - b.aTop);
  // ONE consistent seam per pair: a single straight line at the MIDPOINT between
  // consecutive products' de-skewed content (closes gaps AND splits tilt overlaps),
  // shared on both edges so every seam has the SAME bend (parallel to g) and nothing
  // gets sliced or twisted. CLAIM puts the seam at the lower product's own top so a
  // name recovered from the prior discount line isn't cut. NOTE: discount/€-kg VALUES
  // are recovered during PARSING (ikiClassifyRow), independent of this geometry — so a
  // fused discount+name line still extracts correctly even though its band boundary is
  // a single straight seam (a tilted per-column seam there only ever twisted the band).
  for (let i = 1; i < metas.length; i++) {
    let s = (metas[i - 1].aBot + metas[i].aTop) / 2;
    if (claimed.has(metas[i].o)) s = Math.min(s, metas[i].aTop);
    metas[i - 1].aBot = s; metas[i].aTop = s;
  }
  // FULL WIDTH (section X0..X1); re-skewed by g into a parallelogram following the tilt.
  for (const m of metas) {
    const yLT = m.aTop + g * X0, yRT = m.aTop + g * X1;
    const yLB = m.aBot + g * X0, yRB = m.aBot + g * X1;
    m.o.p.region = {
      xLeft: X0, xRight: X1,
      yLeftTop: yLT, yRightTop: yRT, yLeftBottom: yLB, yRightBottom: yRB,
      yTop: Math.min(yLT, yRT), yBottom: Math.max(yLB, yRB),
    };
  }
  return out.map((o) => o.p);
}

function parseThermalProducts(lines: IkiLine[], start: number, end: number): IkiProduct[] {
  // 1) Explode OCR-fused rows into atomic tokens.
  const toks: ThermalTok[] = [];
  for (let i = start; i < end; i++) for (const tk of explodeThermalLine(lines[i])) toks.push(tk);

  const MAX_BLOCK = 8; // runaway guard for when a product name goes unrecognised
  const out: IkiProduct[] = [];
  // Column-scrambled OCR sometimes emits two product NAMES back-to-back and the
  // first one's price further down, leaked into the second product's block. A
  // name with an empty block is held here until the next product hands the
  // leaked pre-weight price back (see resolve below).
  let pending: { name: string; src: IkiLine } | null = null;
  let i = 0;
  while (i < toks.length) {
    if (!isNameStart(toks[i].text)) { i++; continue; }
    const name = toks[i].text;

    // 2) Block = tokens from here until the NEXT product name (bounded). Coupon /
    //    bag / points rows do NOT end the block — on scrambled OCR a product's
    //    price can land just after one — they're simply ignored when extracting.
    let next = i + 1;
    while (next < toks.length && next - i <= MAX_BLOCK && !isNameStart(toks[next].text)) next++;
    const block = toks.slice(i + 1, next);

    // weight → €/kg. The printed quantity is OCR-garbled often ("1, v68 kg"), so
    // we DERIVE qty from lineTotal ÷ €/kg below instead of trusting it.
    let perKg: number | null = null;
    let weightPos = -1;
    for (let b = 0; b < block.length; b++) {
      if (isTWeight(block[b].text)) { perKg = extractPerKg(block[b].text); weightPos = b; break; }
    }
    // line total: for a weighed item it's the first positive price AFTER the
    // weight row (skip any leaked neighbour price before it); else the first
    // positive price in the block.
    let lineTotal: number | null = null;
    let derivedFromQty = false;
    const from = perKg != null && weightPos >= 0 ? weightPos + 1 : 0;
    for (let b = from; b < block.length; b++) {
      if (isTPosPrice(block[b].text)) { lineTotal = parseNum(block[b].text); break; }
    }
    // Weighed item with NO printed line-total (OCR dropped it) → derive the total
    // from quantity × €/kg. The quantity is the kg on the weight row, OR — when
    // OCR split "0,720 kg X 3,99" into "0,72" + "0 kg X 3,99" (weight row leads
    // with a degenerate bare-integer kg) — the decimal fragment right before it.
    // That fragment is the QUANTITY, NOT a line total (the bug that made
    // pomidorai 0,72 € instead of 0,72 kg × 3,99 = 2,87 €).
    if (lineTotal == null && perKg != null && weightPos >= 0) {
      const lead = leadingKg(block[weightPos].text);
      if (lead && /[.,]/.test(lead)) {
        const qty = parseNum(lead);                              // weight row carries the full qty — trust it
        if (qty > 0) { lineTotal = round2(qty * perKg); derivedFromQty = true; }
      } else if (lead && weightPos > 0 && isTPosPrice(block[weightPos - 1].text)) {
        const qty = parseNum(block[weightPos - 1].text);         // split qty fragment; guard vs a scrambled total
        if (qty > 0 && qty * perKg < 100) { lineTotal = round2(qty * perKg); derivedFromQty = true; }
      }
    }
    // Last resort: a scrambled total printed ANYWHERE in the block (e.g. before
    // the weight). Skipped once we've derived from the printed quantity, so a
    // weight-quantity fragment can't be mistaken for the total.
    if (lineTotal == null && perKg != null && !derivedFromQty) {
      for (const b of block) if (isTPosPrice(b.text)) { lineTotal = parseNum(b.text); break; }
    }
    if (lineTotal == null) {
      // A real name with an EMPTY block (immediately followed by another name) is
      // the signature of column-scrambled OCR — its price was emitted out of
      // order into a later block. Hold it; the next weighed product returns the
      // leaked price. (Non-empty-but-priceless blocks are genuine junk → drop.)
      if (block.length === 0) pending = { name, src: toks[i].src };
      i = Math.max(next, i + 1);
      continue;
    }

    // Resolve a pending (scrambled) product from THIS product's leaked pre-weight
    // price: a positive price BEFORE the weight row can't be a weighed item's own
    // total, so it belongs to the prior empty-block name. Emit it as a unit item.
    if (pending && perKg != null && weightPos > 0) {
      let leaked: number | null = null;
      for (let b = 0; b < weightPos; b++) {
        if (isTPosPrice(block[b].text)) { leaked = parseNum(block[b].text); break; }
      }
      if (leaked != null) {
        const ps = pending.src;
        const pr = regionOf([ps]);
        pr.yLeftTop = ps.yLeftTop ?? pr.yTop;
        pr.yRightTop = ps.yRightTop ?? pr.yTop;
        pr.yLeftBottom = ps.yLeftBottom ?? pr.yBottom;
        pr.yRightBottom = ps.yRightBottom ?? pr.yBottom;
        out.push({
          name: cleanProductName(pending.name),
          price: leaked, promoPrice: null, quantity: 1, unit: 'vnt',
          pricePerUnit: leaked, rawLines: [pending.name], region: pr,
        });
      }
    }
    pending = null; // pending only survives to the immediately following product

    // per-product discounts anywhere in the block (loyalty + regular)
    let discount = 0;
    for (const b of block) {
      if (isTDiscount(b.text)) { const d = b.text.match(T_NEG_RE); if (d) discount += parseNum(d[1]); }
    }

    // Convention (matches the A4 parser + the price×quantity display): `price` is
    // the UNIT price. Weighed → €/kg + derived kg quantity; unit items → line
    // price + qty 1. `promoPrice` = per-unit price after discount (paid ÷ qty).
    const quantity = perKg != null && perKg > 0 ? round3(lineTotal / perKg) : 1;
    const unitPrice = perKg ?? lineTotal;
    const paid = round2(lineTotal - discount);
    // Band = the NAME line's OWN box (tight, tilt-following). This is the one
    // thing OCR is sure about — where the product name sits. The unified tiler
    // then drops each band's BOTTOM to the next product's name top, so every
    // product owns one clean, gap-free, non-overlapping slice. We do NOT try to
    // chase the (often column-scrambled) price/weight/discount rows into the band
    // height — that's what made the overlay unstable.
    const nameSrc = toks[i].src;
    const region: Region = {
      yTop: nameSrc.yTop,
      yBottom: nameSrc.yBottom,
      xLeft: nameSrc.xLeft,
      xRight: nameSrc.xRight,
      yLeftTop: nameSrc.yLeftTop ?? nameSrc.yTop,
      yRightTop: nameSrc.yRightTop ?? nameSrc.yTop,
      yLeftBottom: nameSrc.yLeftBottom ?? nameSrc.yBottom,
      yRightBottom: nameSrc.yRightBottom ?? nameSrc.yBottom,
    };
    out.push({
      name: cleanProductName(name),
      price: unitPrice,
      promoPrice: discount > 0 && quantity > 0 ? round2(paid / quantity) : null,
      quantity,
      // Weighed items (have a €/kg) are kg, not vnt — drives the
      // "0,720 kg × 3,99 €/kg" calculation line in the detail view.
      unit: perKg != null ? 'kg' : 'vnt',
      pricePerUnit: unitPrice,
      rawLines: [name, ...block.map((b) => b.text)],
      region,
    });
    i = next;
  }

  // NOTE: band WALLS (no-gap, no-overlap tiling) are applied later in
  // parseIkiThermal's unified pass, AFTER the skipped coupon/bag/points lines are
  // threaded in — so here each product keeps its TRUE content box (name-top +
  // price-row-bottom corners). The tiler turns those into seams.
  return out;
}

function parseIkiThermal(lines: IkiLine[]): IkiParseResult {
  const rawText = lines.map((l) => l.text).join('\n');
  const region = regionOf(lines);
  // ── ONE receipt tilt (gFoot), measured from WIDE OCR lines (a real left-to-right
  // line): Δy/Δx of its left-most vs right-most word. Used to BEND footer bands so
  // they follow the skew instead of sitting flat. Clamped to a sane rotation. ──
  const fSlopes: number[] = [];
  const fW = (region.xRight - region.xLeft) || 1;
  for (const l of lines) {
    const ws = l.words;
    if (!ws || ws.length < 2) continue;
    const lw = ws.reduce((a, b) => (b.xLeft < a.xLeft ? b : a));
    const rw = ws.reduce((a, b) => (b.xRight > a.xRight ? b : a));
    const lx = (lw.xLeft + lw.xRight) / 2, rx = (rw.xLeft + rw.xRight) / 2;
    if (rx - lx > 0.4 * fW) fSlopes.push((rw.yTop - lw.yTop) / (rx - lx));
  }
  const gFoot = Math.max(-0.06, Math.min(0.06, emedian(fSlopes)));
  // FOOTER field band: FULL WIDTH (receipt left→right) + BENT by gFoot, anchored in Y
  // to the words that carry the field VALUE when they survived (tight, off the merged
  // neighbour line), else the whole line bbox (stable — covers the value even when OCR
  // dropped its words). One rule for total / dateTime / receiptNo so they stop drifting.
  const footBand = (l: IkiLine, kind: RegionKind, value: string): LabeledRegion => {
    const X0 = region.xLeft, X1 = region.xRight;
    const key = value.replace(/[^0-9A-Za-z]/g, '');
    const ws = l.words ?? [];
    // words whose digits/letters overlap the value (e.g. "26,52" for total "26,52",
    // "2026-06-11" for the date) — these mark where the field actually sits.
    const hit = ws.filter((w) => {
      const k = w.text.replace(/[^0-9A-Za-z]/g, '');
      return k.length >= 2 && (key.includes(k) || k.includes(key.slice(0, 4)));
    });
    const src = hit.length ? hit : null;
    const cx = (w: IkiWord) => (w.xLeft + w.xRight) / 2;
    const aTop = src
      ? Math.min(...src.map((w) => w.yTop - gFoot * cx(w)))
      : l.yTop - gFoot * ((l.xLeft + l.xRight) / 2);
    const aBot = src
      ? Math.max(...src.map((w) => w.yBottom - gFoot * cx(w)))
      : l.yBottom - gFoot * ((l.xLeft + l.xRight) / 2);
    const yLT = aTop + gFoot * X0, yRT = aTop + gFoot * X1;
    const yLB = aBot + gFoot * X0, yRB = aBot + gFoot * X1;
    return {
      kind, xLeft: X0, xRight: X1,
      yLeftTop: yLT, yRightTop: yRT, yLeftBottom: yLB, yRightBottom: yRB,
      yTop: Math.min(yLT, yRT), yBottom: Math.max(yLB, yRB),
    };
  };
  // Build a band from a span of consecutive WORD boxes (left word + right word),
  // each contributing its OWN top/bottom Y so the band bends with the receipt
  // curve and hugs exactly that text. The shared anchor used by every field band.
  const wordSpan = (kind: RegionKind, left: IkiWord, right: IkiWord): LabeledRegion => ({
    kind,
    xLeft: left.xLeft, xRight: right.xRight,
    yTop: Math.min(left.yTop, right.yTop),
    yBottom: Math.max(left.yBottom, right.yBottom),
    yLeftTop: left.yTop, yLeftBottom: left.yBottom,
    yRightTop: right.yTop, yRightBottom: right.yBottom,
  });
  const regionFor = (l: IkiLine, kind: RegionKind): LabeledRegion => {
    // WORD-anchored when per-word boxes exist: span the first→last word, taking
    // each end's real Y. Tightly hugs the actual text and bends with the curve,
    // instead of trusting the line's `frame`/cornerPoints (which MLKit can return
    // flat or inflated across merged rows).
    const ws = l.words;
    if (ws && ws.length >= 1) return wordSpan(kind, ws[0], ws[ws.length - 1]);
    return {
      kind, yTop: l.yTop, yBottom: l.yBottom, xLeft: l.xLeft, xRight: l.xRight,
      yLeftTop: l.yLeftTop ?? l.yTop, yRightTop: l.yRightTop ?? l.yTop,
      yLeftBottom: l.yLeftBottom ?? l.yBottom, yRightBottom: l.yRightBottom ?? l.yBottom,
    };
  };

  // The RAW line bbox (full width AND full height) as a flat band. The STABLE
  // fallback for a footer field whose anchor word MLKit dropped from the line's
  // word array (e.g. "Kvito Nr."/"Laikas" missing, leaving only a stray amount on
  // the same scrambled line) — covers the whole line, so it always sits ON the data
  // instead of anchoring to the wrong surviving word or a mis-estimated char slice.
  const lineBox = (l: IkiLine, kind: RegionKind): LabeledRegion => ({
    kind, xLeft: l.xLeft, xRight: l.xRight, yTop: l.yTop, yBottom: l.yBottom,
    yLeftTop: l.yTop, yRightTop: l.yTop, yLeftBottom: l.yBottom, yRightBottom: l.yBottom,
  });

  // Narrow a band to a horizontal SLICE of a line — e.g. just "Laikas 21:07:53"
  // on a "Prekiautojo ID 15027037 Laikas 21:07:53" line, so the time band sits on
  // the time and not the unrelated left half. x is estimated from the character
  // offset (thermal print is ~monospace); the corner Y are interpolated along the
  // line's OWN tilt so the slice stays glued to the text on a skewed receipt.
  const regionForSlice = (l: IkiLine, kind: RegionKind, startChar: number, endChar: number): LabeledRegion => {
    const len = Math.max(1, l.text.length);
    const lxL = l.xLeft, w = l.xRight - l.xLeft;
    const xA = lxL + (Math.max(0, startChar) / len) * w;
    const xB = lxL + (Math.min(endChar, len) / len) * w;
    const lt = l.yLeftTop ?? l.yTop, rt = l.yRightTop ?? l.yTop;
    const lb = l.yLeftBottom ?? l.yBottom, rb = l.yRightBottom ?? l.yBottom;
    const topAt = (x: number) => lt + (w ? (x - lxL) / w : 0) * (rt - lt);
    const botAt = (x: number) => lb + (w ? (x - lxL) / w : 0) * (rb - lb);
    const yTL = topAt(xA), yTR = topAt(xB), yBL = botAt(xA), yBR = botAt(xB);
    return {
      kind, xLeft: xA, xRight: xB,
      yTop: Math.min(yTL, yTR), yBottom: Math.max(yBL, yBR),
      yLeftTop: yTL, yRightTop: yTR, yLeftBottom: yBL, yRightBottom: yBR,
    };
  };

  // "Kvito Nr. 168/645/104148 Kasa 0027" → band anchored to the real WORD boxes:
  // left edge = the "Kvito" word (the K that starts the line), right edge = the
  // "Kasa" word (the K that ends it). The two words' own top/bottom Y let the
  // band bend with the receipt curve and hug exactly that one line. Falls back to
  // "0027" (Kasa's number) then the last word if the K of "Kasa" is smudged, and
  // to the whole-line box when no per-word data is available.
  const receiptNoRegion = (l: IkiLine): LabeledRegion => {
    const ws = l.words;
    // Word-anchor ONLY when the real "Kvito" word survived — otherwise anchoring to
    // ws[0] grabs a stray amount ("26, 52" that OCR put first but is physically on
    // the right) and the band lands on the wrong block. No Kvito word → line bbox.
    const left = ws?.find((w) => /kvito/i.test(w.text));
    if (ws && left) {
      const kasa = ws.find((w) => /kasa/i.test(w.text));
      const right = kasa
        ?? ws.find((w) => /^\d{3,4}$/.test(w.text) && w.xLeft > left.xRight)
        ?? ws[ws.length - 1];
      if (right.xLeft > left.xLeft) {
        return {
          kind: 'receiptNo',
          xLeft: left.xLeft, xRight: right.xLeft,
          yTop: Math.min(left.yTop, right.yTop),
          yBottom: Math.max(left.yBottom, right.yBottom),
          yLeftTop: left.yTop, yLeftBottom: left.yBottom,
          yRightTop: right.yTop, yRightBottom: right.yBottom,
        };
      }
    }
    return lineBox(l, 'receiptNo');
  };

  // ── header: company (PVM) code (with bbox band) ──
  const headerRegions: LabeledRegion[] = [];
  let pvmCode = '';
  let pvmLineIdx = -1;
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    // PVM/VAT code — tolerate OCR confusions in the "LT" prefix (e.g. "LI") and a
    // digit run SPLIT by stray spaces ("LT1019372 19" for LT101937219). Grab the
    // alphanumeric run after "kodas" (spaces allowed inside, stripped after), else
    // a bare 2-letter+digits token. OCR also garbles "kelio kodas" → "kel jo
    // kodas", so match a bare "kodas".
    const pv = lines[i].text.match(/kodas\s*([A-Z]{0,2}\d[\d ]{6,14}\d)/i) ?? lines[i].text.match(/\b([A-Z]{2}\d{9,12})\b/);
    // FULL-WIDTH + bent band (footBand), not a word-span: OCR routinely drops every
    // word of this line but "PVN" (receipt-64), which would shrink a word-anchored
    // band to a stub. footBand spans the receipt and falls back to the line bbox Y.
    if (pv) { pvmCode = pv[1].replace(/\s+/g, ''); pvmLineIdx = i; headerRegions.push(footBand(lines[i], 'storeCode', pvmCode)); break; }
  }

  // ── product bounds ── Products begin AFTER the header block. Prefer an
  // explicit "PVM mokėtojo kodas" line; else the company-code line; else 0.
  // Leaving pStart at 0 would let the IKI-name/address/code lines be scanned as
  // products and pull the first band's top up to the top of the receipt.
  let pStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/PVM\s+mok[eė]tojo\s+kodas/i.test(lines[i].text)) { pStart = i + 1; break; }
  }
  if (pStart === 0 && pvmLineIdx >= 0) pStart = pvmLineIdx + 1;

  // Store address: scan ONLY the header zone (lines up to the company-code line),
  // never the product rows — otherwise a product line ("SKANĖ … BASMATI, 8") gets
  // mistaken for the address. The address is routinely OCR-fused onto the chain
  // name ("IKI Lietuva, UA8 Gardino g. 2-2, Siauliai"); strip that leading
  // "… Lietuva, UAB" company prefix (chain-name agnostic — OCR garbles "IKI" →
  // "KI"), then accept the remainder as the address when it has a number + comma
  // + letters (street + city). Don't require a literal "g." — OCR turns it into
  // "9." etc.
  let storeAddress = '';
  const addrEnd = pvmLineIdx >= 0 ? pvmLineIdx + 1 : Math.min(4, lines.length);
  for (let i = 0; i < addrEnd; i++) {
    const stripped = lines[i].text.replace(/^.*?Lietuva,?\s*UA[B8]?\s*/i, '').trim();
    if (/\d/.test(stripped) && /,/.test(stripped) && /[A-Za-zĄČĘĖĮŠŲŪŽ]/.test(stripped) && !/PVM|kodas/i.test(stripped)) {
      storeAddress = stripped;
      headerRegions.push(footBand(lines[i], 'storeAddress', storeAddress));
      break;
    }
  }
  let pEnd = lines.length;
  for (let i = pStart; i < lines.length; i++) {
    if (T_PRODUCTS_END_RE.test(lines[i].text)) { pEnd = i; break; }
  }
  // COLUMN ENGINE dispatch (flag-gated): use it when enough per-word data exists
  // AND it actually yields products; otherwise fall back to the legacy tokenizer.
  const engineProducts = USE_COLUMN_ENGINE && ikiHasWords(lines, pStart, pEnd)
    ? parseIkiColumnar(lines, pStart, pEnd)
    : null;
  const usedEngine = !!engineProducts && engineProducts.length > 0;
  const products = usedEngine ? engineProducts! : parseThermalProducts(lines, pStart, pEnd);

  // ── TOP-SECTION band walls (skew-aware) ──
  // Tile the header bands like the products: each band's BOTTOM edge is pinned to
  // the next band's TOP edge (per-corner, so the seam follows the receipt tilt),
  // so stacked header bands (address over company-code) neither overlap nor sit
  // flat. Then pin product 1's TOP to the header's bent BOTTOM edge — the top
  // section now bends as one piece AND a product band can NEVER overlap the
  // header (hard rule), with the seam following the tilt instead of a flat line.
  headerRegions.sort((a, b) => a.yTop - b.yTop);
  for (let k = 0; k < headerRegions.length - 1; k++) {
    const cur = headerRegions[k], nxt = headerRegions[k + 1];
    if (cur.yBottom > nxt.yTop) {
      cur.yBottom = Math.max(cur.yTop, nxt.yTop);
      cur.yLeftBottom = nxt.yLeftTop ?? nxt.yTop;
      cur.yRightBottom = nxt.yRightTop ?? nxt.yTop;
    }
  }
  if (products.length > 0) {
    // Bottommost header EDGE, carrying its skew corners — from the raw header
    // lines (before pStart, whether or not they got a band) AND detected bands,
    // so it's bulletproof even when a header line is too garbled to be recognised.
    const edges: Array<{ yb: number; yL: number; yR: number }> = [];
    if (pStart > 0) for (const l of lines.slice(0, pStart)) edges.push({ yb: l.yBottom, yL: l.yLeftBottom ?? l.yBottom, yR: l.yRightBottom ?? l.yBottom });
    for (const r of headerRegions) edges.push({ yb: r.yBottom, yL: r.yLeftBottom ?? r.yBottom, yR: r.yRightBottom ?? r.yBottom });
    if (edges.length > 0) {
      const bound = edges.reduce((a, b) => (b.yb > a.yb ? b : a));
      const r0 = products[0].region;
      // CLAMP DOWN only — never pull product 1's top UP into the header. The first
      // band starts at its OWN name; it is only pushed below the header edge if its
      // name would otherwise overlap the header. This leaves the PVM-code line and
      // the dashed separator above it as a clean gap instead of absorbing them.
      const yLT = r0.yLeftTop ?? r0.yTop, yRT = r0.yRightTop ?? r0.yTop;
      r0.yLeftTop = Math.max(yLT, bound.yL);
      r0.yRightTop = Math.max(yRT, bound.yR);
      r0.yTop = Math.min(r0.yLeftTop, r0.yRightTop);
    }
  }

  // ── skipped lines (coupons / bags / loyalty points) in the product section:
  //    their own grey bands in the photo view, but never counted as products ──
  const skippedRegions: LabeledRegion[] = [];
  for (let i = pStart; i < pEnd; i++) {
    // lineBox (whole-line bbox): a coupon/bag/points line is often "<amount> <skip
    // word>" where MLKit kept only the amount word — a word-anchored band would grey
    // just the amount. The full line bbox greys the whole skipped row.
    if (isTSkip(lines[i].text)) skippedRegions.push(lineBox(lines[i], 'skipped'));
  }

  // ── band walls across PRODUCTS + SKIPPED lines (EDGE-TO-EDGE partition) ──
  // Dead-simple and STABLE: sort every band (each is its NAME-line box) top→bottom,
  // give them a common width, then drop each band's BOTTOM to the NEXT band's TOP
  // (per corner, so the seam follows the tilt). Every product therefore owns one
  // contiguous slice from its own name down to the next product's name — gap-free
  // and, by construction, NEVER overlapping. The last band runs to the bottom of
  // the product section. No content-chasing, no margins, no heuristics: the seam
  // is ALWAYS the next recognised name, which is the one thing OCR is sure of.
  // Legacy edge-to-edge tiler — only when the COLUMN ENGINE didn't run (it bands
  // its own products). Skipped lines keep their own word-anchored boxes either way.
  const bands: Region[] = usedEngine ? [] : [...products.map((p) => p.region), ...skippedRegions];
  if (bands.length > 0) {
    const X0 = Math.min(...bands.map((r) => r.xLeft));
    const X1 = Math.max(...bands.map((r) => r.xRight));
    // Extend each band to the section's full width while CONTINUING its own tilt
    // (slope clamped to a sane receipt skew), so the right-aligned price — well to
    // the right of a left-aligned name — is covered instead of clipped by a flat
    // extension. Slope comes from the name line's own (now element-derived) corners.
    for (const r of bands) {
      const w = r.xRight - r.xLeft;
      if (w > 1) {
        const ltY = r.yLeftTop ?? r.yTop, rtY = r.yRightTop ?? r.yTop;
        const lbY = r.yLeftBottom ?? r.yBottom, rbY = r.yRightBottom ?? r.yBottom;
        const clamp = (s: number) => Math.max(-0.08, Math.min(0.08, s));
        const sT = clamp((rtY - ltY) / w), sB = clamp((rbY - lbY) / w);
        r.yLeftTop = ltY + sT * (X0 - r.xLeft);
        r.yRightTop = ltY + sT * (X1 - r.xLeft);
        r.yLeftBottom = lbY + sB * (X0 - r.xLeft);
        r.yRightBottom = lbY + sB * (X1 - r.xLeft);
      }
      r.xLeft = X0; r.xRight = X1;
    }
    bands.sort((a, b) => a.yTop - b.yTop);
    // Snapshot each band's own name-TOP corners before we start moving bottoms.
    const tops = bands.map((r) => ({ l: r.yLeftTop ?? r.yTop, r: r.yRightTop ?? r.yTop }));
    // Bottom of the product section (lowest OCR line edge) for the final band.
    let sbL = -Infinity, sbR = -Infinity;
    for (let i = pStart; i < pEnd; i++) {
      const lb = lines[i].yLeftBottom ?? lines[i].yBottom;
      const rb = lines[i].yRightBottom ?? lines[i].yBottom;
      if (lb > sbL) sbL = lb;
      if (rb > sbR) sbR = rb;
    }
    for (let k = 0; k < bands.length - 1; k++) {
      const cur = bands[k], nt = tops[k + 1];
      // Seam = next band's name top, clamped so it never rises above this band's
      // own top (degenerate ordering safety).
      const sL = Math.max(nt.l, cur.yLeftTop ?? cur.yTop);
      const sR = Math.max(nt.r, cur.yRightTop ?? cur.yTop);
      cur.yLeftBottom = sL;
      cur.yRightBottom = sR;
      cur.yBottom = Math.max(sL, sR);
    }
    const last = bands[bands.length - 1];
    last.yLeftBottom = Math.max(last.yLeftTop ?? last.yTop, sbL);
    last.yRightBottom = Math.max(last.yRightTop ?? last.yTop, sbR);
    last.yBottom = Math.max(last.yLeftBottom, last.yRightBottom);
  }

  // ── footer fields (scan whole receipt; take first hit) + bbox bands ──
  let total: number | null = null;
  let receiptNo = '';
  let totalSavings: number | null = null;
  let date = '';
  let time = '';
  let dateLine: IkiLine | undefined;
  let timeLine: IkiLine | undefined;
  let timeMatch: RegExpMatchArray | undefined;
  let sumaPending = false; // previous line had a bare "SUMA" keyword w/o an amount
  const footerRegions: LabeledRegion[] = [];
  for (const l of lines) {
    const t = l.text;
    // Total is printed in (up to) THREE forms — band EVERY one, take the VALUE
    // from the first:
    //   1. canonical "SUMA 26,52 EUR" / "26,52 EUR SUMA" (amount-order tolerant)
    //   2. SUMA split across two lines — "Pardavimas SUMA" then "26,52 EUR …"
    //      (OCR breaks the row); the amount line right after a bare SUMA is it.
    //   3. the "26,52 Mokėti" payment line.
    const sm = t.match(T_SUMA_RE);
    const sumaAmt = sm ? (sm[1] ?? sm[2]) : null;
    // footBand: full-width + bent, anchored to the amount word (so it sits on the
    // total, not the merged "Patvirtintas" below) — falls back to the line bbox when
    // OCR kept only the "SUMA"/"Mokėti" keyword.
    if (sumaAmt) {
      if (total == null) total = parseNum(sumaAmt);
      footerRegions.push(footBand(l, 'total', sumaAmt));
    } else if (sumaPending) {
      const m = t.match(/(\d{1,4}[.,]\s?\d{2})\s*EUR/i);
      if (m) { if (total == null) total = parseNum(m[1]); footerRegions.push(footBand(l, 'total', m[1])); }
    } else if (/Mok[eė]t\s?i/i.test(t)) {
      // A "Mokėti" line with the amount on either side; ignore the VAT-breakdown
      // header ("…Mokestis Suma su PVM…") which has "Mok…" but no bare price.
      const m = t.match(/(\d{1,4}[.,]\s?\d{2})/);
      if (m) {
        if (total == null) total = parseNum(m[1]);
        footerRegions.push(footBand(l, 'total', m[1]));
      }
    }
    // Arm the split-SUMA look-ahead for the NEXT line: this line names SUMA but
    // carries no amount itself.
    sumaPending = !sumaAmt && /\bSUMA\b/i.test(t) && !/\d{1,4}[.,]\s?\d{2}\s*EUR/i.test(t);
    if (!receiptNo) { const m = t.match(T_RECEIPTNO_RE); if (m) { receiptNo = m[1]; footerRegions.push(footBand(l, 'receiptNo', m[1])); } }
    if (totalSavings == null) { const m = t.match(T_SAVINGS_RE); if (m) totalSavings = parseNum(m[1]); }
    if (!date) { const m = t.match(T_DATE_RE); if (m) { date = `${m[1]}-${m[2]}-${m[3]}`; dateLine = l; } }
    if (!time) { const m = t.match(T_TIME_RE); if (m) { time = `${m[1]}:${m[2]}`; timeLine = l; timeMatch = m; } }
  }
  // Date + time bands: one combined 'dateTime' band when they share a line,
  // else a 'date' AND a 'time' band so BOTH are covered — IKI prints
  // "Data 2026-06-11 Laikas 21:07:53" and OCR often splits it into two boxes, so
  // banding only the date left the time (Laikas) uncovered.
  if (dateLine && timeLine && dateLine === timeLine) {
    // Whole line "Data 2026-06-11 Laikas 21:07:53": anchor in Y to the DATE words
    // (they survive; the Laikas/time words are usually dropped) and extrapolate the
    // band full-width + bent so its right side lands on Laikas at the tilted Y.
    footerRegions.push(footBand(dateLine, 'dateTime', date));
  } else {
    if (dateLine) footerRegions.push(footBand(dateLine, 'date', date));
    if (timeLine && timeMatch) {
      footerRegions.push(footBand(timeLine, 'time', timeMatch[0]));
    } else if (timeLine) {
      footerRegions.push(footBand(timeLine, 'time', time));
    }
  }
  footerRegions.sort((a, b) => a.yTop - b.yTop);

  return {
    header: { chainName: 'IKI', storeCode: '', storeName: '', storeAddress, pvmCode, rawText, region, lineRegions: headerRegions },
    products,
    footer: { total, date, time, receiptNo, totalSavings, rawText, region, lineRegions: footerRegions },
    skippedRegions,
  };
}

// ───────── public entry points ─────────

export function parseIkiReceipt(lines: IkiLine[]): IkiParseResult {
  // Thermal POS receipts (physical scanned) have no column header — dispatch to
  // the single-column thermal parser above.
  if (findFirstColumnHeader(lines) < 0) return parseIkiThermal(lines);
  // Date/time are in the header area on IKI; we still surface them via the
  // footer object to match the Rimi/Maxima interface the downstream UI reads.
  // Order can be either `YYYY MM DD HH:MM` or `HH:MM YYYY MM DD` — parse them
  // independently so either layout works. Tracking the source lines so the
  // Kvitas-tab photo can band them precisely.
  let date = "";
  let time = "";
  let dateLine: IkiLine | undefined;
  let timeLine: IkiLine | undefined;
  for (const line of lines.slice(0, 8)) {
    if (!date) {
      const d = line.text.match(DATE_ONLY_RE);
      if (d) {
        date = `${d[1]}-${d[2]}-${d[3]}`;
        dateLine = line;
      }
    }
    if (!time) {
      const t = line.text.match(TIME_ONLY_RE);
      if (t) {
        time = `${t[1]}:${t[2]}`;
        timeLine = line;
      }
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

  // Push date/time line bboxes into the header's per-line regions —
  // they physically live in the top region of IKI receipts even
  // though the data is surfaced under the footer object. Same physical
  // line is the combined `dateTime` kind; distinct lines get split
  // `date` / `time` kinds — matches the Rimi parser convention.
  const pushIfNew = (line: IkiLine | undefined, kind: RegionKind) => {
    if (!line) return;
    const exists = header.lineRegions.some(
      (r) => r.yTop === line.yTop && r.yBottom === line.yBottom && r.kind === kind,
    );
    if (exists) return;
    header.lineRegions.push({
      kind,
      yTop: line.yTop,
      yBottom: line.yBottom,
      xLeft: line.xLeft,
      xRight: line.xRight,
    });
  };
  if (dateLine && timeLine && dateLine === timeLine) {
    pushIfNew(dateLine, 'dateTime');
  } else {
    pushIfNew(dateLine, 'date');
    pushIfNew(timeLine, 'time');
  }
  header.lineRegions.sort((a, b) => a.yTop - b.yTop);

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
