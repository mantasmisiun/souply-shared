/**
 * Cap + order swipe-queue cards for the receipt-anchored voluntary mode.
 *
 * Behaviour (locked spec from the pink-button design discussion):
 *   • Hard cap: 10 cards per session.
 *   • Slot priority across the queue: slot 2 → slot 1 → slot 3.
 *   • Phase A — take up to 3 receipt-anchored cards per slot, in slot
 *     priority order. Won't exceed the receipt budget of 9 (= 10 cap
 *     minus 1 reserved slot for the community contribution card).
 *   • Phase B (redistribution) — if Phase A didn't fill the receipt
 *     budget (e.g. a slot had < 3 cards), fill from the remaining
 *     receipt cards in the same priority order.
 *   • Phase C — fill the remaining slots up to 10 from the global
 *     queue, again in slot priority order. This is what enforces the
 *     "always ≥ 1 global per session" rule when the global pool has
 *     any unique cards.
 *   • Phase D (fallback) — if Phase C yielded zero globals because the
 *     global pool is empty or fully overlapping with receipt picks,
 *     backfill the remaining slots with extra receipt cards. The
 *     "≥ 1 global" rule yields when global is empty (a hard cap of 9
 *     would be a worse UX).
 *
 * Output preserves receipt-then-global ordering so the user resolves
 * their own receipt's items first and the "community contribution"
 * cards land at the end of the session. Each card is tagged with
 * `fromGlobalFill` so the renderer can show a subtle subline
 * distinguishing them.
 *
 * Implementation is intentionally a single pure function: deterministic
 * given the same inputs, no side effects, easy to unit-test without a
 * server or React tree.
 */

export interface CapCardLike {
    cardId: string;
    slot: 1 | 2 | 3;
}

export interface CapInput<T extends CapCardLike> {
    receiptItems: T[];
    globalItems: T[];
}

export interface CapResult<T extends CapCardLike> {
    items: (T & { fromGlobalFill: boolean })[];
}

const TOTAL_CAP = 10;
const PER_SLOT_TARGET = 3;
const RECEIPT_BUDGET = TOTAL_CAP - 1; // 9 — reserve 1 slot for global
const SLOT_PRIORITY: readonly (1 | 2 | 3)[] = [2, 1, 3] as const;

const groupBySlot = <T extends CapCardLike>(cards: T[]): Map<number, T[]> => {
    const m = new Map<number, T[]>([
        [1, []],
        [2, []],
        [3, []],
    ]);
    for (const c of cards) {
        const bucket = m.get(c.slot);
        if (bucket) bucket.push(c);
    }
    return m;
};

const makeCursors = (): Map<number, { value: number }> =>
    new Map([
        [1, { value: 0 }],
        [2, { value: 0 }],
        [3, { value: 0 }],
    ]);

/** Take one not-yet-seen card from the slot's pool, advancing the cursor
 *  past any already-seen entries. Returns null when the pool is exhausted. */
const pickNextUnseen = <T extends CapCardLike>(
    pool: T[],
    cursor: { value: number },
    seen: Set<string>,
): T | null => {
    while (cursor.value < pool.length) {
        const c = pool[cursor.value++];
        if (!seen.has(c.cardId)) return c;
    }
    return null;
};

export function capVoluntaryQueue<T extends CapCardLike>({
    receiptItems,
    globalItems,
}: CapInput<T>): CapResult<T> {
    const seen = new Set<string>();
    const receiptBySlot = groupBySlot(receiptItems);
    const globalBySlot = groupBySlot(globalItems);
    const receiptCursors = makeCursors();
    const globalCursors = makeCursors();

    const receiptPicked: T[] = [];

    // ── Phase A: up to PER_SLOT_TARGET (3) per slot, priority order
    for (const slot of SLOT_PRIORITY) {
        if (receiptPicked.length >= RECEIPT_BUDGET) break;
        const pool = receiptBySlot.get(slot) ?? [];
        const cursor = receiptCursors.get(slot)!;
        let takenThisSlot = 0;
        while (
            takenThisSlot < PER_SLOT_TARGET &&
            receiptPicked.length < RECEIPT_BUDGET
        ) {
            const c = pickNextUnseen(pool, cursor, seen);
            if (!c) break;
            seen.add(c.cardId);
            receiptPicked.push(c);
            takenThisSlot++;
        }
    }

    // ── Phase B: redistribute remaining receipt budget across slots,
    // priority order, round-robin so all slot 2 isn't drained before
    // slot 1 gets a chance when both have leftovers past the per-slot
    // target.
    let progress = true;
    while (progress && receiptPicked.length < RECEIPT_BUDGET) {
        progress = false;
        for (const slot of SLOT_PRIORITY) {
            if (receiptPicked.length >= RECEIPT_BUDGET) break;
            const pool = receiptBySlot.get(slot) ?? [];
            const cursor = receiptCursors.get(slot)!;
            const c = pickNextUnseen(pool, cursor, seen);
            if (c) {
                seen.add(c.cardId);
                receiptPicked.push(c);
                progress = true;
            }
        }
    }

    // ── Phase C: fill remaining capacity from global, priority order,
    // round-robin. This is the layer that enforces ≥ 1 global card
    // when the global pool has any unique cards.
    const globalPicked: T[] = [];
    const globalNeeded = () => TOTAL_CAP - receiptPicked.length - globalPicked.length;
    progress = true;
    while (progress && globalNeeded() > 0) {
        progress = false;
        for (const slot of SLOT_PRIORITY) {
            if (globalNeeded() === 0) break;
            const pool = globalBySlot.get(slot) ?? [];
            const cursor = globalCursors.get(slot)!;
            const c = pickNextUnseen(pool, cursor, seen);
            if (c) {
                seen.add(c.cardId);
                globalPicked.push(c);
                progress = true;
            }
        }
    }

    // ── Phase D: if global yielded zero cards (pool empty or fully
    // overlapping with receipt picks) AND we're still under 10,
    // backfill with extra receipt cards rather than ending short. The
    // "always ≥ 1 global" rule yields here — a 9-card session would
    // feel worse than a 10-card session with no community contribution
    // when no global cards exist.
    if (globalPicked.length === 0) {
        progress = true;
        while (progress && receiptPicked.length + globalPicked.length < TOTAL_CAP) {
            progress = false;
            for (const slot of SLOT_PRIORITY) {
                if (receiptPicked.length + globalPicked.length >= TOTAL_CAP) break;
                const pool = receiptBySlot.get(slot) ?? [];
                const cursor = receiptCursors.get(slot)!;
                const c = pickNextUnseen(pool, cursor, seen);
                if (c) {
                    seen.add(c.cardId);
                    receiptPicked.push(c);
                    progress = true;
                }
            }
        }
    }

    return {
        items: [
            ...receiptPicked.map((c) => ({ ...c, fromGlobalFill: false })),
            ...globalPicked.map((c) => ({ ...c, fromGlobalFill: true })),
        ],
    };
}

/** Mandatory mode (banner) keeps its existing 3-card-priority logic.
 *  Extracted here so all queue capping lives in one file. */
export function capMandatoryQueue<T extends CapCardLike>({
    receiptItems,
}: {
    receiptItems: T[];
}): CapResult<T> {
    const MANDATORY = 3;
    const seen = new Set<string>();
    const bySlot = groupBySlot(receiptItems);
    const cursors = makeCursors();
    const picked: T[] = [];

    let progress = true;
    while (progress && picked.length < MANDATORY) {
        progress = false;
        for (const slot of SLOT_PRIORITY) {
            if (picked.length >= MANDATORY) break;
            const pool = bySlot.get(slot) ?? [];
            const cursor = cursors.get(slot)!;
            const c = pickNextUnseen(pool, cursor, seen);
            if (c) {
                seen.add(c.cardId);
                picked.push(c);
                progress = true;
            }
        }
    }

    return {
        items: picked.map((c) => ({ ...c, fromGlobalFill: false })),
    };
}
