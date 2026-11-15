// The profile page everyone sees, exactly as the owner arranged it (the
// public route /u/:handle and the editor preview render this same view).
// HackPath philosophy: black canvas, centred hero with a handwritten tagline
// and a huge Geist name ending in the tilted hand period, a hairline stat
// strip, numbered sections that end in a hairline rule, hairline grids whose
// cells invert to white on hover, rows that lift. Palette law: black, greys,
// white and golden white only; status = icon + word. OWNER: WS-PROFILES.
import { ArrowUpRight, CheckCircle, Circle, HalfCircle } from "../../kit/icons";
import { cn } from "../../kit/lib/cn";
import { Frame, StatStrip } from "../../kit/Layout";
import { Eyebrow, HandPeriod, Kicker, Tagline } from "../../kit/Typography";
import ProfileImage from "./ProfileImage";
import { initialsOf, SKILL_LEVELS } from "./profileModel";
import ReportProfileDialog from "./ReportProfileDialog";
import RichText, { isSafeHref, LINK_REL } from "./RichText";

const LEVEL_ICON = { circle: Circle, half: HalfCircle, check: CheckCircle };

/** Our own line art: radial hairlines crossing at the centre (no third-party art). */
export function RadialLines({ className }) {
  return (
    <svg aria-hidden="true" className={cn("pointer-events-none absolute inset-0 size-full", className)} viewBox="0 0 1200 600" preserveAspectRatio="xMidYMid slice" fill="none">
      <g stroke="#fff" strokeWidth="1" vectorEffect="non-scaling-stroke">
        <line x1="0" y1="300" x2="1200" y2="300" strokeOpacity=".08" />
        <line x1="600" y1="0" x2="600" y2="600" strokeOpacity=".08" />
        <line x1="300" y1="0" x2="900" y2="600" strokeOpacity=".05" />
        <line x1="900" y1="0" x2="300" y2="600" strokeOpacity=".05" />
        <circle cx="600" cy="300" r="140" strokeOpacity=".06" />
        <circle cx="600" cy="300" r="260" strokeOpacity=".04" />
      </g>
    </svg>
  );
}

function BadgeGlyph({ tier }) {
  // A hand-drawn-style medal outline; the tier is a word, never a colour.
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="size-10 transition-[filter] duration-300 group-hover:invert motion-reduce:transition-none" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4l4 12M32 4l-4 12" />
      <circle cx="24" cy="29" r="12" />
      <circle cx="24" cy="29" r="7" strokeOpacity={tier === "gold" ? 1 : 0.5} strokeDasharray={tier === "bronze" ? "2 3" : undefined} />
    </svg>
  );
}

function SectionHead({ id, index, title, count, align }) {
  return (
    <div className={cn("flex items-end justify-between gap-6 border-b border-white/10 pb-6", align === "center" && "sm:text-left")}>
      <div>
        <Eyebrow>{String(index).padStart(2, "0")}</Eyebrow>
        <h2 id={id} className="mt-3 text-3xl font-medium text-white sm:text-4xl">
          {title}
        </h2>
      </div>
      {count ? <p className="shrink-0 text-sm text-subtle">{count}</p> : null}
    </div>
  );
}

function BioBlock({ block }) {
  return <RichText doc={block.doc} className="max-w-2xl" />;
}

function BadgesBlock({ block }) {
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:gap-0 md:overflow-hidden md:rounded-lg md:border-l md:border-t md:border-white/10 lg:grid-cols-4">
      {block.items.map((badge) => (
        <li
          key={badge.key}
          className={cn(
            "group flex min-h-48 flex-col rounded-lg border border-white/10 p-6 transition-colors duration-300 ease-standard motion-reduce:transition-none md:rounded-none md:border-0 md:border-b md:border-r",
            // Touch screens show the inverted state (no hover there); md+ inverts on hover or keyboard focus.
            "bg-white text-black md:bg-surface-1 md:text-white md:hover:bg-white md:hover:text-black"
          )}
        >
          <span className="invert md:invert-0">
            <BadgeGlyph tier={badge.tier} />
          </span>
          <p className="mt-6 text-lg font-medium leading-snug">{badge.title}</p>
          <p className="mt-1 text-eyebrow font-medium uppercase text-black/60 md:text-subtle md:group-hover:text-black/60">
            {badge.tier} badge
          </p>
          <p className="mt-auto pt-4 text-xs leading-5 text-black/70 md:text-muted-foreground md:group-hover:text-black/70">
            {badge.description}
          </p>
        </li>
      ))}
    </ul>
  );
}

function SkillsBlock({ block }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {block.items.map((skill, index) => {
        const level = SKILL_LEVELS.find((item) => item.value === skill.level) || SKILL_LEVELS[0];
        const Icon = LEVEL_ICON[level.icon];
        return (
          <li key={`${skill.name}-${index}`} className="inline-flex h-10 items-center gap-2 rounded-full border border-white/[.12] px-4 text-sm text-white">
            <Icon size={14} className={level.value === "learning" ? "text-subtle" : "text-white"} />
            <span>{skill.name}</span>
            <span className="text-xs text-subtle">· {level.label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function WriteupsBlock({ block }) {
  return (
    <ol className="grid gap-3">
      {block.items.map((item, index) => {
        const linked = isSafeHref(item.url);
        const body = (
          <>
            <span className="w-11 shrink-0 font-mono text-xs tabular-nums text-subtle">{String(index + 1).padStart(2, "0")}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-base font-medium text-white/90">{item.title}</span>
              {item.summary ? <span className="mt-1 block text-sm leading-6 text-muted-foreground">{item.summary}</span> : null}
              {item.tags?.length ? (
                <span className="mt-3 flex flex-wrap gap-1.5">
                  {item.tags.map((tag) => (
                    <span key={tag} className="rounded border border-white/15 px-1.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-subtle">
                      {tag}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            {linked ? (
              <span className="hidden shrink-0 items-center gap-1 text-xs text-white/70 sm:inline-flex">
                {item.host}
                <ArrowUpRight size={14} className="transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transition-none" />
              </span>
            ) : null}
          </>
        );
        const rowClass =
          "group flex items-start gap-4 rounded-xl border border-white/10 bg-white/[.025] px-5 py-4 transition-[transform,border-color,background-color] duration-150 motion-reduce:transition-none";
        return (
          <li key={`${item.title}-${index}`}>
            {linked ? (
              <a
                href={item.url}
                rel={LINK_REL}
                target="_blank"
                className={cn(rowClass, "hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:hover:translate-y-0")}
              >
                {body}
                <span className="sr-only"> (opens {item.host} in a new tab)</span>
              </a>
            ) : (
              <div className={rowClass}>{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function GalleryBlock({ block }) {
  return (
    <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {block.items.map((item) => (
        <li key={item.image_id}>
          <figure>
            <ProfileImage src={item.src} alt={item.alt || item.caption || ""} className="aspect-[4/3] rounded-2xl border border-white/10" />
            {item.caption ? <figcaption className="mt-3 text-sm leading-6 text-muted-foreground">{item.caption}</figcaption> : null}
          </figure>
        </li>
      ))}
    </ul>
  );
}

function LinksBlock({ block }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {block.items
        .filter((item) => isSafeHref(item.url))
        .map((item) => (
          <li key={item.url}>
            <a
              href={item.url}
              rel={LINK_REL}
              target="_blank"
              className="group inline-flex h-10 items-center gap-2 rounded-full border border-white/15 px-4 text-sm text-white transition-colors duration-150 hover:border-white hover:bg-white hover:text-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
            >
              <span>{item.label}</span>
              <span className="text-xs text-subtle group-hover:text-black/60">{item.host}</span>
              <ArrowUpRight size={14} />
            </a>
          </li>
        ))}
    </ul>
  );
}

/**
 * The release-day Founding Glow frame (payload `frame.kind === "founding_glow"`,
 * 30 days for founding students still active at launch): a soft, static
 * golden-white ring. Deliberately quieter than the Monthly CTF champion's
 * Golden Aura (no breathing animation, no gold name), so the aura stays the
 * top cosmetic. Static, so reduced motion needs nothing extra.
 */
export function FoundingGlow({ frame, children }) {
  if (frame?.kind !== "founding_glow") return children;
  const label = frame.label || "Founding Glow";
  return (
    <span className="relative inline-flex flex-col items-center" data-frame="founding_glow">
      <span className="rounded-full shadow-[0_0_0_2px_rgba(255,244,214,0.55),0_0_22px_3px_rgba(255,236,196,0.22)]">{children}</span>
      <span className="mt-3 rounded-full border border-[rgba(255,240,205,0.35)] px-2.5 py-0.5 text-[10px] uppercase tracking-eyebrow text-[#fff4d6]">
        {label}
      </span>
    </span>
  );
}

/**
 * The owner's highlighted badges and certificates (at most 3, chosen in the
 * Console). Handle only: a certificate shows as a badge title, never with a
 * reference, link or name.
 */
export function HighlightsStrip({ items }) {
  const list = Array.isArray(items) ? items.slice(0, 3) : [];
  if (!list.length) return null;
  return (
    <section aria-labelledby="profile-highlights" className="border-b border-white/10">
      <Frame className="py-10 sm:py-12">
        <Eyebrow aria-hidden="true">Highlights</Eyebrow>
        <h2 id="profile-highlights" className="sr-only">
          Highlights
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-3">
          {list.map((item, index) => (
            <li key={`${item.kind}-${item.key || item.title}-${index}`} className="flex items-center gap-4 rounded-lg border border-white/15 bg-surface-1 p-4">
              <BadgeGlyph tier={item.kind === "certificate" ? "gold" : item.tier} />
              <div className="min-w-0">
                <p className="text-sm font-medium leading-snug text-white">{item.title}</p>
                <p className="mt-1 text-eyebrow font-medium uppercase text-subtle">
                  {item.kind === "certificate" ? "Certified" : `${item.tier || ""} badge`.trim()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </Frame>
    </section>
  );
}

const BLOCK_VIEWS = { bio: BioBlock, badges: BadgesBlock, skills: SkillsBlock, writeups: WriteupsBlock, gallery: GalleryBlock, links: LinksBlock };

function countLabel(block) {
  const n = block.items?.length || 0;
  if (!n || block.type === "bio") return "";
  const nouns = { badges: "badge", skills: "skill", writeups: "write-up", gallery: "image", links: "link" };
  const noun = nouns[block.type] || "item";
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * <ProfileView profile={viewModel} /> where viewModel is the API's public
 * payload ({ handle, header, theme, blocks, can_report, preview }).
 */
export default function ProfileView({ profile, headingLevel = "h1", showReport = true }) {
  const theme = profile?.theme || {};
  const header = profile?.header || {};
  const blocks = Array.isArray(profile?.blocks) ? profile.blocks : [];
  const centered = theme.align !== "left";
  const Heading = headingLevel;
  const count = (type) => blocks.find((block) => block.type === type)?.items?.length || 0;
  const stats = [
    { value: String(count("badges")), label: "badges" },
    { value: String(count("skills")), label: "skills" },
    { value: String(count("writeups")), label: "write-ups" },
  ];

  return (
    <article className="bg-background text-white" aria-label={`Profile of @${profile?.handle || ""}`}>
      <header className="relative overflow-hidden border-b border-white/10">
        {theme.banner === "lines" ? <RadialLines /> : null}
        {theme.banner === "image" && header.banner ? (
          <ProfileImage src={header.banner} alt="" className="absolute inset-0 opacity-40" imgClassName="grayscale" />
        ) : null}
        {theme.banner === "image" && header.banner ? <span aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-black/30 via-black/60 to-black" /> : null}
        <Frame className={cn("relative flex flex-col pb-16 pt-28 sm:pb-24 md:pt-32", centered ? "items-center text-center" : "items-start text-left")}>
          <FoundingGlow frame={profile?.frame}>
            <ProfileImage
              src={header.avatar}
              alt=""
              className="size-24 shrink-0 rounded-full border border-white/15 sm:size-28"
              fallback={
                <span aria-hidden="true" className="flex size-full items-center justify-center font-hand text-4xl text-white/[.82]">
                  {initialsOf(header.display_name || profile?.handle)}
                </span>
              }
            />
          </FoundingGlow>
          {header.tagline ? (
            theme.tagline === "plain" ? (
              <p className="mt-6 text-base text-muted-foreground sm:text-lg">{header.tagline}</p>
            ) : (
              <Tagline className="mt-6">{header.tagline}</Tagline>
            )
          ) : null}
          <Heading className={cn("mt-4 max-w-5xl break-words font-semibold leading-none text-white text-balance", "text-5xl sm:text-7xl md:text-8xl")}>
            {header.display_name || profile?.handle}
            <HandPeriod className={theme.accent === "gold" ? "text-accent opacity-100" : undefined} />
          </Heading>
          <Kicker lead={`@${profile?.handle || ""}`} className={cn("mt-6", !centered && "justify-start")}>
            {header.real_name ? header.real_name : "Student profile"}
          </Kicker>
          <StatStrip items={stats} columns={3} className={cn("mt-10 grid-cols-3", !centered && "mx-0")} />
        </Frame>
      </header>

      <HighlightsStrip items={profile?.highlights} />

      {blocks.length ? (
        <Frame className="space-y-20 py-16 sm:space-y-24 sm:py-24">
          {blocks.map((block, index) => {
            const View = BLOCK_VIEWS[block.type];
            if (!View) return null;
            return (
              <section key={block.id || block.type} aria-labelledby={`profile-block-${block.type}`}>
                <SectionHead id={`profile-block-${block.type}`} index={index + 1} title={block.title} count={countLabel(block)} align={theme.align} />
                <div className="mt-8">
                  <View block={block} />
                </div>
              </section>
            );
          })}
        </Frame>
      ) : (
        <Frame className="py-16 text-center sm:py-24">
          <p className="text-sm text-muted-foreground">Nothing here yet.</p>
        </Frame>
      )}

      <Frame className={cn("flex flex-col gap-3 border-t border-white/10 py-8 sm:flex-row sm:items-center sm:justify-between")}>
        <p className="text-xs text-subtle">Profiles show a public handle. Personal details are blocked before publishing.</p>
        {showReport && profile?.can_report ? <ReportProfileDialog handle={profile.handle} /> : null}
      </Frame>
    </article>
  );
}

