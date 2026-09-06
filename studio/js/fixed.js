/*
 * Fix64, as much of it as authoring a card needs.
 *
 * The game stores every gameplay number as a Q31.32 scaled integer, and the only sanctioned
 * way to write a non-integer one is an exact ratio - a decimal would have to pass through a
 * float, which bakes a platform-dependent rounding into the card. So the studio keeps the
 * numerator and denominator the author meant and never lets a float near them.
 *
 * BigInt throughout, because the conversion is a 64-bit shift and a 64-bit division and
 * doing either in a double loses the low bits that the card's id is hashed from.
 */

const SHIFT = 32n;
const ONE = 1n << SHIFT;

/** Fix64.Ratio: (n << 32) / d, truncating toward zero exactly as C# long division does. */
export function rawFromRatio(numerator, denominator) {
    const d = BigInt(denominator);
    if (d === 0n) return 0n;
    return (BigInt(numerator) << SHIFT) / d;
}

/** Fix64.ToDouble. The double is for display and arithmetic about display, never for a card. */
export function rawToNumber(raw) {
    return Number(raw) / 4294967296;
}

export function ratioToNumber(numerator, denominator) {
    return rawToNumber(rawFromRatio(numerator, denominator));
}

function gcd(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) { const t = a % b; a = b; b = t; }
    return a || 1n;
}

const INT_MAX = 2147483647n;

/**
 * The ratio a typed decimal means, exactly.
 *
 * "1.35" is 135/100 and reduces to 27/20 - which is what the author wrote, recovered by
 * counting digits rather than by measuring a float. Returns null for anything that is not
 * a number, and for anything whose exact ratio will not fit in the two ints the file
 * format carries.
 */
export function ratioFromDecimal(text) {
    const trimmed = String(text ?? "").trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(trimmed)) return null;

    const negative = trimmed.startsWith("-");
    const body = trimmed.replace(/^[+-]/, "");
    const [whole, fraction = ""] = body.split(".");

    const digits = (whole || "0") + fraction;
    let numerator = BigInt(digits || "0");
    let denominator = 10n ** BigInt(fraction.length);

    const divisor = gcd(numerator, denominator);
    numerator /= divisor;
    denominator /= divisor;

    if (numerator > INT_MAX || denominator > INT_MAX) return null;

    return {
        numerator: Number(negative ? -numerator : numerator),
        denominator: Number(denominator),
    };
}

export function reduce(numerator, denominator) {
    let n = BigInt(numerator), d = BigInt(denominator);
    if (d === 0n) return { numerator, denominator };
    if (d < 0n) { n = -n; d = -d; }

    const divisor = gcd(n, d);
    return { numerator: Number(n / divisor), denominator: Number(d / divisor) };
}

const MAX_DENOMINATOR = 1000n;

/**
 * Recovers the simplest ratio that lands on a fixed-point value.
 *
 * A port of CustomCard.Rationalise, and it exists for the same reason: 13/10 becomes a
 * scaled integer whose exact fraction is 1395864371/1073741824, so "start from a built-in
 * card" would otherwise hand the author a pair of numbers nobody can edit. Stern-Brocot
 * finds the ratio a person would have typed.
 *
 * Only reached when the data file gives a card's value as a decimal with no ratio beside
 * it. Where it gives both, the authored pair is used untouched.
 */
export function rationalise(raw) {
    let value = BigInt(raw);
    const negative = value < 0n;
    if (negative) value = -value;

    // Past a few thousand a "ratio" is not something anybody authored.
    if (value > (1n << 44n)) {
        const whole = Number(value / ONE);
        return { numerator: negative ? -whole : whole, denominator: 1 };
    }

    let lowN = 0n, lowD = 1n, highN = 1n, highD = 0n;

    for (let guard = 0; guard < 64; ++guard) {
        const midN = lowN + highN;
        const midD = lowD + highD;

        if (midD > MAX_DENOMINATOR || midN > INT_MAX) break;

        const lhs = midN * ONE;
        const rhs = value * midD;

        if (lhs === rhs) { lowN = midN; lowD = midD; break; }
        if (lhs < rhs) { lowN = midN; lowD = midD; }
        else { highN = midN; highD = midD; }
    }

    if (highD > 0n && highD <= MAX_DENOMINATOR) {
        const abs = (v) => (v < 0n ? -v : v);
        const lowError = abs(lowN * ONE - value * lowD) * highD;
        const highError = abs(highN * ONE - value * highD) * lowD;
        if (highError < lowError) { lowN = highN; lowD = highD; }
    }

    if (lowD === 0n) { lowN = value / ONE; lowD = 1n; }

    return {
        numerator: Number(negative ? -lowN : lowN),
        denominator: Number(lowD),
    };
}

/**
 * A number formatted the way C#'s "0.##" family does, which is what the effect lines on the
 * pick screen are printed with. Trailing zeros go; the rounding is half away from zero.
 */
export function fixedFormat(value, places) {
    if (!Number.isFinite(value)) return "0";

    let text = value.toFixed(places);
    if (places > 0 && text.includes(".")) {
        text = text.replace(/0+$/, "").replace(/\.$/, "");
    }

    return text;
}
