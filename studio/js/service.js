/*
 * The one place this site names the submission service.
 *
 * Everything here is a client of Tools/studio-service/API.md, which is being built in
 * parallel and may not be up - so nothing here assumes success. `health()` is the one
 * call the rest of the app is allowed to treat as "is this worth trying at all", and it
 * never throws: a dead service is a reason to go read-only, not a reason to break the
 * page that reads `data/cards.json` from a completely different, always-static, origin.
 *
 * The URL is a single constant so a local service under test needs one query parameter
 * and not a source edit - `?service=http://localhost:8080` overrides the default, which
 * is the deployed one.
 */

const DEFAULT_SERVICE_URL = "https://studio.advancedstudios.net";

function readOverride() {
    try {
        return new URLSearchParams(location.search).get("service");
    } catch {
        return null;
    }
}

export const SERVICE_URL = (readOverride() || DEFAULT_SERVICE_URL).replace(/\/$/, "");

/**
 * Thrown by every call below. `status` is the HTTP status, or 0 for "never got an
 * answer". `problems` is the per-field list a 422 carries, and is null otherwise - a
 * caller checks `error.problems` rather than parsing the message to tell the two apart.
 */
export class ServiceError extends Error {
    constructor(message, status, problems) {
        super(message);
        this.name = "ServiceError";
        this.status = status;
        this.problems = problems || null;
    }
}

async function call(path, options = {}) {
    let response;
    try {
        response = await fetch(SERVICE_URL + path, {
            credentials: "include",
            headers: options.body ? { "Content-Type": "application/json" } : undefined,
            ...options,
        });
    } catch {
        // A network failure and a CORS refusal look identical from here, and both mean
        // the same thing to the caller: nothing answered.
        throw new ServiceError("could not reach the submission service", 0);
    }

    if (response.status === 204) return null;

    let body = null;
    try {
        body = await response.json();
    } catch {
        // A body-less error response is still an error; a body-less success (204 is
        // handled above) is unusual but not fatal - callers that need a value will
        // find it missing and say so themselves.
    }

    if (!response.ok) {
        const message = (body && body.error) || `the service answered ${response.status}`;
        throw new ServiceError(message, response.status, (body && body.problems) || null);
    }

    return body;
}

/**
 * Whether the service is reachable at all.
 *
 * Never throws. Per the contract, "if GET /health fails, the site works read-only" - so
 * this is a boolean question, not a fallible one, and every caller treats it that way.
 */
export async function health() {
    try {
        await call("/health");
        return true;
    } catch {
        return false;
    }
}

/**
 * The signed-in session, or null.
 *
 * Only meaningful after `health()` has answered true - calling it against a dead service
 * just spends a timeout finding out what `health()` already knows.
 */
export async function me() {
    try {
        return await call("/me");
    } catch (error) {
        if (error instanceof ServiceError && error.status === 401) return null;
        throw error;
    }
}

/** Where the "Sign in with Discord" button points, carrying the page to come back to. */
export function loginUrl(returnPath) {
    return `${SERVICE_URL}/auth/login?` + new URLSearchParams({ return: returnPath });
}

export async function logout() {
    await call("/auth/logout", { method: "POST" });
}

/** `POST /submit/card` - a new custom card. `document` is `{version, cards, note}`. */
export async function submitCard(document) {
    return call("/submit/card", { method: "POST", body: JSON.stringify(document) });
}

/** `POST /submit/mod` - a change to a built-in. `document` is `{version, baseId, card, note}`. */
export async function submitMod(document) {
    return call("/submit/mod", { method: "POST", body: JSON.stringify(document) });
}

/** `POST /submit/announcer` - one line. `document` is `{group, shown, spoken, note}`. */
export async function submitAnnouncer(document) {
    return call("/submit/announcer", { method: "POST", body: JSON.stringify(document) });
}

/** The signed-in author's open PRs, oldest call semantics: nothing is cached here. */
export async function mySubmissions() {
    const body = await call("/submissions?mine=1");
    return Array.isArray(body) ? body : [];
}
