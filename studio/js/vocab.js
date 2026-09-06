/*
 * The vocabulary a card is written in: the enums, in their enum order.
 *
 * Order is load-bearing rather than cosmetic. A card's id is a hash of its definition and
 * the hash mixes each enum's *ordinal*, so a name inserted in the middle of one of these
 * lists silently repoints every card ever authored. Same rule the C# enums carry: new
 * values go on the end, always.
 *
 * These lists are a copy of Assets/Sim/Cards/*.cs, and a copy can drift. Two things keep
 * that honest. Anything data/ supplies wins: stats.json is read in order and becomes the
 * StatId ordering, so the generator is the authority for the list most likely to grow. And
 * any name seen in cards.json that is missing here is appended at load, so an unknown
 * keyword shows up in the editor rather than disappearing from it.
 */

export const RARITIES = ["Common", "Uncommon", "Rare"];

export const KEYWORDS = [
    "None",
    "Projectile", "Explosive", "Multishot", "Ricochet", "Rapid", "Precision", "Heavy",
    "Reload", "Execute",
    "Knockback", "Slow", "Stun", "Poison", "Aura",
    "Vitality", "Regeneration", "Lifesteal", "Shield", "Block", "Thorns",
    "Mobility", "Teleport", "Momentum",
    "Drawback",
];

export const TRIGGERS = [
    "Passive", "OnFire", "OnHitPlayer", "OnBlock", "OnBlockSuccess", "OnKill",
    "OnTakeDamage", "OnReload",
];

export const ACTIONS = [
    "StatMod", "Heal", "ReloadNow", "RefreshBlock", "PushNearby", "PullNearby",
    "DamageNearby", "SlowNearby", "SpawnRing", "Blink", "SlowTarget", "StunTarget",
    "PoisonTarget", "HasteSelf", "ShieldSelf", "CostHealth",
];

export const OPS = ["Add", "Multiply", "Set"];

export const STATS = [
    "MoveSpeed", "Acceleration", "AirControl", "TurnBoost", "GroundFriction", "AirDrag",
    "JumpSpeed", "GravityScale", "Radius", "ExtraJumps",
    "BlinkCharges", "BlinkSpeed", "BlinkCooldown",
    "WallSlideSpeed", "WallKickSpeed", "WallClingTime", "WallClimbSpeed",
    "BlockWindow", "BlockCooldown", "BlockReflectScale",
    "MaxHealth", "Regeneration", "LifeSteal", "DamageTakenScale", "SelfDamageScale",
    "BoundsBounceDamage", "BoundsBounceSpeed",
    "Damage", "BulletSpeed", "BulletGravityScale", "BulletRadius", "BulletLifetime",
    "ReloadTime", "AttackCooldown", "Spread", "Recoil", "Knockback",
    "MagazineSize", "BulletsPerShot", "Bounces", "BlastRadius",
    "ImpactDamageSpeed", "ImpactDamageScale",
    "ThrusterForce", "ThrusterTime",
];

/**
 * What a keyword is about, which is the only thing that decides a card's colour when it
 * carries one. Mirrors CardKeywords.Domain.
 */
const DOMAIN_OF_KEYWORD = {
    Projectile: "Offence", Explosive: "Offence", Multishot: "Offence", Ricochet: "Offence",
    Rapid: "Offence", Precision: "Offence", Heavy: "Offence", Reload: "Offence",
    Execute: "Offence",
    Knockback: "Control", Slow: "Control", Stun: "Control", Poison: "Control",
    Aura: "Control",
    Vitality: "Protection", Regeneration: "Protection", Lifesteal: "Protection",
    Shield: "Protection", Block: "Protection", Thorns: "Protection",
    Mobility: "Movement", Teleport: "Movement", Momentum: "Movement",
    // Says what a card costs rather than what it is, so it carries no colour of its own.
    Drawback: "Neutral", None: "Neutral",
};

/** The domains a stat falls in, for cards with nothing tagged. Mirrors CardInk.Weigh. */
const DOMAIN_OF_STAT = {
    MoveSpeed: "Movement", Acceleration: "Movement", AirControl: "Movement",
    TurnBoost: "Movement", GroundFriction: "Movement", AirDrag: "Movement",
    JumpSpeed: "Movement", GravityScale: "Movement", ExtraJumps: "Movement",
    BlinkCharges: "Movement", BlinkSpeed: "Movement", BlinkCooldown: "Movement",
    WallSlideSpeed: "Movement", WallKickSpeed: "Movement", WallClingTime: "Movement",
    WallClimbSpeed: "Movement", ThrusterForce: "Movement", ThrusterTime: "Movement",

    MaxHealth: "Protection", Regeneration: "Protection", DamageTakenScale: "Protection",
    SelfDamageScale: "Protection", BlockWindow: "Protection", BlockCooldown: "Protection",
    BlockReflectScale: "Protection", BoundsBounceDamage: "Protection",
    BoundsBounceSpeed: "Protection", ImpactDamageSpeed: "Protection",
    ImpactDamageScale: "Protection",

    Damage: "Offence", BulletSpeed: "Offence", BulletGravityScale: "Offence",
    BulletRadius: "Offence", BulletLifetime: "Offence", ReloadTime: "Offence",
    AttackCooldown: "Offence", Spread: "Offence", Recoil: "Offence",
    MagazineSize: "Offence", BulletsPerShot: "Offence", Bounces: "Offence",
    BlastRadius: "Offence",

    // Being bigger is more of you to hit and more health to carry it.
    Radius: "Protection",

    // Shoving is control rather than damage.
    Knockback: "Control",
};

/** Stats that count for two domains at once, weighted. Mirrors CardInk's LifeSteal case. */
const SPLIT_STATS = {
    // Genuinely both: a reason to shoot and a reason to survive.
    LifeSteal: { Offence: 0.5, Protection: 0.5 },
};

const DOMAIN_OF_ACTION = {
    Heal: "Protection", ShieldSelf: "Protection", RefreshBlock: "Protection",
    CostHealth: "Protection",
    ReloadNow: "Offence", SpawnRing: "Offence", DamageNearby: "Offence",
    Blink: "Movement", HasteSelf: "Movement",
    PushNearby: "Control", PullNearby: "Control", SlowNearby: "Control",
    SlowTarget: "Control", StunTarget: "Control", PoisonTarget: "Control",
};

/**
 * The ink each domain paints with, straight out of CardInk. These are the game's own
 * numbers, and they are the studio's accent palette too: the app is a grey workbench and
 * the cards supply every colour on it.
 */
export const DOMAIN_INK = {
    Movement: [0.32, 0.92, 0.48],
    Protection: [0.95, 0.55, 0.26],
    Offence: [1.0, 0.30, 0.36],
    Control: [0.72, 0.42, 1.0],
    Neutral: [0.30, 0.62, 1.0],
};

export const DOMAINS = ["Movement", "Protection", "Offence", "Control", "Neutral"];

/** The domain a card reads as: its primary keyword's, or derived from what it does. */
export function domainOf(card) {
    const primary = card.keywords && card.keywords.length ? card.keywords[0] : "None";
    if (primary && primary !== "None") return DOMAIN_OF_KEYWORD[primary] || "Neutral";

    const effects = card.effects || [];
    if (!effects.length) return "Neutral";

    const weight = { Movement: 0, Protection: 0, Offence: 0, Control: 0 };
    for (const e of effects) {
        if (e.action === "StatMod" && SPLIT_STATS[e.stat]) {
            for (const [domain, share] of Object.entries(SPLIT_STATS[e.stat])) {
                weight[domain] += share;
            }
            continue;
        }

        const domain = e.action === "StatMod"
            ? DOMAIN_OF_STAT[e.stat]
            : DOMAIN_OF_ACTION[e.action];
        if (domain && domain in weight) weight[domain] += 1;
    }

    // The dominant domain wins outright rather than blending, because averaging hues
    // spread around the wheel lands in the desaturated middle and carries no information.
    let best = "Neutral", most = 0;
    for (const domain of ["Movement", "Protection", "Offence", "Control"]) {
        if (weight[domain] > most) { best = domain; most = weight[domain]; }
    }
    return best;
}

export function inkCss(domain, alpha) {
    const [r, g, b] = DOMAIN_INK[domain] || DOMAIN_INK.Neutral;
    const to255 = (v) => Math.round(v * 255);
    return alpha === undefined
        ? `rgb(${to255(r)} ${to255(g)} ${to255(b)})`
        : `rgb(${to255(r)} ${to255(g)} ${to255(b)} / ${alpha})`;
}

/** Turns MaxHealth into "max health", exactly as CardMaths.Spaced does. */
export function spaced(name) {
    let out = "";
    for (let i = 0; i < name.length; ++i) {
        const c = name[i];
        if (i > 0 && c >= "A" && c <= "Z") out += " ";
        out += c.toLowerCase();
    }
    return out;
}

/** Sentence case for a label a person reads: "Max health". */
export function titled(name) {
    const s = spaced(name);
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The score in the tile's corner, as MatchView.PointsFor sets it. */
export const RARITY_POINTS = { Common: 1, Uncommon: 4, Rare: 8 };
