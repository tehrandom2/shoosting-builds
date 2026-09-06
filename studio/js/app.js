/*
 * The studio: browse every card in the game, write one of your own, and watch the pick
 * screen redraw as you type.
 *
 * Two views over one piece of state. The library is the landing view on purpose - the
 * complaint that started this app was that the in-game editor makes you begin a draft
 * before it will show you anything, so nothing here should need a draft to be useful.
 */

import { loadStudioData } from "./data.js";
import { runSelfTest, worstBuiltIn } from "./selftest.js";
import { renderPanel } from "./panel.js";
import { describe, validate, writeFile, toDocument, mint, effectValue, LIMITS, FILE_VERSION } from "./card.js";
import { ratioFromDecimal, reduce, ratioToNumber, fixedFormat } from "./fixed.js";
import { domainOf, inkCss, titled, DOMAINS } from "./vocab.js";
import { diffCard, hasChanges } from "./diff.js";
import { renderAnnouncerView } from "./announcer.js";
import * as store from "./store.js";
import * as service from "./service.js";

/** Where the browser preview lives, relative to this page - see `runInPreview` below. */
const PREVIEW_URL = "../preview/index.html";

/** The note field on both submission kinds. Kept in one place so the limit agrees everywhere. */
const MAX_NOTE_LENGTH = 500;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
    data: null,
    view: "library",
    filters: { text: "", sets: new Set(), rarities: new Set(), keyword: "", domain: "" },
    drafts: [],
    selected: 0,
    held: 1,
    // null = not checked yet, true/false once `health()` has answered.
    serviceUp: null,
    // null = signed out or not checked; an object once `/me` answers.
    session: null,
    submissions: [],
};

// ------------------------------------------------------------------------------ drafts

/**
 * What the editor opens on.
 *
 * A real card rather than an empty form, and deliberately one with a cost as well as a
 * benefit: the first thing anybody sees here should be a whole card being drawn, and the
 * first thing they learn about this game's cards is that the good ones charge you something.
 */
function blankCard() {
    return {
        // "new" writes a fresh Custom card; "mod" suggests a change to a built-in and
        // remembers which one in baseId. The two are separate entry points on purpose -
        // see suggestChange below - and this is what the drafts list reads to label each.
        kind: "new",
        baseId: null,
        note: "",
        name: "Nitro",
        description: "Bullets fly much faster. They also hit softer.",
        rarity: "Common",
        set: "Custom",
        code: "Nt",
        minPlayers: 2,
        keywords: ["Projectile", "Drawback"],
        effects: [
            {
                trigger: "Passive", action: "StatMod", stat: "BulletSpeed", op: "Multiply",
                value: { numerator: 7, denominator: 5 },
                value2: { numerator: 0, denominator: 1 },
            },
            {
                trigger: "Passive", action: "StatMod", stat: "Damage", op: "Multiply",
                value: { numerator: 17, denominator: 20 },
                value2: { numerator: 0, denominator: 1 },
            },
        ],
    };
}

function cloneEffects(effects) {
    return (effects || []).map((effect) => ({
        trigger: effect.trigger,
        action: effect.action,
        stat: effect.stat,
        op: effect.op,
        value: { ...effect.value },
        value2: { ...effect.value2 },
    }));
}

/**
 * Opens the editor on a change to a built-in card, rather than a new one.
 *
 * The distinct entry point from "Start a new card from this" is the point: this keeps the
 * card's own id and set, tracks baseId so the diff panel and the submit route both know
 * what it is a change to, and never gets offered "Custom" as a set - it is still whichever
 * built-in set the card belongs to, because the submission is a mod of that card, not a
 * new one that merely resembles it.
 */
function suggestChange(card) {
    state.drafts.push({
        kind: "mod",
        baseId: card.id,
        note: "",
        name: card.name,
        description: card.description,
        rarity: card.rarity,
        set: card.set,
        code: card.code,
        minPlayers: card.minPlayers,
        keywords: card.keywords.slice(),
        effects: cloneEffects(card.effects),
    });

    state.selected = state.drafts.length - 1;
    save();
    setView("editor");
    location.hash = "#make";
}

function newEffect() {
    return {
        trigger: "Passive",
        action: "StatMod",
        stat: "Damage",
        op: "Multiply",
        value: { numerator: 5, denominator: 4 },
        value2: { numerator: 0, denominator: 1 },
    };
}

function current() {
    return state.drafts[state.selected];
}

/** The built-in a "mod" draft is a change to, or undefined for a "new" draft. */
function baseCardFor(card) {
    if (card.kind !== "mod" || card.baseId == null) return undefined;
    return state.data.cardById.get(card.baseId);
}

function save() {
    store.write({ drafts: state.drafts, selected: state.selected });
}

// ------------------------------------------------------------------------------- boot

async function boot() {
    const root = $("#studio");

    let data;
    try {
        data = await loadStudioData();
    } catch (error) {
        root.textContent = "";
        root.append(dataMissing(error));
        return;
    }

    root.textContent = "";
    state.data = data;

    const test = runSelfTest(data);
    const restored = store.read();

    // A draft saved before "suggest a change" existed has none of kind/baseId/note - it is
    // always a "new" draft, since that was the only kind the editor could make then.
    state.drafts = Array.isArray(restored?.drafts) && restored.drafts.length
        ? restored.drafts.map((card) => ({
            kind: "new", baseId: null, note: "", ...card,
        }))
        : [blankCard()];
    state.selected = Math.min(restored?.selected ?? 0, state.drafts.length - 1);

    buildChrome(root);
    buildLibrary(root);
    buildEditor(root);
    buildAnnouncer(root);
    buildFooter(root, test);

    setView(location.hash === "#make" ? "editor" : "library");
    renderLibrary();
    renderEditor();

    // A card is a thing people will want to point each other at, and the alternative to a
    // link is "search for Sniper and click the third one". Also on hashchange, because a
    // link pasted into a tab that is already open changes nothing else.
    openAsked();
    addEventListener("hashchange", openAsked);

    checkService();
}

/**
 * Whether the service answers at all, then who (if anybody) is signed in.
 *
 * Per the API contract this is the only unsolicited call the page makes on load - `/me` is
 * "only called when a cookie might exist", which in a static page with no server-rendered
 * hint means "after health() says the service exists at all". Both failures are read-only,
 * not fatal: a dead service degrades the submit buttons to downloads, and a live service
 * with nobody signed in just shows the sign-in button.
 */
async function checkService() {
    state.serviceUp = await service.health();
    if (state.serviceUp) {
        try {
            state.session = await service.me();
        } catch {
            state.session = null;
        }
    }
    renderAccount();
    renderEditor();
    renderAnnouncer();
    if (state.session) refreshSubmissions();
}

async function refreshSubmissions() {
    if (!state.session) return;
    try {
        state.submissions = await service.mySubmissions();
    } catch {
        // A failed refresh leaves the last known list up rather than blanking it - the
        // submissions themselves are unaffected by this call failing.
    }
    renderSubmissions();
}

function openAsked() {
    const asked = /^#card=(\d+)$/.exec(location.hash);
    if (!asked) return;

    const card = state.data.cards.find((entry) => String(entry.id) === asked[1]);
    if (card && !$("#sheet").open) openSheet(card);
}

function dataMissing(error) {
    const node = document.createElement("section");
    node.className = "notice notice--bad";
    node.innerHTML = `
        <h2>The card data has not been published yet.</h2>
        <p>This page reads <code>data/cards.json</code>, which is generated from the game's
        own card library. Until that file is deployed there is nothing truthful to show, so
        it shows nothing.</p>
        <p class="notice__detail"></p>`;
    $(".notice__detail", node).textContent = String(error.message || error);
    return node;
}

// ------------------------------------------------------------------------------ chrome

function buildChrome(root) {
    const header = document.createElement("header");
    header.className = "nav";
    header.innerHTML = `
      <div class="nav__inner">
        <a class="nav__brand" href="../">
          <span class="nav__mark">&#9646;&#9654;</span>
          <span class="nav__name">shoosting</span>
          <span class="nav__tag">/ studio</span>
        </a>
        <nav class="tabs" aria-label="Studio sections">
          <button class="tab" type="button" data-view="library">Cards</button>
          <button class="tab" type="button" data-view="editor">Make a card</button>
          <button class="tab" type="button" data-view="announcer">Voice lines</button>
          <span class="tab tab--soon" aria-disabled="true">Levels<em>soon</em></span>
        </nav>
        <div class="account" id="account"></div>
        <button class="theme" type="button" id="theme" aria-label="Colour theme"></button>
      </div>`;

    $$(".tab[data-view]", header).forEach((tab) => {
        tab.addEventListener("click", () => setView(tab.dataset.view));
    });

    $("#theme", header).addEventListener("click", cycleTheme);
    root.append(header);

    const hero = document.createElement("section");
    hero.className = "hero";
    hero.innerHTML = `
      <p class="hero__eyebrow">every card in the game &middot; and a place to write your own</p>
      <h1 class="hero__title">Card&nbsp;Studio</h1>
      <p class="hero__sub">Browse what the arena already deals out, then build a card and
      watch the pick screen draw it as you type &mdash; the same lines, the same six-line
      budget, the same font it shrinks to.</p>
      <p class="deal">
        <strong>The deal.</strong> A draft stays in this browser until you export it,
        download it, or submit it. Submitting sends it to the studio service, which opens a
        pull request credited to your Discord handle for the vote &mdash; mh may put it in
        the game, changed or unchanged, with no promise either way. Sign-in is required only
        to submit; browsing and drafting need nothing from you.
      </p>`;
    root.append(hero);

    applyTheme(readTheme());
}

const THEMES = ["auto", "light", "dark"];

function readTheme() {
    try {
        return THEMES.includes(localStorage.getItem("shoosting.studio.theme"))
            ? localStorage.getItem("shoosting.studio.theme")
            : "auto";
    } catch {
        return "auto";
    }
}

function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "auto" ? "" : theme;
    if (theme === "auto") delete document.documentElement.dataset.theme;

    const button = $("#theme");
    if (button) {
        button.textContent = theme === "auto" ? "auto" : theme;
        button.title = `Colour theme: ${theme}. Click to change.`;
    }
}

function cycleTheme() {
    const next = THEMES[(THEMES.indexOf(readTheme()) + 1) % THEMES.length];
    try {
        localStorage.setItem("shoosting.studio.theme", next);
    } catch {
        // A theme that cannot be remembered still applies for this visit.
    }
    applyTheme(next);
}

function setView(view) {
    state.view = view;
    $$(".tab[data-view]").forEach((tab) => {
        tab.classList.toggle("is-on", tab.dataset.view === view);
        tab.setAttribute("aria-pressed", String(tab.dataset.view === view));
    });
    $("#library").hidden = view !== "library";
    $("#editor").hidden = view !== "editor";
    $("#announcer").hidden = view !== "announcer";
    if (view === "editor") renderEditor();
}

// ----------------------------------------------------------------------------- account

/**
 * Discord sign-in and sign-out.
 *
 * Three states, and the account slot in the header shows exactly one of them: still
 * checking (nothing, briefly), the service is unreachable (a plain note - the button
 * would only fail), or a sign-in link / handle-and-sign-out pair. `loginUrl` is handed the
 * current path so the callback returns here rather than to the service's own origin.
 */
function renderAccount() {
    const host = $("#account");
    if (!host) return;
    host.textContent = "";

    if (state.serviceUp === false) {
        const note = document.createElement("span");
        note.className = "account__note";
        note.textContent = "submissions offline";
        note.title = "The studio service did not answer, so signing in and submitting "
            + "are unavailable. Browsing and drafting still work.";
        host.append(note);
        return;
    }

    if (state.serviceUp === null) return;

    if (state.session) {
        const handle = document.createElement("span");
        handle.className = "account__handle";
        handle.textContent = state.session.handle;

        const signOut = document.createElement("button");
        signOut.type = "button";
        signOut.className = "button account__signout";
        signOut.textContent = "Sign out";
        signOut.addEventListener("click", async () => {
            signOut.disabled = true;
            try {
                await service.logout();
            } catch {
                // Clearing local state regardless: a sign-out that failed server-side
                // still means this page should stop offering to submit as that person.
            }
            state.session = null;
            state.submissions = [];
            renderAccount();
            renderEditor();
            renderAnnouncer();
        });

        host.append(handle, signOut);
    } else {
        const link = document.createElement("a");
        link.className = "button button--primary account__signin";
        link.href = service.loginUrl(location.pathname + location.search + location.hash);
        link.textContent = "Sign in with Discord";
        host.append(link);
    }
}

// ----------------------------------------------------------------------------- library

function buildLibrary(root) {
    const section = document.createElement("section");
    section.id = "library";
    section.className = "panel-section";
    section.innerHTML = `
      <div class="filters">
        <input id="search" class="search" type="search" placeholder="Search cards, effects, keywords"
               autocomplete="off" aria-label="Search cards">
        <div class="filters__row">
          <span class="filters__label" id="setsLabel">Set</span>
          <div class="chips" id="setChips" role="group" aria-labelledby="setsLabel"></div>
          <span class="filters__label" id="rarityLabel">Rarity</span>
          <div class="chips" id="rarityChips" role="group" aria-labelledby="rarityLabel"></div>
          <label class="select">
            <span>Keyword</span>
            <select id="keywordFilter"></select>
          </label>
          <label class="select">
            <span>Reads as</span>
            <select id="domainFilter"></select>
          </label>
        </div>
      </div>
      <p class="count" id="count" aria-live="polite"></p>
      <div class="grid" id="grid"></div>
      <dialog class="sheet" id="sheet"></dialog>`;
    root.append(section);

    const data = state.data;

    fillChips($("#setChips", section), data.vocabulary.sets, state.filters.sets);
    fillChips($("#rarityChips", section), data.vocabulary.rarities, state.filters.rarities);

    fillSelect($("#keywordFilter", section), ["", ...data.vocabulary.keywords],
        (value) => value || "any");
    fillSelect($("#domainFilter", section), ["", ...DOMAINS], (value) => value || "anything");

    $("#search", section).addEventListener("input", (event) => {
        state.filters.text = event.target.value.trim().toLowerCase();
        renderLibrary();
    });
    $("#keywordFilter", section).addEventListener("change", (event) => {
        state.filters.keyword = event.target.value;
        renderLibrary();
    });
    $("#domainFilter", section).addEventListener("change", (event) => {
        state.filters.domain = event.target.value;
        renderLibrary();
    });
}

function fillChips(host, values, selected) {
    for (const value of values) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = value;
        chip.setAttribute("aria-pressed", "false");
        chip.addEventListener("click", () => {
            if (selected.has(value)) selected.delete(value);
            else selected.add(value);
            chip.classList.toggle("is-on", selected.has(value));
            chip.setAttribute("aria-pressed", String(selected.has(value)));
            renderLibrary();
        });
        host.append(chip);
    }
}

function fillSelect(select, values, label = (v) => v) {
    select.textContent = "";
    for (const value of values) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label(value);
        select.append(option);
    }
}

function matches(card) {
    const { text, sets, rarities, keyword, domain } = state.filters;

    if (sets.size && !sets.has(card.set)) return false;
    if (rarities.size && !rarities.has(card.rarity)) return false;
    if (keyword && !card.keywords.includes(keyword)) return false;
    if (domain && domainOf(card) !== domain) return false;

    if (!text) return true;

    const haystack = [
        card.name, card.description, card.set, card.code, card.keywords.join(" "),
        describe(card, 1),
    ].join(" ").toLowerCase();

    return haystack.includes(text);
}

function renderLibrary() {
    const grid = $("#grid");
    const shown = state.data.cards.filter(matches);

    grid.textContent = "";
    for (const card of shown) grid.append(cardSheet(card));

    $("#count").textContent = shown.length === state.data.cards.length
        ? `${shown.length} cards`
        : `${shown.length} of ${state.data.cards.length} cards`;

    if (!shown.length) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "Nothing matches those filters.";
        grid.append(empty);
    }
}

function cardSheet(card) {
    const domain = domainOf(card);

    const node = document.createElement("article");
    node.className = "sheet-card";
    node.style.setProperty("--ink", inkCss(domain));
    node.tabIndex = 0;
    node.setAttribute("role", "button");
    node.setAttribute("aria-label", `${card.name}. ${card.description}`);

    node.innerHTML = `
      <div class="sheet-card__slab"><span></span></div>
      <div class="sheet-card__body">
        <h3 class="sheet-card__name"></h3>
        <p class="sheet-card__desc"></p>
        <ul class="sheet-card__effects"></ul>
        <p class="sheet-card__tags"></p>
      </div>`;

    $(".sheet-card__slab span", node).textContent = card.code;
    $(".sheet-card__name", node).textContent = card.name;
    $(".sheet-card__desc", node).textContent = card.description;

    const effects = $(".sheet-card__effects", node);
    for (const line of describe(card, 1).split("\n")) {
        if (!line) continue;
        const item = document.createElement("li");
        item.textContent = line;
        effects.append(item);
    }

    const tags = [card.set, card.rarity.toLowerCase(), ...card.keywords.map((k) => k.toLowerCase())];
    if (card.minPlayers > 2) tags.push(`${card.minPlayers}+ players`);
    $(".sheet-card__tags", node).textContent = tags.join("  ·  ");

    const open = () => openSheet(card);
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); }
    });

    return node;
}

function neighboursFor(card) {
    // Two other cards to sit either side, chosen by position rather than at random so the
    // panel does not reshuffle itself on every keystroke.
    const pool = state.data.cards;
    if (pool.length < 3) return [];

    const at = Math.max(0, pool.indexOf(card));
    return [pool[(at + 7) % pool.length], pool[(at + 23) % pool.length]];
}

function openSheet(card) {
    const dialog = $("#sheet");
    dialog.textContent = "";

    if (location.hash !== `#card=${card.id}`) {
        history.replaceState(null, "", `#card=${card.id}`);
    }

    const wrap = document.createElement("div");
    wrap.className = "sheet__inner";
    wrap.innerHTML = `
      <button class="sheet__close" type="button" aria-label="Close">&times;</button>
      <h2 class="sheet__name"></h2>
      <p class="sheet__meta"></p>
      <div class="panel-host" id="sheetPanel"></div>
      <div class="sheet__stack">
        <label for="sheetHeld">Holding</label>
        <input type="range" id="sheetHeld" min="1" max="8" value="1">
        <output id="sheetHeldOut">1</output>
      </div>
      <div class="sheet__actions">
        <button class="button button--primary" type="button" id="sheetCopy">
          Start a new card from this
        </button>
        ${card.builtIn ? `<button class="button" type="button" id="sheetSuggest">
          Suggest a change
        </button>` : ""}
      </div>
      <p class="sheet__note">Copying makes a new card with its own id. The original is
      untouched &mdash; a card's id is a hash of what it does, so a changed card is a
      different card by construction. Suggesting a change edits <em>this</em> card in
      place and tracks it as a mod, with a before/after diff of what you changed.</p>`;

    $(".sheet__name", wrap).textContent = card.name;
    $(".sheet__meta", wrap).textContent =
        [card.set, card.rarity, card.code, ...card.keywords].join("  ·  ");

    dialog.append(wrap);

    const draw = (held) => {
        renderPanel($("#sheetPanel", wrap), card, {
            held,
            neighbours: neighboursFor(card),
            panel: state.data.panel,
            footer: "hold to take",
        });
    };

    draw(1);

    $("#sheetHeld", wrap).addEventListener("input", (event) => {
        $("#sheetHeldOut", wrap).textContent = event.target.value;
        draw(Number(event.target.value));
    });

    $(".sheet__close", wrap).addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
        if (location.hash.startsWith("#card=")) history.replaceState(null, "", "#");
    }, { once: true });
    $("#sheetCopy", wrap).addEventListener("click", () => {
        dialog.close();
        startFrom(card);
    });

    if (card.builtIn) {
        $("#sheetSuggest", wrap).addEventListener("click", () => {
            dialog.close();
            suggestChange(card);
        });
    }

    dialog.showModal();
}

/**
 * Copy on edit, the same rule the in-game editor follows: this makes a new card that
 * starts life as a copy, and leaves the original alone.
 */
function startFrom(card) {
    state.drafts.push({
        kind: "new",
        baseId: null,
        note: "",
        name: card.name.slice(0, LIMITS.maxNameLength),
        description: card.description.slice(0, LIMITS.maxDescriptionLength),
        rarity: card.rarity,
        set: "Custom",
        code: card.code,
        minPlayers: card.minPlayers,
        keywords: card.keywords.slice(),
        effects: cloneEffects(card.effects),
    });

    state.selected = state.drafts.length - 1;
    save();
    setView("editor");
    location.hash = "#make";
}

// ------------------------------------------------------------------------------ editor

/**
 * What the two numbers on a non-stat effect mean, per action. The simulation reads them
 * positionally, so without this an author is typing into a box called "value 2".
 */
const ACTION_VALUES = {
    Heal: ["amount"],
    ReloadNow: [],
    RefreshBlock: [],
    PushNearby: ["force", "radius"],
    PullNearby: ["force", "radius"],
    DamageNearby: ["damage", "radius"],
    SlowNearby: ["strength (0-1)", "radius"],
    SpawnRing: ["bullets", "speed"],
    Blink: ["distance"],
    SlowTarget: ["strength (0-1)", "seconds"],
    StunTarget: ["seconds"],
    PoisonTarget: ["damage per second", "seconds"],
    HasteSelf: ["multiplier", "seconds"],
    ShieldSelf: ["amount", "seconds"],
    CostHealth: ["amount"],
};

function buildEditor(root) {
    const section = document.createElement("section");
    section.id = "editor";
    section.className = "panel-section editor";
    section.innerHTML = `
      <div class="editor__preview">
        <div class="preview">
          <div class="preview__bar">
            <h2 id="previewTitle">As it will be dealt</h2>
            <div class="preview__stack">
              <label for="held">Holding</label>
              <input type="range" id="held" min="1" max="8" value="1">
              <output id="heldOut">1</output>
            </div>
          </div>
          <div class="panel-host" id="panel"></div>
          <div class="budget" id="budget"></div>
          <div class="problems" id="problems"></div>
          <div class="diff" id="diff" hidden></div>
        </div>
      </div>

      <div class="editor__form">
        <div class="drafts" id="drafts"></div>
        <p class="hint editor__kind" id="editorKind"></p>

        <fieldset class="field-set">
          <legend>The card</legend>
          <div class="fields">
            <label class="field field--wide"><span>Name</span>
              <input id="f-name" maxlength="24" autocomplete="off"></label>
            <label class="field"><span>Code</span>
              <input id="f-code" maxlength="2" autocomplete="off"></label>
            <label class="field field--wide"><span>Description</span>
              <input id="f-description" maxlength="96" autocomplete="off"></label>
            <label class="field"><span>Set</span>
              <input id="f-set" maxlength="16" autocomplete="off"></label>
            <label class="field"><span>Rarity</span>
              <select id="f-rarity"></select></label>
            <label class="field"><span>Smallest lobby</span>
              <select id="f-minPlayers"></select></label>
          </div>
          <p class="hint">The two-letter code is what the tile shows and what a hand is read
          by. The description is flavour: it is the one field left out of the card's id, so
          fixing a typo in it never repoints a card somebody is holding.</p>
        </fieldset>

        <fieldset class="field-set">
          <legend>What it is about</legend>
          <div class="chips" id="f-keywords"></div>
          <p class="hint">The first keyword you pick is the primary, and the primary is what
          colours the tile. Click a chosen one again to drop it; use <em>make primary</em> to
          move it to the front.</p>
        </fieldset>

        <fieldset class="field-set">
          <legend>What it does</legend>
          <div id="f-effects"></div>
          <button class="button" type="button" id="addEffect">Add an effect</button>
        </fieldset>

        <fieldset class="field-set">
          <legend>Note to the reviewer</legend>
          <label class="field field--wide"><span>Optional, under ${MAX_NOTE_LENGTH} characters</span>
            <textarea id="f-note" maxlength="${MAX_NOTE_LENGTH}" rows="3"
              placeholder="Why this change, or what this card is for."></textarea></label>
        </fieldset>

        <fieldset class="field-set">
          <legend>Take it away</legend>
          <div class="actions">
            <button class="button" type="button" id="runIt">Run it</button>
            <button class="button button--primary" type="button" id="download">
              Download customcards.json
            </button>
            <button class="button" type="button" id="copy">Copy the JSON</button>
            <button class="button button--primary" type="button" id="submit"></button>
          </div>
          <p class="hint" id="exportNote"></p>
        </fieldset>

        <div class="submissions" id="submissions" hidden></div>
      </div>`;

    root.append(section);

    fillSelect($("#f-rarity", section), state.data.vocabulary.rarities);
    fillSelect($("#f-minPlayers", section),
        Array.from({ length: LIMITS.maxPlayers - 1 }, (_, i) => String(i + 2)));

    const bind = (id, field, transform = (v) => v) => {
        $(id, section).addEventListener("input", (event) => {
            current()[field] = transform(event.target.value);
            save();
            renderEditor({ keepFocus: true });
        });
    };

    bind("#f-name", "name");
    bind("#f-code", "code");
    bind("#f-description", "description");
    bind("#f-set", "set");
    bind("#f-rarity", "rarity");
    bind("#f-minPlayers", "minPlayers", Number);

    $("#f-note", section).addEventListener("input", (event) => {
        current().note = event.target.value;
        save();
    });

    $("#held", section).addEventListener("input", (event) => {
        state.held = Number(event.target.value);
        $("#heldOut", section).textContent = event.target.value;
        renderPreview();
    });

    $("#addEffect", section).addEventListener("click", () => {
        current().effects.push(newEffect());
        save();
        renderEditor();
    });

    $("#download", section).addEventListener("click", download);
    $("#copy", section).addEventListener("click", copyJson);
    $("#submit", section).addEventListener("click", submit);
    $("#runIt", section).addEventListener("click", runInPreview);
}

function renderEditor(options = {}) {
    // Nothing to draw into while the library is up, and the panel measures itself against
    // its host's width - which is zero on a hidden section. setView redraws on the way in.
    if (!state.data || $("#editor")?.hidden) return;

    const card = current();

    const setValue = (id, value) => {
        const node = $(id);
        if (node && node.value !== String(value)) node.value = value;
    };

    setValue("#f-name", card.name);
    setValue("#f-code", card.code);
    setValue("#f-description", card.description);
    setValue("#f-set", card.set);
    setValue("#f-rarity", card.rarity);
    setValue("#f-minPlayers", card.minPlayers);
    setValue("#f-note", card.note || "");

    const base = baseCardFor(card);
    const kindNote = $("#editorKind");
    if (card.kind === "mod") {
        kindNote.textContent = base
            ? `Suggesting a change to ${base.name} (#${base.id}, ${base.set}). `
              + "This submits as a mod, not a new card - the id stays the built-in's."
            : `This was a suggested change to card #${card.baseId}, which is no longer in `
              + "the library - it may have been renamed or removed since. Submitting will "
              + "fail; start a new card instead.";
    } else {
        kindNote.textContent = "";
    }

    $("#previewTitle").textContent = card.kind === "mod" ? "As it will be, changed" : "As it will be dealt";

    renderSubmitButton();
    renderDrafts();
    renderKeywords();
    if (!options.keepFocus || !$("#f-effects").children.length) renderEffects();
    renderPreview();
    renderSubmissions();
}

function renderDrafts() {
    const host = $("#drafts");
    host.textContent = "";

    state.drafts.forEach((card, index) => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip chip--draft" + (index === state.selected ? " is-on" : "")
            + (card.kind === "mod" ? " is-mod" : "");
        chip.textContent = card.name || "untitled";

        const kind = document.createElement("small");
        kind.className = "chip__kind";
        kind.textContent = card.kind === "mod"
            ? `mod of ${baseCardFor(card)?.name ?? `#${card.baseId}`}`
            : "new card";
        chip.append(kind);

        chip.addEventListener("click", () => {
            state.selected = index;
            save();
            renderEditor();
        });
        host.append(chip);
    });

    const add = document.createElement("button");
    add.type = "button";
    add.className = "chip chip--ghost";
    add.textContent = "+ new card";
    add.addEventListener("click", () => {
        state.drafts.push(blankCard());
        state.selected = state.drafts.length - 1;
        save();
        renderEditor();
    });
    host.append(add);

    if (state.drafts.length > 1) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "chip chip--ghost";
        remove.textContent = "delete this one";
        remove.addEventListener("click", () => {
            state.drafts.splice(state.selected, 1);
            state.selected = Math.max(0, state.selected - 1);
            save();
            renderEditor();
        });
        host.append(remove);
    }
}

function renderKeywords() {
    const host = $("#f-keywords");
    const card = current();
    host.textContent = "";

    for (const keyword of state.data.vocabulary.keywords) {
        const at = card.keywords.indexOf(keyword);
        const chosen = at >= 0;

        const wrap = document.createElement("span");
        wrap.className = "chip-pair";

        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip" + (chosen ? " is-on" : "") + (at === 0 ? " is-primary" : "");
        chip.textContent = keyword;
        chip.setAttribute("aria-pressed", String(chosen));
        chip.addEventListener("click", () => {
            if (chosen) card.keywords.splice(at, 1);
            else card.keywords.push(keyword);
            save();
            renderEditor();
        });
        wrap.append(chip);

        if (chosen && at > 0) {
            const promote = document.createElement("button");
            promote.type = "button";
            promote.className = "chip chip--ghost chip--tiny";
            promote.textContent = "make primary";
            promote.addEventListener("click", () => {
                card.keywords.splice(at, 1);
                card.keywords.unshift(keyword);
                save();
                renderEditor();
            });
            wrap.append(promote);
        }

        host.append(wrap);
    }
}

function renderEffects() {
    const host = $("#f-effects");
    const card = current();
    host.textContent = "";

    card.effects.forEach((effect, index) => host.append(effectRow(effect, index, card)));
}

function effectRow(effect, index, card) {
    const row = document.createElement("div");
    row.className = "effect";

    const head = document.createElement("div");
    head.className = "effect__head";
    head.innerHTML = `<span class="effect__num">${index + 1}</span>`;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "chip chip--ghost chip--tiny";
    remove.textContent = "remove";
    remove.addEventListener("click", () => {
        card.effects.splice(index, 1);
        save();
        renderEditor();
    });
    head.append(remove);
    row.append(head);

    const grid = document.createElement("div");
    grid.className = "effect__grid";
    row.append(grid);

    grid.append(selectField("When", state.data.vocabulary.triggers, effect.trigger,
        (value) => { effect.trigger = value; commit(); }));

    grid.append(selectField("Does", state.data.vocabulary.actions, effect.action,
        (value) => { effect.action = value; commit(); }, titled));

    if (effect.action === "StatMod") {
        grid.append(selectField("To", state.data.vocabulary.stats, effect.stat,
            (value) => { effect.stat = value; commit(); },
            (id) => state.data.statById.get(id)?.label || titled(id)));

        grid.append(selectField("How", state.data.vocabulary.ops, effect.op,
            (value) => { effect.op = value; commit(); }, opLabel));

        const compare = document.createElement("p");
        compare.className = "compare";

        grid.append(valueField(effect, 1, statValueLabel(effect),
            () => showComparison(compare, effect)));

        showComparison(compare, effect);
        row.append(compare);
    } else {
        const names = ACTION_VALUES[effect.action];
        if (!names) {
            grid.append(valueField(effect, 1, "value"));
            grid.append(valueField(effect, 2, "second value"));
        } else {
            names.forEach((name, i) => grid.append(valueField(effect, i + 1, name)));
            if (!names.length) grid.append(note("This one takes no numbers."));
        }
    }

    return row;

    function commit() {
        save();
        renderEditor();
    }
}

function opLabel(op) {
    if (op === "Multiply") return "multiply by";
    if (op === "Add") return "add";
    return "set to";
}

function statValueLabel(effect) {
    if (effect.op === "Multiply") return "change, in percent";
    if (effect.op === "Add") return "amount to add";
    return "value to set";
}

function note(text) {
    const node = document.createElement("p");
    node.className = "hint hint--inline";
    node.textContent = text;
    return node;
}

function selectField(label, values, chosen, onChange, format = (v) => v) {
    const field = document.createElement("label");
    field.className = "field";
    field.innerHTML = `<span>${label}</span>`;

    const select = document.createElement("select");
    fillSelect(select, values, format);
    select.value = chosen;
    select.addEventListener("change", (event) => onChange(event.target.value));

    field.append(select);
    return field;
}

/**
 * A plain number field over an exact ratio.
 *
 * The author sees a number and never sees the pair. The pair is what is kept: a decimal is
 * turned back into the fraction it literally is - "1.35" is 135/100, which reduces to 27/20
 * - so nothing ever passes through a float on its way to becoming a card. Multiplicative
 * effects are typed as a percentage instead, because "+35%" is a sentence and "1.35" is a
 * calculation.
 */
function valueField(effect, which, label, after) {
    const pair = which === 2 ? effect.value2 : effect.value;
    const percent = which === 1 && effect.action === "StatMod" && effect.op === "Multiply";

    const field = document.createElement("label");
    field.className = "field";
    field.innerHTML = `<span>${label}</span>`;

    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.autocomplete = "off";

    const shown = percent
        ? fixedFormat((ratioToNumber(pair.numerator, pair.denominator) - 1) * 100, 4)
        : fixedFormat(ratioToNumber(pair.numerator, pair.denominator), 6);

    input.value = shown;

    const exact = document.createElement("small");
    exact.className = "field__exact";

    const showExact = () => {
        exact.textContent = pair.denominator === 1
            ? `stored exactly as ${pair.numerator}`
            : `stored exactly as ${pair.numerator}/${pair.denominator}`;
    };
    showExact();

    input.addEventListener("input", () => {
        const typed = percent
            ? ratioFromDecimal(String(Number(input.value) / 100 + 1))
            : ratioFromDecimal(input.value);

        if (!typed) {
            exact.textContent = "that is not a number the game can store";
            exact.classList.add("is-bad");
            return;
        }

        exact.classList.remove("is-bad");

        const tidy = reduce(typed.numerator, typed.denominator);
        pair.numerator = tidy.numerator;
        pair.denominator = tidy.denominator;

        showExact();
        if (after) after();
        save();
        renderPreview();
    });

    field.append(input, exact);
    return field;
}

/**
 * What the number actually does, in the units a player thinks in.
 *
 * "multiply reload time by 0.65" is a fact about the data model; "reload 1.10s to 0.72s,
 * 35% faster" is a fact about the game. The direction flag decides the colour, because the
 * same 35% is a buff on damage and a nerf on reload time.
 */
function showComparison(node, effect) {
    const stat = state.data.statById.get(effect.stat);

    node.className = "compare";
    node.textContent = "";

    if (!stat) {
        node.textContent = "stats.json says nothing about this stat, so there is no "
            + "default to compare against.";
        return;
    }

    const before = stat.default;
    const each = effectValue(effect, 1);

    let after = before;
    if (effect.op === "Multiply") after = before * each;
    else if (effect.op === "Add") after = before + each;
    else after = each;

    const unit = stat.unit === "multiplier" || !stat.unit ? "" : " " + stat.unit;
    const change = before === 0 ? null : (after - before) / Math.abs(before);
    const better = change === null ? null : (change > 0) === stat.higherIsBetter;

    node.classList.add(change === null || change === 0
        ? "compare--flat"
        : better ? "compare--good" : "compare--bad");

    const move = change === null || change === 0
        ? "no change"
        : `${fixedFormat(Math.abs(change) * 100, 1)}% ${change > 0 ? "more" : "less"}`;

    node.textContent = `${stat.label}  ${fixedFormat(before, 3)}${unit}`
        + `  →  ${fixedFormat(after, 3)}${unit}   (${move}`
        + `${better === null ? "" : better ? ", better for you" : ", worse for you"})`;

    if (stat.meaning) node.title = stat.meaning;
}

// ---------------------------------------------------------------------------- announcer

function buildAnnouncer(root) {
    const section = document.createElement("section");
    section.id = "announcer";
    section.className = "panel-section announcer";
    root.append(section);
    renderAnnouncer();
}

/**
 * `false` means the service is unreachable (offline, download instead); `null`/`undefined`
 * means it is up but nobody is signed in; an object is the signed-in session. Matches what
 * `announcer.js`'s form already branches on for the card submit buttons.
 */
function announcerSessionArg() {
    return state.serviceUp === false ? false : state.session;
}

function renderAnnouncer() {
    const section = $("#announcer");
    if (!section || !state.data) return;
    renderAnnouncerView(section, state.data, announcerSessionArg(), service.submitAnnouncer,
        refreshSubmissions);
}

// ----------------------------------------------------------------------------- preview

function renderPreview() {
    const host = $("#panel");
    if (!host) return;

    const card = current();
    const result = renderPanel(host, card, {
        held: state.held,
        neighbours: neighboursFor(card),
        panel: state.data.panel,
        title: "pick a card",
        footer: "hold to take",
    });

    renderBudget(result);
    renderProblems();
    renderDiff();
}

/**
 * The before/after table for a "suggest a change" draft, next to the preview it changes.
 *
 * Hidden entirely for a "new" draft - there is no base to diff against, and an empty diff
 * panel next to every card would read as a feature nobody explained.
 */
function renderDiff() {
    const host = $("#diff");
    const card = current();

    if (card.kind !== "mod") {
        host.hidden = true;
        return;
    }

    const base = baseCardFor(card);
    host.hidden = false;
    host.textContent = "";

    if (!base) {
        const note = document.createElement("p");
        note.className = "diff__empty";
        note.textContent = `Card #${card.baseId} is not in the current library, so there `
            + "is nothing to compare against.";
        host.append(note);
        return;
    }

    const rows = diffCard(base, card);

    if (!rows.length) {
        const note = document.createElement("p");
        note.className = "diff__empty";
        note.textContent = "Nothing changed yet. Edit a field and the difference from "
            + `${base.name} as it ships today shows up here.`;
        host.append(note);
        return;
    }

    const table = document.createElement("table");
    table.className = "diff__table";
    table.innerHTML = "<caption>Changed from the shipped card</caption>";

    for (const row of rows) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<th></th><td class="diff__before"></td><td class="diff__after"></td>`;
        tr.children[0].textContent = row.label;
        tr.children[1].textContent = row.before;
        tr.children[2].textContent = row.after;
        table.append(tr);
    }

    host.append(table);
}

function renderBudget({ lines, size, overflowing }) {
    const budget = $("#budget");
    const { maxLines, fullSizeLines, fontSize } = state.data.panel;
    const worst = worstBuiltIn(state.data, state.held);

    budget.textContent = "";
    budget.className = "budget";

    const meter = document.createElement("div");
    meter.className = "budget__meter";
    for (let i = 1; i <= maxLines; ++i) {
        const pip = document.createElement("span");
        pip.className = "budget__pip"
            + (i <= lines ? " is-used" : "")
            + (i > fullSizeLines ? " is-shrunk" : "");
        meter.append(pip);
    }
    budget.append(meter);

    const words = document.createElement("p");
    words.className = "budget__words";

    if (overflowing.length) {
        budget.classList.add("is-over");
        words.textContent =
            `${lines} lines. The panel fits ${maxLines}, and the font stopped shrinking at `
            + `${size}px. The last ${overflowing.length} `
            + `${overflowing.length === 1 ? "line is" : "lines are"} drawn straight through `
            + `the footer and the announcer line beneath it, not cut off:`;

        const list = document.createElement("ul");
        list.className = "budget__cut";
        for (const line of overflowing) {
            const item = document.createElement("li");
            item.textContent = line;
            list.append(item);
        }
        budget.append(words, list);
        return;
    }

    if (lines > fullSizeLines) {
        words.textContent =
            `${lines} lines, so the game shrinks the text from ${fontSize}px to ${size}px to `
            + `keep it clear of the footer. ${worst.card ? worst.card.name : "The worst built-in card"}`
            + ` is the deepest one shipped, at ${worst.lines}.`;
    } else {
        words.textContent = lines === 0
            ? "No effects yet, so the panel prints nothing under the description."
            : `${lines} of ${maxLines} lines, drawn at full size.`;
    }

    budget.append(words);
}

function renderProblems() {
    const host = $("#problems");
    const card = current();
    const problems = validate(card, state.data.panel);

    host.textContent = "";
    host.classList.toggle("is-clear", !problems.length);

    if (!problems.length) {
        const ok = document.createElement("p");
        // A mod keeps the built-in's id - minting a new one here would describe a card
        // that submitting will never actually produce.
        ok.textContent = card.kind === "mod"
            ? `Ready. This keeps id #${card.baseId} - a mod changes what the card does, `
              + "never which card it is."
            : `Ready. This card's id is ${mint(card, state.data.ordinals)} - a hash of what `
              + "it does, so nobody else's card can collide with it.";
        host.append(ok);
        return;
    }

    const list = document.createElement("ul");
    for (const problem of problems) {
        const item = document.createElement("li");
        item.textContent = problem;
        list.append(item);
    }
    host.append(list);
}

// ------------------------------------------------------------------------------ export

function exportable() {
    return state.drafts.filter((card) => !validate(card, state.data.panel).length);
}

function exportText() {
    const cards = exportable().map((card) => ({
        ...card,
        id: mint(card, state.data.ordinals),
    }));
    return writeFile(cards, state.data.ordinals);
}

function noteExport(message) {
    $("#exportNote").textContent = message;
}

function download() {
    const cards = exportable();
    if (!cards.length) {
        noteExport("Nothing to export yet - fix the problems listed beside the preview first.");
        return;
    }

    const blob = new Blob([exportText()], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "customcards.json";
    link.click();
    URL.revokeObjectURL(url);

    noteExport(`Exported ${cards.length} card${cards.length === 1 ? "" : "s"}. `
        + "Drop customcards.json next to the game and it will be read on the next launch. "
        + "Custom cards play in offline matches: online, every peer rebuilds the pool from "
        + "the host's card sets, so a card only you have would fail the handshake.");
}

async function copyJson() {
    if (!exportable().length) {
        noteExport("Nothing to copy yet - fix the problems listed beside the preview first.");
        return;
    }

    try {
        await navigator.clipboard.writeText(exportText());
        noteExport("Copied. That is the exact contents of customcards.json.");
    } catch {
        noteExport("This browser would not let the page reach the clipboard. "
            + "Use the download button instead.");
    }
}

/**
 * What the current draft submits as: a new custom card, or a change to the built-in it
 * tracks. Both use `toDocument`, the shape `CustomCardFile.Parse` actually reads.
 */
function cardDocument(card) {
    return {
        version: FILE_VERSION,
        cards: [toDocument(card, state.data.ordinals)],
        note: card.note || "",
    };
}

function modDocument(card, base) {
    const document_ = toDocument(card, state.data.ordinals);
    document_.id = base.id;
    return {
        version: FILE_VERSION,
        baseId: base.id,
        card: document_,
        note: card.note || "",
    };
}

function downloadDocument(document_, filename) {
    const blob = new Blob([JSON.stringify(document_, null, 1) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function renderSubmitButton() {
    const button = $("#submit");
    if (!button) return;
    const card = current();

    if (state.serviceUp === false) {
        button.disabled = false;
        button.textContent = "Download the file";
        return;
    }

    if (state.serviceUp === null) {
        button.disabled = true;
        button.textContent = "Checking the submission service...";
        return;
    }

    button.disabled = false;
    button.textContent = state.session
        ? (card.kind === "mod" ? "Submit this change" : "Submit as a new card")
        : "Sign in to submit";
}

/**
 * Everything wrong with submitting *this* draft, beyond the panel's own `validate` - the
 * things specific to being a mod: no base to diff against, or nothing actually changed.
 * `validate`'s own problems are still checked first by the caller, since a card that does
 * not fit the panel is not fit to submit either way.
 */
function submitProblems(card) {
    if (card.kind !== "mod") return [];

    const base = baseCardFor(card);
    if (!base) {
        return [`card #${card.baseId} is not in the current library, so there is nothing `
            + "to suggest a change to"];
    }
    if (!hasChanges(base, card)) {
        return ["nothing has changed from the shipped card yet"];
    }
    return [];
}

function submitErrorMessage(error) {
    if (error.status === 401) {
        state.session = null;
        renderAccount();
        return "Signed out, or the session expired. Sign in again and submit again - "
            + "nothing was lost.";
    }
    if (error.status === 422 && error.problems) {
        return "The service refused it: " + error.problems.join(" ");
    }
    return error.message || "Something went wrong sending this. Nothing was sent twice.";
}

/**
 * Sends the current draft to the studio service, or - when that is not possible - hands
 * the same document back as a download.
 *
 * The same validation runs whichever way this ends: a card that does not fit the panel or
 * a mod that changed nothing is refused here, before a network call, because "the service
 * said no" is a worse way to learn that than the diff panel already showing it.
 */
async function submit() {
    const card = current();
    const button = $("#submit");

    const problems = [...validate(card, state.data.panel), ...submitProblems(card)];
    if (problems.length) {
        noteExport("Nothing was sent - " + problems.join("; ") + ".");
        return;
    }

    const base = baseCardFor(card);
    const document_ = card.kind === "mod" ? modDocument(card, base) : cardDocument(card);

    if (state.serviceUp === false) {
        downloadDocument(document_, card.kind === "mod"
            ? `mod-${card.baseId}.json` : "card-submission.json");
        noteExport("The submission service is unreachable, so this was downloaded instead "
            + "of sent - it is the exact document the service would have received.");
        return;
    }

    if (!state.session) {
        noteExport("Sign in with Discord first - the button is in the top corner - then "
            + "submit again. Nothing was sent.");
        return;
    }

    button.disabled = true;
    button.textContent = "Sending...";

    try {
        const result = card.kind === "mod"
            ? await service.submitMod(document_)
            : await service.submitCard(document_);

        noteExportLink(`Sent. Pull request #${result.number} is open for the vote:`, result.pr);
        await refreshSubmissions();
    } catch (error) {
        noteExport(submitErrorMessage(error));
    } finally {
        renderSubmitButton();
    }
}

// -------------------------------------------------------------------------- submissions

function renderSubmissions() {
    const host = $("#submissions");
    if (!host) return;

    host.textContent = "";

    if (!state.session || !state.submissions.length) {
        host.hidden = true;
        return;
    }

    host.hidden = false;

    const heading = document.createElement("h3");
    heading.textContent = "Your submissions";
    host.append(heading);

    const list = document.createElement("ul");
    for (const item of state.submissions) {
        const li = document.createElement("li");

        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = `#${item.number} ${item.title}`;

        const meta = document.createElement("span");
        meta.className = "submissions__meta";
        meta.textContent = `${item.kind} · ${item.state}`;

        li.append(link, document.createTextNode(" "), meta);
        list.append(li);
    }
    host.append(list);
}

/**
 * Opens the browser preview with the current draft, in an iframe over this page.
 *
 * An iframe rather than a new tab because that is what the bridge actually reads:
 * `Assets/Plugins/WebGL/PreviewBridge.jslib` checks `window.shoostingPreviewPayload` on
 * its own window, then falls back to its *parent* frame's - never `window.opener`. Setting
 * the payload here, on this window, before the iframe loads is therefore the whole
 * handshake; a new tab would have no parent to read from and would need a protocol this
 * bridge does not speak.
 */
function runInPreview() {
    const card = current();
    const problems = validate(card, state.data.panel);
    if (problems.length) {
        noteExport("Fix the problems listed beside the preview first - there is nothing "
            + "playable yet.");
        return;
    }

    const cardDoc = toDocument(card, state.data.ordinals);
    const base = baseCardFor(card);
    if (card.kind === "mod" && base) cardDoc.id = base.id;

    window.shoostingPreviewPayload = JSON.stringify({
        version: FILE_VERSION,
        stage: 0,
        bots: 2,
        cards: [cardDoc],
    });

    const dialog = document.createElement("dialog");
    dialog.className = "run-dialog";
    dialog.innerHTML = `
      <div class="run-dialog__inner">
        <button class="sheet__close" type="button" aria-label="Close">&times;</button>
        <iframe class="run-dialog__frame" title="Card preview"></iframe>
      </div>`;

    document.body.append(dialog);
    // Set after the dialog (and therefore the iframe) exists in the document, so the frame
    // does not start loading before window.shoostingPreviewPayload is there for it to read.
    $(".run-dialog__frame", dialog).src = PREVIEW_URL;

    // Cleanup is called from both the close button and the dialog's own "close" event
    // (Escape, or a future change that closes it some other way) rather than relying on
    // either alone - a dialog that closes without deleting the payload would leave the
    // next thing that reads window.shoostingPreviewPayload seeing a stale card.
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        delete window.shoostingPreviewPayload;
        dialog.remove();
    };

    $(".sheet__close", dialog).addEventListener("click", () => { dialog.close(); cleanup(); });
    dialog.addEventListener("close", cleanup, { once: true });

    dialog.showModal();
}

function noteExportLink(message, href) {
    const node = $("#exportNote");
    node.textContent = message + " ";
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = href;
    node.append(link);
}

// ------------------------------------------------------------------------------ footer

function buildFooter(root, test) {
    const footer = document.createElement("footer");
    footer.className = "footer";

    const cards = state.data.cards.length;
    const checked = test.ran
        ? `Its effect lines are checked against the game's own output on load: `
          + `${test.checked} comparisons across ${cards} cards, `
          + `${test.failures.length ? `${test.failures.length} disagreeing` : "all matching"}.`
        : "Ground-truth lines were not published with this data, so the effect-line "
          + "renderer could not be checked against the game on this load.";

    footer.innerHTML = `
      <p>This studio reads the same card library the game ships with and draws the pick
      screen at the size the game draws it. ${checked}</p>
      <p class="footer__meta">
        <a href="../">build archive</a> &middot;
        <a href="${service.SERVICE_URL}" target="_blank" rel="noopener">submission service</a>
      </p>`;

    // A missing companion file is a degraded page rather than a broken one - no stat
    // comparisons, or no ground truth to check against - so it is said out loud instead of
    // being left as a feature that mysteriously is not there.
    if (state.data.problems.length) {
        const missing = document.createElement("p");
        missing.textContent = "Some of the card data did not load, so parts of this page are "
            + `working from less than they should: ${state.data.problems.join("; ")}.`;
        footer.prepend(missing);
        footer.classList.add("footer--warn");
    }

    if (test.failures.length) footer.classList.add("footer--warn");
    root.append(footer);
}

boot();
