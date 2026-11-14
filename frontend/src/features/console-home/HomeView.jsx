// Console Home (T1): "what should I do next" (plan §3.4). OWNER: WS-LEARN.
// Presentational: the page passes the /api/console/today/ payload, the
// engagement summary and the capability flags in (no fetching here).
// HackPath philosophy (PHILOSOPHY.md T8 + T-ROAD cards): golden eyebrow, one
// handwritten word (the first name), a hairline stat strip, one golden CTA,
// lesson-row lists and a hairline-framed pair of practice cards.
import "./ConsoleHome.scss";
import "../engagement-ui/Engagement.scss";

import { ArrowRight, Calendar, ChevronRight, Launch, PlayFilledAlt } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { Link } from "react-router-dom";
import { ErrorState, StatusTag } from "../app-shell/ui";
import { buildLiveScheduleIcs } from "../live-classes/schedule";
import { downloadCalendarFile } from "../live-classes/calendarDownload";
import { LiveDot, Meter, RollingDigits } from "../../site-kit/motion";
import { siteBrand } from "../../config/siteBrand";
import { LABS, LABS_URL, labAccess } from "../../data/freeLabs";
import { describeStreak, formatStudyTime, formatXp } from "../engagement-ui/engagementModel";
import { StatStrip } from "../engagement-ui/EngagementParts";
import { getFirstName } from "../users-corner/cornerModel";
import { Artwork, Eyebrow, KIND_ICONS, SkeletonBar, SmartLink } from "./HomeParts";
import {
  KIND_ICON,
  NEXT_UP_EYEBROW,
  formatAlsoMeta,
  formatHubDate,
  formatWhen,
  getStartsIn,
  isExternalHref,
  percent,
} from "./homeModel";

/** The Pentesting track (browsable while purchases are switched off). */
export const PENTESTING_TRACK_PATH = "/tracks/pentesting";
/** The free OSINT directory (link-out catalogue; the free tier with the monthly CTF). */
export const FREE_DIRECTORY_PATH = "/osint/free";
const FREE_DIRECTORY_PLATFORMS = ["TryHackMe", "Hack The Box", "OSINT Dojo", "OSINT Industries"];
const PENTESTING_TIERS = ["Foundations", "Offensive security", "Defensive security", "Advanced operations", "Quick wins"];

function localIsoDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Greeting h1 (the first name is the one handwritten word) + golden date eyebrow. */
export function Greeting({ user, now }) {
  const date = formatHubDate(now);
  const firstName = getFirstName(user);
  return (
    <header className="ch-greeting">
      {date ? (
        <Eyebrow>
          <time dateTime={localIsoDate(now)}>{date}</time>
        </Eyebrow>
      ) : null}
      <h1 className="ch-greeting__title">
        {firstName ? (
          <>
            Welcome back, <span className="ch-hand">{firstName}</span>
            <span className="ch-hand-period" aria-hidden="true">
              .
            </span>
          </>
        ) : (
          "Welcome back"
        )}
      </h1>
    </header>
  );
}

/** Next live class time from the Today payload ("Today 7:00 pm"), or "". */
export function nextClassLabel(data, now = new Date()) {
  if (!data) return "";
  if (data.next_up?.kind === "live_now") return "Live now";
  if (data.next_up?.kind === "next_class") return formatWhen(data.next_up.starts_at || data.next_up.due_at, now);
  const row = (data.also || []).find((entry) => entry.kind === "next_class" || entry.kind === "live_now");
  if (!row) return "";
  return row.kind === "live_now" ? "Live now" : formatWhen(row.due_at, now);
}

/** Hairline stat strip: streak, XP (rank), study time this week, next class. Engagement switch only. */
export function HomeStats({ engagement, data, now = new Date() }) {
  if (!engagement) return null;
  const streak = describeStreak(engagement.streak);
  const nextClass = nextClassLabel(data, now);
  const items = [
    { label: "Streak", value: <span className="eg-mono">{streak.count}</span>, hint: streak.count === 1 ? "day" : "days" },
    { label: engagement.level?.title || "XP", value: <span className="eg-mono">{formatXp(engagement.xp)}</span>, hint: "XP" },
    { label: "This week", value: <span className="eg-mono">{formatStudyTime(engagement.time?.this_week_seconds || 0)}</span> },
    { label: "Next class", value: nextClass || "None", hint: nextClass ? "" : "scheduled" },
  ];
  return <StatStrip items={items} label="Your week in numbers" className="ch-stats" />;
}

function KindLine({ item }) {
  if (item.kind === "live_now") {
    return (
      <p className="ch-next__kind">
        <StatusTag status="live">Live now</StatusTag>
      </p>
    );
  }
  const Icon = KIND_ICONS[KIND_ICON[item.kind]] || ArrowRight;
  return (
    <p className="ch-next__kind">
      <Icon size={16} aria-hidden="true" />
      <span>{NEXT_UP_EYEBROW[item.kind] || "Next up"}</span>
    </p>
  );
}

function PrimaryAction({ action, kind }) {
  if (!action?.href) return null;
  const external = isExternalHref(action.href);
  const icon = external ? Launch : kind === "resume" ? PlayFilledAlt : ArrowRight;
  if (external) {
    return (
      <Button as="a" href={action.href} target="_blank" rel="noopener noreferrer" size="lg" renderIcon={icon} className="ch-accent-button">
        {action.label}
      </Button>
    );
  }
  return (
    <Button as={Link} to={action.href} size="lg" renderIcon={icon} className="ch-accent-button">
      {action.label}
    </Button>
  );
}

function addClassToCalendar(title) {
  const ics = buildLiveScheduleIcs(null, {
    title: title || "Live class",
    url: typeof window !== "undefined" ? `${window.location.origin}/join-live` : "",
    brand: siteBrand?.name || "Live classes",
  });
  downloadCalendarFile(ics, "live-classes.ics");
}

/** Countdown to the next class: only the changed digits roll (M9). */
function StartsIn({ startsAt, now }) {
  const startsIn = getStartsIn(startsAt, now);
  if (!startsIn) return null;
  return (
    <p className="ch-next__countdown">
      <span className="cds--visually-hidden">{startsIn.spoken}</span>
      <span aria-hidden="true" className="ch-next__digits">
        <span className="ch-next__digits-label">Starts in</span>
        {startsIn.segments.map((segment) => (
          <span key={segment.unit} className="ch-next__segment">
            <RollingDigits value={segment.value} />
            <span className="ch-next__unit">{segment.unit}</span>
          </span>
        ))}
      </span>
    </p>
  );
}

/** The one card at the top: the next best action, with the screen's only champagne button. */
export function NextUpCard({ item, now = new Date() }) {
  if (!item) return null;
  const isResume = item.kind === "resume";
  const isNextClass = item.kind === "next_class";
  const isBrowse = item.kind === "browse";
  return (
    <section className={`ch-next ch-enter ch-next--${item.kind}`} style={{ "--ch-i": 0 }} aria-labelledby="ch-next-title" data-kind={item.kind}>
      <div className="ch-next__body">
        <h2 className="cds--visually-hidden">Next up</h2>
        <KindLine item={item} />
        <h3 id="ch-next-title" className="ch-next__title">
          {item.title}
        </h3>
        {item.subtitle ? <p className="ch-next__subtitle">{item.subtitle}</p> : null}
        {isResume && item.progress != null ? (
          <div className="ch-next__meter">
            <Meter value={item.progress} label={`${item.title} progress`} />
            <span className="ch-next__percent">{percent(item.progress)}% complete</span>
          </div>
        ) : null}
        {isNextClass ? <StartsIn startsAt={item.starts_at} now={now} /> : null}
        <div className="ch-next__actions">
          {isNextClass ? (
            <>
              <Button size="lg" renderIcon={Calendar} className="ch-accent-button" onClick={() => addClassToCalendar(item.title)}>
                Add to calendar
              </Button>
              <Button as={Link} to={item.action?.href || "/join-live"} kind="ghost" size="lg">
                {item.action?.label || "Live classes"}
              </Button>
            </>
          ) : (
            <PrimaryAction action={item.action} kind={item.kind} />
          )}
          {isBrowse ? (
            <Button as={Link} to="/contact" kind="ghost" size="lg">
              Have a code? Contact us
            </Button>
          ) : null}
        </div>
      </div>
      <SmartLink href={item.action?.href} className="ch-next__media" tabIndex={-1} aria-hidden="true">
        <Artwork src={item.image} icon={KIND_ICONS[KIND_ICON[item.kind]]} eager />
        {item.kind === "live_now" ? (
          <span className="ch-next__live">
            <LiveDot state={/reconnect/i.test(item.subtitle || "") ? "reconnecting" : "live"} />
          </span>
        ) : null}
      </SmartLink>
    </section>
  );
}

/** "Also this week": up to three rows (icon, label, when, chevron). */
export function AlsoList({ rows = [], now = new Date() }) {
  if (!rows.length) return null;
  return (
    <section className="ch-section" aria-labelledby="ch-also-title">
      <h2 id="ch-also-title" className="ch-section__title">
        Also this week
      </h2>
      <ul className="ch-also">
        {rows.map((row, index) => {
          const Icon = KIND_ICONS[KIND_ICON[row.kind]] || ArrowRight;
          const meta = formatAlsoMeta(row, now);
          return (
            <li key={`${row.kind}-${row.href}-${index}`} className="ch-enter" style={{ "--ch-i": index + 1 }}>
              <SmartLink href={row.href} className="ch-also__row">
                <span className="ch-also__icon" aria-hidden="true">
                  {row.kind === "live_now" ? <LiveDot state="live" /> : <Icon size={20} />}
                </span>
                <span className="ch-also__text">
                  <span className="ch-also__label">{row.label}</span>
                  {meta ? <span className="ch-also__meta">{meta}</span> : null}
                </span>
                {isExternalHref(row.href) ? (
                  <Launch size={16} aria-hidden="true" className="ch-also__chevron" />
                ) : (
                  <ChevronRight size={20} aria-hidden="true" className="ch-also__chevron" />
                )}
              </SmartLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Your courses": up to three cards with progress. */
export function CourseCards({ courses = [], startIndex = 4 }) {
  if (!courses.length) return null;
  return (
    <section className="ch-section" aria-labelledby="ch-courses-title">
      <div className="ch-section__header">
        <h2 id="ch-courses-title" className="ch-section__title">
          Your courses
        </h2>
        <Link to="/my-courses" className="ch-section__link">
          All courses
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
      <ul className="ch-courses">
        {courses.map((course, index) => (
          <li key={course.id} className="ch-enter" style={{ "--ch-i": startIndex + index }}>
            <Link to={course.href || `/learn/${course.id}`} className="ch-course">
              <Artwork src={course.image} className="ch-course__art" />
              <span className="ch-course__body">
                <span className="ch-course__title">{course.title}</span>
                <span className="ch-course__progress">
                  <Meter value={course.progress} label={`${course.title} progress`} />
                  <span className="ch-course__percent">{percent(course.progress)}%</span>
                </span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One HackPath feature card (hairline cell; flips to white on hover and keyboard focus). */
function FeatureCard({ href, external = false, eyebrow, status, title, children, description, meta, action, testId, wide = false }) {
  const body = (
    <>
      <span className="ch-feature__head">
        <span className="ch-feature__eyebrow">{eyebrow}</span>
        {status ? <span className="ch-feature__status">{status}</span> : null}
      </span>
      <span className="ch-feature__title">{title}</span>
      <span className="ch-feature__demo" aria-hidden="true">
        {children}
      </span>
      <span className="ch-feature__desc">{description}</span>
      <span className="ch-feature__foot">
        <span>{meta}</span>
        <span className="ch-feature__action">
          {action}
          {external ? <Launch size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}
        </span>
      </span>
    </>
  );
  if (external) {
    return (
      <a className={`ch-feature${wide ? " ch-feature--wide" : ""}`} href={href} target="_blank" rel="noopener noreferrer" data-testid={testId}>
        {body}
        <span className="cds--visually-hidden"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link className={`ch-feature${wide ? " ch-feature--wide" : ""}`} to={href} data-testid={testId}>
      {body}
    </Link>
  );
}

/**
 * "Practice": the OSINT labs (open to everyone until the owner turns on
 * `labs_membership_required`), the Pentesting track (browsable, purchases
 * "Coming soon" until the `pentesting` switch is on) and the free OSINT
 * directory (link-out challenges: the free tier). Words only; access is
 * enforced by the servers.
 */
export function PracticeCards({ labsMembersOnly = false, pentestingOpen = false, brandId = "alsyed" }) {
  if (brandId === "owlcognito") return null;
  const access = labAccess(LABS[0], { membershipRequired: labsMembersOnly });
  return (
    <section className="ch-section" aria-labelledby="ch-practice-title">
      <div className="ch-section__header">
        <h2 id="ch-practice-title" className="ch-section__title">
          Practice
        </h2>
      </div>
      <ul className="ch-pair">
        <li>
          <FeatureCard
            href={LABS_URL}
            external
            testId="home-labs-card"
            eyebrow={`OSINT labs · ${LABS.length} labs`}
            status={labsMembersOnly ? "Members" : "Open now"}
            title="Investigate a live case"
            description={labsMembersOnly ? access.note : "Four investigation labs on labs.alsyedinitiative.com, open to everyone until memberships launch."}
            meta={`${LABS.length} labs`}
            action="Open the labs"
          >
            <span className="ch-term">
              <span className="ch-term__bar">
                <span />
                <span />
                <span />
                <span className="ch-term__name">labs.alsyedinitiative.com</span>
              </span>
              {LABS.map((lab) => (
                <span key={lab.id} className="ch-term__line">
                  <span className="ch-term__index">{lab.index}</span>
                  <span className="ch-term__title">{lab.title}</span>
                  <span className="ch-term__level">{lab.difficulty}</span>
                </span>
              ))}
            </span>
          </FeatureCard>
        </li>
        <li>
          <FeatureCard
            href={PENTESTING_TRACK_PATH}
            testId="home-pentesting-card"
            eyebrow="Pentesting track"
            status={pentestingOpen ? "Open" : "Coming soon"}
            title="Pentesting"
            description={
              pentestingOpen
                ? "Every tier is open: from the groundwork to enterprise attack paths."
                : "Browse every course and module now; enrolment opens at launch."
            }
            meta={`${PENTESTING_TIERS.length} tiers`}
            action="Browse the track"
          >
            <span className="ch-tiers">
              {PENTESTING_TIERS.map((tier, index) => (
                <span key={tier} className="ch-tiers__row">
                  <span className="ch-tiers__index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="ch-tiers__title">{tier}</span>
                </span>
              ))}
            </span>
          </FeatureCard>
        </li>
        <li className="ch-pair__wide">
          <FeatureCard
            href={FREE_DIRECTORY_PATH}
            testId="home-free-directory-card"
            eyebrow="Free tier · no lab needed"
            status="Free"
            title="Free OSINT challenges"
            description="A curated list of free challenges on other platforms. Start them there, mark them done here and earn XP on your own learning path."
            meta={`${FREE_DIRECTORY_PLATFORMS.length}+ platforms`}
            action="Browse free challenges"
            wide
          >
            <span className="ch-tiers ch-tiers--inline">
              {FREE_DIRECTORY_PLATFORMS.map((platform, index) => (
                <span key={platform} className="ch-tiers__row">
                  <span className="ch-tiers__index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="ch-tiers__title">{platform}</span>
                </span>
              ))}
            </span>
          </FeatureCard>
        </li>
      </ul>
    </section>
  );
}

export function HomeSkeleton() {
  return (
    <div className="ch-skeleton" role="status" aria-live="polite" aria-busy="true">
      <span className="cds--visually-hidden">Loading your next step</span>
      <div className="ch-next ch-next--skeleton" aria-hidden="true">
        <div className="ch-next__body">
          <SkeletonBar variant="kind" />
          <SkeletonBar variant="title" />
          <SkeletonBar variant="line" />
          <SkeletonBar variant="button" />
        </div>
        <div className="ch-next__media">
          <div className="ch-art">
            <SkeletonBar variant="art" />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Whole Home body for a /api/console/today/ payload. `engagement` is the
 * /api/engagement/me/ summary (null while the switch is off); `practice` is
 * `{ labsMembersOnly, pentestingOpen, brandId }` from capabilities.
 */
export default function HomeView({
  user,
  data,
  loading = false,
  showSkeleton = false,
  error = "",
  onRetry,
  updatedAt,
  now = new Date(),
  engagement = null,
  practice = null,
}) {
  return (
    <div className="ch-home" data-template="t1">
      <Greeting user={user} now={now} />
      <HomeStats engagement={engagement} data={data} now={now} />
      {error && !data ? <ErrorState error={error} onRetry={onRetry} /> : null}
      {loading && showSkeleton ? <HomeSkeleton /> : null}
      {data ? (
        <>
          {error ? <ErrorState error={error} onRetry={onRetry} lastUpdated={updatedAt} /> : null}
          <NextUpCard item={data.next_up} now={now} />
          <AlsoList rows={data.also} now={now} />
          <CourseCards courses={data.courses} startIndex={1 + (data.also?.length || 0)} />
        </>
      ) : null}
      {practice ? <PracticeCards {...practice} /> : null}
    </div>
  );
}
