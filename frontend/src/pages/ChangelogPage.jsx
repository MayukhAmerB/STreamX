// /changelog: "What's new" for every release in config/releaseNotes.js, newest
// first. The version pill in the site footer and the Console sidebar opens it.
import { RELEASES } from "../config/releaseNotes";
import { ButtonLink, CheckList, Tagline } from "../marketing/primitives";

function formatDate(iso) {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
}

export function ReleaseEntry({ release, headingLevel: Heading = "h2" }) {
  const id = `release-${release.version.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <article className="hp-release" aria-labelledby={id}>
      <header className="hp-release__head">
        <Heading id={id} className="hp-h3">
          What&apos;s new in <span className="hp-version-pill hp-version-pill--static">{release.version}</span>
        </Heading>
        {release.date ? (
          <time className="hp-release__date" dateTime={release.date}>
            {formatDate(release.date)}
          </time>
        ) : null}
      </header>
      {release.summary ? <p className="hp-lead hp-release__summary">{release.summary}</p> : null}
      <div className="hp-release__groups">
        {release.groups.map((group) => (
          <section key={group.title} className="hp-release__group" aria-label={group.title}>
            <h3 className="hp-release__group-title">{group.title}</h3>
            <CheckList items={group.items.map((text) => ({ text }))} />
          </section>
        ))}
      </div>
    </article>
  );
}

export default function ChangelogPage() {
  const [latest, ...older] = RELEASES;
  return (
    <div className="hp-changelog-page">
      <section className="hp-hero hp-hero--page" aria-labelledby="hp-changelog-title">
        <Tagline>Release notes</Tagline>
        <h1 id="hp-changelog-title" className="hp-display">
          What&apos;s new in {latest.version}
        </h1>
        <p className="hp-lead">Everything that changed on the website, the Console, the labs and the exams, version by version.</p>
      </section>
      <section className="hp-band hp-band--tight-top" aria-label="Releases">
        <div className="hp-frame hp-release-list">
          <ReleaseEntry release={latest} />
          {older.map((release) => (
            <ReleaseEntry key={release.version} release={release} />
          ))}
          <div className="hp-actions">
            <ButtonLink to="/" variant="secondary" arrow>
              Back to the home page
            </ButtonLink>
            <ButtonLink to="/console" variant="ghost" arrow>
              Open the Console
            </ButtonLink>
          </div>
        </div>
      </section>
    </div>
  );
}
