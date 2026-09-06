/*
 * The card offer panel, drawn at the size and in the places the game draws it.
 *
 * This is the whole reason the studio exists: mh wants to see the card as it will be
 * in-game as soon as he hits enter, and a stylised approximation of it would be worth
 * nothing for the one question that keeps going wrong - does the text fit.
 *
 * So the geometry is not decorative. Every number below is read off Hud.EnsureOffer and
 * MakeOfferTile in canvas units: a 1180x560 panel, tiles 176x240 with a 44 gap centred at
 * y 186, the name at 318, the description at 370, the effect block at 408 and the footer's
 * top edge at 526. The whole stage is then scaled to whatever room the page has, so the
 * proportions - and therefore the collision - survive.
 *
 * MakeText pins a text rect's pivot to its top, which is why every y here is a top edge
 * rather than a centre. Getting that backwards is what makes a mock-up disagree with the
 * thing it mocks.
 */

import { describe, countLines, effectFontSize, PANEL } from "./card.js";
import { domainOf, inkCss, RARITY_POINTS } from "./vocab.js";

const STAGE = { width: 1180, height: 560 };

const TILE = { width: 176, height: 240, gap: 44, centreY: 186 };

const TEXT = {
    titleY: 34, titleSize: 26,
    nameY: 318, nameSize: 42,
    descriptionY: 370, descriptionSize: 26,
    effectsY: 408,
    footerTop: 526, footerSize: 20,
};

/**
 * Room per line, as a multiple of the font size.
 *
 * Calibrated rather than guessed, and the distinction matters. What is actually *known*
 * about the game is the rule CardOfferPanelTests pins: four lines fit at full size, the
 * font shrinks by 4/lines from there, and six is the last count that clears the footer.
 * The exact metrics of the engine's built-in Arial are not known here and a browser's
 * would not match them anyway, so this is set to the value that makes the picture agree
 * with that rule - six lines at the 14px floor just fitting between the effect block at
 * 408 and the footer at 526, a seventh not.
 *
 * The rule itself is the authority, not this number: which lines are marked as
 * overflowing is decided by the line count, and this only decides where they are drawn.
 */
const LINE_HEIGHT = 1.35;

/** Inserts hair spaces between characters, since legacy Text has no tracking. */
function tracked(text) {
    return (text || "").split("").join(" ");
}

function element(className, text) {
    const node = document.createElement("div");
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function tile(card, picked) {
    const domain = domainOf(card);
    const ink = inkCss(domain);

    const node = element("panel-tile" + (picked ? " is-picked" : ""));
    node.style.setProperty("--ink", ink);
    node.style.width = TILE.width + "px";
    node.style.height = TILE.height + "px";
    node.style.transform = `translate(-50%, -50%) scale(${picked ? 1.045 : 0.97})`;

    const code = element("panel-tile__code", card.code || "??");
    const points = element("panel-tile__points", String(RARITY_POINTS[card.rarity] ?? 1));

    node.append(code, points);
    return node;
}

/**
 * Renders one card as the pick screen will draw it.
 *
 * `neighbours` are the two unpicked tiles either side. They are not decoration: a tile is
 * lit against unlit ones and the row is centred as a group, so a card shown alone would
 * look like a different screen from the one it is going to appear on.
 */
export function renderPanel(host, card, options = {}) {
    const {
        held = 1,
        neighbours = [],
        panel: budget,
        title = "pick a card",
        footer = "hold to take",
    } = options;

    host.textContent = "";

    const stage = element("panel-stage");
    stage.style.width = STAGE.width + "px";
    stage.style.height = STAGE.height + "px";

    const domain = domainOf(card);

    stage.append(place(element("panel-title", tracked(title)), {
        top: TEXT.titleY, size: TEXT.titleSize, className: "panel-title",
    }));

    const row = [...neighbours];
    row.splice(Math.min(1, row.length), 0, card);
    const picked = row.indexOf(card);

    const span = row.length * TILE.width + Math.max(0, row.length - 1) * TILE.gap;
    const left = -span / 2 + TILE.width / 2;

    row.forEach((entry, i) => {
        const node = tile(entry, i === picked);
        node.style.left = `${STAGE.width / 2 + left + i * (TILE.width + TILE.gap)}px`;
        node.style.top = `${TILE.centreY}px`;
        stage.append(node);
    });

    stage.append(place(element("panel-name", card.name || "Untitled"), {
        top: TEXT.nameY, size: TEXT.nameSize,
    }));

    stage.append(place(element("panel-description", card.description || ""), {
        top: TEXT.descriptionY, size: TEXT.descriptionSize,
    }));

    const limits = budget ?? PANEL;
    const text = describe(card, held);
    const lines = countLines(text);
    const size = effectFontSize(lines, limits);
    const step = size * LINE_HEIGHT;

    const effects = element("panel-effects");
    effects.style.color = inkCss(domain, 0.85);

    const overflowing = [];

    text.split("\n").forEach((line, i) => {
        if (!text) return;
        const lineNode = element("panel-effects__line", line);
        lineNode.style.fontSize = size + "px";
        lineNode.style.height = step + "px";

        // The Text component overflows rather than clips, so a line past the budget is not
        // cut off - it is printed straight through the footer and the announcer beneath
        // it. Marked rather than hidden, because the author needs to see exactly which
        // sentence lands on top of another one.
        if (i >= limits.maxLines) {
            lineNode.classList.add("is-overflowing");
            overflowing.push(line);
        }

        effects.append(lineNode);
    });

    stage.append(place(effects, { top: TEXT.effectsY, size }));

    if (overflowing.length) {
        const mark = element("panel-overflow-mark");
        mark.style.top = TEXT.effectsY + limits.maxLines * step + "px";
        stage.append(mark);
    }

    const footerNode = place(element("panel-footer", tracked(footer)), {
        top: TEXT.footerTop, size: TEXT.footerSize,
    });
    footerNode.classList.add("panel-footer");
    stage.append(footerNode);

    host.append(stage);
    fit(host, stage);

    return { lines, size, overflowing };
}

function place(node, { top, size }) {
    node.classList.add("panel-line");
    node.style.top = top + "px";
    if (size) node.style.fontSize = size + "px";
    return node;
}

/** Scales the whole stage into whatever width the page has. */
function fit(host, stage) {
    const apply = () => {
        const available = host.clientWidth;
        if (!available) return;

        const scale = Math.min(1, available / STAGE.width);
        stage.style.transform = `scale(${scale})`;
        host.style.height = STAGE.height * scale + "px";
    };

    apply();

    if (host._panelObserver) host._panelObserver.disconnect();
    host._panelObserver = new ResizeObserver(apply);
    host._panelObserver.observe(host);
}
