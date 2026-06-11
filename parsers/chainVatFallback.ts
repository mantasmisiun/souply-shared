/**
 * Backup chain detection by the seller's PVM (VAT) payer code.
 *
 * Every LT receipt prints the seller's VAT code, and it's chain-specific +
 * reliably OCR'd even when the branding/header text the primary detectors
 * (`isXReceipt`) key on is garbled. Used ONLY as a fallback when those all
 * fail. Norfa doesn't print its code on the receipt, so it's absent here.
 */

export interface VatChainMatch {
    chainId: number;
    chainName: string;
}

// chainId mapping matches the rest of the app: Maxima 1, Rimi 2, Iki 3,
// Norfa 4 (no code), Lidl 5. Codes stored space-free + upper-case for matching.
const VAT_CODES: { compact: string; chainId: number; chainName: string }[] = [
    { compact: 'LT117910113', chainId: 5, chainName: 'LIDL' },
    { compact: 'LT230335113', chainId: 1, chainName: 'MAXIMA' },
    { compact: 'LT237153113', chainId: 2, chainName: 'RIMI' },
    { compact: 'LT101937219', chainId: 3, chainName: 'IKI' },
];

/**
 * Return the chain whose VAT code appears in the OCR lines, else null.
 * Matches per line with whitespace stripped, so a code OCR'd with stray
 * spaces ("LT 117 910 113") still hits without risking cross-line glue.
 */
export function detectChainByVatCode(lines: string[]): VatChainMatch | null {
    for (const line of lines) {
        const compact = line.replace(/\s+/g, '').toUpperCase();
        if (!compact.includes('LT')) continue;
        for (const c of VAT_CODES) {
            if (compact.includes(c.compact)) {
                return { chainId: c.chainId, chainName: c.chainName };
            }
        }
    }
    return null;
}
