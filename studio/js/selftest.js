/*
 * Does this page still agree with the game?
 *
 * The studio's promise is that a card looks here exactly as it will look on the pick
 * screen, and that promise is a JavaScript port of C# - which is a thing that drifts
 * silently. describe.json carries the lines the game itself printed for every built-in
 * card at every stack depth a hand can reach, so the port can simply be checked against
 * them, all 59 cards at once, on every load.
 *
 * Quiet when it passes: a page that logged a success line on every visit would train
 * everyone to ignore the console it is trying to speak through. It reports through the
 * returned summary, which the footer shows, and only writes to the console when the two
 * actually disagree - at which point the card and the depth are named.
 */

import { describe, countLines } from "./card.js";

export function runSelfTest(data) {
    if (!data.truth) return { ran: false, checked: 0, failures: [] };

    const failures = [];
    let checked = 0;

    for (const card of data.cards) {
        const expected = data.truth[String(card.id)];
        if (!expected) continue;

        for (const [held, text] of Object.entries(expected)) {
            checked++;
            const got = describe(card, Number(held));
            if (got === text) continue;

            failures.push({ card: card.name, held: Number(held), expected: text, got });
        }
    }

    if (failures.length) {
        console.error(
            `studio: the effect-line renderer disagrees with the game on ${failures.length} `
            + `of ${checked} checks. The first is "${failures[0].card}" holding `
            + `${failures[0].held}.`,
            failures.slice(0, 5),
        );
    }

    return { ran: true, checked, failures };
}

/**
 * The worst built-in card, which is what the line budget exists for. Shown in the studio so
 * an author can see that five effects is a real card rather than a limit invented here.
 */
export function worstBuiltIn(data, held = 2) {
    let worst = null, most = 0;

    for (const card of data.cards) {
        const lines = countLines(describe(card, held));
        if (lines <= most) continue;
        most = lines;
        worst = card;
    }

    return { card: worst, lines: most };
}
