/**
 * LOYALTY MONEY on a receipt — "MAXIMOS pinigai", "Mano Rimi pinigai", …
 *
 * These programmes pay part of the bill from a balance the shopper already
 * earned, and the till deducts it AFTER the line items:
 *
 *     …4 × 0,59 …………………………… 2,36      ← the lines add up to 2,36
 *     Nurašyta MAXIMOS pinigų  0,12      ← paid from the balance
 *     Mokėti                   2,24      ← the printed total
 *
 * So on a perfectly captured receipt the line sum legitimately EXCEEDS the
 * printed total by the redeemed amount. Nothing knew that, so the difference
 * counted as a reconciliation gap — the same class of false alarm the IKI set
 * deal (footer.comboDiscount) used to cause before it was modelled.
 *
 * Three distinct numbers, and they must not be confused:
 *   · redeemed — spent off the balance on THIS receipt (reduces what you paid)
 *   · earned   — accrued by this purchase (does NOT reduce this bill)
 *   · balance  — what is left afterwards (informational)
 *
 * Only `redeemed` belongs in reconciliation. `earned` is a future discount and
 * adding it here would make the receipt fail to balance in the other direction.
 */

export type LoyaltyProgram = 'maxima' | 'rimi' | 'iki' | 'lidl' | 'norfa' | 'unknown';

/** A receipt line, optionally with the vertical band it occupies. Geometry lets
 *  a label be paired with an amount printed in the RIGHT COLUMN of the same row
 *  — Rimi prints "Panaudoti MANO RIMI pinigai" and "-0,09" as separate OCR
 *  lines, so adjacency within one string finds nothing. */
export interface LoyaltyLine {
    text: string;
    yTop?: number | null;
    yBottom?: number | null;
}

export interface LoyaltyMoney {
    program: LoyaltyProgram;
    /** Paid from the balance on this receipt (€). 0 when none was spent. */
    redeemed: number;
    /** Earned by this purchase (€), or null when the receipt doesn't print it. */
    earned: number | null;
    /** Balance left after this receipt (€), or null when not printed. */
    balance: number | null;
}

/** `0,12` / `1.234,50` / `12.50` → 12.5 */
function parseAmount(raw: string): number | null {
    const cleaned = raw.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const PROGRAM_HINTS: { program: LoyaltyProgram; re: RegExp }[] = [
    { program: 'maxima', re: /maxim/i },
    { program: 'rimi', re: /\brimi\b/i },
    { program: 'iki', re: /\biki\b/i },
    { program: 'lidl', re: /lidl/i },
    { program: 'norfa', re: /norf/i },
];

/**
 * ADJACENCY IS THE WHOLE GAME. OCR glues several printed rows into one string:
 *
 *   "Suteiktos naudos Atsiskaityta MAXIMOS pinigais - 0,10 A ==== Sutaupėte 0,10"
 *   "Panaudoti MANO RIMI pinigai -0,09 Mangų ir pasiflorų valg. ledai PIRŪ"
 *
 * Taking "the last amount on the line" therefore attributed a receipt TOTAL as
 * loyalty money on real receipts. The amount must follow the loyalty phrase
 * IMMEDIATELY — a short gap with no other digits in it — or it isn't ours.
 */
const AMOUNT = String.raw`-?\d{1,4}(?:[.\s]\d{3})*[.,]\d{2}(?!\d)`;
/** At most this many non-digit characters may sit between phrase and amount. */
const GAP = String.raw`[^0-9\n]{0,14}`;
const rx = (body: string) => new RegExp(body, 'i');

/** SPENT off the balance — "nurašyta", "panaudota", "atsiskaityta … pinigais". */
const REDEEM_RE = rx(
    String.raw`(?:nurašyt|nurasyt|panaudot|atsiskaityt|apmokėt|apmoket|padengt)\w*[^0-9\n]{0,40}pinig\w*${GAP}(${AMOUNT})`);
/** ACCRUED — "Iš viso … pinigų už kvitą 0,02", "Sukaupta … pinigų 1,50". */
const EARN_RES = [
    rx(String.raw`pinig\w*[^0-9\n]{0,20}(?:už|uz)\s*kvit\w*${GAP}(${AMOUNT})`),
    rx(String.raw`(?:sukaupt|priskaičiuot|priskaiciuot|surinkt|uždirbt|uzdirbt)\w*[^0-9\n]{0,40}pinig\w*${GAP}(${AMOUNT})`),
];
/** LEFT OVER — "…pinigų likutis 0,02". */
const BALANCE_RES = [
    rx(String.raw`pinig\w*[^0-9\n]{0,20}likut\w*${GAP}(${AMOUNT})`),
    rx(String.raw`likut\w*[^0-9\n]{0,20}pinig\w*${GAP}(${AMOUNT})`),
];

/** A line that is essentially just a money amount — the right-column value. */
const BARE_AMOUNT_RE = rx(String.raw`^[^0-9a-zęėįšųūž]{0,6}(${AMOUNT})[^0-9]{0,4}$`);

/** Does a loyalty LABEL line match this family at all (amount or not)? */
const labelOnly = (line: string, patterns: RegExp[]): boolean =>
    patterns.some(re => {
        // Reuse the pattern minus its trailing amount requirement.
        const src = re.source.replace(new RegExp(String.raw`\$\{?GAP\}?.*$`), '');
        const head = src.slice(0, src.lastIndexOf('[^0-9'));
        return head.length > 0 && new RegExp(head, 'i').test(line);
    });

const firstAmount = (line: string, patterns: RegExp[]): number | null => {
    for (const re of patterns) {
        const m = line.match(re);
        if (m?.[1]) {
            const v = parseAmount(m[1]);
            if (v != null) return Math.abs(v);
        }
    }
    return null;
};

/**
 * Scan a receipt's OCR lines for loyalty-money movement.
 *
 * Returns null when the receipt has no loyalty lines at all, so callers can
 * distinguish "no programme" from "programme, nothing spent".
 */
export function detectLoyaltyMoney(input: (string | LoyaltyLine)[]): LoyaltyMoney | null {
    const lines: LoyaltyLine[] = input.map(l => (typeof l === 'string' ? { text: l } : l));
    const norm = lines.map(l => ({ ...l, text: (l.text ?? '').replace(/\s+/g, ' ').trim() }));

    /** Distinct redemption amounts — receipts print the SAME redemption twice
     *  ("Atsiskaityta MAXIMOS pinigais" as a header, then "Nurašyta MAXIMOS
     *  pinigų 0,12" as the detail row), and summing both silently doubled the
     *  money. The same amount is one movement; different amounts are different
     *  movements and do add up. */
    const redemptions = new Set<number>();
    let earned: number | null = null;
    let balance: number | null = null;
    let program: LoyaltyProgram | null = null;
    let sawAny = false;

    /**
     * The amount printed in the same ROW as a label, when the OCR split the two.
     * Only bare-amount lines qualify, and only within half a row-height of the
     * label's band — a number two rows down belongs to something else.
     */
    const sameRowAmount = (label: LoyaltyLine): number | null => {
        if (label.yTop == null || label.yBottom == null) return null;
        const h = Math.max(6, label.yBottom - label.yTop);
        for (const other of norm) {
            if (other === label || other.yTop == null || other.yBottom == null) continue;
            const overlap = Math.min(label.yBottom, other.yBottom) - Math.max(label.yTop, other.yTop);
            if (overlap < h * 0.5) continue;
            const m = other.text.match(BARE_AMOUNT_RE);
            if (m?.[1]) {
                const v = parseAmount(m[1]);
                if (v != null) return Math.abs(v);
            }
        }
        return null;
    };

    for (const line of norm) {
        const text = line.text;
        if (!text || !/pinig/i.test(text)) continue;
        sawAny = true;
        if (program == null) {
            program = PROGRAM_HINTS.find(p => p.re.test(text))?.program ?? null;
        }

        // BALANCE first: "…pinigų likutis 0,02" also contains "pinigų", and a
        // leftover balance must never be read as money spent on this receipt.
        const bal = firstAmount(text, BALANCE_RES) ?? (labelOnly(text, BALANCE_RES) ? sameRowAmount(line) : null);
        if (bal != null) { balance = bal; continue; }
        const earn = firstAmount(text, EARN_RES) ?? (labelOnly(text, EARN_RES) ? sameRowAmount(line) : null);
        if (earn != null) { earned = (earned ?? 0) + earn; continue; }
        const spent = firstAmount(text, [REDEEM_RE]) ?? (labelOnly(text, [REDEEM_RE]) ? sameRowAmount(line) : null);
        // A bare header with no amount anywhere on its row claims nothing.
        if (spent != null) redemptions.add(Math.round(spent * 100) / 100);
    }

    if (!sawAny) return null;
    const redeemed = Math.round([...redemptions].reduce((a, b) => a + b, 0) * 100) / 100;
    return {
        program: program ?? 'unknown',
        redeemed,
        earned: earned == null ? null : Math.round(earned * 100) / 100,
        balance,
    };
}
