export interface ParsedProductName {
  strippedName: string;
  amount: number | null;
  unit: string | null;
}

const KNOWN_UNITS = new Set(["g", "kg", "ml", "l", "vnt", "oz"]);

/**
 * Strip a trailing weight/volume suffix from an OCR product name and return
 * the stripped name plus (optionally) the parsed amount + unit.
 *
 * Handles:
 *   "Foo, 150"           → strip ", 150",     amount=null, unit=null
 *   "Foo, 150 g"         → strip ", 150 g",   amount=150,  unit="g"
 *   "Foo 150 g"          → strip " 150 g",    amount=150,  unit="g"
 *   "Foo, 935 g / 455 g" → strip trailing,    amount=935,  unit="g"  (prefers g)
 *   "Foo, 500 ml"        → strip ", 500 ml",  amount=500,  unit="ml"
 *   "Foo, 2 l"           → strip ", 2 l",     amount=2,    unit="l"
 *   "Foo, 1 l / 0.5 kg"  → strip trailing,    amount=1,    unit="l"  (prefers l side)
 *
 * Rule: name is always stripped when a matching suffix is found; amount + unit
 * are returned for g, kg, ml, l (prefer g first). "vnt"/"oz" are stripped but
 * left as null since they don't meaningfully differentiate package sizes.
 * Weighable products skip parsing (amount/unit handled differently upstream).
 */
export function parseProductName(
  raw: string,
  isWeighable: boolean = false,
): ParsedProductName {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { strippedName: "", amount: null, unit: null };
  if (isWeighable) {
    return { strippedName: trimmed, amount: null, unit: null };
  }

  const re =
    /[,\s]+(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?(?:\s*\/\s*(\d+(?:[.,]\d+)?)\s*([a-zA-Z]+)?)?\s*$/;
  const m = trimmed.match(re);
  if (!m) return { strippedName: trimmed, amount: null, unit: null };

  const [full, n1Raw, u1Raw, n2Raw, u2Raw] = m;
  const n1 = n1Raw ? parseFloat(n1Raw.replace(",", ".")) : null;
  const n2 = n2Raw ? parseFloat(n2Raw.replace(",", ".")) : null;
  const u1 = u1Raw?.toLowerCase() ?? null;
  const u2 = u2Raw?.toLowerCase() ?? null;

  // If neither side has a known unit, don't strip — too risky (e.g. "Milk 2l" vs "Item 2").
  // Bare number (", 150") is an exception: strip but leave amount/unit null per spec.
  const u1Known = u1 != null && KNOWN_UNITS.has(u1);
  const u2Known = u2 != null && KNOWN_UNITS.has(u2);
  const isBareNumber = !u1 && !u2 && !n2;
  if (!u1Known && !u2Known && !isBareNumber) {
    return { strippedName: trimmed, amount: null, unit: null };
  }

  const strippedName = trimmed
    .slice(0, trimmed.length - full.length)
    .replace(/[,\s]+$/, "")
    .trim();

  // Prefer g first (most specific packaged weight), then other measurable units
  const RETURNABLE = ["g", "kg", "ml", "l"] as const;
  for (const u of RETURNABLE) {
    if (u1 === u && n1 != null) return { strippedName, amount: n1, unit: u };
    if (u2 === u && n2 != null) return { strippedName, amount: n2, unit: u };
  }

  return { strippedName, amount: null, unit: null };
}
