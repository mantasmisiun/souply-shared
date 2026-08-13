# souply-shared

Receipt parsers and recognition configuration for [Souply](https://souply.lt), a grocery
price-comparison platform for the Lithuanian market. This code has to produce identical
results on a phone and on a server, so it lives in its own repository and is consumed by
both.

| Repo | Role |
|---|---|
| **`souply-shared`** | **This repo — parsers + recognition config** |
| `souply-api` | Node/Express/MariaDB backend |
| `souply-app` | React Native / Expo mobile client |
| `souply-web` | Web client |

`souply-api` checks this out in CI, pinned to the matching environment branch. `souply-app`
keeps a synced copy under `shared/`. It is consumed by path, not published to npm.

## What's here

```
parsers/
├── ikiParser.ts               one parser per chain — layouts differ completely
├── lidlParser.ts
├── maximaParser.ts
├── norfaParser.ts
├── rimiParser.ts
├── productNameParser.ts       size/unit extraction from a product name
├── normalizeLithuanianText.ts diacritic and homoglyph folding
├── cardMaskDetection.ts       finds and masks payment card digits
├── loyaltyMoney.ts            loyalty-scheme value lines
└── chainVatFallback.ts        VAT rates when the receipt omits them

recognitionConfig.ts           central thresholds for the matching pipeline
swipeQueueCap.ts               queue sizing for the manual review flow
```

About 17,000 lines of parser code across the five chains.

## The problem

A supermarket receipt photographed on a phone is a hostile input. Thermal paper fades,
the paper curves, and OCR drops or confuses characters. Every chain uses a different
layout, and the same chain changes it without warning. Two OCR engines are in play —
Apple Vision on iOS, ML Kit on Android — and they disagree about where lines break.

The parsers turn that into structured line items: product name, quantity, unit price,
line total, discounts, and the receipt footer.

## Design rules, all of them learned from failures

**Band walls are hard walls.** A receipt has structural regions, and a band border is the
edge of an extraction zone. Content is never absorbed across one, no matter how close it
looks in the image.

**Never trust vertical proximity alone.** Attaching a price to the nearest label by
y-distance works until the receipt is curved, and then it silently attaches the wrong
price. Same for sorting fragments by x-coordinate, which breaks on skew. Both produce
plausible-looking wrong data, which is the worst failure mode available.

**Never fabricate a price.** A weighed item whose price per kilo can't be recovered gets
`price = 0` and a null unit price. A wrong number that looks right is worse than an
obvious gap, because only one of the two gets reported.

**Numbers disambiguate, they don't decorate.** "2,5%" and "3,5%" are different products.
Size and percentage mismatches carry penalties in matching rather than being normalised
away.

**If it isn't in the OCR output, no parser can recover it.** Parser changes are checked
against the raw OCR geometry first; when the text was never captured, the fix belongs in
the imaging pipeline, not here.

## Documentation

The design documents in this repository are working notes rather than polished docs, but
they record why things are the way they are:

| | |
|---|---|
| `RECOGNITION_PIPELINE.md` | end-to-end flow from photo to matched line item |
| `OCR_MATCHING.md` | how receipt text is matched to catalogue products |
| `ROBUST_PARSING_PLAN.md` | strategy for surviving OCR damage |
| `RECEIPT_VOCABULARY.md` | learned aliases from receipt names to products |
| `PARSER_PARITY_CHECKLIST.md` | keeping the app and server parsers identical |
| `PIPELINE_AUDIT_2026-07-02.md` | full audit of the recognition pipeline |
| `SWIPE_QUEUE_REDESIGN.md` | manual review queue for uncertain matches |
| `SMART_BASKET_SPEC.md`, `SOUPLY_2.0_SPEC.md` | product specifications |

## Testing

Parsers are exercised by replaying stored OCR output through the current code, so a change
can be checked against the whole corpus without a phone in the loop. That corpus is
**deliberately absent from this repository** — it consists of real receipts, which are
personal data, and it is ignored by `.gitignore`.

## Status and licence

Actively developed. Published so the work can be read; not currently accepting
contributions, and no open-source licence is granted — all rights reserved.
