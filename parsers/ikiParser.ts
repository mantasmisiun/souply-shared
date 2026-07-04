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
  // Optional MID-COLUMN step (column engine's two-box band): when present, the band is an
  // 8-point polygon — a NAME box on the left [xLeft..xMid] and a PRICE/discount box on the
  // right [xMid..xRight], EACH a clean parallelogram riding the receipt tilt, joined by a
  // VERTICAL step at xMid. yMidTop/yMidBottom = the LEFT column's top/bottom AT xMid;
  // yMidTopR/yMidBottomR = the RIGHT column's. Equal pairs → no step (degenerates to a quad).
  // Lets the right column drop to a fused discount the left column excludes, without either
  // edge leaving the tilt. Absent → ordinary quad from the four corners.
  xMid?: number;
  yMidTop?: number;
  yMidBottom?: number;
  yMidTopR?: number;
  yMidBottomR?: number;
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
  // A by-WEIGHT line (priced per kg) is weighable. Set true on weighed rows so
  // the server resolver keeps a weighable catalog SP instead of treating the
  // null/false flag as a form mismatch and falling through to name-dedup (which
  // can capture a garbled same-name orphan). See receiptLineResolver weighableMismatch.
  isWeighable?: boolean;
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
  receiptNo: string;             // CANONICAL id (= receiptNos[0]) — backwards-compatible single value
  receiptNos: string[];          // every distinct receipt identifier on the footer (canonical first)
  totalSavings: number | null;
  /** POSITIVE magnitude of IKI's bare-"RINKINYS" combo/set-deal discounts (the dropped
   *  rows' negatives, e.g. 1.90 for "RINKINYS -1,90"), null when none. A receipt-LEVEL
   *  adjustment: the paid total is Σproducts − comboDiscount. Deliberately NOT distributed
   *  onto products (which product(s) form the bundle is unknown — distributing would poison
   *  per-product reference prices). Additive field — old consumers ignore it. */
  comboDiscount: number | null;
  /** Phase-2 receipt reconciliation: true = Σ line-paids + dropped charges − combo equals the
   *  printed total to the cent (prices corroborated); false = the books don't balance or an
   *  unknown couldn't be pinned (honest flag); undefined = not checked (legacy engine /
   *  fallback total). Additive optional fields — old consumers ignore them. */
  reconciled?: boolean;
  reconDelta?: number;
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

// ── LITHUANIAN RECEIPT KEYWORD LEXICON (Phase 3, shared/ROBUST_PARSING_PLAN.md) ──
// ONE fuzzy matcher for receipt label words instead of a skeleton regex per keyword per
// garble: FOLD (lowercase → de-diacritic → confusion-glyph map → strip non-letters,
// spaces included) → banded edit-distance SUBSTRING match with a per-keyword budget →
// per-keyword REJECT guards (KORIANDRAS is not KORTELĖ). A new garble is either inside
// the budget already (zero code) or a one-line data entry. Inlined here (not a module)
// because shared parsers are single-file by convention — Metro/jest resolve value
// imports differently than the api's nodenext tsc; extract once both are configured.
// Exported for tests and for the other chain parsers when they migrate.

export interface LexKeyword {
  word: string;
  /** max edit distance; default ceil(len/4) capped at 3 */
  budget?: number;
  rejects?: string[];
}

const GLYPH_LEX_FOLD: Record<string, string> = {
  '0': 'o', '1': 'i', '|': 'i', '!': 'i', 'l': 'i', 'í': 'i', 'ì': 'i',
  '5': 's', '$': 's', '8': 'b', '6': 'b', '2': 'z', '7': 'z', '9': 'g', '4': 'a',
  '3': 'e', '€': 'e', '(': 'c', '{': 'c', '[': 'c',
};

export function foldLex(s: string): string {
  let out = '';
  const lowered = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const ch of lowered) {
    const mapped = GLYPH_LEX_FOLD[ch] ?? ch;
    if (/[a-z]/.test(mapped)) out += mapped;
  }
  return out;
}

/** Approximate-substring edit distance (free start/end in `text`), banded at maxDist. */
export function substringEditDistance(pattern: string, text: string, maxDist: number): number {
  const m = pattern.length, n = text.length;
  if (m === 0) return 0;
  if (n === 0) return m > maxDist ? Infinity : m;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= n; j++) {
      const sub = prev[j - 1] + (pattern[i - 1] === text[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > maxDist) return Infinity;
    prev = cur;
  }
  let best = Infinity;
  for (let j = 0; j <= n; j++) if (prev[j] < best) best = prev[j];
  return best <= maxDist ? best : Infinity;
}

const lexBudget = (len: number) => Math.min(3, Math.ceil(len / 4));

/** Best in-budget occurrence distance of `kw` in the line (0 = printed cleanly), or
 *  null when absent / better explained by a reject word. */
export function keywordDistance(lineText: string, kw: LexKeyword): number | null {
  const folded = foldLex(lineText);
  if (!folded) return null;
  const pat = foldLex(kw.word);
  const budget = kw.budget ?? lexBudget(pat.length);
  const d = substringEditDistance(pat, folded, budget);
  if (d === Infinity) return null;
  for (const rej of kw.rejects ?? []) {
    const rd = substringEditDistance(foldLex(rej), folded, budget);
    if (rd < d) return null;
  }
  return d;
}

export function hasKeyword(lineText: string, kw: LexKeyword): boolean {
  return keywordDistance(lineText, kw) != null;
}

export const LEX = {
  /** the savings line ("sutaupete", "sutaupëje", split forms) */
  SUTAUPETE: { word: 'sutaupete', rejects: ['suteikta'] } as LexKeyword,
  /** the trader-id products-end wall ("Pr ekiaut o", "Prckiautojo") */
  PREKIAUTOJO: { word: 'prekiautojo' } as LexKeyword,
  /** loyalty-card word ("KORTFLE", "KOR(ELĖS", "KURTELA") — not yet consumed, staged */
  KORTELE: { word: 'kortele', budget: 2, rejects: ['koriandras', 'kornai', 'kartele'] } as LexKeyword,
  /** discount label ("NUOLATDA", "HUOLA!DA", "UOLAINA") — not yet consumed, staged.
   *  NOTE for migration: "nuolat" (the adverb, marketing footer lines) can NOT be a
   *  substring reject — it is a PREFIX of nuolaida and would veto real garbles. The
   *  discrimination is contextual (discount rows carry amounts; marketing lines are in
   *  the trailer) and belongs to the consumer's gates, exactly like the old skeleton's. */
  NUOLAIDA: { word: 'nuolaida', budget: 2 } as LexKeyword,
} as const;

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
    // a band-merge can leak a weight/unit-calc tail ("… EUR/ kg", "… EUR/ vr") into the NAME row
    // (DZIOVINTOS SLYVOS). "EUR/" is only ever a price-calc marker, never part of a product name,
    // so strip the remnant. (Bare "kg"/"vnt" without the "EUR/" lead are left — a name may hold "1 kg".)
    .replace(/\s*EUR\s*\/?\s*(?:kg|vr|yr|vnt|vie|vnet)\b/gi, "")
    // a column-merge can leave an already-consumed DISCOUNT token mid-name ("DVARO … RIEBUM
    // -0,84 2,79 A" → total stripped, "-0,84" stranded — receipt-275). A product name never
    // contains a negative decimal; drop it (and its VAT letter, when glued right after).
    .replace(/(^|\s)-\s?\d{1,4}[.,]\s?\d{2}(\s+[ABC])?(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// A per-unit multi-buy calc row ("N vnt. X P,PP EUR/ vr") can get COLUMN-MERGED into the
// product's NAME row and interleaved by x ("Žaliosios 2 vnt. X cukinijos 1,49 EUR/ VI",
// receipt-214/215): the price ends up NON-adjacent to "vnt X", so T_UNIT_CALC_RE (which needs
// them adjacent) never fires — the calc pollutes the name AND the qty stays 1. Recover it from
// the assembled name: pull the unit count and strip the two calc fragments, returning the clean
// name. Requires BOTH a "N vnt" lead AND a "P,PP EUR/…" price so a plain "2 vnt" in a real name
// can't trigger it; unitQty is returned only for a genuine multi-buy (≥2).
function extractInterleavedMultibuy(name: string): { name: string; unitQty: number | null } {
  const qtyM = name.match(/\b(\d{1,3})\s*vnt\b/i);
  const priceM = /\d{1,4}[.,]\s?\d{2}\s*EUR\s*\/?\s*[A-Za-z0-9]{0,3}/i.test(name);
  if (!qtyM || !priceM) return { name, unitQty: null };
  const n = parseInt(qtyM[1], 10);
  const cleaned = name
    .replace(/\b\d{1,3}\s*vnt\.{0,2}\s*[xX×*]?\s*/i, ' ')                 // "2 vnt. X "
    .replace(/\d{1,4}[.,]\s?\d{2}\s*EUR\s*\/?\s*[A-Za-z0-9]{0,3}/i, ' ')  // "1, 49 EUR/ VI"
    .replace(/\s+/g, ' ').trim();
  return { name: cleaned, unitQty: n >= 2 ? n : null };
}

// ───────── detection ─────────

export function isIkiReceipt(lines: string[]): boolean {
  const head = lines.slice(0, 10).join(" ").toUpperCase();
  // Either the IKI store header line or any column-header row is a strong
  // signal — much stronger than a bare "IKI" which could appear elsewhere.
  if (/\bIKI\s*[-–—]/.test(head)) return true;
  // Thermal POS receipts open with "IKI Lietuva, UAB" (no column header).
  if (/\bIKI\s+LIETUVA\b/.test(head)) return true;
  if (lines.slice(0, 30).some(isColumnHeader)) return true;
  // STAINED / CUT-OFF HEADER FALLBACK: when the top is unreadable, the rest of an IKI receipt
  // is saturated with IKI-only markers — the iki.lt domain, the "IKI kortelė" loyalty card,
  // and the "IKI taškai" points lines (Buvę / Pridėti / Panaudoti / VISI IKI Taškai). Any ONE
  // is decisive. Each is a COMPOUND form unique to IKI — never a bare "IKI", which is also the
  // Lithuanian word "until" (e.g. "galioja iki 2026-…") — so this can't false-positive on
  // another chain. OCR-tolerant: IK! / IKl / IK1 for the mangled final I, S-or-Š in taškai.
  const full = lines.join(" ").toUpperCase();
  const IKI = 'IK[I!L1]';
  return (
    new RegExp(`\\b${IKI}\\s*[.,]\\s*LT\\b`).test(full) ||   // the iki.lt / www.iki.lt domain
    new RegExp(`\\b${IKI}\\s*KORTEL`).test(full) ||          // "IKI KORTELĖS" / "su IKI kortele"
    new RegExp(`\\b${IKI}\\s*TA[SŠ]K`).test(full) ||         // "IKI Taškai" / "IKI taškų"
    new RegExp(`\\b${IKI}\\s+LIETUVA\\b`).test(full)         // header line wherever it landed
  );
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
    receiptNos: [],
    totalSavings,
    comboDiscount: null,
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
// "EUR" but OCR-tolerant: the E/U/R routinely come back accented/garbled on a curled
// thermal print — "ÉUR", "ĖUR", "EUŘ", "ÉUŘ", and the E mis-read as F ("FUR", a very
// common thermal glyph confusion — receipt-105 salmon "16 99 FUR/kg" + paprikos
// "3,49 FUR/kg"). Without this, a weighed row's €/kg slot is unrecognised and the
// whole item silently drops to a unit price / leaks the weight line into the name
// (receipt-96 POMIDORAI, receipt-105 salmon).
// "EUR" with the U DROPPED reads "ER/" (receipt-268 agurkai: "2,99 ER/ kg" — the weight
// row went unrecognized and the product never closed, swallowing the next one). The
// U-less alternative requires the following slash, so a stray "er" inside a word can
// never qualify as the currency marker.
const T_EUR = '(?:[EÉĖÈÊF][UÜŪ][RŘ]|[EÉĖÈÊF][RŘ]\\s*/)';
const T_WEIGHT_LOOSE_RE = new RegExp(`\\bkg\\b\\s*[xXyY×*].*${T_EUR}`, 'i'); // any "… kg X … EUR/kg" row (OCR reads the × as X/Y/*)
// A weighed QUANTITY token ("0,470 kg", "2,090 kg") — 3-decimal kg. Survives even
// when OCR drops the "X €/kg" tail (so the EUR-based weight test above misses it).
// Every weighed IKI item prints exactly ONE, so a SECOND one = a new product.
const T_KG_QTY_RE = /\d[.,]\s?\d{3}\s*[-–—·.]?\s*kg\b/i; // interpunct-tolerant (see T_KG_LEAD_RE)
// UNIT-quantity calc row "N vnt. X P,PP EUR/ Vr" (per-unit-priced multi-buy, "Vr" = vienetui) — the
// kg analogue of a weighed calc. Without it the whole calc string is mistaken for a product NAME
// and steals the real product's total. Group 1 = the unit count.
const T_UNIT_CALC_RE = /\b(\d{1,4})\s*vnt\.{0,2}\s*[xX×*]?\s*\d{1,4}[.,]\s?\d{2}\s*EUR\s*\/?\s*(?:[VU][rint1l]|vnt|vie|vnet)/i;   // \.{0,2}: OCR doubles the period ("2 vnt.. X 1,49 EUR/ Vr"); suffix "Vr" (vienetui) OCR-garbles to VI/V1/Vt/Ur (receipt-214)
const T_PERKG_RE = new RegExp(`(\\d{1,4}[.,]\\s?\\d+)\\s*[:;.]?\\s*${T_EUR}`, 'i'); // €/kg = number before EUR (tolerate a stray ":" OCR adds, "3,4: EUR")
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
// Two alternatives: (1) NUOL + ≤4 + D[A4] — tolerates a garbled middle but keeps the "DA" tail;
// (2) NUOLAI… where the trailing "DA" itself shredded ("NUOLAIDA"→"NUOLAlUn": D→U, A→n, no D
// survives). The 6-char "NUOLAI" skeleton (N-U-O-L-A-I, OCR-tolerant) is distinctive enough on its
// own — no grocery product name starts that way. (receipt-166.)
const T_DISCOUNT_RE = /N?[UV][OCQD0][LI1].{0,4}D[A4]|N[UV][OCQD0][LI1][A4Ą][I1lLÌ]\w*/i;
// OCR-tolerant "kortelė" (loyalty card) word skeleton. The trailing "EL" garbles hard: E
// reads as F ("KORTFLE" → the card-discount label leaked into a product name, receipt-219),
// L as I/1, O as 0. Shared by every card-discount-label detector (ikiLabelTail, T_DISC_NAME_RE,
// the card-number products-end marker) so a garbled label word can't be mistaken for a name.
// Kept specific enough (requires K-O/U-R-T then E/F then L/I) to never hit KORNAI/KORIANDRAS/KORTAS.
// O also reads as U on smudged prints ("KURTELA", receipt-234) — JOGURTĖLIS stays safe (G≠K).
const T_KORTELE_RE = /K[O0U]RT[EF][LI1]/i;
const T_NEG_RE = /-\s?(\d{1,4}[.,]\s?\d{2})/;
// coupons, plastic bags, points lines. These words are heavily OCR-garbled on
// photos: the coupon "KU" can drop entirely ("xKUPONAS" → "JPONAS"/"PONAS"), and
// "Taškais" (IKI loyalty points) loses its tail ("Taškals" with i→l, "Taškai").
// Match the STABLE stems — "KUPON" / "…PONAS" for coupons, "MAI[SŠ]ELIS" for
// bags, and "TA[SŠ]KA" for points — so none slips through as a phantom product.
// HARD-skip names (dropped entirely): coupons ("KUPONAS"/"…PONAS", incl. the merged
// "xPiginoRuponas" via PIGIN = "Piginimo"), plastic bags, loyalty points.
// Bag/coupon/points/discount-promo skip stems. The bag "MAIŠELIS PLASTIKINIS" is
// matched TWO ways so an OCR split or mis-read still skips it: a split/char-tolerant
// maišelis (MLKit gave "MAISEL IS" — the \s* bridges the split, [SŠ5]/[I1l] the
// mis-reads) AND the distinctive long word PLASTIKIN (no grocery product contains it),
// so either surviving the OCR is enough. Kept TIGHT — these stems never appear in real
// product names (e.g. "ŠAMPONAS" stays safe: PONAS needs ≤2 chars before it at a \b).
// The bag stems tolerate the heavier mis-reads seen in the wild (receipt-195 "MAJSELIS
// FLASTIKNIS"): the MAI→MAJ I→J swap (MA[I1lJ]) and the PLAST→FLAST P→F swap plus a dropped
// second I in PLASTIKIN→FLASTIKN ([PF]LAST[I1l]K[I1l]?N). Still tight — no grocery product reads
// as MA?SEL?S or [PF]LASTIK?N.
const T_SKIP_NAME_RE = /KUPON|\b[A-Z]{0,2}PONAS\b|PIGIN|MA[I1lJ][SŠ5]EL\s*[I1l][SŠ5]|[PF]LAST[I1l]K[I1l]?N|TA[SŠ]KA/i;
// The BAG subset of the skip stems (plastic carrier bag). A bag costs €0,01–0,10 and NEVER carries
// its own negative, so a negative amount on a bag row is always a FOREIGN (mis-clustered) discount —
// unlike a coupon/points skip ("KUPONAS -0,30", "IKI Taškais -0,05"), whose negative is its OWN.
// Used to gate the discPending discount recovery so it can't steal a coupon/points amount.
const T_BAG_RE = /MA[I1lJ][SŠ5]EL\s*[I1l][SŠ5]|[PF]LAST[I1l]K[I1l]?N/i;
// Bottle DEPOSIT / UŽSTATAS — handled SEPARATELY (folds into the product above's
// band, no value), not hard-skipped. OCR rots the O→0 ("DEP0ZIAS") AND — because IKI
// actually prints "DEPOŽITAS" with a Lithuanian ž — the char after DEP[O0] is routinely
// Ž/ž, not a plain Z ("DEPOŽ1TAS", receipt-228). Without the [ZŽž] class the label slips
// through and, when a mis-clustered price+VAT-letter rides on its line, the `!hadVat`
// fallback can't catch it either → the deposit mints a phantom product.
const T_DEPOSIT_RE = /DEP[O0][ZŽž]|U[ŽZ]STAT/i;
// Deposit REFUND / RETURN ("UŽSTATO GRĄŽINIMAS", "Išimta (Užstatas)"): a genuinely
// NEGATIVE deposit ledger line (returning empties), NOT a loyalty discount. Must NOT be
// reinterpreted as a fused product discount — its negative amount is the refund itself.
const T_DEPOSIT_REFUND_RE = /GR[ĄA][ŽZ2]IN|I[ŠS]IMT/i;
const T_LEAD_DISC_RE = /^(?:[SŠ]U\s+)?(-\s?\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s+(\S.*)$/;   // "-0,72 A RAUDONOSIOS PAPRIKOS" (optional stray "SU " shed from the label row above, receipt-272)
// OCR can garble the fused discount amount so T_LEAD_DISC_RE misses it: it drops the decimal
// comma ("-000" for "-0,00") or reads the cents as digit-shaped letters ("-0,CO"). Fall back to
// a leading minus + a SHORT (≤5) digit-ish blob + a MANDATORY VAT letter [ABC] (the only reliable
// discount/name separator once the amount is malformed) + the trailing name. The mandatory letter
// + the downstream name guards (isNameStart/!isTSkip/!ikiLabelTail) keep this from over-splitting.
const T_LEAD_DISC_GARBLED_RE = /^(?:[SŠ]U\s+)?(-\s?[\dOoSsCcIl][\dOoSsCcIl.,\s]{0,4})\s*[ABC]\s+(\S.*)$/;  // "-000 A RAUDONOSIOS PAPRIKOS"
const T_LEAD_PRICE_RE = /^(\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s*-?\s*(\S.*)$/;      // "18,15 A- 1,068 kg X 16,99 EUR/kg"
const T_DISC_NAME_RE = /^(NUOL.{0,4}D[A4](?:\s+[SŠ]U\s+K[O0]RT[EF][LI1]\w*)?)\s+(.+)$/i;  // "NUOLAIDA SU KORTELE RAUDONOS IOS PAPRIKOS" (label fused w/ next name; kortelė via T_KORTELE_RE skeleton)
const T_TRAIL_PRICE_RE = /^(.*?[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž].*?)\s+(\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s*$/; // "NAME 1,99 A"
// "<NAME1> <price> A <NAME2>" — two products fused on ONE OCR row, separated by a
// line-total's VAT-class token. e.g. "LYDYTAS TEPAWAS RIS 99 A LIETUW1SKI POMIDORAI"
// (the integer of "1,99" is dropped by OCR, leaving "99 A"). The "<digits> A"
// can only be a price, so whatever follows it starts a NEW product. The price
// digits are loose (OCR drops the integer/decimal) — the VAT letter is the anchor.
const T_MID_PRICE_NAME_RE = /^(.+?)\s+(\d{1,4}(?:[.,]\s?\d{0,2})?)\s*([ABC])\s+(.+)$/;
// End of the product list. Besides the payment markers, the IKI TRAILER starts with the loyalty
// card line ("IKI KORTELĖS NR. …") and the VAT-invoice notice ("PVM sąskaitos-faktūros …") — on a
// CASH receipt (no "Prekiautojo ID" trader line, payment block garbled at the very bottom) those
// are the only reliable "products are over" signals; without them the whole loyalty/savings
// trailer gets parsed as phantom products (receipt-148). `KORTEL…\s+NR` is the card-NUMBER label,
// distinct from the "… SU KORTELE" discount line (no "NR" after it). \S* tolerates the Ė/dropped
// diacritic ("KORTELĖS"/"KORTELES").
// card-NUMBER label "KORTELĖS NR" — the `\s+NR` anchor makes this specific, so it keeps the
// LOOSER `KOR\w?` tolerance (the T reads as I: "KORIELĖS", receipt-219) and only ADDS the E→F
// garble ([EF]) that T_KORTELE_RE handles for the discount label. Do NOT tighten to require T
// here or the products-end marker misses "KORIELĖS NR" and the card line leaks as a phantom.
// "Data YYYY-…" / "Laikas HH:…" (the VMI trailer's date/time line) is a BACKSTOP wall: it only
// prints after the products, so even when the "Prekiautojo ID" line garbles past both trader
// stems (receipt-234) the zone still ends here instead of eating the whole payment trailer.
const T_PRODUCTS_END_RE = /^\s*Par\s?davimas\b|MASTERCARD|^\s*SUMA\b|Mok[eė]ti\b|KOR.?[EF][LI1]\S*\s+N[RA]\b|s[aą]ska[il1]t\S*fakt|\bDat[a4]\s*\d{4}\s*[-.]|\bLa[i1]kas\s*\d{1,2}\s*[:.]/i;   // KOR.? — the T reads as '(' too (r268); NR reads as NA (r272); saskait's i reads as l (r272)
// "Prekiautojo ID <number>" (trader-id line) ends the product section. The "Prekia…"
// seller stem alone is too loose ("Prekiautojo nuolaida" — a promo — would truncate the
// product list). Confirm it with EITHER the trader number (6+ digits) OR an "ID"/"1D"
// token whose D is UPPERCASE (case-sensitive — the OCR keeps "ID"/"g1D" capitalised, but
// the lowercase "id" buried in "nuolaida"/"idejos" stays excluded). I→1 tolerant.
const T_TRADER_LINE_RE = /Prekia\w{0,8}/i;
// Garble-tolerant trader stem: the "e" itself rots on smudged prints ("Prckiautojo", e→c,
// receipt-234 — the missed boundary let the whole trailer assemble into a phantom product).
// One wildcard char (or none) between "Pr" and the distinctive "kiaut" run. Unlike the strict
// stem this NEVER qualifies alone — the caller must confirm with the trader number / "ID".
const T_TRADER_GARBLED_RE = /Pr.?kiaut/i;
const T_TRADER_NUM_RE = /\d{6,}/;
const T_TRADER_ID_RE = /[I1]D/; // case-SENSITIVE: uppercase D only
// Separators are [-.]{1,2}: IKI prints "YYYY-MM-DD" but OCR sometimes DOUBLES a hyphen
// ("2026-06--18"). A repeated hyphen/dot stays a date; a slash or space is NOT accepted, so
// the card/receipt/module numbers ("CR-000014698", "42/610/114559", "7229 0429/…") can't match.
const T_DATE_RE = /(\d{4})[-.]{1,2}(\d{2})[-.]{1,2}(\d{2})/;
// HH:MM:SS, but OCR can turn the FIRST colon into a hyphen/dot ("12-20:35" for 12:20:35). The first
// separator is tolerant [:.\-]; the SECOND stays a literal ":" so a date ("2026-06-20" → "26-06-20")
// can never be misread as a time (it has no MM:SS colon).
// HH:MM:SS. The LAST separator stays a literal ':' so a date ("2026-05-19", '-'/'.' seps)
// can never be mis-read as a time. `\s*` around the separators tolerates OCR inserting a
// space after a colon ("19:36: 13" → time lost before, receipt-221).
const T_TIME_RE = /(\d{2})[:.\-]\s*(\d{2})\s*:\s*(\d{2})/;
// "Kvito" itself rots heavily on IKI thermal: the K→A and v→o/u/y swaps give "Koito"/"AVito"
// (receipt-198) and "Kyito" (receipt-199), so the stem is [KA][vouy]ito. The mandatory "Nr"/"numer"
// context (and the captured digits) keeps it from matching the other "Kvito …" lines (kodas/parašas).
const T_RECEIPTNO_RE = /[KA][vouy]ito\s+Nr?[.,]?\s*([0-9/]+)/i;   // OCR reads "Nr." / "Nr," / "N." (dropped r)
// Fallback receipt id when "Kvito Nr." is missing/unreadable: the shorter "Kvitas"
// sequence number on the terminal line ("Term. 15027037 Kvitas 3157 Atsk 000").
// Distinct from "Kvito" (no trailing "s"), so it can't match the primary line.
const T_KVITAS_RE = /\bKvitas[\s.:]*(\d{3,6})\b/i;
// A THIRD IKI identifier — "Kvito numeris 104148" in the VMI footer block (the sequence number,
// an INDEPENDENT OCR read of the tail of "Kvito Nr."). OCR splits "numeris" → "numer i s", so the
// stem is tolerant. Captured for the receiptNos array + its own band; never the canonical id.
const T_KVITONUM_RE = /[KA][vouy]ito\s+numer[a-z]*\s*i?\s*s?\s*[:.]?\s*([0-9/]{4,})/i;
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
const isTDiscount = (t: string) =>
  T_DISCOUNT_RE.test(stripDiacritics(t)) || T_BARE_NEG_RE.test(t.trim())
  // Lexicon fallback (Phase 3): any in-budget garble of "nuolaida" the skeleton lanes
  // missed. Fallback-only — the legacy lanes short-circuit, so the hot path and every
  // pinned behavior are unchanged; the lexicon only ADDS coverage for new garbles.
  || hasKeyword(t, LEX.NUOLAIDA);
// Only a real product NAME can start a product — never a price / weight /
// discount / coupon-bag-points marker / digit-only noise. Requires ≥2 letters
// so OCR crumbs like a lone "A" (the leftover of a mangled points line) never
// become a phantom product.
const isNameStart = (t: string) =>
  !!t && !isTPrice(t) && !isTWeight(t) && !isTDiscount(t) && !isTSkip(t) &&
  t.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length >= 2;

// €/kg where OCR dropped the decimal comma: "… 16 99 EUR/kg" (was "16,99"). Anchored
// to the EUR slot with exactly 2 trailing cents, so a stray "<int> <2-digit>" elsewhere
// can't match. Only consulted when the strict comma form fails.
const T_PERKG_SPACE_RE = new RegExp(`(\\d{1,3})\\s+(\\d{2})\\s*[:;.]?\\s*${T_EUR}`, 'i');
export const extractPerKg = (t: string): number | null => {
  const m = t.match(T_PERKG_RE);
  let v = m ? parseNum(m[1]) : NaN;
  if (!(Number.isFinite(v) && v > 0)) {
    const ms = t.match(T_PERKG_SPACE_RE);
    if (ms) v = parseFloat(`${ms[1]}.${ms[2]}`);   // "16 99 EUR" → 16.99
  }
  return Number.isFinite(v) && v > 0 ? v : null;
};
// The kg quantity at the START of a weight row: "0,720 kg X …" → "0,720".
// Returns null if there's no "<number> kg". A result WITHOUT a decimal (e.g. "0")
// is a degenerate kg — the signature of OCR splitting "0,720 kg" into "0,72" +
// "0 kg", where the real quantity is the decimal fragment on the preceding line.
// "kg" is routinely mis-OCR'd as "ka"/"kq"/"k9" on the quantity unit ("0,720 ka X
// … EUR/ kg"), so tolerate those reads when capturing the leading kg quantity.
// IKI prints an interpunct between the quantity and the unit ("0, 245 · kg") which OCR
// reads as a stray -/./· token — tolerate ONE such junk char so the quantity still binds
// to its kg (receipt-242 paprikos: "0.245 - kg" lost the amount entirely).
const T_KG_LEAD_RE = /(\d{1,4}(?:[.,]\s?\d+)?)\s*[-–—·.]?\s*k[gqa9]\b/i;
const leadingKg = (t: string): string | null => {
  const m = t.match(T_KG_LEAD_RE);
  return m ? m[1].trim() : null;
};

// ───────── combo-set discount ─────────
// A BARE "RINKINYS" line ("set") is IKI's multi-buy / combo-deal discount, not a
// product — drop it. A REAL product always qualifies the word ("ŽALUMYNŲ RINKINYS",
// "STIKLINIŲ RINKINYS …"), so only the standalone word is the combo line. Anchored
// ^…$ on the letter-only name so a qualified product survives.
// OCR-tolerant skeleton: the two "I" routinely read as T/1/L ("RINKTNYS", receipt-187),
// the "Y" is dropped or read as T/1/V ("RINKTN)S" → "RINKTNS", receipt-206), and the whole
// "NY" pair can drop out ("RINKINYS" → "RINKI:.S" → letters "RINKIS", receipt-209) — so the
// SECOND N is optional too. Still anchored ^…$ on the letter-only name, so a qualified
// product ("ŽALUMYNŲ RINKINYS") never collapses to the bare skeleton and survives.
const RINKINYS_SKEL = /^R[IT1L]NK[IT1L]N?[YT1V]?S$/;
export function isIkiComboSetName(name: string): boolean {
  // Keep DIGITS as well as letters: the skeleton's [IT1L] intentionally accepts a digit '1'
  // for an OCR'd "I", but stripping digits here made that alternative dead code (a
  // "R1NK1NYS" read slipped through). Strip only punctuation/whitespace.
  return RINKINYS_SKEL.test(stripDiacritics(name).replace(/[^A-Za-z0-9]/g, '').toUpperCase());
}

// ───────── header-junk guard (product-name protection) ─────────
// When the header/product boundary detection fails — e.g. the "PVM mokėtojo kodas"
// line OCR-garbles so NONE of the pStart fallbacks fire (pStart stays 0, receipt-206
// where "kodas"→"kolas") — the IKI store line, the store address and the VAT-code line
// fold into the FIRST product's NAME ("IKI L  Vilniaus g…  PVM…kodas …  VIRTA DEŠRA").
// These tokens NEVER occur in a real IKI product name, so strip a LEADING run of them
// defensively: belt-and-suspenders on top of pStart, so product 1 can't absorb the header.
function isIkiHeaderNamePart(part: string, storeAddress?: string): boolean {
  const t = part.trim();
  if (!t) return false;
  // VAT / company registration block — tokens that never appear in a product name.
  if (/\bP[VY][MN]\b/i.test(t)) return true;                        // "PVM" (OCR PVN / PYM …)
  if (/mok[eė]t/i.test(t)) return true;                            // "mokėtojo" (kodas line)
  if (/\d{8,}/.test(t.replace(/\s+/g, ''))) return true;           // 8+ digit run = the VAT/company code, never a product
  if (/\bLietuva\b/i.test(t)) return true;                         // "IKI Lietuva, UAB"
  if (/(^|[^A-Za-z])[UJ]A[B8]([^A-Za-z]|$)/i.test(t)) return true; // UAB / JAB / A8 company suffix
  // IKI store-name header line — NARROW so IKI store-brand PRODUCTS ("IKI Pienas")
  // are never touched: only the bare store line "IKI L", "IKI - …", "IKI Lietuva".
  if (/^\W*IK[I1L!]\s*(?:[-–—]|L\b|LIET)/i.test(t)) return true;
  // The store address the header scan already extracted, matched fuzzily (the name's
  // word-box text ≈ header.storeAddress) — covers the address line even when the VAT
  // line after it was dropped so the sandwich rule below can't reach it.
  if (storeAddress) {
    const norm = (s: string) => foldForeignDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const a = norm(t), b = norm(storeAddress);
    if (a.length >= 6 && b.length >= 6 && (a === b || a.startsWith(b) || b.startsWith(a))) return true;
  }
  return false;
}
// Drop a LEADING run of header lines from a product's accumulated name parts. Finds the
// last strong header marker within the leading window (never the FINAL part — that's the
// real product name) and slices everything up to and including it. The address line,
// sandwiched between the IKI line and the VAT line, is carried out with them even when it
// isn't itself a recognised marker. Inert on the happy path (product 1 has no header parts).
function stripIkiLeadingHeaderParts(parts: string[], storeAddress?: string): string[] {
  if (parts.length <= 1) return parts;
  const window = Math.min(parts.length - 1, 6);
  let cut = -1;
  for (let i = 0; i < window; i++) {
    if (isIkiHeaderNamePart(parts[i], storeAddress)) cut = i;
  }
  return cut < 0 ? parts : parts.slice(cut + 1);
}

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
  const lead = t.match(T_LEAD_DISC_RE) ?? t.match(T_LEAD_DISC_GARBLED_RE);
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
    // Tolerate OCR garbles: "ŠU" (Š for S) and "KORTELt"/"KORTELĖ"/"KORTFLE" (T_KORTELE_RE skeleton).
    const isLabelTail = /^[SŠ]U\b/i.test(tail) || T_KORTELE_RE.test(tail) || hasKeyword(tail, LEX.KORTELE);
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
  /** total came from a FALLBACK lane (source-single / headless / glyph-garbled / bare-digit)
   *  rather than the strict read — the row solver may overrule it with kg × €/kg. */
  totSoft?: boolean;
  /** PRICE-SHAPED but UNREADABLE trailing amount ("3, 4: A" — a glyph no map can resolve):
   *  the row still CLOSES its product (it IS a total row), value unknown. Receipt-level
   *  reconciliation (Phase 2) pins it from Σ paid = printed total. */
  totUnknown?: boolean;
  unkCents?: number | null;                                          // headless bare-cents unknown ("59" → the solved total must end ,59")
  /** Candidate values for the unknown total (decimal-glyph expansion); null = unconstrained. */
  totCands?: number[] | null;
  /** A discount that belongs to THIS row's OWN product (soup-row reconstruction: name +
   *  total + discount all on one attached row) — unlike trailDisc, which the assembler
   *  attributes to the previously-open product. */
  selfDisc?: number;
  trailDisc: number;                                                  // trailing text-only discount on a NAME row that belongs to the PREVIOUS product (OCR fused the prior product's discount onto this name with no word box)
  isDeposit: boolean;                                                 // bottle deposit — folds into the product above's band, no value
  kgQty: boolean;                                                     // row bears a weighed-quantity token
  weigh?: boolean;                                                    // classified as a WEIGHT row (kg × €/kg), even if €/kg unreadable
  kgVal?: number | null;                                             // printed kg quantity on a weight row ("0,720"), for total÷qty €/kg recovery
  unitQty?: number | null;                                           // printed unit count on a "N vnt. X P EUR/Vr" calc row (per-unit multi-buy)
  mergedTotal?: number | null;                                       // a positive total fused onto a DISCOUNT row (overlapping OCR boxes); adopted as the total ONLY for a non-weighed product
  softTotal?: boolean;                                               // `total` was RECOVERED from the source line (no word box) — must not anchor a product on a name-CONTINUATION row (the boxless value can be an MLKit leak onto a wrapped name)
  depositFollows?: boolean;                                          // this DISCOUNT row's source line had a bottle-deposit LABEL fused onto it ("-0,33 A DEP0ZITAS") — the deposit's own bare price sits on the NEXT row and must be folded (skipped), not made a phantom product
  discLabel?: boolean;                                               // this row carried a "NUOLAIDA …" discount LABEL but its amount was elsewhere (band-merged calc row) — the product HAS a discount, recover its amount from a following mis-clustered row
  topY: number; botY: number; leftX: number; slope: number;
}
const T_TRAIL_AMT_RE = /(-?\d{1,4}[.,]\s?\d{2})\s*(?:[ABC]\s*){0,2}$/;  // a line's trailing amount (tolerates a stray doubled VAT letter, receipt-271)
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
// Trailing amount whose DECIMAL digits rotted into confusable GLYPHS ("3, 4y A" — the
// printed 9 read as y; receipt-242's flaxseed oil never closed and swallowed the next
// product into its name). The shape is anchored hard — REAL-digit integer + decimal
// separator + the VAT letter + end-of-row — so only the two decimal characters may be
// confusion glyphs, each mapped to its canonical digit. A real digit passes through
// unmapped, and any glyph outside the map rejects the whole match.
const T_AMT_GARBLED_RE = /(-?\d{1,4})[.,]\s?([\dOoIlSsBgqyZz]{2})\s*[ABC]\s*$/;
const GLYPH_DIGIT: Record<string, string> = {
  O: '0', o: '0', I: '1', l: '1', Z: '2', z: '2', S: '5', s: '5', B: '8', g: '9', q: '9', y: '9',
};
function matchGarbledVatAmt(text: string): number | null {
  const m = text.match(T_AMT_GARBLED_RE);
  if (!m) return null;
  const dec = [...m[2]].map((c) => GLYPH_DIGIT[c] ?? c).join('');
  if (!/^\d{2}$/.test(dec)) return null;
  const neg = m[1].startsWith('-');
  const v = Math.abs(parseNum(`${m[1]}.${dec}`));
  return Number.isFinite(v) ? (neg ? -v : v) : null;
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

// Robust per-line slope from the line's OWN words: median of ADJACENT-pair slopes,
// skipping pairs separated by a large x-gap. The gap cap is the whole point — a line
// that GLUES the name column to the price column ("DEPOZI TAS 0, 10") has one huge
// cross-column pair whose "slope" is the OCR column SHEAR, not the paper tilt;
// leftmost-vs-rightmost measurement (both the old refSamples here and mlkitOcr's
// corner synthesis) read that shear as tilt and poisoned every de-skew downstream
// (receipt-232: scrambled clustering + bands pivoting up on the device while the
// corner-less offline parse of the same words was clean). Adjacent intra-column
// pairs survive the cap; the cross-gap pair is excluded; the median does the rest.
// Returns null when no valid pair exists.
export function robustLineSlope(
  words: { xLeft: number; xRight: number; yTop: number; yBottom?: number }[] | undefined,
): number | null {
  if (!words || words.length < 2) return null;
  const ws = [...words].sort((a, b) => a.xLeft - b.xLeft);
  // Split into gap-free RUNS (a run never crosses the column gap), then measure the
  // slope END-TO-END over the LONGEST run — a long baseline averages out per-word box
  // noise. Two rejection rules, each guarding a distinct poison:
  //   • the cross-column pair (huge gap) never joins a run → shear can't register;
  //   • a run SHORTER than MIN_SPAN yields null — a micro-baseline like "1,69"→"A"
  //     (dx≈76, ±3px box noise) would fabricate ±0.04 "tilt" out of pure noise and
  //     drag the global median (the second poisoning mode found on receipt-232).
  const MIN_SPAN = 180;
  const gapCap = Math.max(120, ((ws[ws.length - 1].xRight - ws[0].xLeft) || 1) * 0.25);
  const runs: (typeof ws)[] = [];
  let run: typeof ws = [ws[0]];
  for (let i = 1; i < ws.length; i++) {
    if (ws[i].xLeft - ws[i - 1].xRight > gapCap) { runs.push(run); run = []; }
    run.push(ws[i]);
  }
  runs.push(run);
  const cy = (w: (typeof ws)[number]) => (w.yBottom != null ? (w.yTop + w.yBottom) / 2 : w.yTop);
  const cx = (w: (typeof ws)[number]) => (w.xLeft + w.xRight) / 2;
  let best: (typeof ws) | null = null;
  for (const r of runs) {
    if (r.length < 2) continue;
    if (!best || cx(r[r.length - 1]) - cx(r[0]) > cx(best[best.length - 1]) - cx(best[0])) best = r;
  }
  if (!best) return null;
  const dx = cx(best[best.length - 1]) - cx(best[0]);
  if (dx < MIN_SPAN) return null;
  const slope = (cy(best[best.length - 1]) - cy(best[0])) / dx;
  return Math.max(-0.08, Math.min(0.08, slope));
}

// Flatten every word in the product section. Each word carries its source line's
// tilt (the local receipt slope) — we ignore MLKit's line GROUPING, not its tilt.
function ikiCollectWords(lines: IkiLine[], start: number, end: number): EWord[] {
  // CORNER-GATED slope assignment. When a line carries NO corner data (stored
  // fixtures, old dumps) the slope stays exactly what it always was — the corner
  // formula collapses to 0 — so battle-tested cornerless behavior is untouched.
  // When corners ARE present (on-device), they are NEVER trusted for word-bearing
  // lines: mlkitOcr synthesizes them from element pairs, which carry the column
  // shear on glued lines and micro-pair noise on short ones — the poison that
  // scrambled receipt-232's clustering. Instead: word-derived long-baseline slope
  // (robustLineSlope), and lines too short to measure inherit the MEDIAN of the
  // measured lines. Word-less lines keep the (capped) corner value — nothing
  // better exists there.
  const hasCorners = (l: IkiLine) => l.yLeftTop != null || l.yRightTop != null;
  const measured = new Map<number, number>();
  for (let i = start; i < end; i++) {
    if (!hasCorners(lines[i])) continue;
    const s = robustLineSlope(lines[i].words);
    if (s != null) measured.set(i, s);
  }
  const inherited = measured.size ? emedian([...measured.values()]) : 0;
  const out: EWord[] = [];
  for (let i = start; i < end; i++) {
    const l = lines[i];
    const w = (l.xRight - l.xLeft) || 1;
    const cornerSlope = Math.max(-0.08, Math.min(0.08, ((l.yRightTop ?? l.yTop) - (l.yLeftTop ?? l.yTop)) / w));
    const slope = !hasCorners(l)
      ? cornerSlope /* = 0 without corners — legacy behavior byte-for-byte */
      : (measured.get(i) ?? (l.words && l.words.length ? inherited : cornerSlope));
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

// True ROW PITCH measured from the words themselves. The median box HEIGHT (the lineH
// fallback) OVERESTIMATES the line pitch when MLKit pads its boxes downward — receipt-228:
// ~48px boxes on a ~38px printed pitch, every name box bleeding into the next line's
// glyphs on a perfectly clean image. Every clustering/attachment threshold derives from
// lineH, so an inflated lineH makes them wider than the real between-row gap and adjacent
// printed lines CHAIN-MERGE into one interleaved row ("BAJORISKIŲ TICHE NATŪRALUS
// MAISTINĖ NEGAZUOTA ACTO"). Estimate the pitch from the DATA in two stages: (1) group
// the sorted de-skewed word centers into LEVELS, splitting where the consecutive gap
// clears the same-row jitter floor (0.35 × boxH — column tilt offsets + multi-word
// spread); (2) pitch = median diff between consecutive LEVEL MEDIANS. A raw
// consecutive-gap median would measure the BOUNDARY gap (pitch minus the within-row
// spread, ~24px on 228) and shrink the attach radius until true prices orphan — the
// level-median diff measures the actual center-to-center pitch (~38px). Needs ≥3
// levels (2 diffs — a single diff could be a section break, not a pitch); returns null
// when the zone is too sparse to measure.
function ikiEstimateRowPitch(words: EWord[], boxH: number, medSlope: number): number | null {
  if (words.length < 4) return null;
  const centers = words
    .map((w) => (w.yTop + w.yBottom) / 2 - medSlope * ((w.xLeft + w.xRight) / 2))
    .sort((a, b) => a - b);
  const levels: number[][] = [];
  let cur: number[] = [centers[0]];
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] >= boxH * 0.35) { levels.push(cur); cur = []; }
    cur.push(centers[i]);
  }
  levels.push(cur);
  if (levels.length < 3) return null;
  const mids = levels.map((l) => emedian(l));
  const diffs: number[] = [];
  for (let i = 1; i < mids.length; i++) diffs.push(mids[i] - mids[i - 1]);
  return emedian(diffs);
}

// Curve-normalized row clustering: de-bend by the median slope, group words whose
// normalized Y is within ~½ a line-height, then RE-UNION rows that share an MLKit
// source line. The two failure modes this balances (receipt-228 vs 161):
//   • MLKit pads word boxes downward (228: ~48px boxes on a ~38px pitch), so a
//     box-height threshold chain-merges TWO SEPARATE printed name lines into one
//     interleaved row ("BAJORISKIŲ TICHE NATŪRALUS MAISTINĖ NEGAZUOTA ACTO"). The
//     split threshold therefore uses min(boxH, measured pitch) — see splitH.
//   • But some printed pairs legitimately sit at SUB-pitch spacing and the fold
//     logic depends on them clustering together (161: a unit-calc row + its
//     NUOLAIDA label, 24px apart on a 32px pitch). Those pairs invariably arrive
//     GLUED IN ONE MLKit LINE — MLKit already judged them one visual unit — so
//     after the fine split, rows sharing a source line are re-united. 228's
//     poison merge was across two DIFFERENT source lines, so it stays split.
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
  // Same-source-line union (adjacent rows only — rows are y-sorted, and a glued
  // MLKit line only ever spans neighbouring printed rows). GATED on a HELPER row:
  // a load-bearing sub-pitch merge always involves a calc/label/deposit row that
  // cannot stand alone (161: unit-calc + its NUOLAIDA label). When BOTH rows are
  // name/price-shaped, the glue is two REAL products fused by MLKit and the split
  // must stand (receipt-170: two KETO loaves in one MLKit line).
  const helperish = (ws: EWord[]) => {
    const t = ws.map((w) => w.text).join(' ');
    // Card label only in DISCOUNT contexts ("NUOL…", "…SU KORTELE") — a bare KORT
    // skeleton would also catch a real DOVANŲ KORTELĖ (gift card) product row.
    // NO deposit stem here: a DEPOZITAS word glued onto a product's NAME line would
    // union the pair and ikiClassifyRow would then type the WHOLE merged row as a
    // deposit skip — silently deleting the product. Deposit amounts are handled by
    // the deposit-targeted re-home in ikiBuildRows instead.
    return T_KG_QTY_RE.test(t) || T_UNIT_CALC_RE.test(t) ||
      /E[UÜŪ]R\s*\//i.test(t) || /NUOL[A4]|[SŠ]U\s+K[O0]RT[EF][LI1]/i.test(t);
  };
  // Precompute per-ORIGINAL-row flags and forbid a just-merged row from unioning
  // again: re-evaluating helperish on CONCATENATED text would let an absorbed
  // helper's markers license a second merge that fuses two REAL name+price rows —
  // defeating the exact receipt-170 invariant the gate protects.
  // (A vertical distance gate on the union — 0.9·splitH — was tried and REVERTED: on a
  // scrambled receipt (211) splitH is the measured LOW pitch, so the gate blocked a
  // load-bearing helper union and the next product's name fused into its neighbour.
  // The helper + shared-line + adjacency + no-chaining conditions bound the union
  // tightly enough; re-add a distance gate only with a real fixture in hand, scaled to
  // lineH not splitH.)
  const helperFlag = rows.map((r) => helperish(r));
  const merged = new Set<number>();
  for (let i = rows.length - 1; i > 0; i--) {
    if (merged.has(i) || merged.has(i - 1)) continue;
    const above = new Set(rows[i - 1].map((w) => w.line));
    if (rows[i].some((w) => above.has(w.line)) && (helperFlag[i - 1] || helperFlag[i])) {
      rows[i - 1] = rows[i - 1].concat(rows[i]);
      rows.splice(i, 1);
      helperFlag.splice(i, 1);
      merged.add(i - 1);
    }
  }
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
  const base: ERow = { words: ws, leftText: '', total: null, perKg: null, discount: 0, trailDisc: 0, isSkip: false, isDeposit: false, kgQty: T_KG_QTY_RE.test(text), topY, botY, leftX: ws[0].xLeft, slope };
  // Skip from the row text OR the source line — "0,10 DEPOZITAS" keeps only the
  // "0,10" amount as words (the DEPOZITAS label is dropped), so the row text alone
  // misses it; the line text still has it. EXTRA signal: a deposit amount has NO
  // VAT-class letter (every real IKI product total ends in A/B/C), so a weak deposit
  // hint ("DEP0…") on a NO-VAT amount is a deposit even when too garbled to match
  // the strict skip name — and a real product (which always has the VAT letter) is
  // never caught by it.
  const hadVat = /[ABC]\s*$/.test(text);
  const depositHint = /\bDEP[O0]|U[ŽZ]ST/i.test(firstSrc);
  // FUSED "discount + deposit-label": OCR can glue a product's loyalty discount AMOUNT
  // (right column of the NUOLAIDA row) onto the deposit LABEL of the row below
  // ("-0,33 A DEP0ZITAS"). Such a row is a DISCOUNT (it belongs to the product above),
  // NEVER a deposit — a real deposit amount is POSITIVE; a deposit-label row carrying a
  // NEGATIVE is a mis-clustered loyalty discount. Without this guard the deposit test below
  // would swallow the discount (folded as a no-value deposit → promo lost) AND the deposit's
  // own bare price on the next row would mint a phantom product. Two OCR shapes:
  //   (a) the deposit label rode along ONLY in the source line → the boxed words are the bare
  //       negative ("-0,33 A", text starts with "-").  receipt-139.
  //   (b) the OCR BOXED the deposit word, so it x-sorts to the LEFT and the negative is the
  //       right-column amount ("DEPOZITAS -0,33 A", text holds the label).  receipt-183.
  const negWordsDisc = /^-\s*\d/.test(text.trim());                  // (a) the words START with a discount amount
  // A deposit REFUND ("-1,00 A UŽSTATO GRĄŽINIMAS") is ALSO a deposit-family negative — but there
  // the negative IS the refund, not a stray loyalty discount. Exclude it: it stays a deposit SKIP.
  const isDepositRefund = T_DEPOSIT_REFUND_RE.test(text) || T_DEPOSIT_REFUND_RE.test(firstSrc);
  const fusedDepA = negWordsDisc && !T_DEPOSIT_RE.test(text) && T_DEPOSIT_RE.test(firstSrc) && !isDepositRefund;
  const fusedDepB = T_NEG_RE.test(text) && T_DEPOSIT_RE.test(text) && !isDepositRefund;
  const fusedDepositLabel = fusedDepA || fusedDepB;
  // Variant (b): the fall-through extractor below would read "DEPOZITAS" as the product NAME, so
  // handle it explicitly — strip the label, return the negative as the discount, and flag
  // depositFollows so the deposit's own bare price (next row) folds instead of minting a phantom.
  if (fusedDepB) {
    const dn = text.match(T_NEG_RE) ?? firstSrc.match(T_NEG_RE);
    return { ...base, depositFollows: true, discount: dn ? parseNum(dn[1]) : 0, leftText: '' };
  }
  // COMBO-SET vs DEPOSIT (receipt-278): MLKit can glue the NEXT printed row's deposit
  // LABEL onto a combo-discount line ("RINKINYS -1,90 A DEPOZITAS" — one source line,
  // two printed rows), and the source-line deposit test below would swallow the whole
  // rebuilt row ("RINKINYS -1,90 A") as a value-less deposit skip — the -1,90 vanished
  // and the set was priced in full. The row's OWN words are the truth: a bare combo
  // word ahead of a trailing negative is unambiguously the combo-discount row — let it
  // reach the trailing-amount lanes, where the assembler's combo interception routes
  // the value to footer.comboDiscount.
  const negIdx = text.search(/-\s?\d/);
  const comboNegRow = negIdx > 0 && !T_DEPOSIT_RE.test(text) && isIkiComboSetName(text.slice(0, negIdx));
  // DEPOSIT (folds into the product above's band, no value). The no-VAT extra catches
  // deposits too garbled for the strict name: a real product total always ends in A/B/C.
  if (!fusedDepositLabel && !comboNegRow && (T_DEPOSIT_RE.test(text) || T_DEPOSIT_RE.test(firstSrc) || (depositHint && !hadVat))) {
    return { ...base, isSkip: true, isDeposit: true, leftText: text };
  }
  // (a) Carry the deposit-follows signal on the (about-to-be-built) discount row so the
  // assembler can fold the deposit's bare price that lands on the very next row.
  if (fusedDepositLabel) base.depositFollows = true;
  if (isTSkip(text) || isTSkip(firstSrc)) {
    // A bag/coupon SKIP row can carry the PRIOR product's mis-clustered loyalty discount amount
    // ("MAISELIS PLASTIKINIS … -1,80 … 0,01 A" — the -1,80 is the zucchini's discount, band-merged
    // down onto the bag). Surface the leading negative so the assembler can apply it to the open
    // product (gated on discPending — see below). The bag's OWN price (0,01) is positive, untouched.
    const sneg = text.match(T_NEG_RE) ?? firstSrc.match(T_NEG_RE);
    // The skip's own positive charge ("MAISELIS … 0,01 A", "IKI Taškais 0,01 A") is part of
    // the PRINTED TOTAL — capture it so receipt reconciliation can balance the books.
    const spos = text.match(/(^|[^-\d])(\d{1,4}[.,]\s?\d{2})\s*[ABC]\s*$/);
    return { ...base, isSkip: true, leftText: text, discount: sneg ? parseNum(sneg[1]) : 0, total: spos ? parseNum(spos[2]) : null };
  }
  // UNIT-quantity calc row "N vnt. X P,PP EUR/ Vr" — a CALC, not a NAME. Strip to a nameless row
  // (keep a leading fused name if any) + carry the printed unit count, so it folds into the product
  // and the line total ("2,98 A") on the next row lands on it. (receipt-154 Žaliosios cukinijos.)
  const ucm = text.match(T_UNIT_CALC_RE);
  if (ucm) {
    const lead = text.match(/^([A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž][A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž .]+?)\s+\d/);
    // the line total ("2,98 A") is usually fused onto the END of the calc row — keep it.
    const ut = text.match(T_TRAIL_AMT_RE);
    const utv = ut && parseNum(ut[1]) > 0 ? parseNum(ut[1]) : null;
    return { ...base, leftText: lead ? lead[1].trim() : '', unitQty: parseInt(ucm[1], 10), total: utv };
  }
  const srcPerKg = extractPerKg(firstSrc);
  // A leading 3-decimal kg quantity + an "EUR/kg" marker on the line ⇒ a weighed
  // item, EVEN WHEN the €/kg number itself is OCR-garbled ("3.ga EUR/ kg" →
  // unreadable, and the unit "kg" mis-read as "ka"). Without this the calc row gets
  // mistaken for a clean total and fused into the name ("LIETUVISKI POMIDORAI 0,720
  // ka X 3.ga EUR/kg"), losing the weight. The €/kg is then recovered at assembly
  // from total ÷ qty. (receipt-111 POMIDORAI.) The unit may be GLUED to the digits
  // ("0,245kg" — Vision dropped both the space and the ×): `\b` never fires between
  // a digit and a letter, so the glued unit is an explicit alternative. (receipt-315.)
  const hasLeadingKgQty = /^\d{1,4}[.,]\s?\d{3}(?:\b|k[gqa9])/i.test(text);
  const hasPerKgMarker = /e[uü]?r\s*\/\s*k[ga]/i.test(text) || /e[uü]?r\s*\/\s*k[ga]/i.test(firstSrc)
    || /eur\s*k[ga]/i.test(text) || /eur\s*k[ga]/i.test(firstSrc);
  // WEIGHT row — straight from the words, OR RECOVERED when OCR shattered the
  // "kg X … EUR" tokens (only the leading kg-quantity survived as a word, the "kg"
  // itself even mis-read — salmon "1,068 KORTELL X 16.99 EUR/ kg" kept only "1,068")
  // but the source line still holds the €/kg. Lead with a 3-decimal quantity + a €/kg
  // (readable OR just an "EUR/kg" marker) on the line ⇒ a weighed item.
  if (isTWeight(text) || ((srcPerKg != null || hasPerKgMarker) && hasLeadingKgQty)) {
    // A weight row can carry the product NAME fused before the quantity
    // ("BE GAL 1,068 kg X …") AND the line TOTAL fused after it ("… EUR/kg 18,15 A").
    // Keep both so the product gets its name and its total.
    const lead = text.match(/^([A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž][A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž .]+?)\s+\d/);
    // The line TOTAL ("0,78 A") can be word-boxless on a weight row too — MLKit keeps it in
    // the line TEXT but drops its box, so the word-only `text` misses it. Fall back to the
    // source line. This MATTERS when the €/kg is ALSO garbled: without a total the assembler
    // can't recover €/kg = total ÷ qty and the price-poisoning guard zeroes the item
    // (receipt-96 garbled-EUR class). GUARD: only when the source line carries EXACTLY ONE
    // VAT-lettered amount (the row's own total). TWO means the NEXT product's total fused onto
    // this calc line ("…EUR/kg 2,87 A 1,49 A") — the `$`-anchored match would grab the FOREIGN
    // amount and write a wrong per-kg REFERENCE price (the worst outcome the poisoning guard
    // exists to prevent); ambiguous ⇒ recover nothing and let weighedNoPpu zero it. The `> 0`
    // guard keeps a trailing NEGATIVE (a fused discount, parseNum keeps the sign) out (a
    // discount's "0,30 A" still counts toward the VAT-amount tally, so own-total + discount
    // also reads as TWO ⇒ skip rather than risk grabbing the discount). The €/kg and kg
    // quantity carry no trailing VAT letter, so they are never counted nor picked up.
    const tmText = text.match(T_TRAIL_AMT_RE);
    let tm = tmText;
    if (!tmText) {
      const vatAmts = firstSrc.match(/\d{1,4}[.,]\s?\d{2}\s*[ABC]\b/g);
      if (vatAmts && vatAmts.length === 1) tm = firstSrc.match(T_TRAIL_AMT_RE);
    }
    let tot = tm && parseNum(tm[1]) > 0 ? parseNum(tm[1]) : null;
    // Strict word-box read = trusted; every lane below is a RISKY read the row solver
    // (see flush) may overrule when the locked kg × €/kg arithmetic contradicts it.
    let totSoft = !tmText && tot != null;
    // HEADLESS total: a sub-1€ total prints "0,86" but OCR can drop the integer
    // (".86 A" / ", 86 A", receipt-242 paprikos) — losing the total kills the weighed
    // qty→promo recovery. The [.,] lead + VAT letter + end-of-row anchor the shape;
    // the (^|[^\d,.]) guard keeps it off the tail of a complete amount.
    if (tot == null) {
      const hm = text.match(/(?:^|[^\d,.])[.,]\s?(\d{2})\s*[ABC]\s*$/);
      if (hm) { tot = parseInt(hm[1], 10) / 100; totSoft = true; }
    }
    // Glyph-rotted decimals ("3, 4y A") — same lane as the unit-product rows.
    if (tot == null) {
      const gv = matchGarbledVatAmt(text);
      if (gv != null && gv > 0) { tot = gv; totSoft = true; }
    }
    // Bare digits + VAT letter ("86 A" — BOTH separator and integer dropped from "0,86",
    // receipt-268 paprikos): the unit rows' cents lane, reused. The [ABC]+end-of-row
    // anchor keeps it off the €/kg (never VAT-lettered).
    if (tot == null) {
      const bv = matchVatAmt(text);
      if (bv != null && bv > 0) { tot = bv; totSoft = true; }
    }
    // Keep the printed kg quantity ("0,720") so a garbled €/kg ("3,9a EUR" → unreadable)
    // can be recovered at assembly from total ÷ qty (the total may sit on a separate OCR
    // row). A bare "0 kg" (OCR dropped the decimals) → null: dividing by it can't recover
    // a real €/kg, so the item is left for the poisoning guard.
    const lk = leadingKg(text);
    const kgVal = lk && /[.,]/.test(lk) ? parseNum(lk) : null;
    // A loyalty discount can RIDE the weight/calc row when MLKit merged the bands of a
    // tightly-printed weighed item ("DZIOVINTOS SLYVOS … 0,355 kg X8,99 -0,80 A" — the
    // total 3,19 split onto the name row, the discount -0,80 onto this calc row). Capture the
    // negative amount so the weighed product keeps its promo instead of silently dropping it.
    // (`tot` above already excluded it: a negative fails the `> 0` gate.)
    const wneg = text.match(T_NEG_RE);
    const weighDisc = wneg ? parseNum(wneg[1]) : 0;
    return { ...base, perKg: extractPerKg(text) ?? srcPerKg, total: tot, totSoft, discount: weighDisc, leftText: lead ? lead[1].trim() : '', weigh: true, kgVal };
  }
  const tm = text.match(T_TRAIL_AMT_RE);
  let amt = tm ? parseNum(tm[1]) : null;
  const cleanDecimal = amt != null;                   // matched the strict "1,49" decimal form
  let amtRe = T_TRAIL_AMT_RE;                         // pattern to strip from leftText
  if (amt == null) {
    const lv = matchVatAmt(text);                     // OCR dropped the decimal but kept the VAT letter
    if (lv != null) { amt = lv; amtRe = T_AMT_VAT_RE; }
  }
  if (amt == null) {
    const gv = matchGarbledVatAmt(text);              // decimal digits rotted into glyphs ("3, 4y A")
    if (gv != null) { amt = gv; amtRe = T_AMT_GARBLED_RE; }
  }
  // TRAILING text-only discount fused onto THIS name's line — IKI prints a product's
  // discount UNDER it, but OCR can glue the "-X,XX" onto the NEXT product's name line
  // with NO word box (it survives only in the source-line text). Recover the VALUE here,
  // BEFORE the positive-total early returns below: a name row can ALSO carry the next
  // product's own positive total (the salmon → "NAMINIS … -7,48 … 1,49 A" case, where the
  // 1,49 clustered into this row), and the clean-total return would otherwise hit first
  // and silently drop the fused minus. Suppress ONLY when a NEGATIVE amount is itself
  // word-boxed on this row (then the discount really belongs here); the row's own
  // POSITIVE total must NOT suppress it. The band still comes from the name's words; the
  // assembler attaches the value to the open PREVIOUS product. (receipt-99 RAUDONOSIOS /
  // POMIDORAI discounts, receipt-109 salmon.)
  // `-\s*` (not `-\s?`): OCR can leave MULTIPLE spaces between the minus and the number
  // ("-  0,40 A"). A single-space guard let such a discount slip past as a positive total.
  const trailNeg = firstSrc.match(/-\s*(\d{1,4}[.,]\s?\d{2})\s*[ABC]?\s*$/);
  const negInWords = ws.some((w) => /-\s*\d{1,4}[.,]\s?\d{2}/.test(w.text));
  const trailDisc = trailNeg && !negInWords ? parseNum(trailNeg[1]) : 0;
  // TRAILING positive TOTAL fused onto THIS name's line but with NO word box — MLKit keeps
  // the price in the LINE text ("CLEVER SVIESI RAIKY TA DUO 0, 45 A") yet drops its right-
  // column boxes, so `text` (words only) sees just the name and the row would fall through
  // as NAME-ONLY below: the price is lost AND, with no total to anchor it, the NEXT
  // product's total merges into this one via the assembler's `cur.total != null` boundary
  // (receipt-127: 2nd CLEVER loaf swallowed LIETUVIŠKI AGURKAI). Recover the VALUE from the
  // source line — symmetric to trailDisc above — but ONLY when: the words carry no amount of
  // their own (amt == null, so the clean/loose-total returns below didn't fire), it isn't a
  // discount line, and the line ends in a VAT-lettered POSITIVE amount that is NOT the
  // trailing negative trailDisc already captured. Geometry (the band) still comes from the
  // name's words; this recovers the scalar total only. Used ONLY in the name-only fallthrough.
  const trailPos = firstSrc.match(/(\d{1,4}[.,]\s?\d{2})\s*[ABC]\s*$/);
  const trailPosNeg = !!trailPos && /-\s*$/.test(firstSrc.slice(0, trailPos.index));
  const trailTotal =
    trailPos && !trailPosNeg && amt == null && trailDisc === 0 &&
    !isTDiscount(text) && !isTDiscount(firstSrc)
      ? parseNum(trailPos[1]) : 0;
  // A CLEAN positive decimal is always a TOTAL — even when a discount LABEL got fused
  // onto the line ("NUOLAIDA ŠU 18,15" = a label + the total from the line above, an
  // MLKit mis-group on a tilted receipt). Discounts always print a minus; a positive
  // decimal is never a discount. (A decimal-LESS loose amount like "48 A" stays a
  // discount on a NUOLAIDA line — there the minus was just dropped by OCR.)
  // …but NOT when the row is a DISCOUNT row that ALSO carries a negative (receipt-154
  // "NUOLAIDA SU KORTELE -0,50 1,99 A A") — that shape must reach the discount branch
  // below, which takes the -0,50 as the discount and the 1,99 as mergedTotal. The
  // doubled-VAT tolerance in T_TRAIL would otherwise early-return it as a plain total
  // and silently drop the discount.
  if (cleanDecimal && amt! > 0 && !(isTDiscount(text) && T_NEG_RE.test(text))) return { ...base, total: amt, trailDisc, leftText: text.replace(amtRe, '').trim() };
  if (isTDiscount(text) || (amt != null && amt < 0)) {
    // recover a word-dropped discount amount from the source line ("NUOLAIDA" word
    // survived, "-0,30 A" did not — but it's still in the line text)
    const d = text.match(T_NEG_RE) ?? firstSrc.match(T_NEG_RE);
    const dv = d ? parseNum(d[1]) : (amt != null ? Math.abs(amt) : 0);
    // MERGED ROW: when overlapping OCR boxes glue a product's OWN positive total onto its discount
    // row ("NUOLAIDA SU KORTELE -0,50 1,99 A A"), the discount-only return would LOSE the 1,99 and
    // the product vanishes (receipt-154 SUNOKE). Recover a positive VAT-lettered amount in the WORDS
    // (not preceded by a minus, distinct from the discount dv) as a CANDIDATE total — carried on a
    // SEPARATE `mergedTotal` field so the assembler can REFUSE it for a weighed product (whose total
    // comes from its own kg-calc; a weighed neighbour's total can leak into a discount row — that is
    // the receipt-105 paprikos false positive). A unit product adopts it.
    let posTotal: number | null = null;
    for (const m of text.matchAll(/(-?)\s*(\d{1,4}[.,]\s?\d{2})\s*[ABC]\b/g)) {
      if (m[1] !== '-') { const v = parseNum(m[2]); if (v > 0 && v !== dv) { posTotal = v; break; } }
    }
    // UNIT-CALC fused onto the discount band, with the total's VAT letter OCR-misread to a
    // non-[ABC] glyph so the scan above missed it: "… 1,49 EUR/ yr 2,98 F" (a band-merge of the
    // per-unit calc line + the "NUOLAIDA SU KORTELE" label whose own amount sits on a LATER row,
    // so dv === 0). The "EUR/<vnt-marker>" proves a per-unit item; take the unit price (decimal
    // before the marker) + the line total (decimal after) and DERIVE the count = total ÷ unit-price.
    // Require it to divide to a clean small integer (±0,02) so we never write a guessed price, and
    // carry the count so finalize stores the per-UNIT price (1,49), not the line total (poisoning
    // guard). Return it as a TOTAL row — the product's price lives here, the label is just fused.
    // (receipt-161 Žaliosios cukinijos: 2 vnt × 1,49 = 2,98 A, OCR'd "2,98 F".)
    if (dv === 0 && posTotal == null) {
      const mk = text.match(/(\d{1,4}[.,]\s?\d{2})\s*EUR\s*\/?\s*(?:vr|yr|vnt|vie|vnet)\b.*?(\d{1,4}[.,]\s?\d{2})/i);
      if (mk) {
        const up = parseNum(mk[1]), tot = parseNum(mk[2]);
        const n = up > 0 ? Math.round(tot / up) : 0;
        if (up > 0 && tot >= up && n >= 1 && n <= 99 && Math.abs(tot - n * up) <= 0.02) {
          return { ...base, total: tot, unitQty: n, leftText: '', discLabel: true };
        }
      }
    }
    // dv===0 ⇒ a "NUOLAIDA" label whose amount didn't land in this row's text (dropped or band-merged
    // onto a neighbour). Flag discLabel so the assembler arms discPending and recovers the amount from
    // a following BAG row (receipt-162 Žaliosios cukinijos: the -1,80 rode the MAIŠELIS row).
    let discLeft = text.replace(amtRe, '').replace(T_DISCOUNT_RE, '').trim();
    // INTERLEAVED UNION ROW (receipt-317): the same-line union in ikiClusterRows can merge the
    // "NUOLAIDA SU KORTELE" label with the NEXT product's NAME (both printed rows inside one
    // Vision line), and the x-sort INTERLEAVES them ("Fasuoti NUÓLAIDA obuoliai SU KORTELL IKI
    // ÜKIS -0,23"). The regex strip above then leaves label residue in leftText, ikiNameText
    // rejects it, and the next product goes nameless ("?"). Rebuild from the WORDS: drop
    // amount-shaped / short / label words; adopt what remains ONLY when it is a STRONG name
    // whose words sit at/BELOW the label words — a fused next-name is always the printed row
    // UNDER its neighbour's label. Fires only when the plain strip yielded no usable name.
    // Three guards keep this from minting phantoms out of label GARBLE (the trailer rot
    // "wuniuy uU KURTELA", receipt-234, or same-row crumbs "ŠI CO", receipt-152):
    //   (a) dv > 0 — the row carries a REAL discount amount (the fused shape always does;
    //       a bare garbled label has nothing to anchor it),
    //   (b) the candidate has a ≥4-letter WORD (ikiStrongName counts letters ACROSS words,
    //       so two 2-letter crumbs pass it),
    //   (c) the candidate's words sit CLEARLY BELOW the label words (≥ a third of the word
    //       height) — same-row garble sits level with the label and is rejected.
    if (dv > 0 && !ikiNameText(discLeft)) {
      const isLabelWord = (s: string) => /^[SŠ$5][UŲÙÚÜ]$/i.test(s) || T_DISCOUNT_RE.test(s) ||
        isKorteleWord(s) || hasKeyword(s, LEX.NUOLAIDA);
      const lWs = ws.filter((w) => isLabelWord(w.text.trim()));
      const nWs = ws.filter((w) => {
        const s = w.text.trim();
        return !/\d/.test(s) && !isLabelWord(s) &&
          s.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length >= 2;
      });
      const yC = (w: EWord) => (w.yTop + w.yBottom) / 2;
      const wordH = emedian(ws.map((w) => w.yBottom - w.yTop));
      const cand = nWs.map((w) => w.text).join(' ').trim();
      if (nWs.length && lWs.length && ikiStrongName(cand) && !isTSkip(cand) &&
          nWs.some((w) => w.text.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length >= 4) &&
          emedian(nWs.map(yC)) >= emedian(lWs.map(yC)) + wordH * 0.35) {
        discLeft = cand;
      }
    }
    return { ...base, discount: dv, mergedTotal: posTotal, discLabel: dv === 0, leftText: discLeft };
  }
  if (amt != null && amt > 0) return { ...base, total: amt, trailDisc, leftText: text.replace(amtRe, '').trim() };
  // ── SOUP-ROW RECONSTRUCTION (FIX C, receipt-271) ── Dense pitch + curvature can attach a
  // product's total AND its discount to the NAME row, x-interleaving the amount tokens into
  // soup no trailing lane can read ("LAVAZ7A … MALTA -4, 9,99 50 A A" = 9,99 total + -4,50
  // discount, tokens shuffled). Reconstruct from the word multiset: complete decimals stand
  // alone; an orphan head ("-4,") pairs with the nearest following bare 2-digit token ("50").
  // Commit ONLY the unambiguous shape — exactly ONE positive + ONE negative, everything
  // paired, a VAT letter present, a real name on the left, and paid = pos − neg ≥ 0. The
  // row then carries its OWN total + discount (selfDisc, not trailDisc — it must not leak
  // to the previous product). Receipt reconciliation corroborates downstream.
  if (!/EUR\s*\/|\bvnt\b|\bkg\b/i.test(text)) {
    const toks = text.split(/\s+/).filter(Boolean);
    const amounts: number[] = [];
    const heads: string[] = [];
    let vatSeen = 0; let bad = false;
    const nameToks: string[] = [];
    for (const t of toks) {
      if (/^-?\d{1,4}[.,]\d{1,2}$/.test(t)) { amounts.push(parseNum(t)); continue; }
      if (/^-?\d{1,4}[.,]$/.test(t)) { if (heads.length >= 2) { bad = true; break; } heads.push(t); continue; }
      if (/^\d{2}$/.test(t) && heads.length) { amounts.push(parseNum(heads.shift()! + t)); continue; }
      if (/^[ABC]$/.test(t)) { vatSeen++; continue; }
      nameToks.push(t);
    }
    const pos = amounts.filter((v) => v > 0);
    const neg = amounts.filter((v) => v < 0);
    const soupName = nameToks.join(' ');
    if (!bad && heads.length === 0 && pos.length === 1 && neg.length === 1 && vatSeen >= 1 &&
        pos[0] + neg[0] >= -0.005 && ikiStrongName(soupName) && !isTDiscount(soupName)) {
      return { ...base, total: pos[0], selfDisc: Math.abs(neg[0]), leftText: soupName };
    }
  }
  // PRICE-SHAPED but UNREADABLE decimals ("3, 4: A" — ':' resolves to no digit): every value
  // lane failed, but the SHAPE (real-digit integer + separator + 2 decimal slots + VAT letter
  // + end-of-row) proves this IS the product's total row. Close the product with an UNKNOWN
  // total + candidate expansions — receipt reconciliation (Phase 2) pins the value from
  // Σ paid = printed total. The old behavior absorbed the garbled amount into the NAME and
  // merged two products (receipt-269 oil "3, 4: A").
  {
    const um = text.match(/(^|[^-\d])(\d{1,4})[.,]\s?([^\s]{2})\s*[ABC]\s*$/);
    if (um && /[^\d]/.test(um[3]) && !isTDiscount(text) && !isTDiscount(firstSrc)) {
      const cands = expandUnknownDecimals(um[2], um[3]);
      // the garbled amount text must NOT ride into the product name
      const leftText = text.slice(0, um.index! + um[1].length).trim();
      return { ...base, totUnknown: true, totCands: cands, trailDisc, leftText };
    }
  }
  // HEADLESS BARE-CENTS total (receipt-308): the OCR drops the amount's integer+comma,
  // leaving a bare 2-digit cents token after the name ("KETO LENGVAI DUONA SU SĖK 59" for
  // "… 2,59 A"). A product name never ends in a stray 2-digit token, so classify it as an
  // UNKNOWN total whose CENTS are known — reconciliation solves the integer part (incl.
  // the twin equal-split lane when two same-name rows degrade identically).
  {
    const hb = text.match(/^(.{8,}?[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž])\s+(\d{2})\s*$/);
    if (hb && amt == null && trailDisc === 0 && trailTotal === 0 &&
        ikiStrongName(hb[1]) && !isTDiscount(text) && !isTDiscount(firstSrc)) {
      return { ...base, totUnknown: true, totCands: null, unkCents: Number(hb[2]), leftText: hb[1].trim() };
    }
  }
  // Name-only fallthrough — but recover a word-boxless positive total from the source line
  // so the name anchors its OWN product instead of letting the next product's total merge in.
  // Flagged `softTotal` so the assembler can refuse it when this row is only CONTINUING a
  // wrapped name (where the boxless amount may be an unrelated MLKit leak, not a real total).
  if (trailTotal > 0) return { ...base, total: trailTotal, softTotal: true, leftText: text, trailDisc };
  return { ...base, leftText: text, trailDisc };
}

// Candidate values for a price whose DECIMAL glyphs are partly unreadable: digits pass
// through, mapped confusion glyphs resolve, anything else becomes a wildcard digit.
// Two wildcards → null (unconstrained: 100 candidates say nothing).
function expandUnknownDecimals(intPart: string, dec: string): number[] | null {
  const sets: string[][] = [];
  let wildcards = 0;
  for (const ch of dec) {
    if (/\d/.test(ch)) sets.push([ch]);
    else if (GLYPH_DIGIT[ch]) sets.push([GLYPH_DIGIT[ch]]);
    else { wildcards++; sets.push(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']); }
  }
  if (wildcards >= 2) return null;
  let combos = [''];
  for (const set of sets) combos = combos.flatMap((c) => set.map((d) => c + d));
  return combos.map((d) => parseFloat(`${intPart}.${d}`)).filter((v) => Number.isFinite(v) && v > 0);
}

// "SU KORTELĖ" discount-label tails (OCR-garbled: "SU K HT", "ŠU KORTEL.") must
// NEVER be mistaken for a product name — they create phantom products.
// Card-word predicate: skeleton first, lexicon fallback (Phase 3 — additive coverage).
const isKorteleWord = (s: string) => T_KORTELE_RE.test(s) || hasKeyword(s, LEX.KORTELE);
const ikiLabelTail = (s: string) => /^[SŠ]U\b/i.test(s.trim()) || isKorteleWord(s);
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
// `splitH` bounds only the ROW-SPLIT threshold (the chain-merge fix: min(boxH, measured
// pitch)); `lineH` (the raw box height) keeps scaling the ATTACH radius and the re-home
// guards — those radii must stay generous or multi-row weighed/unit-calc folding loses
// its discount/calc rows (receipts 150/154/161 regressed when the pitch shrank them).
function ikiBuildRows(words: EWord[], lineH: number, splitH: number, medSlope: number, xMid: number): EWord[][] {
  const left: EWord[] = [], right: EWord[] = [];
  for (const w of words) ((w.xLeft + w.xRight) / 2 < xMid ? left : right).push(w);
  const normOf = (w: EWord) => (w.yTop + w.yBottom) / 2 - medSlope * ((w.xLeft + w.xRight) / 2);
  const norm = (ws: EWord[]) => emedian(ws.map(normOf));
  // ── CROSS-COLUMN OFFSET CORRECTION (receipt-275) ── The de-skew above assumes ONE
  // linear slope across the receipt width, but on a curled/perspective-warped photo the
  // left-column baselines tilt (~+0.05) while the price column does NOT continue that
  // line (name→price pairwise slope ≈ 0) — extrapolating medSlope over the ~500px column
  // gap then displaces every price norm by up to a full lineH, so true totals miss the
  // 0.6·lineH attach radius, go STANDALONE, and the whole assembly shifts one row
  // (275/272: Lavazza took grietinė's 2,79 + its band; the real 9,99 became a "?"
  // phantom — and reconciliation can NOT flag it, since swapped prices still sum right).
  // The receipt itself measures the model error: MLKit lines GLUED across both columns
  // hold a same-printed-row left/right pair, whose norm residual (left − right) is the
  // exact offset the linear model gets wrong at the price column. Sample only shapes
  // that are same-row BY PRINT FORMAT: a discount LABEL with its amount, or a strong
  // NAME with a positive VAT-lettered non-deposit total. A NAME glued to a NEGATIVE is
  // the classic cross-row fusion (the leading-discount shape, receipt-170) and a bare
  // deposit glued to a name rides the row below (receipt-228) — both excluded (on 275
  // they'd poison the median by +pitch: samples 50–60 vs true 20–29). The correction
  // only engages past a 0.25·lineH DEADBAND (box noise is ±6px — well-modeled receipts
  // stay byte-identical) and is capped at 0.9·lineH; it shifts ONLY the cross-column
  // attach comparison — within-column clustering and row order are untouched.
  const glued = new Map<number, { l: EWord[]; r: EWord[] }>();
  for (const w of words) {
    let e = glued.get(w.line);
    if (!e) glued.set(w.line, (e = { l: [], r: [] }));
    ((w.xLeft + w.xRight) / 2 < xMid ? e.l : e.r).push(w);
  }
  const corrSamples: number[] = [];
  for (const { l, r } of glued.values()) {
    if (!l.length || !r.length) continue;
    const lText = l.map((w) => w.text).join(' ');
    const rText = r.map((w) => w.text).join(' ');
    const m = rText.match(/(\d{1,4})[.,]\s?(\d{2})/);
    if (!m) continue;
    const rNeg = /-\s?\d/.test(rText);
    const rVat = r.some((w) => /[ABC]$/i.test(w.text.trim()));
    const rDeposit = Number(m[1]) === 0 && Number(m[2]) > 0 && Number(m[2]) <= 30 && Number(m[2]) % 10 === 0;
    if (!(isTDiscount(lText) || (ikiStrongName(lText) && !rNeg && rVat && !rDeposit))) continue;
    // Each side must be a TIGHT single-row group: MLKit also glues TWO printed rows into
    // one line (receipt-161: the unit-calc row + its NUOLAIDA label below), and a bimodal
    // side's median lands between the rows — fabricating an offset that isn't there.
    const lNorms = l.map(normOf), rNorms = r.map(normOf);
    if (Math.max(...lNorms) - Math.min(...lNorms) > lineH * 0.5) continue;
    if (Math.max(...rNorms) - Math.min(...rNorms) > lineH * 0.5) continue;
    corrSamples.push(emedian(lNorms) - emedian(rNorms));
  }
  let colCorr = 0;
  if (corrSamples.length >= 2) {
    const med = emedian(corrSamples);
    if (Math.abs(med) > lineH * 0.25) colCorr = Math.max(-0.9 * lineH, Math.min(0.9 * lineH, med));
  }
  if (process.env.IKI_DEBUG) {
    console.error(`[COLCORR] samples=[${corrSamples.map((s) => s.toFixed(1)).join(', ')}] colCorr=${colCorr.toFixed(1)} lineH=${lineH.toFixed(1)}`);
  }
  const normA = (ws: EWord[]) => norm(ws) + colCorr;
  const linesOf = (ws: EWord[]) => new Set(ws.map((w) => w.line));
  const hosts = ikiClusterRows(left, splitH, medSlope).map((ws) => ({ ws, lines: linesOf(ws) }));
  const standalone: EWord[][] = [];
  for (let amt of ikiClusterRows(right, splitH, medSlope)) {
    // MONGREL SPLIT (receipt-275): xMid sits clamp-floored generously left, so a long
    // name's TAIL ("LAVAZZA … ORO MALTA") crosses into the price partition and can
    // cluster with the NEIGHBOUR row's amount. Rule (1) would then attach that amount
    // to the tail's name row — scrambling both the price and the discount. Split ONLY
    // the semantically-certain shape: the cluster is NEGATIVE and its digit words'
    // own source line maps to a DISCOUNT-LABEL host (on IKI a negative printed on a
    // label line belongs to that label, full stop) while the tail votes elsewhere.
    // Tails go home to their own line's host (completing the name); the amount stays
    // a cluster and proceeds to the label through the normal flow. Anything wider was
    // tried and REVERTED — generic tail re-routing broke the pinned dense-pitch
    // mongrel rides (161's unit-calc recovery, 172/242 fragment columns).
    const LT_ALPHA_RE = /^[A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]{3,}$/;
    const digitWords = amt.filter((w) => /\d/.test(w.text));
    const tailWords = amt.filter((w) => LT_ALPHA_RE.test(w.text.trim()));
    if (digitWords.length && tailWords.length && digitWords.some((w) => /-\s?\d/.test(w.text))) {
      const digitHost = hosts.find((h) => [...linesOf(digitWords)].some((ln) => h.lines.has(ln)));
      const tailHost = hosts.find((h) => [...linesOf(tailWords)].some((ln) => h.lines.has(ln)));
      if (digitHost && tailHost && digitHost !== tailHost &&
          isTDiscount(digitHost.ws.map((w) => w.text).join(' '))) {
        tailHost.ws.push(...tailWords);
        amt = amt.filter((w) => !tailWords.includes(w));
      }
    }
    const aLines = linesOf(amt);
    let host = hosts.find((h) => [...aLines].some((ln) => h.lines.has(ln)));   // (1) MLKit grouped them
    // LEADING-DISCOUNT GUARD: MLKit fuses a product's "-X,XX A" discount onto the NEXT product's
    // NAME line ("-0,60 A KETO LENGVAI…"), so rule (1) binds the discount to that next product — but
    // the discount sits a full line ABOVE the name (it belongs to the row above). When the same-line
    // host is a line BELOW a NEGATIVE amount, drop rule (1) and fall through to nearest-Y, which
    // re-homes it on the discount-label row above. (receipt-170: -0,60 is ROKIŠKIO's, not KETO's.)
    // Only when the same-line host is a real product NAME — NOT a bag/coupon skip (a discount that
    // band-merged onto a MAIŠELIS bag row is recovered by the bag-gated discPending path, which needs
    // it left on the bag row; re-homing it there would break that — receipt-161 Žaliosios cukinijos).
    const isNegAmt = amt.some((w) => /^-/.test(w.text.trim()));
    const hostText = host ? host.ws.map((w) => w.text).join(' ') : '';
    if (host && isNegAmt && !isTSkip(hostText) && norm(host.ws) > normA(amt) + lineH * 0.5) host = undefined;
    // POSITIVE twin of the leading-discount guard, DEPOSIT-TARGETED: MLKit also glues a
    // bare bottle-deposit amount onto the NEXT printed line's NAME ("0,10 TICHĖ NATŪRALUS…",
    // receipt-228 — the deposit's 0,10 rode on the water's name line), so rule (1) binds it
    // a full line below where it belongs. Signature of that case: the amount is positive
    // with NO VAT-class letter (every real product total ends in A/B/C; deposits never do)
    // and a DEPOSIT-labeled row exists nearby. Re-home it onto the nearest deposit row —
    // never onto an arbitrary nearest row: under a sheared/curved column (receipt-169 —
    // the price column rides a full line below the names) nearest-Y picks the WRONG name
    // row, while the deposit row is the semantically-certain owner of a bare no-VAT amount.
    // Three gates keep this from stealing a REAL total whose VAT letter merely got
    // dropped/garbled: (a) VAT scan over ALL amount words (the letter is often its own
    // token or fused into the number, "0,10A"); (b) the amount must be an actual DEPOSIT
    // DENOMINATION (0,10/0,20/0,30 — the assembler's own depositLike rule); (c) never
    // target a deposit-REFUND row (its negative is the refund itself, not a home for a
    // stray positive).
    const amtText = amt.map((w) => w.text).join(' ');
    const amtHasVat = amt.some((w) => /[ABC]$/i.test(w.text.trim()));
    const amtM = amtText.match(/(\d{1,4})[.,]\s?(\d{2})/);
    const amtDepositLike = amtM != null && Number(amtM[1]) === 0 &&
      Number(amtM[2]) > 0 && Number(amtM[2]) <= 30 && Number(amtM[2]) % 10 === 0;
    if (host && !isNegAmt && !amtHasVat && amtDepositLike && !T_DEPOSIT_RE.test(hostText) &&
        norm(host.ws) > normA(amt) + lineH * 0.5) {
      const aN = normA(amt);
      let dep: typeof host | undefined; let depD = lineH * 1.2;
      for (const h of hosts) {
        if (h === host) continue;
        const ht = h.ws.map((w) => w.text).join(' ');
        if (!T_DEPOSIT_RE.test(ht) || T_DEPOSIT_REFUND_RE.test(ht)) continue;
        const d = Math.abs(norm(h.ws) - aN);
        if (d < depD) { depD = d; dep = h; }
      }
      if (dep) host = dep;
    }
    if (!host) {                                                               // (2) nearest by tilt-corrected Y
      // FIX B (receipt-271): a POSITIVE VAT-lettered amount is a product TOTAL — its home
      // is a NAME/calc row, never a bare "NUOLAIDA…" label (labels only own negatives on
      // IKI). Under dense pitch + curvature the label row can sit marginally nearer in
      // normalized Y than the true name row (grietinė's 2,79: label at 10px, DVARO at
      // 26px) — so label rows are eligible only when NO non-label host is in radius.
      // Negative / non-VAT amounts keep the plain nearest-Y rule.
      const aN = normA(amt);
      const posVat = !isNegAmt && amtHasVat && /\d/.test(amtText);
      let bestD = lineH * 0.6; let bestLabelD = lineH * 0.6;
      let bestLabel: { ws: EWord[]; lines: Set<number> } | undefined;
      for (const h of hosts) {
        const d = Math.abs(norm(h.ws) - aN);
        if (posVat && isTDiscount(h.ws.map((w) => w.text).join(' '))) {
          if (d < bestLabelD) { bestLabelD = d; bestLabel = h; }
        } else if (d < bestD) { bestD = d; host = h; }
      }
      host = host ?? bestLabel;
    }
    if (process.env.IKI_DEBUG) {
      const txt = amt.map((w) => w.text).join(' ');
      console.error(`[ATTACH] amt "${txt}" norm=${normA(amt).toFixed(1)} -> host="${host ? host.ws.map((w)=>w.text).join(' ').slice(0,40) : 'STANDALONE'}" hostNorm=${host ? norm(host.ws).toFixed(1) : '-'}`);
    }
    if (host) host.ws.push(...amt);
    else standalone.push(amt);                                                 // (3) price with no name
  }
  const rows = [...hosts.map((h) => h.ws), ...standalone];
  rows.sort((a, b) => norm(a) - norm(b));
  for (const r of rows) r.sort((a, b) => a.xLeft - b.xLeft);
  if (process.env.IKI_DEBUG_ROWS) {
    for (const r of rows) console.error(`[ROW] norm=${norm(r).toFixed(0)} "${r.map((w) => w.text).join(' ')}"`);
  }
  return rows;
}

// PER-CORNER SEAM ENFORCEMENT — the ONE tiling rule shared by PRODUCT bands and SKIPPED
// (coupon/bag/points) bands so both partition the receipt by the EXACT same rule. Each item
// carries its own CONTENT-TOP (the name/first-row top, NOT the possibly-inflated band top — a
// product band is tiled to extend UP to its predecessor, so its band top can sit above a skip
// that physically follows its name; ordering by content-top keeps the partition in true
// reading order). Sort by content-top, then snap each band's BOTTOM edge to the NEXT band's TOP
// edge (per corner, so the seam follows the receipt tilt): consecutive bands tile seam-to-seam
// — no overlap, no gap. Anchor on the LOWER band's own top so a name is never clipped. When a
// lower band's band-top has collided AT/ABOVE the upper's (an inflated product top, or a
// scrambled column), clamp the lower's top DOWN to the upper's bottom — never invert a band.
// Mutates the regions in place.
function enforceTileSeamsBy(items: Array<{ top: number; region: Region }>): void {
  const tile = items.filter((it) => !!it.region).sort((a, b) => a.top - b.top);
  for (let i = 1; i < tile.length; i++) {
    const A = tile[i - 1].region, B = tile[i].region;
    const bLT = B.yLeftTop ?? B.yTop, bRT = B.yRightTop ?? B.yTop;
    const aLT = A.yLeftTop ?? A.yTop, aRT = A.yRightTop ?? A.yTop;
    if (bLT > aLT + 1 && bRT > aRT + 1) {
      A.yLeftBottom = bLT; A.yRightBottom = bRT;
      A.yBottom = Math.max(bLT, bRT);
      A.yTop = Math.min(aLT, aRT);
    } else if (bLT <= aLT + 1 && bRT <= aRT + 1) {
      // B's band-top sits AT/ABOVE A's top → B would SWALLOW A. Clamp B's top DOWN to A's bottom
      // so B starts where A ends — but only when B stays non-inverted (its bottom still below A's).
      const aLB = A.yLeftBottom ?? A.yBottom, aRB = A.yRightBottom ?? A.yBottom;
      if ((B.yLeftBottom ?? B.yBottom) > aLB + 1 && (B.yRightBottom ?? B.yBottom) > aRB + 1) {
        B.yLeftTop = aLB; B.yRightTop = aRB;
        B.yTop = Math.min(aLB, aRB);
      }
    }
  }
}

// Tile PRODUCTS + SKIPPED bands into ONE seam-to-seam partition in DE-SKEWED space, then re-skew
// every band to the single receipt tilt `g`. Each item carries its de-skewed content extent
// [dt, db] (computed from its own words / box, NOT the possibly-inflated band edges). The seam
// between consecutive items (sorted by content-top) is max(upper.db, lower.dt):
//   • upper.db  → the upper band NEVER loses its own rows. The receipt-142 case: a weighed
//     product's price ("3,87 A") OCR-landed on the next coupon's row, so the product's content
//     extends BELOW the coupon's top; the band must still reach that price, not be cut at the
//     coupon and let the grey skip band "abduct" it.
//   • lower.dt  → the lower band isn't cut into.
//   • the max of the two → no gap, no overlap.
// Re-skewing both edges at `g` makes EVERY band — incl. the grey skipped ones — a parallelogram
// that BENDS with the receipt, exactly like the product bands (fixes flat skip bands). When the
// seam pushes an item's top past its own bottom (its content was fully claimed by the band
// above), it collapses to a thin sliver at the seam rather than inverting.
function tileByContent(items: Array<{ dt: number; db: number; region: Region }>, g: number, x0: number, x1: number): void {
  const tile = items.filter((it) => !!it.region && it.db > it.dt).sort((a, b) => a.dt - b.dt);
  for (let i = 1; i < tile.length; i++) {
    const seam = Math.max(tile[i - 1].db, tile[i].dt);
    tile[i - 1].db = seam;
    tile[i].dt = Math.min(seam, tile[i].db);   // never invert: clamp top at this item's own bottom
  }
  for (const it of tile) {
    const r = it.region;
    r.yLeftTop = it.dt + g * x0; r.yRightTop = it.dt + g * x1;
    r.yLeftBottom = it.db + g * x0; r.yRightBottom = it.db + g * x1;
    r.yTop = Math.min(r.yLeftTop, r.yRightTop);
    r.yBottom = Math.max(r.yLeftBottom, r.yRightBottom);
    r.xLeft = x0; r.xRight = x1;
  }
}

export function parseIkiColumnar(lines: IkiLine[], start: number, end: number, skipped?: Region[], headerAddr?: string, combo?: { amount: number }, recon?: { adjust: number }): IkiProduct[] {
  const words = ikiCollectWords(lines, start, end);
  if (words.length < 2) return [];
  const lineH = emedian(words.map((w) => w.yBottom - w.yTop).filter((h) => h > 0)) || 24;
  const medSlope = emedian(words.map((w) => w.slope));
  const X0 = Math.min(...words.map((w) => w.xLeft));
  const X1 = Math.max(...words.map((w) => w.xRight));
  const Xmid = ikiColumnSplit(words, X0, X1);
  // splitH = min(box height, measured row pitch), used ONLY for the row-split threshold:
  // identical to lineH unless the boxes are provably padded past the real pitch
  // (receipt-228, where inflated boxes chain-merged adjacent printed lines). The attach/
  // fold radii keep the generous lineH — see ikiBuildRows.
  // TUNING GRAVEYARD (both variants traded real fleet receipts — don't re-try blind):
  //   • LEFT-column-only estimate (to dodge cross-column stagger) shifted row formation
  //     on receipts 211/227 → lost products/promos.
  //   • A 0.65·lineH FLOOR (to guard a theoretical tilt-collapse where the stagger lands
  //     in the level band) re-merged receipt-211's genuinely sub-0.65·lineH rows — on a
  //     scrambled receipt the LOW measured pitch is CORRECT, the rows really are that
  //     close. The collapse scenario needs on-device tilt (stored fixtures all have
  //     medSlope=0), so guard it there if it ever materialises.
  const pitch = ikiEstimateRowPitch(words, lineH, medSlope);
  const splitH = pitch != null ? Math.min(lineH, pitch) : lineH;
  const rows = ikiBuildRows(words, lineH, splitH, medSlope, Xmid).map((ws) => ikiClassifyRow(ws, lines));

  // ── assemble: accumulate a product's rows until the NEXT product starts. The
  //    positive `X,XX A` total anchors a product; a discount FOLLOWS its total in
  //    IKI, so it attaches to the current product (not the next). A name fused onto
  //    a weight/total/discount row is recovered: on a discount row that name starts
  //    the NEXT product. Guarded recovery for a trailing name with no total. ──
  interface Cur { nameParts: string[]; perKg: number | null; total: number | null; totSoft: boolean; totUnknown: boolean; totCands: number[] | null; unkCents: number | null; discount: number; top: ERow | null; price: ERow | null; rows: ERow[]; aCount: number; kgRows: number; weighRows: number; kgVal: number | null; unitQty: number | null; discPending: boolean; discPendingCard: boolean; }
  const out: { p: IkiProduct; top: ERow; price: ERow | null; rows: ERow[] }[] = [];
  const fresh = (): Cur => ({ nameParts: [], perKg: null, total: null, totSoft: false, totUnknown: false, totCands: null, unkCents: null, discount: 0, top: null, price: null, rows: [], aCount: 0, kgRows: 0, weighRows: 0, kgVal: null, unitQty: null, discPending: false, discPendingCard: false });
  const rowText = (r: ERow) => r.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
  let cur = fresh();
  const flush = () => {
    const c = cur; cur = fresh();
    if (!c.top) return;
    let name = stripIkiLeadingHeaderParts(c.nameParts, headerAddr).map((s) => s.trim()).filter(Boolean).join(' ');
    // Recover a column-merged multi-buy calc that interleaved into the name (clean name + qty).
    // Only when a clean calc ROW didn't already set unitQty (that path never dirties the name).
    if (c.unitQty == null) {
      const mb = extractInterleavedMultibuy(name);
      name = mb.name;
      if (mb.unitQty != null) c.unitQty = mb.unitQty;
    }
    // (guarded recovery + the lt snapshot moved BELOW the row solver — the solver can
    // recover/correct c.total, and both must see the SOLVED value, not the raw read.)
    // LINE-TEXT weight recovery: MLKit sometimes drops the weight row's word-boxes, leaving
    // only the product NAME boxed on a fused "NAME … X,XXX kg X … EUR/kg" line — the column
    // engine (word-box based) then never sees the weight and the item drops to a unit price
    // (receipt-96 RAUDONOSIOS). Re-read the ORIGINAL line TEXT of the product's rows for a kg
    // quantity + €/kg on a weight-pattern line, so it stays weighed.
    if (c.perKg == null && c.kgVal == null) {
      for (const r of c.rows) {
        const li = r.words[0]?.line;
        const srcText = li != null ? lines[li]?.text : undefined;
        if (!srcText || !isTWeight(srcText)) continue;
        const km = srcText.match(/(\d[.,]\s?\d{3})\s*kg\b/i);
        if (km) { const q = parseNum(km[1]); if (q > 0) c.kgVal = q; }
        const pk = extractPerKg(srcText);
        if (pk != null) c.perKg = pk;
        if (c.kgVal != null) break;
      }
    }
    // ── ROW SOLVER (Phase 1, shared/ROBUST_PARSING_PLAN.md) ──
    // A weighed IKI line is an arithmetic identity: printed total = round2(kg × €/kg).
    // The parser has long recovered the other two directions (€/kg = total ÷ kg below;
    // qty = total ÷ €/kg in the quantity fallback) — this adds the third and uses it to
    // outrank risky reads:
    //  • RECOVER: both kg and €/kg are strict reads but the total was unreadable
    //    ("0, 7? A", a dropped total) → the total IS kg × €/kg. No glyph knowledge needed.
    //  • OVERRULE: the total came from a fallback lane (headless/bare/garbled — totSoft)
    //    and CONTRADICTS the locked arithmetic → the equation wins over the risky read
    //    (a foreign amount that drifted onto the calc row can no longer become the total).
    // A strict-read total is NEVER overruled here — a printed-vs-computed mismatch on
    // trusted reads is a receipt-level flag (Phase 2), not a silent rewrite.
    if (c.kgVal != null && c.kgVal > 0 && c.perKg != null && c.perKg > 0 && (c.weighRows >= 1 || c.kgRows >= 1)) {
      const expectTot = round2(c.kgVal * c.perKg);
      if (expectTot > 0) {
        if (c.total == null) {
          c.total = expectTot;
          if (process.env.IKI_DEBUG) console.log(`[SOLVER] recovered total ${expectTot} = ${c.kgVal} kg × ${c.perKg} €/kg (was unreadable)`);
        } else if (c.totSoft && Math.abs(c.total - expectTot) > 0.005) {
          // exact-to-the-cent identity: a soft read either matches round2(kg × €/kg)
          // exactly or the equation wins (even a 1-cent drift on a RISKY lane is a miss).
          if (process.env.IKI_DEBUG) console.log(`[SOLVER] overruled soft total ${c.total} → ${expectTot} (${c.kgVal} kg × ${c.perKg} €/kg)`);
          c.total = expectTot;
        }
      }
    }
    if (c.total == null && !c.totUnknown && !ikiStrongName(name)) return; // guarded recovery (an unknown-total row still anchors)
    const lt = c.total ?? 0;
    // RECOVER a garbled €/kg: the printed €/kg was unreadable ("3,9a EUR" → null) but we
    // have the line total and the printed kg quantity, so €/kg = total ÷ qty
    // (2,87 ÷ 0,720 = 3,99). Keeps the item WEIGHED with a real €/kg instead of a unit
    // price equal to the line total (which would poison the per-kg reference price).
    let perKg = c.perKg;
    if (perKg == null && c.kgVal != null && c.kgVal > 0 && c.total != null) {
      const derived = round2(c.total / c.kgVal);
      if (derived > 0 && derived < 1000) perKg = derived;
    }
    // PRICE-POISONING GUARD: a WEIGHED item (a "kg X … EUR" / "X,XXX kg" row was seen) whose
    // €/kg STILL couldn't be established — €/kg unreadable AND the total÷qty recovery failed
    // (e.g. the qty was OCR-garbled too). It must NOT fall back to a unit price equal to the
    // LINE TOTAL: that total is for a FRACTION of a kg, so storing it as the product's price
    // would poison the per-kg reference price. Keep the item (unit 'kg' so it still SHOWS on
    // the receipt) but null its price / €-per-kg → the server's price ingestion skips it
    // (`item.price <= 0`) and never updates reference price. (User: "show it, never write price".)
    const weighedNoPpu = (c.weighRows >= 1 || c.kgRows >= 1) && perKg == null;
    // Prefer the PRINTED kg quantity ("1,992 kg") over total÷€/kg, which rounds to a
    // wrong figure (0,78 ÷ 0,39 = 2,0 instead of 1,992). Fall back to the derived value
    // only when the printed kg couldn't be read.
    const quantity = c.kgVal != null && c.kgVal > 0
      ? c.kgVal
      : (c.unitQty != null && c.unitQty > 0
        ? c.unitQty
        : (perKg != null && perKg > 0 && c.total != null ? round3(c.total / perKg) : 1));
    // For a "N vnt × P €/vnt" multi-buy the line total covers ALL units, so the per-unit price is
    // total ÷ count (2,98 ÷ 2 = 1,49) — matching the per-unit convention of weighed/single items.
    const unitPrice = weighedNoPpu ? 0
      : (perKg ?? (c.unitQty != null && c.unitQty > 0 ? round2(lt / c.unitQty) : lt));
    const paid = round2(lt - c.discount);
    // SANITY GATE: a discount can never exceed the line total — a NEGATIVE paid (e.g. a 0,01 €
    // line that mis-absorbed a foreign -1,80 discount → paid -1,79) is impossible, so the discount
    // was mis-attributed. Drop the promo rather than surface a negative "promo price". The penny
    // line itself is handled by the nameless-penny guard / region recovery.
    const validDisc = c.discount > 0 && paid >= 0;
    // Internal reconciliation markers (STRIPPED before the parse result leaves the parser):
    // _paid = what this line contributed to the printed total; null = unknown (unreadable
    // total). _unk carries the unknown-total candidates + discount for the receipt solver.
    // card-flavored discount? ("… SU KORTELE" rows) — feeds the sutaupėte equation
    const cardLabeled = c.rows.some((r) => (r.discount > 0 || r.discLabel) && isKorteleWord(rowText(r)));
    const marks: any = {
      _paid: c.total == null ? null : round2(lt - c.discount),
      ...(c.total == null && c.totUnknown ? { _unk: { cands: c.totCands, discount: c.discount, cents: c.unkCents ?? null } } : {}),
      ...(c.discount > 0 && cardLabeled ? { _cardDisc: c.discount } : {}),
      // a discount is KNOWN TO EXIST (its label printed) but the amount never surfaced —
      // the savings equation can pin it (kopūstai "HUOLA!DA KORTFLE" with no amount).
      ...(c.discPending && c.discount === 0 && c.total != null ? { _unkDisc: { card: c.discPendingCard, lineTotal: lt } } : {}),
    };
    out.push({
      top: c.top, price: c.price, rows: c.rows.slice(),
      p: {
        ...marks,
        name: cleanProductName(name || '?'),
        price: unitPrice,
        promoPrice: weighedNoPpu ? null : (validDisc && quantity > 0 ? round2(paid / quantity) : null),
        quantity,
        unit: (perKg != null || weighedNoPpu) ? 'kg' : 'vnt',
        // Priced per kg → weighable. Drives the server resolver to keep a weighable
        // catalog SP (rather than falling through to a garbled same-name orphan).
        isWeighable: perKg != null || weighedNoPpu,
        pricePerUnit: weighedNoPpu ? null : unitPrice,
        // FULL row text per product, so all parsed info lands in rawData even when
        // a band/coordinate is imperfect.
        rawLines: c.rows.filter((r) => !r.isSkip).map(rowText).filter(Boolean),
        region: { yTop: c.top.topY, yBottom: c.top.botY, xLeft: c.top.leftX, xRight: c.top.leftX },
      },
    });
  };
  let prevRow: ERow | null = null;
  for (const r of rows) {
    const afterFusedDepositLabel = prevRow?.depositFollows === true;
    // The BAG's own price sits on the row right after the "MAIŠELIS PLASTIKINIS" skip
    // row — remember that so the fold below can drop it (see the bag-price fold).
    const afterBagSkip = prevRow?.isSkip === true && T_BAG_RE.test(rowText(prevRow));
    prevRow = r;
    // The deposit's own bare PRICE ("0,10") lands on the row right after a fused
    // "discount + DEPOSIT-label" row (the label having ridden the discount above). It
    // arrives nameless with a small positive total, so the boundary logic below would
    // mint it as a phantom product. Fold it into the open product's band instead — same
    // as any other deposit: no value, no new product. (receipt-139 AKVILĖ GAZ.)
    // TWO discriminators keep this fold from eating a real product that merely happens to
    // follow a fused-deposit row (both signals are needed; a double OCR drop defeats either
    // one alone):
    //  (1) a real IKI deposit price carries NO VAT-class letter ("0, 10"); every product
    //      total ends in A/B/C ("1,29 A"). But OCR sometimes drops that trailing letter too.
    //  (2) the Lithuanian bottle deposit is €0,10 per container, so a deposit amount is a
    //      SMALL MULTIPLE OF 0,10 (0,10 / 0,20 / 0,30). A real product total like "0,45" — the
    //      double-drop case (name AND VAT letter gone) — is not, so it survives as its own
    //      product instead of being swallowed.
    const rowVatLettered = /[ABC]\s*$/.test(r.words.map((w) => w.text).join(' ').trim());
    const cents = r.total != null ? Math.round(r.total * 100) : -1;
    const depositLike = cents > 0 && cents <= 30 && cents % 10 === 0;   // 0,10 / 0,20 / 0,30 deposit denominations
    if (
      afterFusedDepositLabel && cur.top != null &&
      depositLike && !rowVatLettered && r.discount === 0 && !r.perKg && !ikiStrongName(r.leftText)
    ) {
      // deposit charge is part of the printed total — book it for reconciliation
      if (recon && r.total != null) recon.adjust = round2(recon.adjust + r.total);
      cur.rows.push({ ...r, isSkip: true, isDeposit: true }); continue;
    }
    // The BAG's OWN price ("0,01 A") sits on the row right after the "MAIŠELIS PLASTIKINIS"
    // skip row (whose fused loyalty discount already went to the product above). It arrives
    // NAMELESS with a tiny positive total, so the boundary logic below would mint it as a
    // phantom product that NAME RECOVERY then labels with the PRIOR product's name
    // ("Žaliosios cukinijos 0,01", receipt-214). A bag is a CHARGE, not a product — drop the
    // row. Guards: a real product after a bag carries a NAME (ikiStrongName) and effectively
    // never costs ≤ €0,50 nameless, so this fold can't eat one; a discount/weight row is excluded.
    if (
      afterBagSkip && r.total != null && r.total > 0 && r.total <= 0.5 &&
      r.discount === 0 && !r.perKg && !ikiStrongName(r.leftText)
    ) {
      // the bag's own charge is part of the printed total — book it for reconciliation
      if (recon) recon.adjust = round2(recon.adjust + r.total);
      continue;
    }
    if (r.isSkip) {
      // A bottle DEPOSIT belongs to the product ABOVE — fold it into that product's
      // rows so the SAME band covers it, but DON'T flush and DON'T add its amount
      // to the product (it's a charge, not a product). The charge itself IS part of
      // the printed total though — book a deposit-denomination amount riding the
      // row's own text ("DEPOZITAS 0, 10") into recon.adjust, or reconciliation
      // runs short by every deposit (receipt-278: 2×0,10). Refund rows are excluded
      // (their negative is the refund itself, not a charge).
      if (r.isDeposit && cur.top != null) {
        if (recon) {
          const dtxt = rowText(r);
          const dm = dtxt.match(/(\d{1,4}[.,]\s?\d{2})/);
          const dv = dm ? parseNum(dm[1]) : 0;
          const dc = Math.round(dv * 100);
          if (dc > 0 && dc <= 30 && dc % 10 === 0 && !/-\s*\d/.test(dtxt) && !T_DEPOSIT_REFUND_RE.test(dtxt)) {
            recon.adjust = round2(recon.adjust + dv);
          }
        }
        cur.rows.push(r); continue;
      }
      // RECOVER a mis-clustered discount AMOUNT that band-merged onto this skip row: ONLY when the
      // open product flagged discPending (its calc row carried a "NUOLAIDA" label but no amount —
      // so a discount is KNOWN to exist), it has no discount yet, the negative fits its total, AND
      // the skip is a BAG. A bag never carries its own negative, so the amount must be foreign; a
      // coupon/points skip ("KUPONAS -0,30", "IKI Taškais -0,05") owns its negative and must NOT be
      // stolen (the bag gate is what keeps that promise). (receipt-161 Žaliosios cukinijos: -1,80
      // rode the MAIŠELIS bag row.)
      let skipDiscStolen = false;
      if (cur.discPending && cur.discount === 0 && r.discount > 0 && cur.total != null &&
          r.discount <= cur.total && T_BAG_RE.test(rowText(r))) {
        cur.discount += r.discount; cur.discPending = false; skipDiscStolen = true;
      }
      // The skip's own charge (+) / own negative (−) are part of the printed total —
      // book them so receipt reconciliation can balance (IKI Taškais +0,01/−0,05,
      // coupon negatives, bag charges that ride the skip row itself).
      if (recon) recon.adjust = round2(recon.adjust + (r.total ?? 0) - (skipDiscStolen ? 0 : r.discount));
      // Any OTHER skip (coupon/bag/points) CLOSES the current product: it's the
      // trailer section, so a trailing points amount (e.g. "IKI Taškais -0,05 A",
      // whose skip word didn't survive into the row's words) can't attach to the
      // last real product as a phantom discount.
      if (cur.total != null || cur.totUnknown) flush();
      continue;
    }
    // AGGREGATE/LOYALTY savings-line guard (receipt 119): the receipt's "sutaupėte 2,50
    // EUR" total can OCR-fuse onto a stray RE-PRINT of an already-bought product's name
    // ("CLEVER … DUO -2,50 A"). It arrives as a strong name whose ONLY amount is a
    // WORD-BOXLESS trailing negative (trailDisc; no own total/weight/word-boxed discount)
    // and whose name DUPLICATES an already-emitted product. Left alone the block below
    // would attach the 2,50 to the open product (poisoning its promo) and then the name
    // would mint a phantom duplicate. Drop the whole row. A GENUINE fused discount
    // (receipt-99/-109) carries the NEXT product's name, never a duplicate of one already
    // emitted, so it is untouched.
    if (r.trailDisc > 0 && r.total == null && r.perKg == null && !r.discount) {
      const nm = r.leftText && ikiNameText(r.leftText) ? r.leftText : '';
      const key = nm && ikiStrongName(nm)
        ? nm.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').toUpperCase() : '';
      if (key.length >= 6 && out.some((o) =>
        o.p.name.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').toUpperCase() === key)) {
        continue;
      }
    }
    // A trailing text-only discount fused onto THIS name row belongs to the PREVIOUS
    // product (IKI prints the discount under its product; OCR glued it onto the next
    // name with no word box). Attach the value to the open product BEFORE this name
    // boundary flushes it. Guarded to an open product that already has a total so a
    // stray leading-row minus can't invent a discount. (receipt-99 RAUDONOSIOS/POMIDORAI.)
    if (
      r.trailDisc > 0 && cur.top != null && cur.total != null &&
      // PLAUSIBILITY GUARD (user rule): a discount can't exceed the item's own total, so
      // a lost discount only belongs to the open previous product when that product's net
      // stays non-negative (gross − already-applied − this ≥ 0). The salmon takes the
      // fused -7,48 (18.15 − 7.48 = 10.67 ✓); a candidate it would drive negative (e.g. a
      // €1,49 milk) cannot own it, so it is left for the right product rather than
      // poisoning this one. (receipt-109 salmon vs NAMINIS.)
      cur.total - cur.discount - r.trailDisc >= -0.005
    ) {
      cur.discount += r.trailDisc;
      cur.aCount++;
    }
    const name = r.leftText && ikiNameText(r.leftText) ? r.leftText : '';   // usable name text
    const strong = !!name && ikiStrongName(name);                          // can START a product
    // A trailTotal-RECOVERED total (no word box) must NOT anchor a product when this row is
    // merely CONTINUING the name of an already-open, still-totalless product: MLKit can leak
    // an unrelated "X,XX A" into a wrapped name's source text, and honoring it would split one
    // product into a phantom-priced half + an orphan "?". A FRESH product (cur.top == null,
    // first row) still honors it — that is the receipt-127 win. Suppressed here → the row falls
    // through as a name continuation; the product's REAL total arrives on a later row.
    const softCont = r.softTotal === true && cur.top != null && cur.total == null && cur.nameParts.length >= 1;
    const rTotal = softCont ? null : r.total;                              // effective total for assembly
    const carriesAmt = rTotal != null || r.discount > 0 || r.totUnknown === true; // an A-terminated price (incl. unreadable)
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
    // COMBO-SET row ("RINKINYS -1,90"): the discount is IKI's multi-buy DEAL amount —
    // a RECEIPT-level adjustment (→ footer.comboDiscount), NOT the open product's promo,
    // and the bare combo word must never open a product. Intercept BEFORE the discount
    // branches below would attribute the -1,90 to the open product (where a net-negative
    // guard silently discards it — receipt-229's "IKI most expensive" bug). The row stays
    // visible as a grey skip band.
    if (r.discount > 0 && isIkiComboSetName(r.leftText || '')) {
      if (combo) combo.amount = round2(combo.amount + r.discount);
      if (skipped && r.words.length) {
        skipped.push({
          xLeft: Math.min(...r.words.map((w) => w.xLeft)),
          xRight: Math.max(...r.words.map((w) => w.xRight)),
          yTop: r.topY, yBottom: r.botY, kind: 'skipped',
        } as LabeledRegion);
      }
      continue;
    }
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
    if (r.discount > 0) {
      cur.discount += r.discount; cur.aCount++; cur.top ??= r; cur.rows.push(r);
      // a discount can RIDE a weight/calc row when OCR merged the bands (DZIOVINTOS SLYVOS:
      // "0,355 kg X8,99 -0,80 A") — record the weigh data here too (the branch `continue`s before
      // the normal weigh assignment below), so the product stays weighed with its €/kg + qty.
      if (r.perKg != null) cur.perKg = r.perKg;
      if (r.kgVal != null && cur.kgVal == null) cur.kgVal = r.kgVal;
      if (r.weigh) cur.weighRows++;
      if (r.kgQty) cur.kgRows++;
      if (r.unitQty != null && cur.unitQty == null) cur.unitQty = r.unitQty;
      // a discount row can ALSO carry its product's OWN positive total — overlapping OCR boxes
      // merged them ("… -0,50 1,99 A A"). Adopt it so the product isn't left totalless and lost
      // (receipt-154 SUNOKE: its 1,99 rode on the discount row). NOT for a weighed product: its
      // total comes from its kg-calc, and a weighed NEIGHBOUR's total can leak into this discount
      // row, minting a phantom with a foreign discount (receipt-105 paprikos).
      // FIX A (receipt-271 price theft): donation requires a REAL discount amount on the
      // row (dv > 0 — the receipt-154 shape "NUOLAIDA … -0,50 1,99 A"). A BARE label
      // (dv = 0) glued with a positive is almost always the NEXT product's price that
      // MLKit sheared onto the label line — donating it steals the neighbour's price
      // (Lavazza took grietinė's 2,79). The bare-label positive is left for the attach/
      // reconciliation layers to place correctly.
      if (r.mergedTotal != null && r.discount > 0 && cur.total == null && cur.perKg == null && cur.kgVal == null && cur.weighRows === 0) {
        cur.total = r.mergedTotal; cur.price = r; cur.aCount++;
      }
      continue;
    }
    // A fresh strong name, or a SECOND total, begins a new product. A strong name
    // ALSO ends the current product when it already has a weight (perKg) even with
    // NO total — IKI dropped the total on this scan, but a new named product still
    // means the old one is done (prevents POMIDORAI absorbing RAUDONOSIOS).
    if ((strong || rTotal != null || r.totUnknown === true) && (cur.total != null || cur.totUnknown)) flush();
    else if (strong && cur.perKg != null) flush();
    // TWIN PURCHASE (receipt-307): two consecutive IDENTICAL strong names are two UNITS of
    // the same item, never a wrapped name — IKI wraps long names, but a wrap never repeats
    // the WHOLE name. The open twin reached here totalless only because OCR destroyed its
    // amount ("…DUONA SU SĖK CO" for "… 2,59 A"); flush it as an UNKNOWN-total product so
    // Phase-2 reconciliation can solve the destroyed value from the printed total (the Σ of
    // the other lines leaves exactly one line's worth unaccounted — the receipt names its
    // own answer). Without this the twins merged into one double-named product AND the
    // second loaf's 2,59 was silently absorbed.
    else if (strong && name && cur.total == null && !cur.totUnknown && cur.nameParts.length > 0) {
      const tw = (s: string) => foldForeignDiacritics(s).toLowerCase().replace(/[^a-z0-9]/g, '');
      const open = tw(cur.nameParts.join(' '));
      const incoming = tw(name);
      if (open.length >= 8 && (open === incoming || open.startsWith(incoming) || incoming.startsWith(open))) {
        cur.totUnknown = true;    // no candidates — recon's single-unknown solve pins the value
        cur.totCands = null;
        flush();
      }
    }
    if (name) cur.nameParts.push(name);
    if (r.perKg != null) cur.perKg = r.perKg;
    if (rTotal != null) { cur.total = rTotal; cur.totSoft = r.totSoft === true; cur.price = r; cur.aCount++; }
    if (rTotal != null && r.selfDisc != null && r.selfDisc > 0) { cur.discount += r.selfDisc; cur.aCount++; }
    else if (r.totUnknown === true && cur.total == null && !cur.totUnknown) {
      cur.totUnknown = true; cur.totCands = r.totCands ?? null; cur.unkCents = r.unkCents ?? null; cur.price = r; cur.aCount++;
    }
    if (r.discLabel) {
      cur.discPending = true;   // calc row carried a NUOLAIDA label w/o amount → recover it from a later row
      // card-flavored label ("… SU KORTELE") — feeds the sutaupėte savings equation
      if (isKorteleWord(rowText(r))) cur.discPendingCard = true;
    }
    if (r.kgQty) cur.kgRows++;
    if (r.weigh) cur.weighRows++;
    if (r.kgVal != null && cur.kgVal == null) cur.kgVal = r.kgVal;
    if (r.unitQty != null && cur.unitQty == null) cur.unitQty = r.unitQty;
    cur.top ??= r; cur.rows.push(r);
  }
  flush();
  if (out.length === 0) return [];

  out.sort((a, b) => a.top.topY - b.top.topY);

  // ── MINUS-DROPPED LOYALTY DISCOUNT (post-pass — needs the Y-sorted LOOKAHEAD the streaming
  //    assembler lacks): OCR sometimes drops the leading "-" on a "NUOLAIDA SU KORTELE -X,XX A"
  //    line, so it parses as a positive TOTAL (a CLEAN positive decimal is always a total — see
  //    makeERow ~972) and becomes a phantom product whose NAME is only the discount label
  //    (receipt-161 LAVAZZA: -4,50 → a stray "?" priced 4,50, and LAVAZZA loses its promo).
  //    Fold that phantom into the PRECEDING product as its discount. The SAME shape also appears
  //    when MLKit tilt-displaces a real product's total onto a discount line ("NUOLAIDA ŠU 18,15"),
  //    and there the amount is a genuine FOREIGN total — folding it would delete a real product
  //    AND write a bogus promo. Discriminate with signals only available post-sort:
  //      • the preceding product P is a plain unit item with no discount yet and a price ≥ the
  //        amount (so it fits as P's loyalty discount), AND
  //      • the FOLLOWING product is NOT an orphan that lost its own total (a tilt-displaced total
  //        leaves the next product priced 0) — i.e. nothing downstream still needs this amount.
  //    If either fails, leave it a total (the parser's deliberate safe default). Asymmetric on
  //    purpose: a stray visible phantom beats deleting a real product + a wrong promo. ──
  for (let i = out.length - 1; i >= 1; i--) {
    const x = out[i].p;
    // The phantom is NAMELESS ("?": the label leftText never became a name) and its only content
    // is the NUOLAIDA discount label (carried in rawLines, not the name).
    if (x.name !== '?' && x.name !== '') continue;
    if (!(x.rawLines ?? []).some((l) => isTDiscount(l))) continue;
    if (x.unit === 'kg' || x.promoPrice != null) continue;               // not weighed, carries no discount of its own
    if (!(x.price != null && x.price > 0)) continue;
    if (x.quantity != null && x.quantity !== 1) continue;                // a single unit's dropped-minus discount only
    const P = out[i - 1].p;
    if (P.promoPrice != null || P.unit === 'kg' || P.price == null) continue;  // P: plain unit item, no discount yet
    if ((P.quantity ?? 1) !== 1) continue;
    // MAGNITUDE: a loyalty discount is a FRACTION of the price. A near-whole-price "discount" is
    // almost always a tilt-displaced FOREIGN total (18,15 off 19,99), never a real card discount.
    if (!(x.price > 0 && x.price <= P.price * 0.7)) continue;
    // CLEAN SUCCESSOR (the decisive guard): only fold when the FOLLOWING product is itself an intact
    // non-weighed unit item with its OWN positive total. That proves the receipt structure continues
    // normally and the amount did NOT belong to a downstream product whose total was displaced onto
    // this line. The false-fold cases all FAIL this: a weighed next (its total comes from a kg-calc
    // OCR may have dropped → it can't vouch for the structure), a price-0 orphan, or NO successor at
    // all (the phantom is the last line, so a lost-owner foreign total leaves no trace). In every one
    // of those, leave it a phantom (the parser's safe default) rather than risk deleting a real product.
    const next = out[i + 1]?.p;
    if (!(next != null && next.unit === 'vnt' && next.price != null && next.price > 0)) continue;
    const paid = round2(P.price - x.price);
    if (paid < 0) continue;
    P.promoPrice = paid;
    (P as any)._paid = paid; // the fold changed what this line contributed to the total
    const xr = x.region, pr = P.region;                                  // grow P's band over the folded discount line
    if (xr && pr) { pr.yBottom = Math.max(pr.yBottom, xr.yBottom); pr.xRight = Math.max(pr.xRight, xr.xRight); pr.xLeft = Math.min(pr.xLeft, xr.xLeft); }
    out[i - 1].rows.push(...out[i].rows);
    if (x.rawLines?.length) P.rawLines = [...(P.rawLines ?? []), ...x.rawLines];
    out.splice(i, 1);
  }

  // ── WEIGHED-PHANTOM FOLD (receipt-305 bananas): IKI can print a weighed item's TOTAL on
  //    its NAME line ("BANANAI BON VIA 0,48 A") with the kg-calc on the NEXT line ("0,400 kg
  //    X 1,19 EUR/ kg"). The name row then closes as a finished unit product, and the
  //    orphaned calc row mints a nameless weighed "?" — the product's data scattered across
  //    bands. The receipt's own arithmetic identifies the pair EXACTLY: fold when
  //    round2(kg × €/kg) equals the previous product's bare total to the cent. The merged
  //    product becomes properly weighed (qty=kg, price=€/kg — the storage convention). ──
  for (let i = out.length - 1; i >= 1; i--) {
    const x = out[i].p;
    if (x.name !== '?' && x.name !== '') continue;                        // phantom is nameless
    if (x.unit !== 'kg' || !(x.quantity != null && x.quantity > 0)) continue; // and weighed
    if (!(x.price != null && x.price > 0)) continue;                      // with a readable €/kg
    const P = out[i - 1].p;
    if (P.unit === 'kg' || P.price == null || P.price <= 0) continue;     // P: unit item…
    if ((P.quantity ?? 1) !== 1) continue;
    const kgTimesPerKg = round2(x.price * x.quantity);
    if (Math.abs(kgTimesPerKg - P.price) > 0.011) continue;               // exact-to-cent identity
    // Merge: P keeps its name + line total; adopts the calc's weighed identity. A discount
    // the calc row carried (already folded into the phantom's promo) transfers as the paid rate.
    const lineTotal = P.price;
    let disc = x.promoPrice != null ? round2((x.price - x.promoPrice) * x.quantity) : (P.promoPrice != null ? round2(P.price - P.promoPrice) : 0);
    // Word-boxed negative riding EITHER side's rows ("BANANAI BON VIA … -0,08 0,48 A" —
    // the calc fragments block the soup lane, the trailing lane suppresses trailDisc for
    // boxed negatives, so nothing captured it). Recover it here: this fold's exact
    // kg×€/kg=total identity already proves the row group's structure.
    if (disc === 0) {
      for (const rl of [...(P.rawLines ?? []), ...(x.rawLines ?? [])]) {
        const dm = rl.match(/-\s?(\d{1,4}[.,]\s?\d{2})\b/);
        if (dm) { const v = parseNum(dm[1]); if (v > 0 && v < lineTotal) { disc = v; break; } }
      }
    }
    P.quantity = x.quantity;
    P.unit = 'kg';
    P.price = x.price;                                                     // €/kg (storage convention)
    P.pricePerUnit = x.price;
    P.promoPrice = disc > 0 && x.quantity > 0 ? round2(round2(lineTotal - disc) / x.quantity) : P.promoPrice ?? null;
    (P as any)._paid = round2(lineTotal - disc);
    const xr = x.region, pr = P.region;                                    // grow P's band over the calc line
    if (xr && pr) { pr.yBottom = Math.max(pr.yBottom, xr.yBottom); pr.xRight = Math.max(pr.xRight, xr.xRight); pr.xLeft = Math.min(pr.xLeft, xr.xLeft); }
    out[i - 1].rows.push(...out[i].rows);
    if (x.rawLines?.length) P.rawLines = [...(P.rawLines ?? []), ...x.rawLines];
    out.splice(i, 1);
  }

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
    // Same garble tolerance as T_LEAD_DISC_GARBLED_RE: a leading minus + short digit-ish blob +
    // MANDATORY VAT letter recovers the fused name when OCR mangled the amount ("-000 A …").
    const leadGarbled = /^\s*-\s?[\dOoSsCcIl][\dOoSsCcIl.,\s]{0,4}\s*[ABC]\s+(.+)$/;
    // The discount LABEL can glue in FRONT of the minus too ("NUOLAIDA SU KORTELE -0,40 A
    // TRUMPAVAISIAI AGURKAI", receipt-307) — the ^-anchored patterns above never see the
    // name, so agurkai stayed "?" while its name sat in plain sight on the avocado's
    // discount line. Anchor on the label keyword instead.
    const labelLead = /(?:KORTELE|KORTEL\S{0,3}|NUOLAID\S{0,3})\s+-\s?\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s+(.+)$/i;
    const isAmtTok = (t: string) => /^-?[\d.,]+$/.test(t.trim()) || /^[ABC]$/.test(t.trim());
    const have = new Set(out.map((o) => o.p.name).filter((n) => n && n !== '?'));
    const cands: { name: string; y: number; li: number; used: boolean }[] = [];
    for (let i = start; i < end; i++) {
      const m = lines[i].text.match(lead) ?? lines[i].text.match(leadGarbled) ?? lines[i].text.match(labelLead);
      if (!m) continue;
      const nm = m[1].trim();
      // A bottle-deposit LABEL fused as the lead-discount tail ("-0,33 A DEP0ZITAS") is
      // NEVER a product name — it would mint a phantom "DEP0ZITAS". (Belt-and-braces: the
      // assembler already folds the deposit price, so no nameless product should reach here.)
      if (!isNameStart(nm) || isTSkip(nm) || isTWeight(nm) || ikiLabelTail(nm) || T_DEPOSIT_RE.test(nm)) continue;
      const clean = cleanProductName(nm);
      const candY = (lines[i].yTop + lines[i].yBottom) / 2;
      // The name already belongs to a product → normally a stray re-mention, so skip it.
      // BUT IKI lists the SAME item twice when you buy two (e.g. two "CLEVER … DUO" loaves,
      // only one discounted): the 2nd unit's name is dropped by OCR and survives only as the
      // LEAD of a discount line, while a SEPARATE nameless product sits right next to it.
      // Keep the duplicate candidate when such a nameless product is adjacent, so the 2nd
      // unit gets its real name instead of "?". (The pairing below still gives each nameless
      // product its NEAREST name, so this can't steal a far-away product's identity.)
      if (have.has(clean) && !nameless.some((o) => Math.abs(o.top.topY - candY) <= lineH * 2)) continue;
      cands.push({ name: clean, y: candY, li: i, used: false });
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
        words: ews, leftText: cands[best].name, total: null, perKg: null, discount: 0, trailDisc: 0, isSkip: false, isDeposit: false, kgQty: false,
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
        words: ews, leftText: o.p.name, total: null, perKg: null, discount: 0, trailDisc: 0, isSkip: false, isDeposit: false, kgQty: false,
        topY: Math.min(...ews.map((w) => w.yTop)), botY: Math.max(...ews.map((w) => w.yBottom)),
        leftX: Math.min(...ews.map((w) => w.xLeft)), slope: 0,
      });
      if (!o.p.rawLines.some((l) => letters(l).includes(probe))) o.p.rawLines = [o.p.name, ...o.p.rawLines];
      break;
    }
  }

  // ── PENNY-PHANTOM GUARD: a NAMELESS product priced at a stray penny (€0 < p ≤ 0.02) is almost
  //    never a real line — it's a bag/rounding artifact whose name landed on a neighbour's row. IKI
  //    prints "MAIŠELIS PLASTIKINIS" (a 0,01 € bag) as "-1,80 A MAIŠELIS PLASTIKINIS" (its name fused
  //    onto the PRIOR product's discount, no word boxes), leaving only the bare "0,01 A" price as an
  //    orphan "?" product. The bag's NAME line is already greyed as a skip (T_SKIP_NAME_RE), so drop
  //    the orphan penny so it doesn't surface as a phantom product. Weighed items (price = €/kg) are
  //    exempt. (User: an extremely-low price with no usable name is not a product.) ──
  for (let i = out.length - 1; i >= 0; i--) {
    const pp = out[i].p;
    const nameless = pp.name === '?' || pp.name === '';
    if (nameless && !pp.isWeighable && pp.price != null && pp.price > 0 && pp.price <= 0.02) out.splice(i, 1);
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
  // Per product: merged de-skewed top (aTop, for ordering) AND per-column extents —
  // the NAME column (left of Xmid) and the PRICE column (right of Xmid). Columns are
  // DIVERGED only at a "claimed" seam (a product whose NAME was recovered from the
  // PRIOR product's fused discount line). There a single straight seam can't cover the
  // recovered name (left) without dragging the prior product's discount (right) into
  // this band. EVERY OTHER seam stays the SAME single midpoint as before, so all the
  // non-discount fixtures keep their exact quad bands.
  const colT = (sub: EWord[], all: EWord[]) => Math.min(...(sub.length ? sub : all).map(dT));
  const colB = (sub: EWord[], all: EWord[]) => Math.max(...(sub.length ? sub : all).map(dB));
  const metas = out.map((o) => {
    const ws = o.rows.flatMap((r) => r.words);
    const lw = ws.filter((w) => cx(w) < Xmid), rw = ws.filter((w) => cx(w) >= Xmid);
    return {
      o, split: false, aTop: Math.min(...ws.map(dT)),
      lT: colT(lw, ws), lB: colB(lw, ws), rT: colT(rw, ws), rB: colB(rw, ws),
    };
  });
  metas.sort((a, b) => a.aTop - b.aTop);
  for (let i = 1; i < metas.length; i++) {
    const A = metas[i - 1], B = metas[i];
    // Two-box ONLY for a GENUINE discount-bleed conflict: B's name was recovered from a
    // fused discount line AND the upper product A actually OWNS a discount (so B's name
    // really landed on A's own NUOLAIDA row), AND the resulting per-column seams stay
    // non-inverted. A heavily-scrambled receipt can sort a 3rd product (with no discount)
    // between the discounted product and the claimed one, or cross a column — there the
    // two-box would invert a band, so we fall back to the safe quad.
    // "A owns a discount": normally promoPrice != null, but when OCR garbled the discount AMOUNT
    // ("-0,CO"/"-000") it never parsed to a promo even though the NUOLAIDA row is right there (and
    // is exactly what B's name fused onto). Detect the row itself so the two-box still engages.
    const aOwnsDiscount = A.o.p.promoPrice != null || A.o.p.rawLines.some((l) => isTDiscount(l));
    if (claimed.has(B.o) && aOwnsDiscount) {
      const ls = Math.min((A.lB + B.lT) / 2, B.lT);   // LEFT (names): CLAIM B's name
      const rs = (A.rB + B.rT) / 2;                    // RIGHT (prices/discounts): midpoint
      if (ls >= A.lT && rs >= A.rT && ls <= B.lB && rs <= B.rB) {
        A.lB = ls; B.lT = ls;
        A.rB = rs; B.rT = rs;
        A.split = true; B.split = true;
        continue;
      }
    }
    // Ordinary seam — ONE shared midpoint (the pre-two-box quad; never inverted). Claim
    // for a claimed B so its recovered name isn't cut.
    const bTop = Math.min(B.lT, B.rT);
    const aBot = Math.max(A.lB, A.rB);
    let s = (aBot + bTop) / 2;
    if (claimed.has(B.o)) {
      s = Math.min(s, bTop);
    } else {
      // FLOOR the seam at A's own lowest word so a weighed upper product's
      // "amount × €/kg" / price row (which de-skews BELOW the next product's name on a
      // tilted scan) stays inside A's band instead of bleeding into B. Capped at B's
      // bottom so B can never invert (the degenerate-band fallback backstops residue).
      // No-op when bands don't overlap in de-skewed y (the common case: aBot < bTop).
      s = Math.min(Math.max(s, aBot), Math.min(B.lB, B.rB));
    }
    // NEVER drop the seam below B's OWN top content (its name). On a column-scrambled
    // receipt the right (price) column lags the left (name) column by 1-2 products, so A's
    // lagged price/discount/weigh rows de-skew straight INTO B's name; the midpoint (or the
    // weigh-floor above) would then push the seam through B's name and CLIP it — the
    // receipt-120 P2/P3 "name cropped too low" regression. Capping at bTop anchors every
    // band at its own name top and keeps the tile clean (A.bottom == B.top). No-op on
    // ordinary receipts (A sits above B → s < bTop already). The unavoidable flat-band cost
    // is that A's lagged row may fall just below the seam (its VALUE is still extracted
    // correctly; only the crop rectangle misses it) — a stepped 8-point band would be the
    // only way to show both, and the user asked for flat (non-"choppy") bands.
    s = Math.min(s, bTop);
    A.lB = A.rB = s; B.lT = B.rT = s;
  }
  // Re-skew by g → every product is ONE flat parallelogram (both edges ride the single
  // receipt tilt g). For a two-box product the NAME column and PRICE column ended at
  // different rows (the old 8-point step / "choppy" band); collapse that step into a
  // single STRAIGHT border by AVERAGING the two — the user's "average" edge: the true
  // border sits between where the name row and the price row were heading. Non-split
  // products already have lT==rT / lB==rB (shared straight seams) so the average is a
  // no-op for them. Because the two-box wrote the SAME seam into A's bottom and B's top
  // at every boundary, the averaged edges stay equal too → adjacent bands tile EXACTLY
  // (A.bottom == B.top), no overlap and no gap, with no per-column step.
  for (const m of metas) {
    // SPLIT (two-box) product: its name column and price column ended at different rows.
    // Collapse to a STRAIGHT border by AVERAGING the two (the user's "average" edge — the
    // truth sits between where the name and price rows were heading). Because the two-box
    // wrote the SAME seam into A's bottom and B's top, the averaged edges stay equal too,
    // so adjacent split bands still tile EXACTLY. NON-split product: keep the union
    // (min-top / max-bottom) so a normal/weighed band still strictly CONTAINS every word.
    const aT = m.split ? (m.lT + m.rT) / 2 : Math.min(m.lT, m.rT);
    const aB = m.split ? (m.lB + m.rB) / 2 : Math.max(m.lB, m.rB);
    const yLT = aT + g * X0, yRT = aT + g * X1, yLB = aB + g * X0, yRB = aB + g * X1;
    m.o.p.region = {
      xLeft: X0, xRight: X1,
      yLeftTop: yLT, yRightTop: yRT, yLeftBottom: yLB, yRightBottom: yRB,
      yTop: Math.min(yLT, yRT), yBottom: Math.max(yLB, yRB),
    };
  }
  // DEGENERATE-BAND FALLBACK: when two products' OCR rows interleave in y (MLKit dropped a
  // name's boxes and fused the text onto a neighbour's row), the seam can collapse a band to
  // a sliver or invert it — the word-box geometry is broken and untrustworthy. Detect that
  // (any column height < MIN_BAND_H or inverted) and REDRAW from what we DO trust: the line
  // height × the product's content-line count. A product spans one line for its name+price
  // row, +1 for a weighed "amount × €/kg" row, +1 for a discount row — anchored at the
  // product's real name top. Always a clean, sane band instead of an empty sliver.
  const MIN_BAND_H = 3;
  for (const m of metas) {
    const r = m.o.p.region;
    const hL = (r.yLeftBottom ?? r.yBottom) - (r.yLeftTop ?? r.yTop);
    const hR = (r.yRightBottom ?? r.yBottom) - (r.yRightTop ?? r.yTop);
    if (hL >= MIN_BAND_H && hR >= MIN_BAND_H) continue;          // band is fine — leave it
    const ws = m.o.rows.flatMap((row) => row.words);
    if (!ws.length) continue;
    const lw = ws.filter((w) => cx(w) < Xmid);                  // name-column words (reliable anchor)
    const aT = (lw.length ? lw : ws).reduce((mn, w) => Math.min(mn, dT(w)), Infinity);
    let nLines = 1;                                              // name + price share one IKI row
    if (m.o.p.unit === 'kg') nLines++;                          // weighed: amount × €/kg row
    if (m.o.p.promoPrice != null) nLines++;                     // discount row
    const aB = aT + lineH * nLines;
    const yLT = aT + g * X0, yRT = aT + g * X1, yLB = aB + g * X0, yRB = aB + g * X1;
    m.o.p.region = {
      xLeft: X0, xRight: X1,
      yLeftTop: yLT, yRightTop: yRT, yLeftBottom: yLB, yRightBottom: yRB,
      yTop: Math.min(yLT, yRT), yBottom: Math.max(yLB, yRB),
    };
  }
  // FINAL TILE ENFORCEMENT: the degenerate fallback above redraws collapsed bands from
  // their OWN name-top + line count, ignoring neighbours — so a redrawn band can OVERLAP
  // the band above or leave a GAP below (receipt-121 P4/P5). Walk the products top-to-
  // bottom and snap each band's BOTTOM edge to the NEXT band's TOP edge (per corner) so
  // consecutive crops tile seam-to-seam: no overlap, no gap. Anchor on the LOWER band's
  // top (its name) so a name is never clipped. Skip a pair that would INVERT the upper
  // band (next.top sits at/above this.top — only a pathological same-row scramble); leave
  // it rather than collapse it. Bands the main seam loop already tiled are a no-op (their
  // bottom already equals the next top).
  if (skipped && skipped.length) {
    // SKIPPED bands (coupons / bags / points) tile by the SAME rule as products: build the
    // de-skewed content extent [dt, db] of every product (from its words) AND every skip (from its
    // box), then run ONE content-aware partition (tileByContent) that re-skews all of them to the
    // single receipt tilt g. This (a) makes the grey skip bands BEND like the product bands, and
    // (b) guarantees a product never loses its own rows to a following skip even when its price
    // OCR-landed on the skip's row (receipt-142). Done HERE, not post-hoc, because it needs each
    // product's true de-skewed content extent. Skips keep their 'skipped' identity / exclusion.
    const prodRegions = metas.map((m) => m.o.p.region).filter((r): r is Region => !!r);
    const sx0 = Math.min(...prodRegions.map((r) => r.xLeft), ...skipped.map((r) => r.xLeft));
    const sx1 = Math.max(...prodRegions.map((r) => r.xRight), ...skipped.map((r) => r.xRight));
    const items: Array<{ dt: number; db: number; region: Region }> = [
      ...metas.filter((m) => !!m.o.p.region).map((m) => {
        const ws = m.o.rows.flatMap((r) => r.words);
        return { dt: Math.min(...ws.map(dT)), db: Math.max(...ws.map(dB)), region: m.o.p.region! };
      }),
      ...skipped.map((r) => {
        const cxr = (r.xLeft + r.xRight) / 2;                       // de-skew the box about its own centre
        return { dt: (r.yLeftTop ?? r.yTop) - g * cxr, db: (r.yLeftBottom ?? r.yBottom) - g * cxr, region: r };
      }),
    ];
    tileByContent(items, g, sx0, sx1);
  } else {
    // No skips → preserve the original product-only ordering (by band top) exactly.
    enforceTileSeamsBy(metas.filter((m) => !!m.o.p.region).map((m) => ({ top: m.o.p.region!.yTop ?? 0, region: m.o.p.region! })));
  }

  // ── TWIN RECOVERY: the SAME product bought ×N prints as N IDENTICAL lines with the SAME unit price
  //    and SAME per-unit loyalty discount. When OCR drops PART of one line's amount (receipt-162: KETO
  //    "2,59"→"59" lost its integer+comma; MAGIJA discount "-0,26"→"0," lost its minus+cents) the value
  //    can't be rebuilt from that line alone — but an identical-named TWIN on the SAME receipt has it.
  //    Same receipt + same normalized name ⇒ same product ⇒ same price/discount, so this is an
  //    invariant, not a guess. Unit (vnt) items only; weighed items vary by weight. ──
  // Fold diacritics so OCR variance on accents doesn't split a twin pair ("SĖK" vs "SEK").
  const tnorm = (s: string) => stripDiacritics(s).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  for (let i = 0; i < out.length; i++) {
    const a = out[i].p;
    if (a.unit !== 'vnt' || a.price == null) continue;
    const aKey = tnorm(a.name);
    if (aKey.length < 4) continue;
    // Only IMMEDIATE neighbours qualify as twins: IKI prints identical units CONSECUTIVELY, so a real
    // twin is always adjacent. Adjacency shrinks the chance that a fold-key COLLISION between two
    // genuinely different goods (e.g. two products truncated to the same name) is mistaken for a twin
    // and lifts a wrong price/discount across them.
    const twins = [out[i - 1], out[i + 1]].filter((o) => !!o && o.p.unit === 'vnt' && tnorm(o.p.name) === aKey).map((o) => o!.p);
    if (!twins.length) continue;
    // (1) PRICE — a's price is the CENTS-ONLY remnant of a twin's (OCR dropped the integer+comma):
    // a < 1, a twin ≥ 1 with the SAME cents. Adopt the twin's full price (preserving a's own discount Δ).
    if (a.price < 1) {
      // Guard against overriding a GENUINE sub-€1 price: only recover when a's own line never carried
      // the well-formed "0,NN" (so OCR really dropped the integer, leaving a bare "NN") — a real 0,59
      // item prints "0,59 A" and must be left alone even if a 2,59 twin exists.
      const cents = String(Math.round(a.price * 100)).padStart(2, '0');
      const hasFullSubEuro = (a.rawLines ?? []).some((l) => new RegExp(`0\\s*[.,]\\s?${cents}\\b`).test(l));
      const pt = hasFullSubEuro ? undefined : twins.find((b) => b.price != null && b.price >= 1 && Math.round(b.price * 100) % 100 === Math.round(a.price * 100));
      if (pt && pt.price != null) {
        const ownDisc = a.promoPrice != null ? round2(a.price - a.promoPrice) : null;
        a.price = pt.price; a.pricePerUnit = pt.price;
        a.promoPrice = ownDisc != null && ownDisc > 0 && ownDisc < pt.price ? round2(pt.price - ownDisc) : null;
      }
    }
    // (2) DISCOUNT — a carries a NUOLAIDA label (a discount EXISTS) but no promo (its amount was lost);
    // a twin has a promo → apply the twin's per-unit discount Δ.
    if (a.promoPrice == null && a.price != null && (a.rawLines ?? []).some((l) => isTDiscount(l))) {
      const dt = twins.find((b) => b.promoPrice != null && b.price != null && b.price > b.promoPrice);
      if (dt && dt.price != null && dt.promoPrice != null) {
        const disc = round2(dt.price - dt.promoPrice);
        if (disc > 0 && disc < a.price) a.promoPrice = round2(a.price - disc);
      }
    }
  }

  // COMBO-SET discount: drop a bare "RINKINYS" line (IKI's multi-buy/combo deal), see
  // isIkiComboSetName. Qualified products ("ŽALUMYNŲ RINKINYS") survive — only the
  // standalone combo word is dropped. (receipt-169 "RINKINYS -1,90", receipt-206 "RINKTN)S".)
  // The dropped row's NEGATIVE is real money off the paid total — capture its magnitude
  // into the combo accumulator (→ footer.comboDiscount) instead of discarding it, and keep
  // the row visible as a grey skip band. (receipt-229: "RINKINYS -1,90" — without this the
  // total over-counts by 1.90 and the store comparison flags IKI as most expensive.)
  return out.filter((o) => {
    if (!isIkiComboSetName(o.p.name)) return true;
    if (combo) {
      // Distinct amounts only: a row's rawLines carry both the source line and the merged
      // row text, so the same "-1,90" can appear twice — one combo row has ONE deal amount.
      const seen = new Set<number>();
      for (const rl of o.p.rawLines ?? []) {
        const m = rl.match(T_NEG_RE);
        if (m) seen.add(parseNum(m[1]));
      }
      for (const v of seen) combo.amount = round2(combo.amount + v);
      if (skipped && o.p.region) skipped.push({ ...o.p.region, kind: 'skipped' } as LabeledRegion);
    }
    return false;
  }).map((o) => o.p);
}

function parseThermalProducts(lines: IkiLine[], start: number, end: number, headerAddr?: string, combo?: { amount: number; regions: Region[] }): IkiProduct[] {
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
    // Header-junk guard: a store / address / VAT-code line that leaked into the
    // product zone (pStart failed) must never START a product (see parseIkiColumnar).
    if (isIkiHeaderNamePart(toks[i].text, headerAddr)) { i++; continue; }
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
    // RECOVER a garbled €/kg from lineTotal ÷ the printed kg quantity (mirrors the column
    // engine). A weighed item whose printed €/kg was unreadable would otherwise price at the
    // line total, poisoning the per-kg reference price.
    if (perKg == null && weightPos >= 0 && lineTotal != null) {
      const lead = leadingKg(block[weightPos].text);
      const qty = lead && /[.,]/.test(lead) ? parseNum(lead) : NaN;
      if (Number.isFinite(qty) && qty > 0) {
        const derived = round2(lineTotal / qty);
        if (derived > 0 && derived < 1000) perKg = derived;
      }
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
    // PRICE-POISONING GUARD: a weighed item whose €/kg still couldn't be established (€/kg
    // unreadable AND total÷qty recovery failed) keeps unit 'kg' so it still SHOWS, but its
    // price/€-per-kg are nulled → the server skips it (`item.price <= 0`), never writing a
    // line-total as the per-kg reference price. (User: "show it, never write price".)
    const weighedNoPpu = weightPos >= 0 && perKg == null;
    const quantity = perKg != null && perKg > 0 ? round3(lineTotal / perKg) : 1;
    const unitPrice = weighedNoPpu ? 0 : (perKg ?? lineTotal);
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
      promoPrice: weighedNoPpu ? null : (discount > 0 && quantity > 0 ? round2(paid / quantity) : null),
      quantity,
      // Weighed items (have a €/kg, OR a weight row we couldn't price) are kg, not vnt —
      // drives the "0,720 kg × 3,99 €/kg" calculation line in the detail view.
      unit: (perKg != null || weighedNoPpu) ? 'kg' : 'vnt',
      isWeighable: perKg != null || weighedNoPpu,
      pricePerUnit: weighedNoPpu ? null : unitPrice,
      rawLines: [name, ...block.map((b) => b.text)],
      region,
    });
    i = next;
  }

  // NOTE: band WALLS (no-gap, no-overlap tiling) are applied later in
  // parseIkiThermal's unified pass, AFTER the skipped coupon/bag/points lines are
  // threaded in — so here each product keeps its TRUE content box (name-top +
  // price-row-bottom corners). The tiler turns those into seams.
  // Dropped bare-RINKINYS combo rows: capture the deal's negative into the combo
  // accumulator (→ footer.comboDiscount) + surface the row as a grey skip band —
  // see the identical columnar-path capture in parseIkiColumnar.
  return out.filter((p) => {
    if (!isIkiComboSetName(p.name)) return true;
    if (combo) {
      const seen = new Set<number>();
      for (const rl of p.rawLines ?? []) {
        const m = rl.match(T_NEG_RE);
        if (m) seen.add(parseNum(m[1]));
      }
      for (const v of seen) combo.amount = round2(combo.amount + v);
      if (p.region) combo.regions.push(p.region);
    }
    return false;
  });
}

// ── MLKit GHOST-LINE filter ──
// A photographed row can be read TWICE: besides the true per-row lines, MLKit sometimes emits
// an extra DIAGONAL line cutting across two printed rows and re-reading their glyphs
// (receipt-236: "ATLAITINES LAan EUR/ k9" stitched from the salmon NAME row + its CALC row —
// the row clusterer then merged the ghost into both real rows and the product name interleaved
// the two reads: "ATLAITINES ATLAT INES LAŠISOS LAan 99 BE EUR/ EUR/ GAL k9 kg"). A ghost is
// dropped only when TWO independent signals agree:
//   1. BASELINE-INCOHERENT — its words don't sit on one printed row: the spread of word-centre
//      residuals against the line's OWN baseline (corner-interpolated, so a legitimately tilted
//      row self-absorbs its slope) exceeds ~half a word height. A real row's words share a
//      baseline within a few px; the receipt-236 ghost stepped a full row height (48px) across
//      its span while its corners were FLAT.
//   2. REDUNDANT — EVERY word's box is substantially re-covered by words of baseline-COHERENT
//      lines (min coverage ≥ 0.35, mean ≥ 0.5): dropping the line loses no glyphs that aren't
//      already read elsewhere. Coverage never counts other incoherent candidates, so two
//      diagonal artifacts can't justify each other.
// Lines without word boxes neither contribute coverage nor get dropped (fail-open — legacy
// dumps and price-only fragments are untouched).
function dropGhostLines(lines: IkiLine[]): IkiLine[] {
  if (!lines.some((l) => (l.words?.length ?? 0) >= 2)) return lines;
  // Residual spread of word centres vs the line's own (corner-tilted) mid-baseline.
  const baselineSpread = (l: IkiLine): number => {
    const ws = l.words!;
    const span = (l.xRight - l.xLeft) || 1;
    const midAt = (x: number) => {
      const f = (x - l.xLeft) / span;
      const top = (l.yLeftTop ?? l.yTop) + ((l.yRightTop ?? l.yTop) - (l.yLeftTop ?? l.yTop)) * f;
      const bot = (l.yLeftBottom ?? l.yBottom) + ((l.yRightBottom ?? l.yBottom) - (l.yLeftBottom ?? l.yBottom)) * f;
      return (top + bot) / 2;
    };
    let lo = Infinity, hi = -Infinity;
    for (const w of ws) {
      const r = (w.yTop + w.yBottom) / 2 - midAt((w.xLeft + w.xRight) / 2);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    }
    return hi - lo;
  };
  const medianWordH = (l: IkiLine): number => {
    const hs = l.words!.map((w) => w.yBottom - w.yTop).sort((a, b) => a - b);
    return hs[Math.floor(hs.length / 2)] || 1;
  };
  const incoherent = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const ws = lines[i].words;
    if (!ws || ws.length < 2) continue;
    if (baselineSpread(lines[i]) > 0.55 * medianWordH(lines[i])) incoherent.add(i);
  }
  if (!incoherent.size) return lines;
  const inter = (a: IkiWord, b: IkiWord): number => {
    const w = Math.min(a.xRight, b.xRight) - Math.max(a.xLeft, b.xLeft);
    const h = Math.min(a.yBottom, b.yBottom) - Math.max(a.yTop, b.yTop);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const ghosts = new Set<number>();
  for (const i of incoherent) {
    const ratios = lines[i].words!.map((w) => {
      const area = Math.max(1, (w.xRight - w.xLeft) * (w.yBottom - w.yTop));
      let covered = 0;
      for (let j = 0; j < lines.length && covered < area; j++) {
        if (j === i || incoherent.has(j)) continue;
        for (const w2 of lines[j].words ?? []) covered += inter(w, w2);
      }
      return Math.min(1, covered / area);
    });
    const min = Math.min(...ratios);
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    if (min >= 0.35 && mean >= 0.5) ghosts.add(i);
  }
  return ghosts.size ? lines.filter((_, i) => !ghosts.has(i)) : lines;
}

function parseIkiThermal(lines: IkiLine[]): IkiParseResult {
  lines = dropGhostLines(lines);
  const rawText = lines.map((l) => l.text).join('\n');
  const region = regionOf(lines);
  // RECEIPT tilt SAMPLES: each WIDE multi-word line's (yCentre, slope). The receipt is
  // CURVED (≈flat at the top, steep at the bottom), so a single global median over-bends
  // a flat header line and under/over-bends a footer one. We keep per-line samples and read
  // the LOCAL slope at a band's own Y (localSlopeAtY) — refTilt is only the last-resort
  // median for a receipt too short to bracket a band.
  const refSamples: { y: number; slope: number }[] = [];
  {
    const W = (region.xRight - region.xLeft) || 1;
    for (const l of lines) {
      const ws = l.words;
      if (!ws || ws.length < 2) continue;
      const lw = ws.reduce((a, b) => (b.xLeft + b.xRight < a.xLeft + a.xRight ? b : a));
      const rw = ws.reduce((a, b) => (b.xLeft + b.xRight > a.xLeft + a.xRight ? b : a));
      const lcx = (lw.xLeft + lw.xRight) / 2, rcx = (rw.xLeft + rw.xRight) / 2;
      if (rcx - lcx <= 0.4 * W) continue;
      // SHEAR-PROOF: the wide lines this sampler prefers are exactly the ones that
      // glue the name column to the price column — a leftmost-vs-rightmost slope
      // there measures the OCR column shear, not the paper tilt (receipt-232's
      // bands pivoted up from it). robustLineSlope measures within columns only.
      const s = robustLineSlope(ws);
      if (s != null) refSamples.push({ y: (lw.yTop + rw.yTop) / 2, slope: s });
    }
  }
  const refTilt = refSamples.length ? Math.max(-0.12, Math.min(0.12, emedian(refSamples.map((s) => s.slope)))) : 0;
  // The LOCAL receipt slope at a given Y: linearly interpolate between the two wide lines
  // that bracket it (nearest sample's slope outside the sampled range — no extrapolation),
  // so a band follows the receipt's curve at its OWN height instead of one global tilt.
  const localSlopeAtY = (y: number): number => {
    if (!refSamples.length) return refTilt;
    const a = [...refSamples].sort((p, q) => p.y - q.y);
    if (y <= a[0].y) return a[0].slope;
    if (y >= a[a.length - 1].y) return a[a.length - 1].slope;
    let i = 0;
    while (i < a.length - 1 && a[i + 1].y < y) i++;
    const L = a[i], R = a[i + 1];
    const t = (y - L.y) / ((R.y - L.y) || 1);
    return Math.max(-0.12, Math.min(0.12, L.slope + (R.slope - L.slope) * t));
  };
  // FOOTER/HEADER field band: put the band where the field VALUE actually is, BENT to
  // follow the receipt.
  //   • value words SURVIVED  → cover exactly those boxes (tight, on the value).
  //   • value words DROPPED    → cover the whole LINE FRAME (real MLKit line box) — it
  //     CONTAINS the value wherever OCR scrambled it, and is narrower than the receipt.
  // The band tilts by THIS LINE'S OWN local slope (its leftmost→rightmost word) — NOT a
  // global tilt. The receipt is CURVED (tilt drifts from ~flat at the top to steep at the
  // bottom), so a single receipt-wide refTilt over-bends a near-flat header line. Using
  // the line's own words means a single-word value (storeCode/receiptNo) and a multi-word
  // value (address — where no one word matches the whole value) BOTH bend by their own
  // line. refTilt is only the last resort for a line too narrow to define its own tilt.
  const footBand = (l: IkiLine, kind: RegionKind, value: string): LabeledRegion => {
    const ws = l.words ?? [];
    const key = value.replace(/[^0-9A-Za-z]/g, '');
    const hit = ws.filter((w) => {
      const k = w.text.replace(/[^0-9A-Za-z]/g, '');
      // HUG a word only when it IS the value, or CONTAINS the whole value plus a little
      // decoration (≤3 chars, e.g. "26,52EUR"/"1,05A"). NOT when the word is merely a
      // FRAGMENT of the value ("26" of "26,52" → drops the ",52") or a longer number
      // that happens to share the value's leading digits (term-id "15001934" vs total
      // "1500"); those fall through to the value-containing LINE FRAME instead.
      return k.length >= 2 && (k === key || (k.includes(key) && k.length - key.length <= 3));
    });
    // A MULTI-WORD value (the store ADDRESS) has no single word that hugs the whole value, so
    // `hit` is empty and X/Y would fall back to the whole LINE FRAME. When the address is OCR-
    // FUSED with the company-code line ("…Siaul iai PV moketojo kodas LT101937219"), that frame
    // drags the band across the unboxed code (receipt-142). Instead HUG the value's own FRAGMENT
    // words (each cleaned word is a piece of the value) so the band covers ONLY the address, not
    // the trailing code. Restricted to multi-word values so single-token bands (code/total/date)
    // keep their exact line-frame fallback.
    const multiWordValue = /\S\s+\S/.test(value.trim());
    const frag = (!hit.length && multiWordValue)
      ? ws.filter((w) => { const k = w.text.replace(/[^0-9A-Za-z]/g, ''); return k.length >= 2 && key.includes(k); })
      : [];
    const src = hit.length ? hit : (frag.length >= 2 ? frag : null);
    // X: the value words when present, else the whole LINE FRAME (so it still contains
    // the value wherever OCR scrambled it).
    const xL = src ? Math.min(...src.map((w) => w.xLeft)) : l.xLeft;
    const xR = src ? Math.max(...src.map((w) => w.xRight)) : l.xRight;
    // Y (HEIGHT): the value words, else the SURVIVING line words — a thin text-height
    // strip. NOT the line's full bbox: for a tilted, wide line that bbox is ~2 rows tall
    // (left words high, right words low), so the band read as "covering a line above +
    // half the line below". Fall back to the bbox only when no word survived at all.
    let yAnchor = src ?? (ws.length ? ws : null);
    // VALUE-DROPPED 2-ROW MERGE (receipt-84): MLKit sometimes merges two physical rows into
    // one line ("Contactless" + "Term. … Kvitas 7317 …"); only the TOP row's words survive but
    // the value is on the BOTTOM row, so the frame extends a whole text-row BELOW the survivors.
    // Anchor the band to that lower slice (survivors' bottom → frame bottom) so it sits ON the
    // value, not the survivors above it. A SINGLE tilted row (receipt-79) has survivors that
    // fill the frame top-to-bottom (tiny gap) → unchanged thin word-strip.
    let lowerRow = false;
    if (!src && ws.length) {
      const maxBot = Math.max(...ws.map((w) => w.yBottom));
      const hs = ws.map((w) => w.yBottom - w.yTop).sort((a, b) => a - b);
      const medH = hs[Math.floor(hs.length / 2)] || 1;
      if (l.yBottom - maxBot > 0.5 * medH) { lowerRow = true; yAnchor = null; }
    }
    const yT = lowerRow ? Math.max(...ws.map((w) => w.yBottom)) : (yAnchor ? Math.min(...yAnchor.map((w) => w.yTop)) : l.yTop);
    const yB = lowerRow ? l.yBottom : (yAnchor ? Math.max(...yAnchor.map((w) => w.yBottom)) : l.yBottom);
    // SLOPE from the WHOLE line's words (the local tilt at this line), reliable when they
    // span ≥15% of the receipt width; else the LOCAL receipt slope at this band's Y (a
    // single-word value on a flat header stays flat instead of borrowing the steep median).
    let slope = localSlopeAtY(yT);
    if (ws.length >= 2) {
      const lw = ws.reduce((a, b) => (b.xLeft < a.xLeft ? b : a));
      const rw = ws.reduce((a, b) => (b.xRight > a.xRight ? b : a));
      const lcx = (lw.xLeft + lw.xRight) / 2, rcx = (rw.xLeft + rw.xRight) / 2;
      if (rcx - lcx > 0.15 * (region.xRight - region.xLeft)) {
        slope = Math.max(-0.12, Math.min(0.12, (rw.yTop - lw.yTop) / (rcx - lcx)));
      }
    }
    // PIVOT the tilt at the ANCHOR words' centre (where yT/yB were measured), NOT the
    // band centre. When the band is wide because the line frame reaches a far-left label
    // ("SUMA … 1,15 EUR": the value is on the RIGHT, SUMA at the left), a centre pivot
    // lifts the right edge OFF the amount — it covers only the top of the total. Pivoting
    // at the value's centre keeps the band ON the amount and tilts the far side down.
    // Each edge offset still capped at ±30px (≈ one thermal row) so a wide band can't
    // re-create the "bent too much" complaint.
    // PAD a little so the first/last glyph sits INSIDE the band, not flush against the
    // edge — OCR word boxes are tight, so the leading digit ("1" of "1,15 EUR") poked out
    // the left edge. Proportional to the text height. Pivot stays the value's centre.
    const pad = Math.max(3, (yB - yT) * 0.09);
    const bxL = xL - pad, bxR = xR + pad, byT = yT - pad, byB = yB + pad;
    const cxA = yAnchor
      ? (Math.min(...yAnchor.map((w) => w.xLeft)) + Math.max(...yAnchor.map((w) => w.xRight))) / 2
      : (bxL + bxR) / 2;
    const offL = Math.max(-30, Math.min(30, slope * (bxL - cxA)));
    const offR = Math.max(-30, Math.min(30, slope * (bxR - cxA)));
    const yLT = byT + offL, yRT = byT + offR;
    const yLB = byB + offL, yRB = byB + offR;
    return {
      kind, xLeft: bxL, xRight: bxR,
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
  let pvmGarbledIdx = -1; // a header line that just STARTS with "PVM" but whose code OCR shredded
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    // PVM/VAT code — tolerate OCR confusions in the "LT" prefix (e.g. "LI") and a
    // digit run SPLIT by stray spaces ("LT1019372 19" for LT101937219). Grab the
    // alphanumeric run after "kodas" (spaces allowed inside, stripped after), else
    // a bare 2-letter+digits token. OCR also garbles "kelio kodas" → "kel jo
    // kodas", so match a bare "kodas".
    // Tolerate OCR garble of the "PVM mokėtojo kodas" line: "kodas"→"kadas" (o↔a) and
    // the "LT" code prefix lower-cased/garbled to "Li" (receipt 116). Without this the
    // VAT line isn't found → pStart stays 0 → the whole header folds into product 1.
    const pv = lines[i].text.match(/k[oa]das\s*([A-Za-z]{0,2}[\d ]{8,16})/i) ?? lines[i].text.match(/\b([A-Za-z]{2}\s?\d[\d ]{7,12}\d)\b/i);
    // FULL-WIDTH + bent band (footBand), not a word-span: OCR routinely drops every
    // word of this line but "PVN" (receipt-64), which would shrink a word-anchored
    // band to a stub. footBand spans the receipt and falls back to the line bbox Y.
    if (pv) { pvmCode = pv[1].replace(/\s+/g, ''); pvmLineIdx = i; headerRegions.push(footBand(lines[i], 'storeCode', pvmCode)); break; }
    // FALLBACK: the "PVM mokėtojo kodas LT…" line OCR-shredded to JUST its long code digits
    // ("1019372 19" — the "PVM … kodas LT" prefix gone, top of receipt cut off). A 7+ digit run on a
    // near-numeric header-zone line is the company/VAT code — a product line never carries one — so
    // treat it as the header boundary; else the cut-off header folds into product 1's band (receipt-166).
    if (i < 5 && lines[i].text.replace(/\D/g, '').length >= 7 &&
        lines[i].text.replace(/[^A-Za-zĄČĘĖĮŠŲŪŽąčęėįšųūž]/g, '').length <= 2) {
      pvmCode = lines[i].text.replace(/\D/g, ''); pvmLineIdx = i; headerRegions.push(footBand(lines[i], 'storeCode', pvmCode)); break;
    }
    // FALLBACK 2: the "PVM mokėtojo kodas" LABEL garbled to arbitrary letters ("DUM
    // :101937219", receipt-292 — the top of the receipt was destroyed) so the ≤2-letter
    // gate above misses it, but the 9-digit VAT code itself survived. A CONSECUTIVE run of
    // 8+ digits in the header zone is unambiguously the company/VAT code — no product name
    // or price carries one — so treat that line as the header boundary regardless of how
    // many junk letters ride with it. (Space-tolerant for the "1019372 19" split-code OCR.)
    {
      // Skip the LOYALTY-CARD line ("IKI KORTELĖS NR. 999000111222", 12 digits) — it also
      // carries a long digit run but is NOT the header VAT code; catching it as the header
      // boundary would push pStart past real products (receipt-162/merged-line fixtures).
      const digitRun = lines[i].text.replace(/\s+/g, '').match(/\d{8,}/);
      if (i < 5 && digitRun && !/kortel/i.test(lines[i].text)) {
        pvmCode = digitRun[0]; pvmLineIdx = i; headerRegions.push(footBand(lines[i], 'storeCode', pvmCode)); break;
      }
    }
    // Fallback: a header line (first 3) CONTAINING a bare "PVM" token IS the VAT line even
    // when its code is OCR-shredded to a stub — in either order: "PVM 7219" (label first) or
    // "7219 PVM" (code first — receipt-297's cut-off header). Without it pvmLineIdx stays -1
    // → pStart stays 0 AND the address scan's addrEnd falls back to 4 lines, reaching the
    // first product ("0,65 AKVILE GAZ" banded as the store address). A product line never
    // carries a bare "PVM" token, and the footer's PVM lines sit far outside the first 3.
    if (pvmGarbledIdx < 0 && i < 3 && /\bPVM\b/i.test(lines[i].text)) pvmGarbledIdx = i;
  }
  if (pvmLineIdx < 0 && pvmGarbledIdx >= 0) {
    pvmLineIdx = pvmGarbledIdx;
    // Band the garbled VAT line too (scrambled shapes like "rokėtojo kodas [110193/219
    // PVM", receipt-302) — without it the header has no storeCode band and the viewer's
    // block-union fallback drew ONE band across the code AND the address.
    headerRegions.push(footBand(lines[pvmGarbledIdx], 'storeCode', lines[pvmGarbledIdx].text));
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
    // `U?A[B8]?`: OCR drops the U of "UAB" ("iKI Lietuva, A8") — the strip must still consume the
    // company suffix so the company line empties out and the scan moves to the real address line below
    // (else "iKI Lietuva, A8" itself is taken as the address — receipt-170).
    let stripped = lines[i].text.replace(/^.*?Lietuva,?\s*U?A[B8]?\s*/i, '').trim();
    // REVERSED company order ("UAB IKI Lietuva, Vilniaus g. 220-1, Siauliai", receipt-313):
    // the strip above only consumes a "…Lietuva, UAB" SUFFIX — with UAB leading, nothing
    // strips and the "Lietuva" reject below vetoes the fused line (address invisible, no
    // band). Strip a LEADING "UAB … Lietuva," block too.
    if (stripped === lines[i].text.trim()) {
      stripped = lines[i].text.replace(/^\s*U?A[B8]\b[^,]{0,20}?Lietuva[,.]?\s*/i, '').trim();
    }
    // The address is often OCR-fused onto the PVM/company-code line ("…Šiauliai Pyw
    // mokttoo kodas I101027210", receipt 117). Cut that trailing "PVM…kodas <code>"
    // run so the address survives instead of being rejected for containing "kodas".
    // (OCR garbles "PVM"→"Pyw"/"Py" and "kodas"→"kadas".)
    stripped = stripped.replace(/\s+(?:PVM|P[vy]w?|k[oa]das)\b.*$/i, '').trim();
    // A bare PRICE ("0, 65 A" — amount + optional VAT letter) is the ITEM's own datum, NEVER
    // the address; reject it so the same value can't be used twice (the garbled-header case
    // where the real address didn't survive and the scan reached the first product's price).
    const isBarePrice = /^-?\d{1,4}[.,]\s?\d{2}\s*[ABC]?\s*$/.test(stripped);
    // PRODUCT-LINE GUARD (receipt-297): when the VAT boundary is lost, addrEnd falls back
    // to the first 4 lines and can reach the FIRST PRODUCT ("0,65 AKVILE GAZ" — digits ✓
    // comma ✓ letters ✓ → accepted as the "address", banding the product's row as the
    // header). A price amount at the line's START or END is a product shape, never an
    // address (house numbers are "19A-1"/"128-2" — dashes, not decimal amounts). Kept
    // POSITIONAL so a mid-line "9. 220-1" street number can't false-trigger.
    const priceShaped = /^\s*-?\d{1,4}[.,]\s?\d{2}\s+\S/.test(stripped) || /\d[.,]\s?\d{2}\s*[ABC]?\s*$/.test(stripped);
    if (/\d/.test(stripped) && /,/.test(stripped) && /[A-Za-zĄČĘĖĮŠŲŪŽ]/.test(stripped) && !/PVM|kodas|Lietuva/i.test(stripped) && !isBarePrice && !priceShaped) {
      storeAddress = stripped;
      headerRegions.push(footBand(lines[i], 'storeAddress', storeAddress));
      break;
    }
  }
  let pEnd = lines.length;
  for (let i = pStart; i < lines.length; i++) {
    const endText = lines[i].text;
    // A "Prekiautojo …" line ends the product list — the merchant / payment-block header. Match
    // the WHITESPACE-STRIPPED text so an OCR split ("Pr ekiaut o", receipt-212) is still caught,
    // and accept a BARE trader header even when its ID was OCR-dropped/cut ("Prekiauto:",
    // receipt-166). The ONE exception is the "Prekiautojo nuolaida" loyalty-discount PROMO, which
    // prints mid-products and must NOT truncate — excluded by the nuolaid guard; a trader number /
    // uppercase "ID" still qualifies a line on its own.
    const endCompact = endText.replace(/\s+/g, '');
    // Lexicon-matched (Phase 3): one fuzzy "Prekiautojo" matcher replaces the strict +
    // garbled stem pair. Distance-tiered trust: a CLEAN hit (d=0) behaves like the old
    // strict stem (qualifies alone unless it's the "…nuolaida" promo line); a GARBLED
    // hit (d>0 — "Prckiautojo", "Pr ekiaut o") additionally requires the trader number
    // or an uppercase ID, so a product name can never truncate the list.
    // CLEAN tier = the old strict PREFIX stem (it must keep accepting BARE truncated
    // headers: "Prekiauto:" / "Pr ekiaut o" with no number — receipts 166/212). The
    // lexicon supplies the GARBLED tier ("Prckiautojo") which always needs confirmation.
    const traderClean = T_TRADER_LINE_RE.test(endCompact);
    const traderD = traderClean ? 0 : keywordDistance(endText, LEX.PREKIAUTOJO);
    const traderConfirmed = T_TRADER_NUM_RE.test(endText) || T_TRADER_ID_RE.test(endText);
    const isTrader = traderD != null && (
      traderD === 0
        ? (!/nuolaid/i.test(endCompact) || traderConfirmed)
        : (!/nuolaid/i.test(endCompact) && traderConfirmed)
    );
    if (T_PRODUCTS_END_RE.test(endText) || isTrader) {
      pEnd = i;
      // The LAST product's NUOLAIDA discount can OCR-fuse onto this footer-boundary line
      // as a LEADING discount, with the trader/footer text UNBOXED ("-0,40 A Prekiautojo
      // ID 15132001": only "-0,40 A" carries word boxes). Excluding the whole line drops
      // the discount — the product keeps its NUOLAIDA label but no amount → promoPrice null
      // (receipt-129 cucumber). When the line's BOXED words are EXACTLY a bare discount and
      // not a name, KEEP the line in the product range: the column engine then reads only
      // the "-0,40 A" and attaches it to the open last product; the unboxed trader text is
      // ignored. Guarded to the column-engine path (no boxes → no change → legacy untouched).
      const boxed = (lines[i].words ?? []).map((w) => w.text).join(' ').trim();
      if (boxed && isTDiscount(boxed) && !ikiStrongName(boxed)) pEnd = i + 1;
      break;
    }
  }
  // ── STRUCTURAL ZONE GUARD (receipt-272 phantom): every wall above is a KEYWORD that can
  // garble past its pattern ("IKI KORTELES NA", "saskaLtos-fakt" — both walls missed and 15
  // marketing/trailer lines glued into one price-0 phantom product). The AMOUNTS are the
  // structural truth the keywords aren't: every product row ends in a decimal amount, and
  // the trailer (card info, marketing, VMI block) never does. Trim the zone to shortly
  // after the LAST amount-bearing line — nothing below it can be a product, whatever the
  // walls missed. (+3 margin: a trailing discount row / deposit label / wrapped name.)
  {
    const amtLineRe = /\d{1,4}[.,]\s?\d{2}\s*(?:[ABC]\s*)*$|\d{1,4}[.,]\s?\d{2}\s*[ABC]\b/;
    let lastAmt = -1;
    for (let i = pStart; i < pEnd; i++) {
      if (amtLineRe.test(lines[i].text)) lastAmt = i;
    }
    if (lastAmt >= 0 && pEnd > lastAmt + 4) pEnd = lastAmt + 4;
  }
  // ── skipped lines (coupons / bags / loyalty points) in the product section: their own grey
  //    bands in the photo view, never counted as products. Built BEFORE the engine so the
  //    column engine can tile them together with the products by the SAME rule (it needs each
  //    product's true content-top, which it has internally). lineBox (whole-line bbox): a
  //    coupon/bag/points line is often "<amount> <skip word>" where MLKit kept only the amount
  //    word — a word-anchored band would grey just the amount; the full line bbox greys the row.
  const skippedRegions: LabeledRegion[] = [];
  for (let i = pStart; i < pEnd; i++) {
    if (isTSkip(lines[i].text)) skippedRegions.push(lineBox(lines[i], 'skipped'));
  }
  // COLUMN ENGINE dispatch (flag-gated): use it when enough per-word data exists
  // AND it actually yields products; otherwise fall back to the legacy tokenizer.
  // `combo` accumulates the dropped bare-RINKINYS deal discounts (→ footer.comboDiscount);
  // reset before the fallback engine so a columnar attempt that yielded 0 products can't
  // leave a stale amount behind.
  const combo = { amount: 0, regions: [] as Region[] };
  // Receipt-reconciliation side-channel: charges/negatives the engine drops from products
  // (deposits, bag charges, IKI Taškais ±, coupons) but the PRINTED TOTAL includes.
  const recon = { adjust: 0 };
  const engineProducts = USE_COLUMN_ENGINE && ikiHasWords(lines, pStart, pEnd)
    ? parseIkiColumnar(lines, pStart, pEnd, skippedRegions, storeAddress, combo, recon)
    : null;
  const usedEngine = !!engineProducts && engineProducts.length > 0;
  if (!usedEngine) { combo.amount = 0; combo.regions = []; }
  const products = usedEngine ? engineProducts! : parseThermalProducts(lines, pStart, pEnd, storeAddress, combo);
  // Thermal-path combo rows arrive as bare regions — thread them into the grey skip bands
  // (the columnar path pushes into skippedRegions itself, pre-tiling).
  for (const r of combo.regions) skippedRegions.push({ ...r, kind: 'skipped' });

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

  // (skippedRegions were built and — on the column-engine path — already tiled with the
  //  products above, before the engine dispatch.)

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

  // (Column-engine path: the skipped-line bands were widened + tiled together with the products
  //  inside parseIkiColumnar, by the SAME per-corner seam rule, so nothing to do here.)

  // ── footer fields (scan whole receipt; take first hit) + bbox bands ──
  let total: number | null = null;
  // CASH-ROUNDING delta (Lithuanian 5-ct rounding): "Apvalinimo suma ±0,0X". Part of the
  // printed to-pay total but of no product line — reconciliation runs short by it unless
  // booked (receipt-278: Σlines 2,33 vs paid 2,35). Under the one-line OCR shear the
  // value can ride the "Mokėti suapvalinus" line instead (receipt-229), so both keywords
  // are scanned; |v| ≤ 0,04 keeps a sheared TOTAL from ever being read as rounding.
  let roundingAdj = 0;
  let receiptNo = '';
  // Captured separately so "Kvito Nr." (the canonical key) always wins over the
  // "Kvitas" fallback even though Kvitas is printed FIRST (higher up the receipt).
  let kvitoVal = ''; let kvitoLine: IkiLine | undefined;
  let kvitasVal = ''; let kvitasLine: IkiLine | undefined;
  let kvitoNumVal = ''; let kvitoNumLine: IkiLine | undefined;   // "Kvito numeris <n>" (VMI block)
  let totalSavings: number | null = null;
  let date = '';
  let time = '';
  let dateLine: IkiLine | undefined;
  let timeLine: IkiLine | undefined;
  let timeMatch: RegExpMatchArray | undefined;
  let sumaPending = false; // previous line had a bare "SUMA" keyword w/o an amount
  // Total-keyword lines whose AMOUNT was glyph-shredded ("Mokėti IU,1", receipt-309) —
  // remembered so the cash-lane fallback can still anchor the 'total' BAND semantically.
  let mokLineNoAmt: IkiLine | undefined;
  let grynLine: IkiLine | undefined;
  let prevAmtLine: IkiLine | undefined; // previous line carried "X,XX EUR" but no SUMA
  let prevAmtVal: string | undefined;
  let prevBareLine: IkiLine | undefined; // immediately-preceding line that was JUST a bare amount
  let prevBareVal: string | undefined;
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
      // Take the first POSITIVE amount: a "Mokėti suapvalinus -0,01" rounding line carries only a
      // NEGATIVE delta, which must NOT be read as the to-pay total (receipt-157 → 0,01).
      let mAmt: string | null = null;
      for (const mm of t.matchAll(/(-?)\s?(\d{1,4}[.,]\s?\d{2})/g)) { if (mm[1] !== '-') { mAmt = mm[2]; break; } }
      // ROUNDING-ARTEFACT guard: Lithuanian cash rounding is to the nearest 5 ct, so
      // |Apvalinimo suma| ≤ 0,04 — and no real to-pay total is below 5 ct. Under the
      // one-line OCR SHEAR the rounding value lands POSITIVE on the "Mokėti suapvalinus"
      // line ("Mokėti suapvalinus 0,02", receipt-229) and the first-positive rule above
      // would take it as the total AND anchor the total band on it. Neutralize a sub-5ct
      // Mokėti amount (no total, no band) and let the authoritative "Suma su PVM" line
      // (scanned next) win. The line's other bookkeeping below still runs.
      if (mAmt && parseNum(mAmt) < 0.05) mAmt = null;
      // OCR sometimes drops the decimal comma on the Mokėti amount, leaving a space
      // ("Mokėti 7 10" = 7,10). Only accept this right AFTER the Mokėti keyword (so a
      // stray "7 10" elsewhere can't be misread) and only when there's no comma form.
      const sp = mAmt ? null : t.match(/Mok[eė]t\s?i\D{0,3}(\d{1,4})\s+(\d{2})(?!\d)/i);
      // …and OCR can also REVERSE the reading order, printing the amount BEFORE the keyword
      // ("7 10 Mokėt i" = 7,10 Mokėti). Same space-as-decimal tolerance, keyword-anchored.
      const spB = (mAmt || sp) ? null : t.match(/(\d{1,4})[.,\s]\s?(\d{2})(?!\d)\s+Mok[eė]t\s?i/i);
      if (mAmt) {
        if (total == null) total = parseNum(mAmt);
        footerRegions.push(footBand(l, 'total', mAmt));
      } else if (sp || spB) {
        const g = (sp || spB)!;
        const v = `${g[1]},${g[2]}`;
        if (total == null) total = parseFloat(`${g[1]}.${g[2]}`);
        footerRegions.push(footBand(l, 'total', v));
      } else if (total == null && prevBareVal && prevBareLine) {
        // CASH receipt: "Mokėti" prints as a COLUMN HEADER ("PVM suma Moketi Be PVM") with the
        // amount split onto the line ABOVE ("3, 95"); no clean "SUMA … EUR" anywhere. Take the
        // immediately-preceding bare amount as the to-pay total. (receipt-148.)
        total = parseNum(prevBareVal);
        footerRegions.push(footBand(prevBareLine, 'total', prevBareVal));
      } else if (total == null && mokLineNoAmt == null) {
        // Keyword present, amount unreadable — keep the line as the band anchor for the
        // cash-lane fallback ("Mokėti IU,1": 1→I, 0→U glyphs, receipt-309).
        mokLineNoAmt = l;
      }
    }
    // Book the cash-rounding delta (see roundingAdj above): first sub-5ct amount on an
    // Apvalinimo/suapvalinus line, signed (rounded down prints a negative).
    if (roundingAdj === 0 && /Apvalinim|suapvalin/i.test(t)) {
      for (const mm of t.matchAll(/(-?)\s?(\d{1,4}[.,]\s?\d{2})/g)) {
        const v = parseNum(mm[2]);
        if (v > 0 && v <= 0.04) { roundingAdj = mm[1] === '-' ? -v : v; break; }
      }
    }
    // "Suma su PVM <amount>" — IKI's TOTAL-with-VAT line. The amount may sit before OR after the
    // keyword ("12,90 Mokestis Suma su PVM"). This is the authoritative printed total on receipts
    // with no clean "Mokėti suapvalinus" line (receipt-159: 12,90 only appears beside "Suma su PVM").
    // First POSITIVE amount only — a stray rounding "-0,02" must never be the total. P[VU]M
    // tolerates the V→U mis-read ("Suma su PUM", receipt-199) — without it the total falls through
    // to the fragile cash−change last resort, which a scrambled payment table reads wrong (199:
    // Grynieji/Grąža mis-boxed as 10,66/2,24 → a phantom 8,42 total).
    if (total == null && /\bSuma\s+su\s+P[VU]M\b/i.test(t)) {
      let svFound = false;
      for (const mm of t.matchAll(/(-?)\s?(\d{1,4}[.,]\s?\d{2})/g)) {
        if (mm[1] === '-') continue;
        // Never the VAT RATE: a scrambled line can fuse "A 21,00 %" onto the Suma-su-PVM
        // text (receipt-169) — a %-suffixed amount is a rate, not a total.
        const after = t.slice((mm.index ?? 0) + mm[0].length, (mm.index ?? 0) + mm[0].length + 3);
        if (after.includes('%')) continue;
        total = parseNum(mm[2]); footerRegions.push(footBand(l, 'total', mm[2])); svFound = true; break;
      }
      // Space-as-decimal fallback, keyword-anchored (mirrors the Mokėti `sp` rule): OCR can
      // drop the comma entirely ("Suma su PVM 2 35" = 2,35). Only when no comma-form amount
      // exists on the line, and only right after the PVM keyword.
      if (!svFound) {
        const sv = t.match(/P[VU]M\D{0,3}(\d{1,4})\s+(\d{2})(?!\d)/);
        if (sv) { total = parseFloat(`${sv[1]}.${sv[2]}`); footerRegions.push(footBand(l, 'total', `${sv[1]},${sv[2]}`)); }
      }
    }
    // LOOK-BEHIND (form 4): OCR split the amount onto the line BEFORE a bare "SUMA"
    // ("1,15 EUR" then "SUMA") — the look-ahead above only catches SUMA-then-amount.
    // Band the AMOUNT line (where "1,15 EUR" actually is), NOT the bare "SUMA" line —
    // the total VALUE is on the amount line, so the band must sit there. When the amount
    // words survived footBand hugs them; when they were dropped it covers that line frame.
    if (total == null && /\bSUMA\b/i.test(t) && !/\d{1,4}[.,]\s?\d{2}\s*EUR/i.test(t) && prevAmtLine && prevAmtVal) {
      total = parseNum(prevAmtVal);
      footerRegions.push(footBand(prevAmtLine, 'total', prevAmtVal));
    }
    // Arm the split-SUMA look-ahead for the NEXT line: this line names SUMA but
    // carries NO amount of its own (so the amount must be on the next line). Requiring the line
    // to be amount-LESS (not just lacking "… EUR") stops a rounding line that merely contains the
    // word "suma" — "Apvalinimo suma 18,47" — from arming the look-ahead and hijacking the REAL
    // total line that follows it ("Mokėti suapvalinus 18,45"), which then drew no total band.
    sumaPending = !sumaAmt && /\bSUMA\b/i.test(t) && !/\d{1,4}[.,]\s?\d{2}/.test(t);
    // Remember a standalone "X,XX EUR" amount line (no SUMA keyword) so the NEXT
    // iteration's look-behind can claim it when a bare SUMA follows.
    const prevM = /\bSUMA\b/i.test(t) ? null : t.match(/(\d{1,4}[.,]\s?\d{2})\s*EUR/i);
    prevAmtLine = prevM ? l : undefined;
    prevAmtVal = prevM ? prevM[1] : undefined;
    // Remember a line that is JUST a bare amount ("3, 95") so the Mokėti look-behind above can
    // claim it on the NEXT line. Reset on any other line → only the IMMEDIATELY preceding one.
    const bareM = t.match(/^\s*(-?\d{1,4}[.,]\s?\d{2})\s*$/);
    prevBareLine = bareM ? l : undefined;
    prevBareVal = bareM ? bareM[1] : undefined;
    if (!kvitoVal) { const m = t.match(T_RECEIPTNO_RE); if (m) { kvitoVal = m[1]; kvitoLine = l; } }
    if (!kvitasVal) { const m = t.match(T_KVITAS_RE); if (m) { kvitasVal = m[1]; kvitasLine = l; } }
    if (!kvitoNumVal) { const m = t.match(T_KVITONUM_RE); if (m) { kvitoNumVal = m[1]; kvitoNumLine = l; } }
    if (totalSavings == null) {
      // Lexicon-matched (Phase 3): any in-budget garble of "sutaupėte" qualifies the line;
      // the amount is the line's first decimal. The old regex needed the stem spelled
      // half-right; "sutaupëje"/"sutaup ete" now match with zero new patterns.
      const m = t.match(T_SAVINGS_RE) ?? (hasKeyword(t, LEX.SUTAUPETE) ? t.match(/(\d+[.,]\s?\d{2})/) : null);
      if (m) totalSavings = parseNum(m[1]);
    }
    if (!date) {
      const m = t.match(T_DATE_RE);
      if (m) {
        // PLAUSIBILITY + 0→1 RESCUE: thermal zeros read as ones ("2026-16-18" for the
        // printed 2026-06-18, receipt-242 re-scan — the impossible month then 500-looped
        // the save downstream). Month 13-19 with a valid day is that exact confusion →
        // rescue the leading 1 back to 0. Anything still implausible is DROPPED and the
        // scan keeps looking — the VMI "CR-…" trailer line usually carries a clean date.
        let mm = m[2];
        const mmN = Number(mm), ddN = Number(m[3]);
        if (mmN >= 13 && mmN <= 19 && ddN >= 1 && ddN <= 31) mm = `0${mm[1]}`;
        if (Number(mm) >= 1 && Number(mm) <= 12 && ddN >= 1 && ddN <= 31) {
          date = `${m[1]}-${mm}-${m[3]}`;
          dateLine = l;
        }
      }
    }
    if (!time) { const m = t.match(T_TIME_RE); if (m) { time = `${m[1]}:${m[2]}`; timeLine = l; timeMatch = m; } }
  }
  // LAST RESORT (cash receipt): total = Grynieji (cash tendered) − Grąža (change). When the VAT/
  // payment table is too scrambled to read a "Mokėti"/"SUMA" total but the cash + change survived,
  // this still recovers it. Only when BOTH are cleanly present and cash ≥ change. (user-suggested.)
  if (total == null) {
    const amtIn = (re: RegExp): { v: number; line: IkiLine } | null => {
      for (const l of lines) {
        if (!re.test(l.text)) continue;
        // First amount that is NOT a VAT rate: the sheared payment table can fuse
        // "A 21,00 %" onto the Grynieji line ("A 21,00 % 20,00 Grynieji EUR",
        // receipt-305) — grabbing the rate fabricated total 21,00−7,10=13,90 for a
        // 12,90 receipt. Same %-guard as the Suma-su-PVM lane.
        for (const m of l.text.matchAll(/(\d{1,4}[.,]\s?\d{2})/g)) {
          const after = l.text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 3);
          if (after.includes('%')) continue;
          return { v: parseNum(m[1]), line: l };
        }
      }
      return null;
    };
    const cash = amtIn(/Grynie/i);
    const change = amtIn(/Gr[aą][zž]a/i);
    if (cash != null && change != null && cash.v >= change.v) {
      total = round2(cash.v - change.v);
      grynLine = cash.line;
      // The cash lane derives the total from TWO lines, so no lane above banded it —
      // the Kvitas photo then shows every band except 'total' (receipt-309 "10,10").
      // Anchor the band on the semantic total line when we saw one (the Mokėti line
      // whose amount was glyph-shredded), else on the Grynieji line the value came from.
      const anchor = mokLineNoAmt ?? grynLine;
      if (anchor) footerRegions.push(footBand(anchor, 'total', String(total)));
    }
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
  // Resolve the receipt id: the CANONICAL id (and the unique dedup key) stays EXACTLY as before —
  // prefer "Kvito Nr.", else "Kvitas", else synthesise from date+time+total — so no existing
  // receipt's dedup key churns. The full receiptNos[] ARRAY additionally carries every distinct
  // identifier on the footer (canonical first) for display + recovery; each gets its OWN band.
  const rnVal = kvitoVal || kvitasVal;
  const rnLine = kvitoVal ? kvitoLine : kvitasLine;
  if (rnVal && rnLine) receiptNo = rnVal;
  if (!receiptNo && date && time && total !== null) {
    receiptNo = `${date.replace(/-/g, '')}-${time.replace(/:/g, '')}-${Math.round(total * 100)}-iki-receipt`;
  }
  // One band per captured identifier line (Kvito Nr., Kvito numeris, Kvitas) — all shown.
  if (kvitoVal && kvitoLine) footerRegions.push(footBand(kvitoLine, 'receiptNo', kvitoVal));
  if (kvitoNumVal && kvitoNumLine) footerRegions.push(footBand(kvitoNumLine, 'receiptNo', kvitoNumVal));
  if (kvitasVal && kvitasLine) footerRegions.push(footBand(kvitasLine, 'receiptNo', kvitasVal));
  // SEGMENT-CORROBORATION WITNESS: IKI prints the slashed id's LAST segment separately in the
  // VMI block ("Kvito Nr. 168/645/104148" ↔ "Kvito numeris 104148"). When the two DISAGREE one
  // of them is OCR-garbled — we can't know which, so we never rewrite the canonical; instead we
  // ADD the VMI-corrected variant as an extra dedup witness. The overlap-based duplicate check
  // (getReceiptByAnyReceiptNoAndUser) then catches a re-scan through EITHER form, so a single
  // garbled digit in one scan can no longer let a duplicate receipt through.
  let segmentWitness = '';
  if (kvitoVal && kvitoNumVal && kvitoVal.includes('/')) {
    const segs = kvitoVal.split('/');
    if (segs[segs.length - 1] !== kvitoNumVal) {
      segmentWitness = [...segs.slice(0, -1), kvitoNumVal].join('/');
    }
  }
  // Array: canonical first, then any other distinct identifier (dedupe, keep order). Falls back to
  // just the canonical (incl. the synthetic id) when no printed identifier survived OCR.
  const receiptNos = [...new Set([rnVal, kvitoVal, kvitoNumVal, kvitasVal, segmentWitness].filter(Boolean))];
  if (receiptNos.length === 0 && receiptNo) receiptNos.push(receiptNo);
  footerRegions.sort((a, b) => a.yTop - b.yTop);

  // header/footer `region` was the whole-receipt union of EVERY line (regionOf(lines)),
  // so when no store-address / PVM line is detected the header band rendered as a
  // FULL-HEIGHT box over the receipt. Bound each section to ONLY its own detected line
  // bands; empty → zero-extent {0,0,0,0} (onPageOne requires yBottom>yTop → renders
  // nothing). (`region` itself stays for the internal tilt sampling above.)
  const unionOf = (rs: LabeledRegion[]): Region => rs.length
    ? { yTop: Math.min(...rs.map(r => r.yTop)), yBottom: Math.max(...rs.map(r => r.yBottom)), xLeft: Math.min(...rs.map(r => r.xLeft)), xRight: Math.max(...rs.map(r => r.xRight)) }
    : { yTop: 0, yBottom: 0, xLeft: 0, xRight: 0 };

  // SANITY: the to-pay total must be in the ballpark of the items' summed PAID amounts. A garbled
  // payment block can leave the total missing OR pin it to a stray tiny value (a "-0,01" rounding
  // delta read as 0,01 — receipt-157). When the parsed total is null or implausibly small versus the
  // item sum, fall back to that sum (each product's discounted unit price × quantity). Only fires on
  // a gross mismatch (< half), so a correctly-read total is never overwritten.
  const itemSum = round2(products.reduce((s, p) => {
    const q = p.quantity && p.quantity > 0 ? p.quantity : 1;
    const unit = (p.promoPrice != null ? p.promoPrice : p.price) ?? 0;
    return s + (unit > 0 ? unit * q : 0);
  }, 0));
  // Combo-aware: the paid total is Σproducts MINUS the captured bare-RINKINYS deal
  // discount (receipt-229: 4.03 − 1.90 = 2.13 vs printed 2.33/2.35 — the residual gap is
  // the valueless deposits, accepted). Both the plausibility test and the fallback use
  // the adjusted sum, so a correctly-read printed total is judged against what was
  // actually paid, and an unreadable payment block no longer inflates the total.
  const adjSum = round2(Math.max(0, itemSum - (combo.amount > 0 ? combo.amount : 0)));
  let totalFromFallback = false;
  if (adjSum > 0 && (total == null || total < adjSum * 0.5)) { total = adjSum; totalFromFallback = true; }

  // ── RECEIPT RECONCILIATION (Phase 2, shared/ROBUST_PARSING_PLAN.md) ──
  // The printed total re-states the whole receipt:
  //     Σ line-paids + dropped charges (deposits/bags/points = recon.adjust) − combo = total
  // Three uses:
  //  • SOLVE a single unreadable total ("3, 4: A" → totUnknown + candidates): the Σ-vs-total
  //    delta belongs to that one line. Accepted ONLY when it matches a candidate reading
  //    (±0.005) — unaccounted leakage can therefore never invent a fit — or any positive
  //    value when the garble was unconstrained.
  //  • CONFIRM (footer.reconciled = true): the books balance to the cent — downstream may
  //    treat these prices as corroborated.
  //  • FLAG (footer.reconciled = false): trusted reads that don't balance, or unknowns the
  //    solver couldn't pin — an honest signal instead of a silently wrong receipt.
  // `_paid`/`_unk` are engine-internal markers, stripped below before the result leaves.
  let reconciled: boolean | undefined;
  let reconDelta: number | undefined;
  if (usedEngine && !totalFromFallback && total != null && total > 0) {
    const anyP = products as any[];
    // ── EQUATION 2 first — sutaupėte = Σ card-labeled discounts (verified: r238 8.01 =
    //    7.48+0.30+0.23, card-only; plain NUOLAIDA and Taškai excluded). When exactly ONE
    //    product's card discount is KNOWN-TO-EXIST but amount-less (its label printed,
    //    the number didn't survive), the savings line pins it: D = savings − Σ known.
    //    TENTATIVE until equation 1 (the printed total) corroborates below — committing
    //    is gated on the books balancing, so a wrong savings semantic can never write a
    //    promo that the total then contradicts. ──
    const unkDiscs = anyP.filter((pp) => pp._unkDisc && pp._unkDisc.card);
    if (totalSavings != null && totalSavings > 0 && unkDiscs.length === 1) {
      const knownCardSum = round2(anyP.reduce((sum, pp) => sum + (pp._cardDisc ?? 0), 0));
      const D = round2(totalSavings - knownCardSum);
      const host = unkDiscs[0];
      if (D > 0 && D <= host._unkDisc.lineTotal) {
        host._tentDisc = D; // picked up by equation 1 below; committed only on balance/fit
      }
    }
    const tentHost = anyP.find((pp) => pp._tentDisc != null);
    const applyTent = () => {
      if (!tentHost) return;
      const D = tentHost._tentDisc;
      const qty = tentHost.quantity && tentHost.quantity > 0 ? tentHost.quantity : 1;
      const paidT = round2(tentHost._unkDisc.lineTotal - D);
      if (paidT >= 0) tentHost.promoPrice = round2(paidT / qty);
      if (process.env.IKI_DEBUG) console.log(`[RECON] savings equation pinned discount ${D} on "${tentHost.name}" (sutaupėte=${totalSavings})`);
    };
    const knowns = anyP.filter((pp) => pp._paid != null);
    const unknowns = anyP.filter((pp) => pp._paid == null);
    const tentAdj = tentHost ? tentHost._tentDisc : 0; // tentative discount lowers the known sum
    const knownSum = round2(knowns.reduce((sum, pp) => sum + pp._paid, 0) - tentAdj + recon.adjust + roundingAdj - (combo.amount > 0 ? combo.amount : 0));
    reconDelta = round2(total - knownSum);
    if (unknowns.length === 0) {
      reconciled = Math.abs(reconDelta) <= 0.011;
      // equation 1 corroborates the savings-pinned discount → commit; else discard it.
      if (tentHost) { if (reconciled) applyTent(); else if (process.env.IKI_DEBUG) console.log('[RECON] savings pin discarded (total does not corroborate)'); }
    } else if (unknowns.length === 1 && unknowns[0]._unk) {
      const u = unknowns[0];
      const solvedTot = round2(reconDelta + (u._unk.discount ?? 0));
      const cands: number[] | null = u._unk.cands;
      // Bare-cents corroboration: a headless "59" pins the solved total's cents.
      const centsOk = u._unk.cents == null || Math.round(solvedTot * 100) % 100 === u._unk.cents;
      // SEGMENTATION GUARD (receipt-313): an unknown whose NAME carries embedded amount
      // tokens ("MAGIJA … 0,65 84 A A") is a MIS-SEGMENTED group, not one product — the
      // solve would absorb a swallowed neighbour's money and falsely reconcile (masking
      // the error from the user AND from the Phase-5 ensemble, which trusts `reconciled`).
      // Leave it flagged; the ensemble/second opinion owns structure, arithmetic owns values.
      const nameClean = !/\d[.,]\s?\d{2}|\s\d{2,}\s+[ABC](?:\s|$)/.test(u.name ?? '');
      const fits = solvedTot > 0 && reconDelta > 0 && centsOk && nameClean &&
        (cands == null || cands.some((cv: number) => Math.abs(cv - solvedTot) <= 0.005));
      if (fits) {
        const qty = u.quantity && u.quantity > 0 ? u.quantity : 1;
        u.price = qty > 1 ? round2(solvedTot / qty) : solvedTot;
        if (u._unk.discount > 0) {
          const paidU = round2(solvedTot - u._unk.discount);
          u.promoPrice = paidU >= 0 ? round2(paidU / qty) : null;
        }
        u.pricePerUnit = u.price;
        reconciled = true;
        reconDelta = 0; // the delta is now fully attributed to the solved line
        applyTent(); // the compound solve fit a candidate → both equations corroborate
        if (process.env.IKI_DEBUG) console.log(`[RECON] solved unknown total ${solvedTot} for "${u.name}" (Σknown=${knownSum}, printed=${total})`);
      } else {
        reconciled = false;
        if (process.env.IKI_DEBUG) console.log(`[RECON] cannot pin unknown "${u.name}": delta=${reconDelta} cands=${JSON.stringify(cands)}`);
      }
    } else {
      // EQUAL-SPLIT lane (receipt-308): N SAME-NAME unknowns — twin purchases whose totals
      // degraded identically ("KETO … SU SĖK 59" ×2). One equation can't solve N free
      // variables, but identical products cost the same: per = delta ÷ N, accepted only
      // when every unknown's bare-cents (and candidates, if any) corroborate per, and
      // per×N re-sums to the delta within one display-rounding cent. Wrong-name or
      // wrong-cents mixes fall through to the honest flag.
      const norm2 = (v: string) => foldForeignDiacritics(v).toLowerCase().replace(/[^a-z0-9]/g, '');
      const cleanNames = unknowns.every((u) => !/\d[.,]\s?\d{2}|\s\d{2,}\s+[ABC](?:\s|$)/.test(u.name ?? ''));
      const sameName = cleanNames && unknowns.length >= 2 && unknowns.every((u) => u._unk && norm2(u.name) === norm2(unknowns[0].name));
      const per = round2(reconDelta / unknowns.length);
      const eachFits = sameName && per > 0 && reconDelta > 0 && unknowns.every((u) => {
        const centsOk = u._unk.cents == null || Math.round(per * 100) % 100 === u._unk.cents;
        const cands: number[] | null = u._unk.cands;
        const candsOk = cands == null || cands.some((cv: number) => Math.abs(cv - per) <= 0.005);
        return centsOk && candsOk;
      }) && Math.abs(round2(per * unknowns.length) - reconDelta) <= 0.011;
      if (eachFits) {
        for (const u of unknowns) {
          const qty = u.quantity && u.quantity > 0 ? u.quantity : 1;
          const solved = round2(per + (u._unk.discount ?? 0));
          u.price = qty > 1 ? round2(solved / qty) : solved;
          if (u._unk.discount > 0) {
            const paidU = round2(solved - u._unk.discount);
            u.promoPrice = paidU >= 0 ? round2(paidU / qty) : null;
          }
          u.pricePerUnit = u.price;
        }
        reconciled = true;
        reconDelta = 0;
        applyTent();
        if (process.env.IKI_DEBUG) console.log(`[RECON] equal-split solved ${unknowns.length}× "${unknowns[0].name}" at ${per} each (Σknown=${knownSum}, printed=${total})`);
      } else {
        reconciled = false;
        if (process.env.IKI_DEBUG) console.log(`[RECON] ${unknowns.length} unknowns, delta=${reconDelta} — flag only`);
      }
    }
  }
  // Strip the internal markers — they must never serialize into parsedData.
  for (const pp of products as any[]) { delete pp._paid; delete pp._unk; delete pp._cardDisc; delete pp._unkDisc; delete pp._tentDisc; }

  return {
    header: { chainName: 'IKI', storeCode: '', storeName: '', storeAddress, pvmCode, rawText, region: unionOf(headerRegions), lineRegions: headerRegions },
    products,
    footer: {
      total, date, time, receiptNo, receiptNos, totalSavings,
      comboDiscount: combo.amount > 0 ? round2(combo.amount) : null,
      reconciled, reconDelta,
      rawText, region: unionOf(footerRegions), lineRegions: footerRegions,
    },
    skippedRegions,
  };
}

// ───────── public entry points ─────────

// MLKit sometimes recognises Lithuanian receipt glyphs as CYRILLIC homoglyphs — the
// visually-identical letter from the other script ("0,45 А" with U+0410, "ОНО!" with
// О/Н, receipt-295/294). Every downstream lane compares against LATIN ([ABC] VAT
// letters, keyword regexes, product names), so an un-folded homoglyph silently breaks
// them: the Cyrillic А made a trailing total unreadable → the product looked totalless
// → the name-continuation lane FUSED it with the next product. Receipts here are
// Lithuanian — any Cyrillic is OCR noise, so folding the identical-looking pairs to
// Latin at the parser ENTRY fixes all lanes at once. (Only visually-identical pairs;
// no phonetic guessing.)
const CYRILLIC_HOMOGLYPHS: Record<string, string> = {
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'І': 'I', 'Ј': 'J', 'К': 'K',
  'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'Ѕ': 'S',
  'а': 'a', 'с': 'c', 'е': 'e', 'і': 'i', 'ј': 'j', 'о': 'o', 'р': 'p', 'х': 'x', 'ѕ': 's', 'у': 'y',
};
const CYRILLIC_RE = /[Ѐ-ӿ]/;
// Underscores are another MLKit artifact — thermal receipts never print them, but OCR
// glues them onto tokens ("kg_", "Lietuva,_UAB", "VARŠKE,_9%"). They poison every \b
// word-boundary regex (underscore IS a \w char): "1,992 kg_" failed T_KG_LEAD_RE's
// `kg\b`, so the printed quantity was dropped and the derived total÷€/kg fallback
// stored 2.000 for a 1,992 kg line (receipt-295). Fold to a space at entry.
const NEEDS_FOLD_RE = /[Ѐ-ӿ_]/;
const foldOcrArtifacts = (s: string): string =>
  NEEDS_FOLD_RE.test(s)
    ? s.replace(/[Ѐ-ӿ]/g, (c) => CYRILLIC_HOMOGLYPHS[c] ?? c).replace(/_/g, ' ')
    : s;
const foldLineHomoglyphs = (l: IkiLine): IkiLine =>
  NEEDS_FOLD_RE.test(l.text) || (l.words ?? []).some((w) => NEEDS_FOLD_RE.test(w.text))
    ? {
        ...l,
        text: foldOcrArtifacts(l.text),
        words: (l.words ?? []).map((w) => (NEEDS_FOLD_RE.test(w.text) ? { ...w, text: foldOcrArtifacts(w.text) } : w)),
      }
    : l;

export function parseIkiReceipt(rawLines: IkiLine[]): IkiParseResult {
  const lines = rawLines.map(foldLineHomoglyphs);
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
  // Keep receiptNos[] consistent with the canonical id on this path (no printed identifiers here).
  if ((!footer.receiptNos || footer.receiptNos.length === 0) && footer.receiptNo) {
    footer.receiptNos = [footer.receiptNo];
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
