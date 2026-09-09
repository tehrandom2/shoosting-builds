/*
 * Loading data/, and turning whatever shape it arrives in into the one shape the rest of
 * the studio speaks.
 *
 * The files are generated from the real C# library by a separate tool, so this end of the
 * contract is deliberately forgiving about spelling and strict about meaning: a value may
 * arrive as {numerator, denominator}, as [n, d] or as a bare decimal, and all three become
 * the same exact pair here. Being forgiving is not politeness - a field renamed upstream
 * should degrade one card's tooltip, never blank the page.
 *
 * What it will not do is invent card data. If cards.json is missing the app says so.
 */

import { rationalise, ratioFromDecimal, rawFromRatio } from "./fixed.js";
import { PANEL } from "./card.js";
import { RARITIES, KEYWORDS, TRIGGERS, ACTIONS, OPS, STATS, titled } from "./vocab.js";

const pick = (object, ...names) => {
    for (const name of names) {
        if (object && object[name] !== undefined && object[name] !== null) return object[name];
    }
    return undefined;
};

async function load(url) {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`${url} responded ${response.status}`);
    return response.json();
}

function asArray(payload, ...keys) {
    if (Array.isArray(payload)) return payload;
    for (const key of keys) if (Array.isArray(payload?.[key])) return payload[key];
    return [];
}

/** A value in whatever form it was written, as the exact pair a card stores. */
function normaliseValue(raw) {
    if (raw === undefined || raw === null) return { numerator: 0, denominator: 1 };

    if (Array.isArray(raw)) {
        return { numerator: Number(raw[0]) || 0, denominator: Number(raw[1]) || 1 };
    }

    if (typeof raw === "object") {
        const numerator = pick(raw, "numerator", "n", "num");
        const denominator = pick(raw, "denominator", "d", "den");
        if (numerator !== undefined && denominator !== undefined) {
            return { numerator: Number(numerator), denominator: Number(denominator) || 1 };
        }
        return normaliseValue(pick(raw, "decimal", "value", "approx"));
    }

    // A bare decimal. Recovered as the simplest ratio that lands on the same fixed-point
    // value, which for anything a person typed is the thing they typed.
    const direct = ratioFromDecimal(raw);
    if (direct) return direct;
    return rationalise(rawFromRatio(Math.round(Number(raw) * 1000000) || 0, 1000000));
}

function normaliseEffect(raw) {
    return {
        trigger: pick(raw, "trigger") ?? "Passive",
        action: pick(raw, "action") ?? "StatMod",
        stat: pick(raw, "stat") ?? "Damage",
        op: pick(raw, "op", "operation") ?? "Multiply",
        value: normaliseValue(pick(raw, "value", "value1")),
        value2: normaliseValue(pick(raw, "value2")),
    };
}

function normaliseCard(raw) {
    return {
        id: Number(pick(raw, "id") ?? 0),
        name: String(pick(raw, "name") ?? ""),
        description: String(pick(raw, "description") ?? ""),
        rarity: pick(raw, "rarity") ?? "Common",
        set: String(pick(raw, "set") ?? ""),
        code: String(pick(raw, "code") ?? ""),
        minPlayers: Number(pick(raw, "minPlayers", "minplayers") ?? 2),
        keywords: (pick(raw, "keywords") ?? []).slice(),
        effects: (pick(raw, "effects") ?? []).map(normaliseEffect),
        spliced: Boolean(pick(raw, "spliced")),
        recipe: normaliseRecipe(pick(raw, "recipe")),
        builtIn: true,
    };
}

/**
 * A splice's price, or null for every ordinary card.
 *
 * Read-only here on purpose: the studio shows what a recipe is and which cards feed it,
 * and does not let anybody author one. A recipe decides what the simulation offers and
 * which cards leave a hand, so it is in `CardPool.Hash` - a card carrying one that the
 * game did not ship would be refused at the join rather than played, which is a worse
 * outcome than not being able to write one.
 */
function normaliseRecipe(raw) {
    if (!raw || typeof raw !== "object") return null;

    const terms = (pick(raw, "terms") ?? []).map((term) => ({
        keyword: String(pick(term, "keyword") ?? ""),
        count: Number(pick(term, "count") ?? 0),
    }));

    if (terms.length === 0) return null;

    return {
        floor: String(pick(raw, "floor") ?? "Common"),
        cost: Number(pick(raw, "cost") ?? terms.reduce((n, t) => n + t.count, 0)),
        terms,
    };
}

/**
 * The stat's default as a number.
 *
 * The generator writes a ratio object - num, den, raw, decimal - because a decimal alone
 * cannot be turned back into the exact Fix64. Reading it with Number() gave NaN, which
 * fixedFormat printed as "0", so every compare line in the editor read "0 -> 0" and
 * nothing threw. The bare "value" field is deliberately not a fallback: in the current
 * shape it is the StatId ordinal, which would produce a wrong number that looks right.
 */
function defaultOf(raw) {
    const d = pick(raw, "default", "defaultValue");

    if (d && typeof d === "object") {
        if (typeof d.num === "number" && typeof d.den === "number" && d.den !== 0) return d.num / d.den;
        if (typeof d.decimal === "number") return d.decimal;
        return 0;
    }

    const n = Number(d);
    return Number.isFinite(n) ? n : 0;
}

function normaliseStat(raw, index) {
    const id = String(pick(raw, "id", "stat", "name") ?? "");
    const higher = pick(raw, "higherIsBetter", "higherBetter", "better", "direction");

    return {
        id,
        index,
        label: String(pick(raw, "label") || titled(id)),
        meaning: String(pick(raw, "meaning", "blurb", "description", "summary") ?? ""),
        default: defaultOf(raw),
        unit: String(pick(raw, "unit", "units") ?? ""),
        operations: (pick(raw, "operations", "ops") ?? OPS).slice(),
        // "higher is worse" has to survive being written three different ways, because
        // getting it backwards colours a buff red and a nerf green.
        higherIsBetter: typeof higher === "string"
            ? /higher|better|up|good/i.test(higher)
            : higher !== false,
    };
}

/** Names in the data that this build has never heard of, appended so nothing disappears. */
function extend(known, seen) {
    const list = known.slice();
    for (const name of seen) if (name && !list.includes(name)) list.push(name);
    return list;
}

/**
 * Reshapes describe.json's card list into the id -> held -> text map the self test reads.
 *
 * The generator emits `cards[]` as a list of `{id, name, renders[{held, lines[], fontSize}]}`,
 * which is the right shape for a file a person might read; the self test wants to look a
 * card up by id and a depth by number. Passing the list straight through was the shape this
 * page first shipped with, and it did not fail loudly - `truth["12"]` on an array is simply
 * the thirteenth element, so every comparison ran against a neighbouring card's fields and
 * the footer reported ninety-three disagreements out of ninety-three checks.
 *
 * The self test caught it on the live page within a minute of the data landing, which is
 * exactly what it is for. The adapter is the part that was missing.
 *
 * Lines are joined with newlines because that is what `describe` returns and what
 * `countLines` splits on.
 */
function truthFromDescribe(raw) {
    if (!raw || !Array.isArray(raw.cards)) return null;

    const byId = {};

    for (const entry of raw.cards) {
        if (entry?.id === undefined || !Array.isArray(entry.renders)) continue;

        const byHeld = {};
        for (const render of entry.renders) {
            if (!Array.isArray(render?.lines)) continue;
            byHeld[String(render.held)] = render.lines.join("\n");
        }

        byId[String(entry.id)] = byHeld;
    }

    return byId;
}

/**
 * Reshapes announcer.json into the shape the announcer view reads.
 *
 * The generator's own shape is already close to right - it exists for a person to read -
 * so this mostly passes groups through and normalises the one thing a form needs that a
 * report does not: a plain array of spoken *text*, since `submit/announcer` and the
 * client-side checks both want strings, not `{index, text, clipKey, hasClip}` records.
 */
function normaliseAnnouncer(raw) {
    if (!raw || !Array.isArray(raw.groups)) return null;

    return {
        placeholders: raw.placeholders || {},
        groups: raw.groups.map((group) => ({
            name: group.name,
            trigger: group.trigger || "",
            priority: group.priority ?? 0,
            intensity: group.intensity ?? 0,
            minChattiness: group.minChattiness || "",
            category: group.category || "",
            shown: Array.isArray(group.shown) ? group.shown.slice() : [],
            spoken: Array.isArray(group.spoken)
                ? group.spoken.map((entry) => entry.text).filter(Boolean)
                : [],
        })),
    };
}

export async function loadStudioData() {
    const problems = [];

    const [cardsRaw, statsRaw, describeRaw, announcerRaw] = await Promise.all([
        load("data/cards.json"),
        load("data/stats.json").catch((error) => { problems.push(error.message); return null; }),
        load("data/describe.json").catch((error) => { problems.push(error.message); return null; }),
        load("data/announcer.json").catch((error) => { problems.push(error.message); return null; }),
    ]);

    const cards = asArray(cardsRaw, "cards").map(normaliseCard);
    const stats = asArray(statsRaw, "stats").map(normaliseStat);

    const statById = new Map(stats.map((stat) => [stat.id, stat]));
    const cardById = new Map(cards.map((card) => [card.id, card]));

    const panel = { ...PANEL };
    for (const key of Object.keys(PANEL)) {
        const value = pick(describeRaw ?? {}, key);
        if (typeof value === "number") panel[key] = value;
    }

    // The enum orderings a card's id is hashed from. stats.json is read in order and is the
    // authority for the list most likely to grow; the rest come from the built-in copies,
    // extended with anything the cards actually use.
    const ordinals = {
        rarities: extend(RARITIES, cards.map((card) => card.rarity)),
        keywords: extend(KEYWORDS, cards.flatMap((card) => card.keywords)),
        triggers: extend(TRIGGERS, cards.flatMap((c) => c.effects.map((e) => e.trigger))),
        actions: extend(ACTIONS, cards.flatMap((c) => c.effects.map((e) => e.action))),
        ops: extend(OPS, cards.flatMap((c) => c.effects.map((e) => e.op))),
        stats: stats.length
            ? extend(stats.map((stat) => stat.id), STATS)
            : extend(STATS, cards.flatMap((c) => c.effects.map((e) => e.stat))),
    };

    // Vocabularies the editor offers. None is a keyword the enum carries and not one an
    // author may pick, so it is dropped here rather than filtered at every menu.
    const vocabulary = {
        rarities: ordinals.rarities,
        keywords: ordinals.keywords.filter((name) => name !== "None"),
        triggers: ordinals.triggers,
        actions: ordinals.actions,
        ops: ordinals.ops,
        stats: ordinals.stats,
        sets: [...new Set(cards.map((card) => card.set).filter(Boolean))].sort(),
    };

    return {
        cards,
        stats,
        statById,
        cardById,
        panel,
        ordinals,
        vocabulary,
        announcer: normaliseAnnouncer(announcerRaw),
        // Ground truth: the lines the game itself printed for each built-in card, keyed by
        // id and then by how many copies were held. selftest.js checks the port against it.
        truth: truthFromDescribe(describeRaw),
        problems,
    };
}
