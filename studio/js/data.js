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
        builtIn: true,
    };
}

function normaliseStat(raw, index) {
    const id = String(pick(raw, "id", "stat", "name") ?? "");
    const higher = pick(raw, "higherIsBetter", "higherBetter", "better", "direction");

    return {
        id,
        index,
        label: String(pick(raw, "label") || titled(id)),
        meaning: String(pick(raw, "meaning", "description", "summary") ?? ""),
        default: Number(pick(raw, "default", "defaultValue", "value") ?? 0),
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

export async function loadStudioData() {
    const problems = [];

    const [cardsRaw, statsRaw, describeRaw] = await Promise.all([
        load("data/cards.json"),
        load("data/stats.json").catch((error) => { problems.push(error.message); return null; }),
        load("data/describe.json").catch((error) => { problems.push(error.message); return null; }),
    ]);

    const cards = asArray(cardsRaw, "cards").map(normaliseCard);
    const stats = asArray(statsRaw, "stats").map(normaliseStat);

    const statById = new Map(stats.map((stat) => [stat.id, stat]));

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
        panel,
        ordinals,
        vocabulary,
        // Ground truth: the lines the game itself printed for each built-in card, keyed by
        // id and then by how many copies were held. selftest.js checks the port against it.
        truth: describeRaw?.cards ?? null,
        problems,
    };
}
