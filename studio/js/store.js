/*
 * Work in progress, kept where a refresh cannot take it.
 *
 * Every access is wrapped, because localStorage does not merely return nothing when it is
 * unavailable - it throws outright in a private window with site data blocked, and an
 * uncaught throw here would take the whole editor down over a saved draft.
 *
 * This is the only place anything an author writes is stored. There is no server, so
 * nothing here leaves the browser it was typed in.
 */

const KEY = "shoosting.studio.v1";

export function read() {
    try {
        const text = localStorage.getItem(KEY);
        return text ? JSON.parse(text) : null;
    } catch {
        return null;
    }
}

export function write(state) {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
        return true;
    } catch {
        return false;
    }
}

export function clear() {
    try {
        localStorage.removeItem(KEY);
    } catch {
        // Nothing to do and nothing worth saying: the draft was never on disk to begin with.
    }
}
