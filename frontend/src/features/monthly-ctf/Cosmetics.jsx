// Monthly CTF cosmetics: Golden Aura, podium frame, First Blood title and
// trophies. OWNER: WS-MONTHLY-CTF.
//
// Used by the Console shell (the signed-in avatar), leaderboards, the Hall of
// Fame and profiles. Status is never colour alone: every reward also carries
// its word ("Golden Aura", "Gold trophy"), and the trophy tiers differ by
// luminance and pattern (gold = solid golden white, silver = solid grey,
// bronze = outline + hatch), never by hue.
import "./monthlyCtf.css";

import { cn } from "../../kit/lib/cn";
import { TIER_LABELS, handleInitials, normaliseCosmetics } from "./seasonModel";

const AVATAR_SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-8 text-xs",
  md: "size-10 text-sm",
  lg: "size-14 text-base",
  xl: "size-20 text-xl",
};

/**
 * Wraps any round avatar with the viewer's active cosmetics.
 * `animated` lets the aura breathe (keep it to one element per viewport:
 * the shell avatar or a page hero; list rows stay static).
 */
export function CosmeticRing({ cosmetics, animated = false, className, children }) {
  const value = normaliseCosmetics(cosmetics);
  if (!value.aura && !value.frame) return children;
  return (
    <span
      className={cn(value.aura && "mctf-aura", value.frame && "mctf-frame", className)}
      data-animated={value.aura && animated ? "true" : undefined}
      data-cosmetic={value.aura ? "aura" : "frame"}
    >
      {children}
    </span>
  );
}

/** Initials avatar for a public handle (boards never show photos or real names). */
export function HandleAvatar({ name, size = "sm", cosmetics, animated = false, className }) {
  return (
    <CosmeticRing cosmetics={cosmetics} animated={animated}>
      <span
        aria-hidden="true"
        className={cn(
          "inline-grid shrink-0 place-items-center rounded-full border border-white/15 bg-card font-medium text-white",
          AVATAR_SIZES[size] || AVATAR_SIZES.sm,
          className
        )}
      >
        {handleInitials(name)}
      </span>
    </CosmeticRing>
  );
}

/** A handle with its aura glow and First Blood title. */
export function CosmeticName({ name, cosmetics, className, showTitle = true }) {
  const value = normaliseCosmetics(cosmetics);
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      <span className={cn("truncate font-medium", value.aura ? "mctf-aura-name" : "text-white")}>{name}</span>
      {value.aura ? <span className="sr-only">(Golden Aura)</span> : null}
      {showTitle && value.title ? <TitleChip>{value.title}</TitleChip> : null}
    </span>
  );
}

/** "First Blood" title: a micro pill with a flag glyph. */
export function TitleChip({ children, className }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-white/25 px-2 py-0.5 text-[10px] font-medium uppercase tracking-eyebrow text-white",
        className
      )}
    >
      <FlagGlyph className="size-3" />
      {children}
    </span>
  );
}

function FlagGlyph({ className }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 14V2.5M4 3h7.5l-1.6 2.6L11.5 8H4" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

const TROPHY_FILL = {
  gold: { cup: "#F3E2B3", stroke: "#F3E2B3", knock: "#0a0a0a" },
  silver: { cup: "#bdbdbd", stroke: "#bdbdbd", knock: "#0a0a0a" },
  bronze: { cup: "none", stroke: "#8a8a8a", knock: "#8a8a8a" },
};

/**
 * Trophy glyph by tier (luminance + pattern): gold solid golden white,
 * silver solid grey, bronze outline with a hatched plinth. `star` marks the
 * Season Champion trophy.
 */
export function TrophyMark({ tier = "gold", size = 40, star = false, className, title }) {
  const fill = TROPHY_FILL[tier] || TROPHY_FILL.gold;
  const patternId = `mctf-hatch-${tier}`;
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : "true"}
      aria-label={title || undefined}
      className={cn("shrink-0", className)}
    >
      {tier === "bronze" ? (
        <defs>
          <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="#8a8a8a" strokeWidth="1.2" />
          </pattern>
        </defs>
      ) : null}
      <path
        d="M14 6h20v9c0 6.6-4.5 12-10 12s-10-5.4-10-12V6Z"
        fill={fill.cup}
        stroke={fill.stroke}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M14 10H8v3c0 4 3 7 7 7.5M34 10h6v3c0 4-3 7-7 7.5" fill="none" stroke={fill.stroke} strokeWidth="2" strokeLinecap="round" />
      <path d="M24 27v7" stroke={fill.stroke} strokeWidth="2" />
      <rect
        x="15"
        y="34"
        width="18"
        height="8"
        rx="1.5"
        fill={tier === "bronze" ? `url(#${patternId})` : fill.cup}
        stroke={fill.stroke}
        strokeWidth="2"
      />
      {star ? (
        <path
          d="m24 10.5 1.9 3.9 4.3.6-3.1 3 .7 4.3-3.8-2-3.8 2 .7-4.3-3.1-3 4.3-.6Z"
          fill={fill.knock}
          stroke="none"
        />
      ) : null}
    </svg>
  );
}

/** A trophy with its word: "Gold trophy · November 2026". */
export function TrophyCard({ tier = "gold", title, caption, star = false, className }) {
  return (
    <div className={cn("flex items-center gap-4 rounded-lg border border-white/10 bg-card px-5 py-4", className)}>
      <TrophyMark tier={tier} size={44} star={star} />
      <div className="min-w-0">
        <p className="text-eyebrow font-medium uppercase text-subtle">{star ? "Season Champion" : `${TIER_LABELS[tier] || "Gold"} trophy`}</p>
        <p className="mt-1 text-base font-medium leading-snug text-white">{title}</p>
        {caption ? <p className="mt-0.5 text-xs text-subtle">{caption}</p> : null}
      </div>
    </div>
  );
}

/** Rank cell: podium ranks show the trophy glyph + number; the rest a mono number. */
export function RankMark({ rank }) {
  const tier = { 1: "gold", 2: "silver", 3: "bronze" }[rank];
  return (
    <span className="inline-flex items-center gap-2 font-mono text-sm tabular-nums text-white">
      {tier ? <TrophyMark tier={tier} size={20} /> : <span aria-hidden="true" className="inline-block w-5" />}
      <span>
        <span className="sr-only">Rank </span>
        {rank}
        {tier ? <span className="sr-only"> ({TIER_LABELS[tier]})</span> : null}
      </span>
    </span>
  );
}

/** Words for the active cosmetics, for chips and screen readers. */
export function cosmeticWords(cosmetics) {
  const value = normaliseCosmetics(cosmetics);
  const words = [];
  if (value.aura) words.push("Golden Aura");
  if (value.frame) words.push(value.frame_tier ? `${TIER_LABELS[value.frame_tier]} podium frame` : "Podium frame");
  if (value.title) words.push(value.title);
  return words;
}
