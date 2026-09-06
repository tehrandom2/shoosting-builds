/*
 * What a card is, as far as the studio is concerned: the effect lines the game will print
 * for it, the id it will be known by, whether it is fit to reach a match, and the file it
 * is written to.
 *
 * Every function here is a port of one in the game, and each says which. That is the whole
 * point of the app - "see it as it will be in-game" is only true if this file agrees with
 * the C# to the character - so selftest.js checks the describe port against describe.json's
 * ground truth for every built-in card at every stack depth, and any drift shows up there
 * rather than on somebody's pick screen.
 */

import { rawFromRatio, rawToNumber, fixedFormat } from "./fixed.js";
import { spaced, RARITIES, KEYWORDS, TRIGGERS, ACTIONS, OPS, STATS } from "./vocab.js";

// ------------------------------------------------------------------ the panel's budget

/**
 * What the card offer panel fits, straight out of Hud. Four lines at full size; past that
 * the font shrinks by 4/lines until the 14px legibility floor, which six lines lands
 * exactly on. A seventh is drawn through the footer and the announcer line beneath it -
 * the Text component overflows rather than clips, so going over budget is not a truncated
 * line, it is one legible sentence printed on top of another.
 *
 * data/describe.json restates these, and it wins where it is present.
 */
export const PANEL = {
    fullSizeLines: 4,
    maxLines: 6,
    fontSize: 21,
    minFontSize: 14,
    deepestStack: 8,
};

/** Hud's shrink rule. Given a line count, the size the effect block is drawn at. */
export function effectFontSize(lines, panel = PANEL) {
    if (lines <= panel.fullSizeLines) return panel.fontSize;
    return Math.max(
        panel.minFontSize,
        Math.floor((panel.fontSize * panel.fullSizeLines) / lines),
    );
}

export function countLines(text) {
    if (!text) return 0;
    return text.split("\n").length;
}

// ------------------------------------------------------------------ CardMaths.Describe

/** CardMaths.Round: enough precision to be useful, not enough to be noise. */
function round(value) {
    const abs = Math.abs(value);
    if (abs >= 100) return fixedFormat(value, 0);
    if (abs >= 10) return fixedFormat(value, 1);
    return fixedFormat(value, 2);
}

function signed(value) {
    const text = round(value);
    return value > 0 ? "+" + text : text;
}

function prettyTrigger(trigger) {
    const s = spaced(trigger);
    return s.startsWith("on ") ? s : "on " + s;
}

/** The value of an effect as a double, by way of the exact ratio the author wrote. */
export function effectValue(effect, which) {
    const pair = which === 2 ? effect.value2 : effect.value;
    if (!pair) return 0;
    return rawToNumber(rawFromRatio(pair.numerator, pair.denominator));
}

/**
 * The effect lines for one card, holding `held` copies including this one.
 *
 * A port of CardMaths.Describe, deliberately line for line. There is no "holding N of
 * these" footer: it cost two rendered lines and pushed a four-effect card through the
 * panel, and every line already ends in "with N".
 */
export function describe(card, held) {
    const effects = card.effects || [];
    const lines = [];

    for (const effect of effects) {
        if (effect.action !== "StatMod") {
            // A triggered effect does not stack into one number the way a stat does, so
            // the trigger is named and the count is stated rather than multiplied.
            let line = prettyTrigger(effect.trigger) + ": " + spaced(effect.action);
            if (held > 1) line += "  ·  " + held + "x";
            lines.push(line);
            continue;
        }

        let line = spaced(effect.stat) + "  ";
        const each = effectValue(effect, 1);

        if (effect.op === "Multiply") {
            line += signed((each - 1) * 100) + "%";
            if (held > 1) {
                let total = 1;
                for (let i = 0; i < held; ++i) total *= each;
                line += "  each   →   " + signed((total - 1) * 100) + "% with " + held;
            }
        } else if (effect.op === "Add") {
            line += signed(each);
            if (held > 1) {
                line += "  each   →   " + signed(each * held) + " with " + held;
            }
        } else {
            // Set does not accumulate: the last card applied wins, so a second copy
            // changes nothing at all. Worth saying, because it is the one case where
            // taking another is definitely wasted.
            line += "set to " + round(each);
            if (held > 1) line += "   (extra copies do nothing)";
        }

        lines.push(line);
    }

    return lines.join("\n");
}

// ------------------------------------------------------------------ CustomCard.Mint

const MASK64 = (1n << 64n) - 1n;
const PRIME = 1099511628211n;
const OFFSET = 14695981039346656037n;

function mix(hash, value) {
    let v = BigInt.asUintN(64, BigInt(value));
    for (let i = 0n; i < 8n; ++i) {
        hash ^= (v >> (i * 8n)) & 0xffn;
        hash = (hash * PRIME) & MASK64;
    }
    return hash;
}

function mixText(hash, text) {
    const s = text ?? "";
    hash = mix(hash, s.length);
    for (let i = 0; i < s.length; ++i) hash = mix(hash, s.charCodeAt(i));
    return hash;
}

/** Where custom ids start, far above anything the shipped library will reach. */
export const ID_BASE = 1000000;
const ID_SPAN = 2147483647 - ID_BASE;

/**
 * A card's id, computed from the card itself. A port of CustomCard.Compute.
 *
 * There is no registry and deliberately never will be: two people authoring "card 200" in
 * different houses has to stop being possible, and a central allocator is a server nobody
 * wants to run for a game that plays on a LAN. The description is the one field left out,
 * because fixing a typo in flavour text must not repoint a card somebody is holding.
 *
 * `ordinals` maps each enum name to its position, and getting one wrong produces a card the
 * game will not agree with, so it comes from the loaded data where the data supplies it.
 */
export function mint(card, ordinals) {
    const index = (list, name) => {
        const at = ordinals[list].indexOf(name);
        if (at < 0) throw new Error(`${name} is not a known ${list.slice(0, -1)}`);
        return at;
    };

    let hash = OFFSET;

    hash = mixText(hash, card.name);
    hash = mixText(hash, card.code);
    hash = mixText(hash, card.set);
    hash = mix(hash, index("rarities", card.rarity));
    hash = mix(hash, card.minPlayers);

    const keywords = card.keywords || [];
    hash = mix(hash, keywords.length);
    for (const keyword of keywords) hash = mix(hash, index("keywords", keyword));

    const effects = card.effects || [];
    hash = mix(hash, effects.length);
    for (const effect of effects) {
        hash = mix(hash, index("triggers", effect.trigger));
        hash = mix(hash, index("actions", effect.action));
        hash = mix(hash, index("stats", effect.stat));
        hash = mix(hash, index("ops", effect.op));
        hash = mix(hash, rawFromRatio(effect.value.numerator, effect.value.denominator));
        hash = mix(hash, rawFromRatio(effect.value2.numerator, effect.value2.denominator));
    }

    // Folded into a range rather than truncated, so the whole digest reaches the id and
    // two cards do not collide merely because their low bits agree.
    const folded = hash ^ (hash >> 32n);
    return ID_BASE + Number(folded % BigInt(ID_SPAN));
}

/** The enum orderings mint reads, as the studio's own vocabulary lists give them. */
export const BUILT_IN_ORDINALS = {
    rarities: RARITIES,
    keywords: KEYWORDS,
    triggers: TRIGGERS,
    actions: ACTIONS,
    ops: OPS,
    stats: STATS,
};

// ------------------------------------------------------------------ CustomCard.Validate

export const LIMITS = {
    maxNameLength: 24,
    maxDescriptionLength: 96,
    maxSetLength: 16,
    maxPlayers: 4,
};

/**
 * Whether a card is fit to reach a match, and if not, why not in one sentence.
 *
 * A port of CustomCard.Validate, including the line budget - which is *measured* by
 * rendering rather than counted from the effect list, because the budget is in rendered
 * lines and an effect that grew a second one would silently stop being the same question.
 * Checked at the deepest stack a hand can hold, since "+576% with 8" is wider than
 * "+160% each" and a card that fits alone can overflow once somebody is several copies in.
 *
 * The message is written for a person mid-edit, not for a log.
 */
export function validate(card, panel = PANEL) {
    const problems = [];
    const fail = (message) => problems.push(message);

    if (!(card.name || "").trim()) fail("the card has no name");
    else if (card.name.length > LIMITS.maxNameLength) {
        fail(`the name is longer than ${LIMITS.maxNameLength} characters`);
    }

    if ((card.description || "").length > LIMITS.maxDescriptionLength) {
        fail(`the description is longer than ${LIMITS.maxDescriptionLength} characters`);
    }

    if (!card.code || card.code.length !== 2) fail("the code has to be exactly two characters");
    else if (!/^[A-Za-z0-9]{2}$/.test(card.code)) fail("the code has to be letters or digits");

    if (!(card.set || "").trim()) fail("the card belongs to no set");
    else if (card.set.length > LIMITS.maxSetLength) {
        fail(`the set name is longer than ${LIMITS.maxSetLength} characters`);
    }

    if (card.minPlayers < 2 || card.minPlayers > LIMITS.maxPlayers) {
        fail(`the smallest lobby has to be between 2 and ${LIMITS.maxPlayers}`);
    }

    const keywords = card.keywords || [];
    keywords.forEach((keyword, i) => {
        if (keyword === "None") fail("a keyword slot was left empty");
        else if (keywords.indexOf(keyword) < i) fail(`${keyword} is tagged twice`);
    });

    const effects = card.effects || [];
    if (!effects.length) fail("the card does nothing yet");

    effects.forEach((effect, i) => {
        if (effect.value.denominator === 0 || effect.value2.denominator === 0) {
            fail(`effect ${i + 1} divides by zero`);
        }
        if (effect.action === "StatMod" && effect.op === "Multiply"
            && effect.value.numerator === 0) {
            fail(`effect ${i + 1} multiplies a stat by zero, which deletes it outright`);
        }
    });

    const lines = countLines(describe(card, panel.deepestStack));
    if (lines > panel.maxLines) {
        fail(`${lines} lines of effects is more than the pick screen fits `
            + `(the limit is ${panel.maxLines})`);
    }

    return problems;
}

/**
 * A card as `CustomCardFile.Parse` actually reads one - `value`/`value2` as `[n, d]` pairs,
 * because that is the only shape `CustomCardFile.ReadRatio` accepts (a bare `{num, den}`
 * object is not; see `Assets/Game/Cards/CustomCardFile.cs`). This is what the submission
 * routes want inside `card`/`cards`, and what the preview payload wants inside `cards` -
 * one function so a shape the real reader would reject cannot drift in from either.
 */
export function toDocument(card, ordinals) {
    return {
        id: card.id ?? mint(card, ordinals),
        name: card.name,
        description: card.description,
        rarity: card.rarity,
        set: card.set,
        code: card.code,
        minPlayers: card.minPlayers,
        keywords: (card.keywords || []).slice(),
        effects: (card.effects || []).map((effect) => ({
            trigger: effect.trigger,
            action: effect.action,
            stat: effect.stat,
            op: effect.op,
            value: [effect.value.numerator, effect.value.denominator],
            value2: [effect.value2.numerator, effect.value2.denominator],
        })),
    };
}

// ------------------------------------------------------------------ CustomCardFile.Write

function quote(text) {
    let out = '"';
    const s = text ?? "";
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (code < 0x20) out += "\\u" + code.toString(16).padStart(4, "0");
        else out += ch;
    }
    return out + '"';
}

/** The format version CustomCardFile writes. */
export const FILE_VERSION = 1;

/**
 * The document a set of cards lives in, byte for byte as CustomCardFile.Write produces it.
 *
 * Matching the whitespace is not fussiness. This is the file somebody drops next to the
 * game and then opens in a text editor, and a studio export that looked different from an
 * in-game export would read as two formats that happen to both work.
 */
export function writeFile(cards, ordinals) {
    let out = `{\n  "version": ${FILE_VERSION},\n  "cards": [`;

    cards.forEach((card, index) => {
        out += index > 0 ? ",\n" : "\n";
        out += writeCard(card, ordinals);
    });

    if (cards.length) out += "\n";
    return out + "  ]\n}\n";
}

function writeCard(card, ordinals) {
    let out = "    {\n";

    // Written first because it is the card's identity, and a person reading the file
    // should see what a card *is* before what it is called.
    out += `      "id": ${card.id ?? mint(card, ordinals)},\n`;
    out += `      "name": ${quote(card.name)},\n`;
    out += `      "description": ${quote(card.description)},\n`;
    out += `      "rarity": ${quote(card.rarity)},\n`;
    out += `      "set": ${quote(card.set)},\n`;
    out += `      "code": ${quote(card.code)},\n`;
    out += `      "minPlayers": ${card.minPlayers},\n`;

    out += "      \"keywords\": [";
    out += (card.keywords || []).map(quote).join(", ");
    out += "],\n";

    out += "      \"effects\": [";
    (card.effects || []).forEach((effect, i) => {
        out += i > 0 ? ",\n        " : "\n        ";
        out += `{ "trigger": ${quote(effect.trigger)}`;
        out += `, "action": ${quote(effect.action)}`;
        out += `, "stat": ${quote(effect.stat)}`;
        out += `, "op": ${quote(effect.op)}`;
        out += `, "value": [${effect.value.numerator}, ${effect.value.denominator}]`;
        out += `, "value2": [${effect.value2.numerator}, ${effect.value2.denominator}]`;
        out += " }";
    });
    if ((card.effects || []).length) out += "\n      ";
    out += "]\n";

    return out + "    }";
}
