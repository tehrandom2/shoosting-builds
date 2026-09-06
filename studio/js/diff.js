/*
 * What changed, for a "suggest a change" draft against the built-in card it started from.
 *
 * This is what makes a mod submission honest: the reviewer's PR body is a before/after
 * table (Tools/studio-service/API.md, POST /submit/mod), and the editor should show the
 * author the same table before they send it, not a surprise after. Every field compares
 * as the text a person would read, not as JSON - the effect list compares as
 * `card.js#describe` output, because that is the sentence the pick screen actually shows
 * and two effects that differ only in an order that renders identically is not a change
 * worth reporting.
 */

import { describe } from "./card.js";

function line(label, before, after) {
    return before === after ? null : { label, before, after };
}

/** Every changed field, in the order a person reads a card. Empty if nothing changed. */
export function diffCard(base, draft) {
    const rows = [
        line("Name", base.name, draft.name),
        line("Description", base.description, draft.description),
        line("Set", base.set, draft.set),
        line("Rarity", base.rarity, draft.rarity),
        line("Code", base.code, draft.code),
        line("Smallest lobby", String(base.minPlayers), String(draft.minPlayers)),
        line("Keywords",
            (base.keywords || []).join(", ") || "(none)",
            (draft.keywords || []).join(", ") || "(none)"),
        line("Effects",
            describe(base, 1) || "(none)",
            describe(draft, 1) || "(none)"),
    ];

    return rows.filter(Boolean);
}

export function hasChanges(base, draft) {
    return diffCard(base, draft).length > 0;
}
