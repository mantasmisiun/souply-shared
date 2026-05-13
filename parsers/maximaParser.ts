/**
 * Maxima Receipt Parser.
 *
 * Two-step pipeline:
 *
 *   STEP 1 — Band detection + line classification.
 *     `findProductBands(lines)` returns `{ bands, internals }`:
 *       - `bands[]` carries the y-coord boundaries between products
 *         (contiguous: `bands[i].yBottom === bands[i+1].yTop`) for
 *         the visual overlay and image cropping.
 *       - `internals[]` carries each band's typed line content —
 *         the anchor row, pre-anchor name fragments, and every
 *         post-anchor line tagged with its role (unit-qty,
 *         discount-label, deposit-name, taisymas-*, same-row, …).
 *
 *   STEP 2 — Per-band content extraction (`extractMaximaProduct`).
 *     Converts each `BandInternal` into a `MaximaProduct` (name,
 *     price, promoPrice, quantity, unit, etc.) without touching
 *     OCR data outside the band. Reads the typed entries directly
 *     from step 1's internals — no string parsing of the trace
 *     dump, no re-classification.
 *
 * Public entry points:
 *   - `parseMaximaReceipt(lines)`     — full receipt (header + products + footer)
 *   - `parseMaximaHeaderOnly(lines)`  — early header probe before product OCR finishes
 *   - `isMaximaReceipt(lineTexts)`    — chain detection
 *   - `findProductBands(lines)`       — step 1 only
 *   - `traceProductBands(lines)`      — step 1 trace dump (dev tool)
 *   - `traceMaximaExtract(lines)`     — step 2 trace dump (dev tool)
 *
 * Convention note: `parseMaximaReceipt` emits per-unit prices for
 * rows with a `unit-qty` line on the receipt — `price` ==
 * `pricePerUnit` and `promoPrice` is divided by `quantity`. The
 * line total is recovered downstream as `price × quantity`. Lower-
 * level functions (`extractMaximaProduct` directly) keep raw line
 * totals; the normalization happens once at the receipt-level
 * boundary so the dev trace and reconcile self-check operate on
 * the receipt's printed numbers.
 */

import type { RegionKind, LabeledRegion } from './rimiParser';

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

/** Per-field source-line bboxes. Mobile renders one band per entry;
 *  legacy receipts (pre-refactor) won't have it, so it's optional and
 *  the photo view falls back to the block `region`. */
export interface MaximaHeader {
  chainName: string;
  storeCode: string;
  storeAddress: string;
  pvmCode: string;
  rawText: string;
  region: Region;
  lineRegions: LabeledRegion[];
}

export interface MaximaFooter {
  total: number | null;
  date: string;
  time: string;
  receiptNo: string;
  totalSavings: number | null;
  rawText: string;
  region: Region;
  lineRegions: LabeledRegion[];
}

export interface MaximaParseResult {
  header: MaximaHeader;
  products: MaximaProduct[];
  footer: MaximaFooter;
}

// ───────── regexes ─────────

const PRICE_RE = /(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const STANDALONE_PRICE_RE = /^(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const NEG_AMOUNT_RE = /^-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;
const INLINE_NEG_AMOUNT_RE = /-\s*(\d+[.,]\s?\d{2})\s*[AB]\s*$/;

// Bare-price anchor — for receipts where MLKit drops the trailing
// `A`/`B` VAT letter entirely (`"1,89"` instead of `"1,89 A"`).
// Used ONLY by `findAnchors` with mandatory prev-line context so
// deposit totals (`"0,10"` after `PET (depozitinis)`) and other
// numeric noise don't get promoted to fake product anchors.
// Tight format (exactly two decimals, full-line anchor) keeps stray
// numbers like `"40"` or `"22,"` out.
const RELAXED_PRICE_RE = /^\d+[.,]\d{2}$/;

// `unit_price X quantity unit` — unit price on left, quantity+unit
// on right. Covers both weighables (`1,99 X 1,118 kg`) and
// multi-pack (`0,59 X 4 vnt.`). Quantity decimal optional since
// pack counts are whole numbers.
//
// OCR tolerances folded in:
//   - unit: `kq` or `ka` for `kg` (q/a both commonly mistaken for
//     g on faded thermal prints)
//   - numbers: accept `O/o` for `0`, `l/I/L` for `1` — Maxima's
//     thermal-print kerning confuses MLKit on these letters.
//     Without this a line like `11,99 X O,388 kq` wasn't recognised
//     as a unit line and the row leaked into the next band's name.
//   - whitespace: `[.,]\s?` between the comma and the next digit
//     tolerates OCR stray spaces inside the decimal group
//     (`1, 100` instead of `1,100` — seen on bananas).
const DIGIT_OR_OCR = '[\\d0OoIlL]';
const UNIT_QTY_RE = new RegExp(
  `(\\d+[.,]\\s?${DIGIT_OR_OCR}{1,2})\\s*[xX×]\\s*(${DIGIT_OR_OCR}+(?:[.,]\\s?${DIGIT_OR_OCR}{1,3})?)\\s*(k[gqa]|mai[sšŠ]\\.?|vnt\\.?|pak\\.?)`,
  'i'
);

// Fallback for lines where MLKit drops the unit suffix entirely
// (`3,59 X 2` instead of `3,59 X 2 vnt.`). Requires the *whole*
// line to be `<price> X <qty>` — anchoring with ^/$ keeps stray
// numeric substrings from matching. Step 2 defaults the unit to
// `vnt` for matches against this fallback.
const UNIT_QTY_NOUNIT_RE =
  /^\s*(\d+[.,]\s?\d{1,2})\s*[xX×]\s*(\d+(?:[.,]\s?\d{1,3})?)\s*$/i;

/**
 * Map OCR's letter-digit confusions back to digits so parseNum can
 * handle captures from the relaxed regexes above.
 */
function sanitizeNumStr(s: string): string {
  return s.replace(/[Oo]/g, '0').replace(/[IlL]/g, '1');
}

// Per-item discount label. Two flavours seen in real receipts:
//   - `AČIŪ nuolaida prekei:<name>` (older AČIŪ kortelė).
//   - `Sutaupėte:<name>` (Mano Maxima e-receipts).
// Both can have the savings amount on the same line OR on the next.
//
// OCR tolerances:
//   - `nuolaida` is split arbitrarily by MLKit (`nuo laida`,
//     `nuola idos`, `nuolai da`). `\s*` between every two letters
//     of the prefix lets the regex catch all of them.
//   - Trailing `i` on `prekei` gets split off (`preke i:` vs
//     `prekei:`); both forms occur.
//   - `Sutaupėte` shows up with `e`/`é`/`è`/`ė` in the middle —
//     `[eéèė]` covers them all (the `/i` flag only case-folds
//     ASCII, not the diacritic variants).
const DISCOUNT_LABEL_RE = /(?:nuo\s*la\s*ida\s+preke\s*i|sutaup[eéèė]t|nuka[ij]?no)/i;

// Refund/correction marker. Maxima prints a `TAISYMAS` header
// followed by a 2- or 3-line block that mirrors the original
// purchase line: name repeat, `-X,XX A` neg amount, and (for
// weighable / multi-pack) a unit-qty repeat. The whole block
// belongs to the band of the product being refunded so the band
// reflects the net transaction, not just the gross.
const TAISYMAS_RE = /^\s*TAISYMAS\s*$/i;

const FOOTER_SEP_RE = /^={10,}\s*#?\s*$/;

// PET / can deposit. Always follows its parent product on the
// receipt — absorbed into the parent's band so deposits don't
// fragment a product into two bands.
//
// Two gendered forms: `PET (depozitinis)` for plastic bottles
// (male -inis suffix) and `Skardinė (depozitinė)` for aluminium
// cans (female -inė). Accept both suffixes + both gender plurals
// (`depozitiniai` / `depozitinės`). Missing this caused
// burger-patty rows to absorb the PET deposit header as their
// name prefix.
export const DEPOSIT_LINE_RE = /\b(?:pet|skardin[eė])\s*\(depozitin[eėi][sa]?[is]?\)/i;

// Checkout-only non-catalog items: disposable bags (maišelis) and
// reusable shopping bags (maišas — "Didelis pirkinių maišas
// MAXIMA"). Charged per piece but not products a shopper "buys"
// in the price-comparison sense.
export const NON_CATALOG_LINE_RE = /\b(?:vienkartinis|didelis|pirkini[uų])?\s*(?:plastikinis|popierinis)?\s*mai[sš](?:elis|as)\b/i;

// ───────── helpers ─────────

export function parseNum(str: string): number {
  return parseFloat(sanitizeNumStr(str).replace(",", ".").replace(/\s/g, ""));
}

export function regionOf(lines: MaximaLine[]): Region {
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
 * Split OCR rows that have a price trailing at the end into two
 * pseudo-lines so downstream parsing sees name/discount and
 * price/savings separately.
 */
export function splitMergedLines(lines: MaximaLine[]): MaximaLine[] {
  const out: MaximaLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;

    // Already standalone price or savings — keep as is.
    if (STANDALONE_PRICE_RE.test(text) || NEG_AMOUNT_RE.test(text)) {
      out.push(line);
      continue;
    }

    const priceMatch = text.match(PRICE_RE);
    const savingsMatch = text.match(INLINE_NEG_AMOUNT_RE);

    // Inline discount: "AČIŪ nuolaida prekei:<name> -X,XX A"
    if (DISCOUNT_LABEL_RE.test(text) && savingsMatch) {
      const savingsStart = text.lastIndexOf(savingsMatch[0]);
      const left = text.slice(0, savingsStart).trim();
      const right = text.slice(savingsStart).trim();
      out.push({ ...line, text: left });
      out.push({ ...line, text: right });
      continue;
    }

    // Merged product line: "<name> X,XX A"
    if (priceMatch && !DISCOUNT_LABEL_RE.test(text)) {
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
 * Strip combining diacritics so `bazėje`, `bazèje`, `bazéje` all
 * collapse to `bazeje` for pattern matching. Without this, one OCR
 * run misspelling ė as è leaks the whole header block into the
 * products region and the first header line ends up as the band 0
 * name fragment.
 */
const stripDiacritics = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function findHeaderEnd(lines: MaximaLine[]): number {
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

/**
 * Footer-start detector. Two-pass: strong signals beat the weak
 * `^={10,}` separator. Returning at the first match on a receipt
 * where MLKit emits a stray `===` mid-receipt would chop the last
 * product's discount off its band — strong-signal-first avoids
 * that class of false positive.
 *
 * Strong signals come in two flavours: receipt-end markers
 * (`Suteiktos naudos`, `Kvito suma`, `Mokėtina suma`) and
 * pre-totals markers that appear on receipts which print a VAT
 * breakdown / deposit summary BEFORE the canonical end marker
 * (`Be PVM`/`Su PVM` column headers, `A= 21,00%` VAT rate row,
 * `Depozitas/įmoka` deposit summary). Without the pre-totals
 * markers, those 5–10 summary lines sit inside the product slice
 * as orphans and the last band's yBottom gets extended down past
 * the actual products region.
 */
export function findFooterStart(lines: MaximaLine[], afterIdx: number): number {
  const norm = (s: string): string =>
    s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (let i = afterIdx; i < lines.length; i++) {
    const t = norm(lines[i].text);
    if (/suteiktos\s+naudos/.test(t)) return i;
    if (/^aciu\s+nuolaidos/.test(t)) return i;
    if (/^kvito\s+suma/.test(t)) return i;
    if (/^f1\s*moketina/.test(t)) return i;
    if (/^moketina\s+suma/.test(t)) return i;
    if (/^be\s+pvm\b/.test(t)) return i;
    if (/^su\s+pvm\b/.test(t)) return i;
    if (/^depozitas\b/.test(t)) return i;
    // VAT rate row e.g. "A= 21,00%". Anchored to start of line +
    // requires the trailing `%` so it doesn't false-positive on a
    // product code or a stray label.
    if (/^[ab]\s*=\s*\d+[.,]?\d*\s*%/.test(t)) return i;
  }
  for (let i = afterIdx; i < lines.length; i++) {
    if (/^={10,}/.test(lines[i].text)) return i;
  }
  return lines.length;
}

// ───────── header / footer ─────────

export function parseHeader(lines: MaximaLine[]): MaximaHeader {
  let storeCode = "";
  let storeAddress = "";
  let pvmCode = "";

  // Per-line region tracker — records the bbox of each line that
  // contributed to a captured field (store identity, address). The
  // photo view bands each entry independently rather than covering
  // the whole header with one giant block. Each entry tagged with
  // `kind` so the renderer can colour and label per field.
  const seen = new Set<string>();
  const lineRegions: LabeledRegion[] = [];
  const trackLine = (line: MaximaLine, kind: RegionKind) => {
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
    const text = line.text.trim();

    const pvmMatch = text.match(/(LT|LV|EE)\d{9,12}/);
    if (pvmMatch) pvmCode = pvmMatch[0];

    // Address lines typically contain `g.`, `pr.`, `al.`, `pl.` and
    // `Kasa` or a comma+city. The boundary preceding the suffix is
    // either whitespace (canonical: `Aido g. 8`) OR a Lithuanian /
    // Latin letter — MLKit sometimes drops the space between the
    // street name and the abbreviation (`Aidog. 8-1` was an actual
    // OCR run on kvitas_2026-01-02), and a strict word boundary
    // misses that form, leaving storeAddress empty and tripping the
    // store_unrecognized bail.
    if (
      !storeAddress &&
      /(?:^|\s|[a-zA-ZąčęėįšųūžĄČĘĖĮŠŲŪŽ])(g|pr|al|pl)\.\s/i.test(text) &&
      !/UAB|MAXIMA|PVM/i.test(text)
    ) {
      // Strip trailing "Kasa Nr. N" — it's a cashier counter, not
      // part of the address, and leaving it in the string tanks the
      // Levenshtein ratio against a clean DB address and breaks the
      // store match.
      storeAddress = text.replace(/,?\s*Kasa\s+Nr\.?\s*\d+.*$/i, "").trim();
      trackLine(line, 'storeAddress');
    }

    // Occasional "X-NNN MAXIMA" legacy store code — used only as a
    // display label since store matching is done via address.
    const codeMatch = text.match(/\b([A-Z]-\d{3,4})\s+MAXIMA\b/i);
    if (codeMatch) {
      storeCode = codeMatch[1].toUpperCase();
      trackLine(line, 'storeCode');
    }
  }

  lineRegions.sort((a, b) => a.yTop - b.yTop);
  return {
    chainName: "MAXIMA",
    storeCode,
    storeAddress,
    pvmCode,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
    lineRegions,
  };
}

export function parseFooter(lines: MaximaLine[]): MaximaFooter {
  let total: number | null = null;
  let date = "";
  let time = "";
  let receiptNo = "";
  let totalSavings: number | null = null;

  // Per-line region tracker — same intent as parseHeader. Tagged
  // with `kind` for per-field colour + label.
  const seen = new Set<string>();
  const lineRegions: LabeledRegion[] = [];
  const trackLine = (line: MaximaLine | undefined, kind: RegionKind) => {
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
    const text = lines[i].text.trim();

    // Kvito suma 71,44 — same line or on the next.
    const sumaMatch = text.match(/Kvito\s+suma\s+(\d+[.,]\s?\d{2})/i);
    if (sumaMatch) {
      total = parseNum(sumaMatch[1]);
      trackLine(lines[i], 'total');
    }
    if (/^Kvito\s+suma\s*$/i.test(text) && i + 1 < lines.length) {
      const m = lines[i + 1].text.trim().match(/(\d+[.,]\s?\d{2})/);
      if (m) {
        total = parseNum(m[1]);
        trackLine(lines[i], 'total');
        trackLine(lines[i + 1], 'total');
      }
    }

    // Fallback: `Mokėtina suma 71,44` or `f1Mokėtina suma 71,44`.
    if (total === null) {
      const mok = text.match(/Mok[eė]tina\s+suma\s+(\d+[.,]\s?\d{2})/i);
      if (mok) {
        total = parseNum(mok[1]);
        trackLine(lines[i], 'total');
      }
    }

    // Receipt datetime — extract date and time INDEPENDENTLY.
    if (!date) {
      const m = text.match(
        /(20\d{2})\s*-\s*(0[1-9]|1[0-2])\s*-\s*(0[1-9]|[12]\d|3[01])/,
      );
      if (m) {
        date = `${m[1]}-${m[2]}-${m[3]}`;
        trackLine(lines[i], 'date');
      }
    }
    if (!time) {
      const m = text.match(
        /(?:^|[^\d])((?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)(?!\d)/,
      );
      if (m) {
        time = m[1].length === 5 ? `${m[1]}:00` : m[1];
        trackLine(lines[i], 'time');
      }
    }

    // Receipt number — Kvito Nr. on one line, on the next, or Dokumento numeris.
    if (!receiptNo) {
      const sameLine = text.match(/Kvito\s+Nr\.?\s+(\S+)/i);
      if (sameLine) {
        receiptNo = sameLine[1];
        trackLine(lines[i], 'receiptNo');
      } else if (/^Kvito\s+Nr\.?\s*$/i.test(text) && i + 1 < lines.length) {
        const next = lines[i + 1].text.trim();
        const digits = next.match(/^(\d{3,})/);
        if (digits) {
          receiptNo = digits[1];
          trackLine(lines[i], 'receiptNo');
          trackLine(lines[i + 1], 'receiptNo');
        }
      }
    }
    if (!receiptNo) {
      const docMatch = text.match(/Dokumento\s+numeris:?\s+(\d{3,})/i);
      if (docMatch) {
        receiptNo = docMatch[1];
        trackLine(lines[i], 'receiptNo');
      } else if (/Dokumento\s+numeris:?\s*$/i.test(text) && i + 1 < lines.length) {
        const next = lines[i + 1].text.trim();
        const m = next.match(/^(\d{3,})/);
        if (m) {
          receiptNo = m[1];
          trackLine(lines[i], 'receiptNo');
          trackLine(lines[i + 1], 'receiptNo');
        }
      }
    }

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

  lineRegions.sort((a, b) => a.yTop - b.yTop);
  return {
    total,
    date,
    time,
    receiptNo,
    totalSavings,
    rawText: lines.map((l) => l.text).join("\n"),
    region: regionOf(lines),
    lineRegions,
  };
}

export function cleanProductName(name: string): string {
  let cleaned = name;
  cleaned = cleaned.replace(/,?\s*\d+[\.,]?\d*\s*(g|kg|ml|l|vnt\.?)\s*$/i, "").trim();
  cleaned = cleaned.replace(/,\s*$/, "").trim();
  return cleaned;
}

// ───────── band model (internal) ─────────

interface InternalBand {
  /** Index of the price-anchor line inside the products slice. */
  anchorIdx: number;
  /** Inclusive last line index belonging to this product. */
  lastIdx: number;
}

/**
 * Reason tag for a line classification inside a band. Used by the
 * trace dump for the human-readable view AND by step 2's
 * extractor to know each line's role.
 */
type TraceReason =
  | 'name'              // pre-anchor name fragment glued to the upcoming band
  | 'anchor'            // positive-price line that started the band
  | 'unit-qty'          // `1,99 X 1,118 kg` style row
  | 'discount-label'    // `AČIŪ nuolaida prekei:` / `Sutaupėte:` (label on its own row)
  | 'discount-amount'   // `-X,XX A` on the row after a discount label
  | 'inline-discount'   // discount label and `-X,XX A` on the same row
  | 'bare-negative'     // standalone `-X,XX A` with no preceding label
  | 'deposit-name'      // `PET (depozitinis)` / can deposit
  | 'deposit-qty'       // unit-qty row of a deposit block
  | 'deposit-price'     // positive-price row of a deposit block
  | 'taisymas-header'   // refund/correction header
  | 'taisymas-name'     // name fragment inside a refund block
  | 'taisymas-amount'   // mandatory neg amount of a refund block
  | 'taisymas-qty'      // optional trailing unit-qty of a refund block
  | 'same-row'          // unclassified line at same y as last absorbed (left-column continuation)
  | 'stop-next-anchor'  // extension stopped: next line is a new product's name
  | 'stop-footer-sep';  // extension stopped: hit the `==========` separator

function isPositivePriceLine(line: MaximaLine): boolean {
  const t = line.text.trim();
  if (!STANDALONE_PRICE_RE.test(t)) return false;
  if (t.startsWith('-')) return false;
  return true;
}

function isDiscountLabelLine(line: MaximaLine): boolean {
  return DISCOUNT_LABEL_RE.test(line.text);
}

function isUnitQtyLine(line: MaximaLine): boolean {
  return UNIT_QTY_RE.test(line.text) || UNIT_QTY_NOUNIT_RE.test(line.text);
}

function isDepositLine(line: MaximaLine): boolean {
  return DEPOSIT_LINE_RE.test(line.text);
}

function isFooterSepLine(line: MaximaLine): boolean {
  return FOOTER_SEP_RE.test(line.text.trim());
}

/**
 * Find every line index that's a true product anchor.
 *
 * Strict path: positive-price line (`X,XX A`/`B`) not preceded by a
 * discount label.
 *
 * Relaxed path: bare-price line (`X,XX` with the trailing VAT
 * letter dropped by OCR) preceded by a name-like line. Required
 * exclusions on the previous line keep deposit totals, discount
 * amounts, and other numeric noise from being promoted to fake
 * anchors.
 */
function findAnchors(lines: MaximaLine[]): number[] {
  const anchors: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = i > 0 ? lines[i - 1] : null;
    if (isPositivePriceLine(line)) {
      if (prev && isDiscountLabelLine(prev)) continue;
      anchors.push(i);
      continue;
    }
    if (!RELAXED_PRICE_RE.test(line.text.trim())) continue;
    if (!prev) continue;
    const prevText = prev.text.trim();
    if (isDepositLine(prev)) continue;
    if (isPositivePriceLine(prev)) continue;
    if (isDiscountLabelLine(prev)) continue;
    if (NEG_AMOUNT_RE.test(prevText)) continue;
    if (TAISYMAS_RE.test(prevText)) continue;
    if (!/\p{L}/u.test(prev.text)) continue;
    anchors.push(i);
  }
  return anchors;
}

/**
 * Extend a band downward from its anchor, absorbing every line
 * that "belongs to" this product:
 *   - unit-qty rows
 *   - discount blocks (label + amount, inline or two-line)
 *   - standalone negative amounts (rare OCR artefact)
 *   - PET / can deposit blocks (deposit name + unit-qty + price)
 *   - TAISYMAS refund blocks (header + mirrored name/amount/qty)
 *   - same-row continuations on the left-column (multi-line names)
 *
 * Stops at the next product's name line or the footer separator.
 */
function extendBand(
  lines: MaximaLine[],
  anchorIdx: number,
  events: { sliceIdx: number; reason: TraceReason }[],
): number {
  let last = anchorIdx;
  let j = anchorIdx + 1;
  let stopReason: 'stop-next-anchor' | 'stop-footer-sep' = 'stop-next-anchor';
  while (j < lines.length) {
    const next = lines[j];
    if (isFooterSepLine(next)) {
      stopReason = 'stop-footer-sep';
      break;
    }

    if (isUnitQtyLine(next)) {
      last = j;
      events.push({ sliceIdx: j, reason: 'unit-qty' });
      j++;
      continue;
    }

    if (isDiscountLabelLine(next)) {
      last = j;
      if (INLINE_NEG_AMOUNT_RE.test(next.text)) {
        events.push({ sliceIdx: j, reason: 'inline-discount' });
        j++;
        continue;
      }
      events.push({ sliceIdx: j, reason: 'discount-label' });
      j++;
      if (j < lines.length && NEG_AMOUNT_RE.test(lines[j].text.trim())) {
        last = j;
        events.push({ sliceIdx: j, reason: 'discount-amount' });
        j++;
      }
      continue;
    }

    if (NEG_AMOUNT_RE.test(next.text.trim())) {
      last = j;
      events.push({ sliceIdx: j, reason: 'bare-negative' });
      j++;
      continue;
    }

    // TAISYMAS refund block — header + (name fragments)? + neg
    // amount + (unit-qty)?. Phased absorption keeps tight bounds:
    // up to 3 name fragments, then mandatory neg amount, then one
    // optional trailing unit-qty.
    if (TAISYMAS_RE.test(next.text.trim())) {
      last = j;
      events.push({ sliceIdx: j, reason: 'taisymas-header' });
      j++;
      let nameLines = 0;
      while (j < lines.length && nameLines < 3) {
        const ln = lines[j];
        if (isFooterSepLine(ln)) break;
        if (NEG_AMOUNT_RE.test(ln.text.trim())) break;
        if (isPositivePriceLine(ln)) break;
        last = j;
        events.push({ sliceIdx: j, reason: 'taisymas-name' });
        j++;
        nameLines++;
      }
      if (j < lines.length && NEG_AMOUNT_RE.test(lines[j].text.trim())) {
        last = j;
        events.push({ sliceIdx: j, reason: 'taisymas-amount' });
        j++;
      }
      if (j < lines.length && isUnitQtyLine(lines[j])) {
        last = j;
        events.push({ sliceIdx: j, reason: 'taisymas-qty' });
        j++;
      }
      continue;
    }

    // PET / can deposit block follows this product. Absorb the
    // deposit's name + unit-qty + price into the parent so the
    // deposit doesn't fragment off into its own band.
    if (isDepositLine(next)) {
      last = j;
      events.push({ sliceIdx: j, reason: 'deposit-name' });
      j++;
      if (j < lines.length && isUnitQtyLine(lines[j])) {
        last = j;
        events.push({ sliceIdx: j, reason: 'deposit-qty' });
        j++;
      }
      if (j < lines.length && isPositivePriceLine(lines[j])) {
        last = j;
        events.push({ sliceIdx: j, reason: 'deposit-price' });
        j++;
      }
      continue;
    }

    // Same physical row as the most recently absorbed line.
    // Maxima's two-column layout (name on left, price on right)
    // gets emitted by MLKit as separate text blocks at the same
    // y, so a name continuation, multi-line name fragment, or a
    // deposit's right-column total ("0,10" without trailing A)
    // appears as the *next* OCR line even though it's the same
    // physical row. Without this, extension stops at that line and
    // orphans the unit-qty / discount block below it.
    //
    // Threshold: y-overlap > 50% of the shorter line's height.
    // Real continuations have ≥80% overlap on Maxima receipts;
    // genuinely-different rows have a 5–15 px gap (no overlap),
    // so the cutoff has comfortable margin in both directions.
    const refLine = lines[last];
    const overlap =
      Math.min(next.yBottom, refLine.yBottom) -
      Math.max(next.yTop, refLine.yTop);
    const minH = Math.min(
      next.yBottom - next.yTop,
      refLine.yBottom - refLine.yTop,
    );
    if (minH > 0 && overlap > minH * 0.5) {
      last = j;
      events.push({ sliceIdx: j, reason: 'same-row' });
      j++;
      continue;
    }

    // Anything else = the next product's name line. Stop here.
    break;
  }
  // Sentinel "stop event" — its sliceIdx is the line that caused
  // the stop (or lines.length if we ran off the end).
  events.push({ sliceIdx: j, reason: stopReason });
  return last;
}

/**
 * Build internal bands. Anchor indices that fall inside an
 * already-built band's range are skipped — this is what makes
 * absorbed deposits (whose price line is itself a positive-price
 * anchor) NOT spawn a duplicate band.
 *
 * `eventsPerBand` is appended in lockstep with the returned bands
 * — every band's extension events are recorded so step 2 and the
 * trace dump can read the same underlying classification without
 * re-running extension.
 */
function buildBands(
  lines: MaximaLine[],
  eventsPerBand: { sliceIdx: number; reason: TraceReason }[][],
): InternalBand[] {
  const anchorIndices = findAnchors(lines);
  const bands: InternalBand[] = [];
  let coveredUpTo = -1;
  for (const anchorIdx of anchorIndices) {
    if (anchorIdx <= coveredUpTo) continue;
    const events: { sliceIdx: number; reason: TraceReason }[] = [];
    const lastIdx = extendBand(lines, anchorIdx, events);
    bands.push({ anchorIdx, lastIdx });
    eventsPerBand.push(events);
    coveredUpTo = lastIdx;
  }
  return bands;
}

// ───────── public API ─────────

export interface ProductBand {
  /**
   * yTop in the same coord space as the input lines (image-pixel
   * for single-page, parser-concat space for multi-page). Equal
   * to the previous band's yBottom (no gaps).
   */
  yTop: number;
  /** yBottom; equal to the next band's yTop. */
  yBottom: number;
}

/**
 * One classified line inside a band. `sliceIdx` is the line's
 * position in the products slice (after `splitMergedLines` +
 * header strip), included so callers can cross-reference against
 * the trace dump.
 */
export interface BandLineEntry {
  line: MaximaLine;
  sliceIdx: number;
  reason: TraceReason;
}

/**
 * Per-band typed content. Step 2 reads from these directly: name
 * from `preName` + `postAnchor` entries tagged `same-row`, price
 * from `anchor`, unit-qty from the matching `postAnchor` entry,
 * etc. The trace dump iterates the same data to render its
 * line-by-line view, so step 1's classification is the single
 * source of truth.
 */
export interface BandInternal {
  /** 0-based; matches the index in `bands`. Visual band number = bandIdx + 1. */
  bandIdx: number;
  /** Positive-price line that anchored this band. */
  anchor: BandLineEntry;
  /** Name fragments appearing before the anchor, in slice order. */
  preName: BandLineEntry[];
  /**
   * Lines absorbed downward from the anchor, in slice order.
   * Excludes the terminal stop sentinel (carried separately on
   * `stop` so consumers know what *would-have-been* the next line
   * if extension hadn't stopped).
   */
  postAnchor: BandLineEntry[];
  /** Why extension stopped + which slice idx caused it. */
  stop: {
    sliceIdx: number;
    reason: 'stop-next-anchor' | 'stop-footer-sep' | 'stop-end-of-input';
  };
}

export interface ReceiptBandPlan {
  /** Bands covering the products region, in y-order. */
  bands: ProductBand[];
  /** Per-band typed content, 1:1 with `bands`. */
  internals: BandInternal[];
}

/**
 * Internal context object — carries everything the public API and
 * the trace dump need without re-running `splitMergedLines` /
 * `findHeaderEnd` / band detection twice.
 */
interface BandsContext {
  processed: MaximaLine[];
  headerEnd: number;
  footerStart: number;
  productSlice: MaximaLine[];
  bands: ProductBand[];
  internals: BandInternal[];
}

/**
 * Run the full step-1 pipeline (split → header/footer detect →
 * anchor → extend → boundary smoothing) and produce both the
 * y-coord band list and the per-band typed content. All public
 * entry points delegate here so the work happens exactly once.
 */
function computeBandsContext(rawLines: MaximaLine[]): BandsContext {
  const processed = splitMergedLines(rawLines);
  const headerEnd = findHeaderEnd(processed);
  const footerStart = findFooterStart(processed, headerEnd);
  const productSlice = processed.slice(headerEnd, footerStart);

  // Display-only boundaries: midpoints between header end / first
  // product line, and last product line / first footer line.
  let topBoundY: number | undefined;
  if (headerEnd > 0 && headerEnd < processed.length) {
    topBoundY = (processed[headerEnd - 1].yBottom + processed[headerEnd].yTop) / 2;
  }
  let bottomBoundY: number | undefined;
  if (footerStart > 0 && footerStart < processed.length) {
    bottomBoundY = (processed[footerStart - 1].yBottom + processed[footerStart].yTop) / 2;
  }

  const eventsPerBand: { sliceIdx: number; reason: TraceReason }[][] = [];
  const internalBands = buildBands(productSlice, eventsPerBand);

  const bands: ProductBand[] = [];
  const internals: BandInternal[] = [];
  for (let bi = 0; bi < internalBands.length; bi++) {
    const band = internalBands[bi];
    // Lines before the first anchor are loose name fragments —
    // attach them to the first band so leading multi-line names
    // aren't lost.
    const sliceStart = bi === 0 ? 0 : internalBands[bi - 1].lastIdx + 1;
    const bandLines = productSlice.slice(sliceStart, band.lastIdx + 1);
    const region = regionOf(bandLines);
    bands.push({ yTop: region.yTop, yBottom: region.yBottom });

    const events = eventsPerBand[bi];
    const preName: BandLineEntry[] = [];
    for (let k = sliceStart; k < band.anchorIdx; k++) {
      preName.push({ line: productSlice[k], sliceIdx: k, reason: 'name' });
    }
    const stopEv = events.find(
      (e) => e.reason === 'stop-next-anchor' || e.reason === 'stop-footer-sep',
    );
    const postAnchor: BandLineEntry[] = events
      .filter((e) => e.reason !== 'stop-next-anchor' && e.reason !== 'stop-footer-sep')
      .map((e) => ({ line: productSlice[e.sliceIdx], sliceIdx: e.sliceIdx, reason: e.reason }));
    const stop = stopEv
      ? {
          sliceIdx: stopEv.sliceIdx,
          reason: stopEv.reason as 'stop-next-anchor' | 'stop-footer-sep',
        }
      : {
          sliceIdx: productSlice.length,
          reason: 'stop-end-of-input' as const,
        };
    internals.push({
      bandIdx: bi,
      anchor: {
        line: productSlice[band.anchorIdx],
        sliceIdx: band.anchorIdx,
        reason: 'anchor',
      },
      preName,
      postAnchor,
      stop,
    });
  }

  // Make adjacent bands share an exact divider, and extend the
  // first/last bands to the header/footer dividers.
  if (bands.length > 0) {
    if (topBoundY !== undefined) bands[0].yTop = topBoundY;
    for (let i = 0; i < bands.length - 1; i++) {
      const mid = (bands[i].yBottom + bands[i + 1].yTop) / 2;
      bands[i].yBottom = mid;
      bands[i + 1].yTop = mid;
    }
    if (bottomBoundY !== undefined) bands[bands.length - 1].yBottom = bottomBoundY;
  }

  return { processed, headerEnd, footerStart, productSlice, bands, internals };
}

/**
 * Step 1: find product band boundaries + per-band typed content.
 * Pure (no I/O), so safe on any platform. Bands are made
 * contiguous and the first/last bands are extended to the
 * header/footer dividers so consumers can use `(yTop, yBottom)`
 * directly as a crop region.
 */
export function findProductBands(lines: MaximaLine[]): ReceiptBandPlan {
  const ctx = computeBandsContext(lines);
  return { bands: ctx.bands, internals: ctx.internals };
}

// ───────── trace dumps (dev tool) ─────────

const TRUNC = (s: string, n = 80): string =>
  s.length <= n ? s : s.slice(0, n - 1) + '…';

const fmtY = (line: MaximaLine): string =>
  `y=${Math.round(line.yTop)}..${Math.round(line.yBottom)}`;

/**
 * Build a copy-paste-friendly trace of how step 1 partitioned a
 * receipt's lines into bands. Format is line-oriented (one OCR
 * line per row in the dump) with explicit reasons, indices, and
 * y-coords so a reader can match the dump against the
 * receipt-detail overlay.
 *
 * Reads from `computeBandsContext` so the classification the
 * trace shows is byte-for-byte the same one step 2 sees in
 * `internals`.
 */
export function traceProductBands(rawLines: MaximaLine[]): string {
  const ctx = computeBandsContext(rawLines);
  const { processed, headerEnd, footerStart, productSlice, internals } = ctx;

  const out: string[] = [];
  out.push(
    `lines: total=${rawLines.length} afterSplit=${processed.length} ` +
      `headerEnd=${headerEnd} footerStart=${footerStart} ` +
      `productSlice=[${headerEnd}..${footerStart}) bands=${internals.length}`,
  );
  if (headerEnd > 0) {
    const lastHeader = processed[headerEnd - 1];
    out.push(`  lastHeaderLine: ${fmtY(lastHeader)} "${TRUNC(lastHeader.text)}"`);
  }
  if (footerStart < processed.length) {
    const firstFooter = processed[footerStart];
    out.push(`  firstFooterLine: ${fmtY(firstFooter)} "${TRUNC(firstFooter.text)}"`);
  }
  out.push('');

  type Tag = { bandIdx1: number; reason: TraceReason };
  const tags = new Map<number, Tag>();
  for (const band of internals) {
    const bandIdx1 = band.bandIdx + 1;
    for (const e of band.preName) tags.set(e.sliceIdx, { bandIdx1, reason: e.reason });
    tags.set(band.anchor.sliceIdx, { bandIdx1, reason: band.anchor.reason });
    for (const e of band.postAnchor) tags.set(e.sliceIdx, { bandIdx1, reason: e.reason });
  }

  if (internals.length === 0) {
    out.push('NO ANCHORS FOUND. All product-region lines:');
    for (let i = 0; i < productSlice.length; i++) {
      const ln = productSlice[i];
      out.push(`  slice[${i}] ${fmtY(ln)} "${TRUNC(ln.text)}"`);
    }
    return out.join('\n');
  }

  let currentBand = 0;
  for (let i = 0; i < productSlice.length; i++) {
    const ln = productSlice[i];
    const tag = tags.get(i);
    if (!tag) {
      out.push(
        `  slice[${i}] ${fmtY(ln)} reason=? band=- "${TRUNC(ln.text)}"`,
      );
      continue;
    }
    if (tag.bandIdx1 !== currentBand) {
      currentBand = tag.bandIdx1;
      const band = internals[currentBand - 1];
      const lastIdx = band.postAnchor.length > 0
        ? band.postAnchor[band.postAnchor.length - 1].sliceIdx
        : band.anchor.sliceIdx;
      out.push('');
      out.push(
        `── band ${currentBand}: anchor=slice[${band.anchor.sliceIdx}] ` +
          `lastIdx=slice[${lastIdx}] ` +
          `${band.stop.reason}=slice[${band.stop.sliceIdx}]`,
      );
    }
    out.push(
      `  slice[${i}] ${fmtY(ln)} reason=${tag.reason} band=${tag.bandIdx1} "${TRUNC(ln.text)}"`,
    );
  }
  return out.join('\n');
}

// ───────── step 2: per-band content extraction ─────────

/**
 * Outcome of running step 2 on a single band. `product` is null
 * when the band represents something we don't surface as a
 * shopping-cart product (deposits, plastic bags, TAISYMAS
 * refunds) OR when the anchor couldn't be parsed at all.
 * `warnings` is always populated for skipped bands (the skip
 * reason) and may also carry diagnostic notes on emitted products
 * (relaxed-anchor fallback, unit-qty regex miss, reconcile
 * mismatch).
 *
 * `product.price` and `product.promoPrice` here are the *raw*
 * line totals printed on the receipt — `extractMaximaProduct` is
 * the receipt's own arithmetic, no normalization. The
 * receipt-level wrapper `parseMaximaReceipt` converts those to
 * per-unit values for the rest of the codebase that multiplies
 * `price × quantity` to recover the line total downstream.
 */
export interface ExtractResult {
  product: MaximaProduct | null;
  warnings: string[];
}

const RECONCILE_TOLERANCE_EUR = 0.02;

/**
 * Convert one classified band into a `MaximaProduct` (or skip it).
 *
 * Skips:
 *   - any band whose `postAnchor` contains a `taisymas-*` event
 *     (refund, net-zero — drop the line)
 *   - any band whose joined name reduces to a non-catalog or
 *     deposit-only string (plastic bag, "PET (depozitinis)" alone)
 *
 * Reconcile self-check:
 *   For bands with an extracted unit-qty, verifies that
 *   `pricePerUnit × quantity ≈ price` (tolerance €0.02). Mismatch
 *   surfaces a warning with the full math so the operator can
 *   eyeball which factor went wrong (qty? ppu? price?). Warning
 *   is informational — the product is still emitted.
 */
export function extractMaximaProduct(internal: BandInternal): ExtractResult {
  const warnings: string[] = [];

  // TAISYMAS refund: net zero, drop.
  const hasTaisymas = internal.postAnchor.some(
    (e) =>
      e.reason === 'taisymas-header' ||
      e.reason === 'taisymas-name' ||
      e.reason === 'taisymas-amount' ||
      e.reason === 'taisymas-qty',
  );
  if (hasTaisymas) {
    const refundedName = internal.preName.map((e) => e.line.text).join(' ').trim();
    return {
      product: null,
      warnings: [`skip:taisymas-refund "${refundedName.slice(0, 60)}"`],
    };
  }

  // Price from anchor. Strict form first, relaxed (no A/B) as
  // fallback so the few OCR-dropped-letter receipts still produce
  // a price — but flag the fallback so it's visible.
  const anchorText = internal.anchor.line.text.trim();
  let price: number;
  const strictPriceMatch = anchorText.match(STANDALONE_PRICE_RE);
  if (strictPriceMatch) {
    price = parseNum(strictPriceMatch[1]);
  } else if (RELAXED_PRICE_RE.test(anchorText)) {
    price = parseNum(anchorText);
    warnings.push(`anchor RELAXED form "${anchorText}" → ${price.toFixed(2)}`);
  } else {
    return {
      product: null,
      warnings: [`skip:anchor-parse-failed "${anchorText}"`],
    };
  }

  // Name = pre-anchor fragments + same-row continuations that
  // appear BEFORE any deposit-name on this band. A `same-row`
  // event after a deposit-name is the deposit's right-column
  // total ("0,10"), not a name continuation — exclude it.
  const nameLineEntries: BandLineEntry[] = [...internal.preName];
  let depositSeen = false;
  for (const e of internal.postAnchor) {
    if (e.reason === 'deposit-name') {
      depositSeen = true;
      continue;
    }
    if (e.reason === 'same-row' && !depositSeen) {
      nameLineEntries.push(e);
    }
  }
  const rawName = nameLineEntries.map((e) => e.line.text).join(' ').trim();

  // Non-catalog filter — plastic bags, deposit-only entries.
  if (NON_CATALOG_LINE_RE.test(rawName)) {
    return {
      product: null,
      warnings: [`skip:non-catalog "${rawName.slice(0, 60)}"`],
    };
  }
  if (DEPOSIT_LINE_RE.test(rawName)) {
    return {
      product: null,
      warnings: [`skip:deposit-only "${rawName.slice(0, 60)}"`],
    };
  }

  const name = cleanProductName(rawName);

  // Unit-qty extraction. Strict (with unit) first, then no-unit
  // fallback. If the band had a `unit-qty` event but neither regex
  // matches the line text, that's a step-1/step-2 disagreement
  // worth surfacing.
  let pricePerUnit: number | null = null;
  let quantity = 1;
  let unit = 'vnt';
  const unitQtyEntry = internal.postAnchor.find((e) => e.reason === 'unit-qty');
  if (unitQtyEntry) {
    const text = unitQtyEntry.line.text;
    const strictMatch = text.match(UNIT_QTY_RE);
    if (strictMatch) {
      pricePerUnit = parseNum(strictMatch[1]);
      quantity = parseNum(strictMatch[2]);
      const rawUnit = strictMatch[3].toLowerCase();
      // Normalize OCR variants: `kq`/`ka` → `kg`, `maišš.` → `maiš`,
      // `pakel.` → `pak`, anything else → `vnt`.
      if (rawUnit.startsWith('k')) unit = 'kg';
      else if (rawUnit.startsWith('mai')) unit = 'maiš';
      else if (rawUnit.startsWith('pak')) unit = 'pak';
      else unit = 'vnt';
    } else {
      const noUnitMatch = text.match(UNIT_QTY_NOUNIT_RE);
      if (noUnitMatch) {
        pricePerUnit = parseNum(noUnitMatch[1]);
        quantity = parseNum(noUnitMatch[2]);
        unit = 'vnt';
      } else {
        warnings.push(
          `unit-qty tag present but no regex matched: "${text}"`,
        );
      }
    }
  }

  // promoPrice from the first discount/neg event we see. The
  // signed amount is the savings; promoPrice = price - |amount|.
  let promoPrice: number | null = null;
  for (const e of internal.postAnchor) {
    if (e.reason === 'discount-amount' || e.reason === 'bare-negative') {
      const m = e.line.text.trim().match(NEG_AMOUNT_RE);
      if (m) {
        const amount = parseNum(m[1]);
        promoPrice = Math.round((price - amount) * 100) / 100;
        break;
      }
    }
    if (e.reason === 'inline-discount') {
      const m = e.line.text.match(INLINE_NEG_AMOUNT_RE);
      if (m) {
        const amount = parseNum(m[1]);
        promoPrice = Math.round((price - amount) * 100) / 100;
        break;
      }
    }
  }

  // Reconcile self-check on bands that have an extracted unit-qty.
  // Receipt's own arithmetic: `ppu × qty` should match the printed
  // line price. Mismatch beyond €0.02 means OCR scrambled one of
  // the three numbers — log it but still emit the product.
  if (pricePerUnit !== null) {
    const expected = pricePerUnit * quantity;
    const delta = Math.abs(expected - price);
    if (delta > RECONCILE_TOLERANCE_EUR) {
      warnings.push(
        `reconcile MISMATCH: ppu=${pricePerUnit.toFixed(2)} × qty=${quantity} = ` +
          `${expected.toFixed(2)} but price=${price.toFixed(2)} (Δ=${delta.toFixed(2)})`,
      );
    }
  }

  // Stitch raw lines + bbox region for downstream consumers.
  const allEntries: BandLineEntry[] = [
    ...internal.preName,
    internal.anchor,
    ...internal.postAnchor,
  ];
  const allLines = allEntries.map((e) => e.line);
  const region = regionOf(allLines);
  const rawLines = allLines.map((l) => l.text);

  const product: MaximaProduct = {
    name,
    price,
    promoPrice,
    quantity,
    unit,
    pricePerUnit,
    rawLines,
    region,
  };
  return { product, warnings };
}

/**
 * Per-band extraction trace, copy-paste-friendly. Companion to
 * `traceProductBands` for step 2 — same band ordering, one row
 * per band, with the extracted product fields and the reconcile
 * status inline so a single glance spots arithmetic drift.
 *
 * Reflects `extractMaximaProduct`'s raw output (line totals), not
 * the per-unit normalization applied in `parseMaximaReceipt`.
 */
export function traceMaximaExtract(rawLines: MaximaLine[]): string {
  const ctx = computeBandsContext(rawLines);
  const out: string[] = [];
  out.push(`bands=${ctx.internals.length}`);
  for (const internal of ctx.internals) {
    const bandNum = internal.bandIdx + 1;
    const { product, warnings } = extractMaximaProduct(internal);
    const skipMsg = warnings.find((w) => w.startsWith('skip:'));
    if (!product) {
      const skip = skipMsg ?? 'no product emitted';
      out.push(`band ${bandNum}: SKIP ${skip}`);
      for (const w of warnings) {
        if (w === skipMsg) continue;
        out.push(`        WARN ${w}`);
      }
      continue;
    }
    const mismatch = warnings.find((w) => w.startsWith('reconcile MISMATCH'));
    let reconcile: string;
    if (product.pricePerUnit === null) {
      reconcile = 'reconcile:n/a';
    } else if (mismatch) {
      const expected = (product.pricePerUnit * product.quantity).toFixed(2);
      const delta = Math.abs(product.pricePerUnit * product.quantity - product.price).toFixed(2);
      reconcile =
        `reconcile:${product.pricePerUnit.toFixed(2)}×${product.quantity}=${expected} ✗ Δ=${delta}`;
    } else {
      const expected = (product.pricePerUnit * product.quantity).toFixed(2);
      reconcile =
        `reconcile:${product.pricePerUnit.toFixed(2)}×${product.quantity}=${expected} ✓`;
    }
    const status = mismatch ? 'WARN' : warnings.length > 0 ? 'NOTE' : 'OK';
    const promo = product.promoPrice === null ? 'null' : product.promoPrice.toFixed(2);
    const ppu = product.pricePerUnit === null ? 'null' : product.pricePerUnit.toFixed(2);
    out.push(
      `band ${bandNum}: ${status}  name="${TRUNC(product.name, 60)}"  ` +
        `price=${product.price.toFixed(2)}  promo=${promo}  ` +
        `qty=${product.quantity}  unit=${product.unit}  ppu=${ppu}  ${reconcile}`,
    );
    for (const w of warnings) {
      if (w === mismatch) continue;
      out.push(`        ${w}`);
    }
  }
  return out.join('\n');
}

// ───────── public entry points ─────────

/**
 * Full receipt parse: header + products + footer.
 *
 * Convention: rows with a `unit-qty` line on the receipt have
 * their `price` and `promoPrice` normalized to PER-UNIT values
 * here (`price = pricePerUnit`, `promoPrice = promoPrice / qty`).
 * Downstream code (receipt-process display, basket calc, persist)
 * recovers the line total as `price × quantity`. Rows without a
 * unit-qty (single-pack non-weighable) keep `price` as the line
 * total since `quantity = 1`.
 *
 * `extractMaximaProduct` keeps the raw line totals for the dev
 * trace and reconcile self-check; the normalization happens once
 * at this boundary.
 */
export function parseMaximaReceipt(lines: MaximaLine[]): MaximaParseResult {
  const ctx = computeBandsContext(lines);
  const header = parseHeader(ctx.processed.slice(0, ctx.headerEnd));
  const footer = parseFooter(ctx.processed.slice(ctx.footerStart));
  const products: MaximaProduct[] = [];
  for (const internal of ctx.internals) {
    const { product } = extractMaximaProduct(internal);
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

export function parseMaximaHeaderOnly(lines: MaximaLine[]): MaximaHeader {
  const processed = splitMergedLines(lines);
  const headerEnd = findHeaderEnd(processed);
  return parseHeader(processed.slice(0, headerEnd));
}
