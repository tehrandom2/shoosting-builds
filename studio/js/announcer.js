/*
 * The announcer view: every group `data/announcer.json` carries, and a form to propose a
 * line for one of them.
 *
 * The rules checked here are deliberately a subset of `Tools/discord-bot/validation.py` -
 * the placeholder-in-spoken check, the length ceiling, and the house rule as a *reminder*,
 * not the bot's blocklist. The service runs the real validator before anything is written
 * anywhere; this exists so a person finds out about a stray `{2}` before they submit, not
 * after a 422 tells them, and the house-rule text is a norm to write by, not a filter this
 * page enforces - `validation.py`'s own comment says the same about its own blocklist.
 */

const PLACEHOLDER = /\{(\d+)\}/g;
const MAX_LENGTH = 70;

const $ = (selector, root = document) => root.querySelector(selector);

/** The same problems `check_submission` would flag before ever reaching the service. */
export function checkLine(shown, spoken) {
    const problems = [];
    const trimmedShown = (shown || "").trim();
    const trimmedSpoken = (spoken || "").trim();

    if (!trimmedShown) problems.push("the on-screen line is empty.");

    if (trimmedShown.length > MAX_LENGTH) {
        problems.push(`on screen: ${trimmedShown.length} characters, and the house limit `
            + `is about ${MAX_LENGTH}. A line that outlasts the moment is worse than no line.`);
    }
    if (trimmedSpoken.length > MAX_LENGTH) {
        problems.push(`spoken: ${trimmedSpoken.length} characters, past the same limit.`);
    }

    if (trimmedSpoken) {
        const match = trimmedSpoken.match(PLACEHOLDER);
        if (match) {
            problems.push(`spoken: carries ${match[0]}. There is no clip for a placeholder, `
                + "so the line would be silently silent - write the spoken version without "
                + "names or numbers.");
        }
    }

    return problems;
}

function placeholdersUsed(text) {
    const found = new Set();
    for (const match of (text || "").matchAll(PLACEHOLDER)) found.add(match[1]);
    return found;
}

/**
 * Fills an already-placed `<section>` with the announcer view.
 *
 * A fill rather than a build-and-append: sign-in resolves after `service.health()` and
 * `service.me()` answer, both async, so this is called again once that settles - `app.js`
 * owns the section's identity (id, hidden-toggling in setView) and calls back in here
 * whenever `session` changes, which is simpler than reaching into a half-built form to
 * patch one button's label.
 */
export function renderAnnouncerView(section, data, session, submitAnnouncer, onSubmitted) {
    section.textContent = "";

    if (!data.announcer) {
        const note = document.createElement("p");
        note.className = "notice__detail";
        note.textContent = "data/announcer.json did not load, so there is nothing to show here.";
        section.append(note);
        return;
    }

    section.innerHTML = `
      <p class="hint announcer__intro">
        Every group the announcer can say something for, and what it already says. Pick one
        and propose a line - the vote and the merge happen in Discord exactly as they do for
        a line proposed there; this is the same door with a form instead of a slash command.
      </p>
      <div class="announcer__layout">
        <div class="announcer__groups" id="announcerGroups"></div>
        <div class="announcer__form-host" id="announcerFormHost"></div>
      </div>`;

    const groupsHost = $("#announcerGroups", section);
    const formHost = $("#announcerFormHost", section);

    let selected = data.announcer.groups[0] || null;

    const renderGroups = () => {
        groupsHost.textContent = "";
        for (const group of data.announcer.groups) {
            groupsHost.append(groupCard(group, group === selected, () => {
                selected = group;
                renderGroups();
                renderForm();
            }));
        }
    };

    const renderForm = () => {
        formHost.textContent = "";
        if (selected) {
            formHost.append(announcerForm(selected, data, session, submitAnnouncer, onSubmitted));
        }
    };

    renderGroups();
    renderForm();
}

function groupCard(group, isOpen, onOpen) {
    const node = document.createElement("article");
    node.className = "announcer-group" + (isOpen ? " is-open" : "");

    node.innerHTML = `
      <button class="announcer-group__head" type="button">
        <span class="announcer-group__name"></span>
        <span class="announcer-group__meta"></span>
      </button>
      <p class="announcer-group__trigger"></p>
      <p class="announcer-group__gate"></p>
      <ul class="announcer-group__shown"></ul>
      <p class="announcer-group__spoken-label"></p>
      <ul class="announcer-group__spoken"></ul>`;

    $(".announcer-group__name", node).textContent = group.name;
    $(".announcer-group__meta", node).textContent =
        `priority ${group.priority} · intensity ${group.intensity} · ${group.category}`;
    $(".announcer-group__trigger", node).textContent = group.trigger;
    $(".announcer-group__gate", node).textContent =
        `Fires at "${group.minChattiness}" chattiness or noisier. `
        + `${group.shown.length} shown line${group.shown.length === 1 ? "" : "s"}, `
        + `${group.spoken.length} spoken.`;

    const shownList = $(".announcer-group__shown", node);
    for (const line of group.shown) {
        const item = document.createElement("li");
        item.textContent = line;
        shownList.append(item);
    }

    const spokenLabel = $(".announcer-group__spoken-label", node);
    const spokenList = $(".announcer-group__spoken", node);
    if (group.spoken.length) {
        spokenLabel.textContent = "Spoken:";
        for (const line of group.spoken) {
            const item = document.createElement("li");
            item.textContent = line;
            spokenList.append(item);
        }
    } else {
        spokenLabel.textContent = "Nothing spoken yet for this group.";
    }

    $(".announcer-group__head", node).addEventListener("click", onOpen);
    return node;
}

function announcerForm(group, data, session, submitAnnouncer, onSubmitted) {
    const wrap = document.createElement("form");
    wrap.className = "announcer-form";
    wrap.innerHTML = `
      <h3>Propose a line for <span></span></h3>
      <p class="hint">
        <strong>{0}</strong> is the subject, <strong>{1}</strong> the other party where the
        group has one, <strong>{2}</strong> a number where it carries one. A spoken line
        never uses any of them - there is no clip for a placeholder, so it plays back
        exactly as typed.
      </p>
      <label class="field field--wide"><span>Shown, on screen</span>
        <input id="a-shown" maxlength="140" autocomplete="off"></label>
      <label class="field field--wide"><span>Spoken (optional, no placeholders)</span>
        <input id="a-spoken" maxlength="140" autocomplete="off"></label>
      <label class="field field--wide"><span>Note to the reviewer (optional)</span>
        <textarea id="a-note" maxlength="500" rows="2"></textarea></label>
      <p class="house-rule">
        <strong>The house rule:</strong> punch down at the situation, never at the player.
        The line is read out for whoever triggers the beat - it has to work for anyone.
      </p>
      <div class="announcer-form__problems" id="a-problems"></div>
      <div class="actions">
        <button class="button button--primary" type="submit" id="a-submit">Propose it</button>
      </div>
      <p class="hint" id="a-result"></p>`;

    wrap.querySelector("h3 span").textContent = group.name;

    const shownInput = $("#a-shown", wrap);
    const spokenInput = $("#a-spoken", wrap);
    const noteInput = $("#a-note", wrap);
    const problemsHost = $("#a-problems", wrap);
    const resultHost = $("#a-result", wrap);
    const submitButton = $("#a-submit", wrap);

    const supplied = new Set();
    for (const line of group.shown) for (const m of placeholdersUsed(line)) supplied.add(m);

    const renderProblems = () => {
        const problems = checkLine(shownInput.value, spokenInput.value);
        problemsHost.textContent = "";
        if (!problems.length) return true;

        const list = document.createElement("ul");
        for (const problem of problems) {
            const item = document.createElement("li");
            item.textContent = problem;
            list.append(item);
        }
        problemsHost.append(list);
        return false;
    };

    for (const input of [shownInput, spokenInput]) {
        input.addEventListener("input", () => {
            resultHost.textContent = "";
            renderProblems();
        });
    }

    submitButton.textContent = session === false ? "Download the file" : "Propose it";

    wrap.addEventListener("submit", async (event) => {
        event.preventDefault();
        resultHost.textContent = "";
        if (!renderProblems()) return;

        const document_ = {
            version: 1,
            group: group.name,
            shown: shownInput.value.trim(),
            spoken: spokenInput.value.trim(),
            note: noteInput.value.trim(),
        };

        if (session === false) {
            downloadAnnouncerLine(document_);
            resultHost.textContent = "The submission service is unreachable, so this was "
                + "downloaded as a file instead of sent. Paste its contents wherever the "
                + "line is meant to land.";
            return;
        }

        if (!session) {
            resultHost.textContent = "Sign in with Discord first - the button is in the "
                + "top corner - then come back and propose this again.";
            return;
        }

        submitButton.disabled = true;
        submitButton.textContent = "Sending...";
        try {
            const result = await submitAnnouncer(document_);
            resultHost.innerHTML = `Sent. <a href="${result.pr}" target="_blank" `
                + `rel="noopener">PR #${result.number}</a> now carries it, for the vote.`;
            shownInput.value = "";
            spokenInput.value = "";
            noteInput.value = "";
            if (onSubmitted) onSubmitted(result);
        } catch (error) {
            resultHost.textContent = announcerErrorMessage(error);
        } finally {
            submitButton.disabled = false;
            submitButton.textContent = "Propose it";
        }
    });

    return wrap;
}

function announcerErrorMessage(error) {
    if (error.status === 401) {
        return "Signed out, or the session expired. Sign in again and resubmit.";
    }
    if (error.status === 422 && error.problems) {
        return "The service refused it: " + error.problems.join(" ");
    }
    return error.message || "Something went wrong sending this.";
}

function downloadAnnouncerLine(document_) {
    const blob = new Blob([JSON.stringify(document_, null, 1) + "\n"], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `announcer-${document_.group}.json`;
    link.click();
    URL.revokeObjectURL(url);
}
