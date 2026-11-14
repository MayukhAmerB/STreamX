// Real product UI, drawn small (PHILOSOPHY §1.4, T2): the storytelling bands
// show what learners actually use (a tier list, the protected player, the
// weekly report, a lab terminal, an exam question, the certificate) instead
// of stock imagery. Static markup, no data calls, decorative to assistive tech
// except for their visible text.
import certificateImage from "../assets/certificate-excellence.webp";
import LineArt from "./LineArt";
import { CheckCircleIcon, ClockIcon, LockIcon, OpenCircleIcon } from "./primitives";

function Bar({ title }) {
  return (
    <div className="hp-mock__bar" aria-hidden="true">
      <i />
      <i />
      <i />
      <span>{title}</span>
    </div>
  );
}

/** Step 1: choosing a track (tier rows with status words). */
export function TrackPickerMock() {
  const rows = [
    { label: "Open Source Intelligence", note: "Open", icon: <CheckCircleIcon />, active: true },
    { label: "Pentesting · Foundations", note: "Soon", icon: <ClockIcon /> },
    { label: "Pentesting · Offensive security", note: "Soon", icon: <ClockIcon /> },
    { label: "Pentesting · Quick wins", note: "Soon", icon: <ClockIcon /> },
  ];
  return (
    <div className="hp-mock">
      <Bar title="tracks" />
      <div className="hp-mock__body">
        {rows.map((row) => (
          <div key={row.label} className={`hp-mock__row${row.active ? " hp-mock__row--active" : ""}`}>
            <span className="hp-mock__label">
              {row.icon}
              <span>{row.label}</span>
            </span>
            <span className="hp-meta">{row.note}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Step 2: the protected recording player (watermark, scrubber). */
export function PlayerMock() {
  return (
    <div className="hp-mock">
      <Bar title="recording · session 07" />
      <div className="hp-mock__body">
        <div className="hp-mock__player" aria-hidden="true">
          <span className="hp-mock__play">
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
              <path d="M5 3.5v9l7.5-4.5z" />
            </svg>
          </span>
          <span className="hp-mock__watermark">learner@example · 21:04</span>
          <span className="hp-mock__scrub" />
        </div>
        <div className="hp-mock__row" style={{ marginTop: 12 }}>
          <span className="hp-mock__label">
            <LockIcon />
            <span>Watermarked to your account</span>
          </span>
          <span className="hp-meta">42:18</span>
        </div>
      </div>
    </div>
  );
}

/** Step 3: a marked weekly report. */
export function ReportMock() {
  return (
    <div className="hp-mock">
      <Bar title="weekly report · week 3" />
      <div className="hp-mock__body">
        <div className="hp-mock__row" style={{ alignItems: "flex-start" }}>
          <span>
            <span className="hp-eyebrow">Marked by your instructor</span>
            <span className="hp-mock__grade">
              17<small>/ 20</small>
            </span>
          </span>
          <span className="hp-status hp-status--open">
            <CheckCircleIcon />
            Graded
          </span>
        </div>
        <div className="hp-mock__row">
          <span className="hp-mock__label">
            <span>“Sources are cited; the timeline needs one more pivot.”</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Step 4 / practice band: a lab terminal with an objective. */
export function TerminalMock({ title = "lab · case 02", lines }) {
  const rows = lines || [
    { kind: "prompt", text: "$ objective" },
    { kind: "out", text: "Find where the handle was first used. Cite every source." },
    { kind: "prompt", text: "$ pivot --from handle --to archive" },
    { kind: "out", text: "3 archived profiles · 1 reused avatar · 2 timestamps" },
    { kind: "prompt", text: "$ submit --flag" },
    { kind: "hit", text: "Correct. Evidence chain recorded." },
  ];
  return (
    <div className="hp-mock">
      <Bar title={title} />
      <div className="hp-mock__body">
        <p className="hp-term">
          {rows.map((row, index) => (
            <span key={index} className={row.kind === "prompt" ? "hp-term__prompt" : row.kind === "hit" ? "hp-term__hit" : "hp-term__out"}>
              {row.text}
              {"\n"}
            </span>
          ))}
          <span className="hp-term__caret" aria-hidden="true" />
        </p>
      </div>
    </div>
  );
}

/** Step 5: one exam question. */
export function ExamMock() {
  return (
    <div className="hp-mock">
      <Bar title="examination · question 4 of 20" />
      <div className="hp-mock__body">
        <p className="hp-mock__q">Which source proves the photo predates the event?</p>
        <div className="hp-mock__options" aria-hidden="true">
          <span className="hp-mock__option">The caption on the repost</span>
          <span className="hp-mock__option hp-mock__option--picked">An archived copy with an earlier capture date</span>
          <span className="hp-mock__option">The account's follower count</span>
        </div>
      </div>
    </div>
  );
}

/** Step 6: the certificate (greyscale). */
export function CertificateMock() {
  return (
    <div className="hp-mock">
      <Bar title="certificate · verified" />
      <div className="hp-mock__body">
        <img className="hp-mock__cert" src={certificateImage} alt="A sample certificate of excellence" width="1600" height="900" loading="lazy" decoding="async" />
      </div>
    </div>
  );
}

/** "Never on your own": a course outline with the live class and a lecture question. */
export function ClassroomMock() {
  const outline = [
    { title: "Search operators that hold up", state: "done" },
    { title: "Reverse image and video checks", state: "done" },
    { title: "Live class: verifying a viral claim", state: "active" },
    { title: "Weekly report 4", state: "next" },
  ];
  return (
    <div className="hp-mock">
      <Bar title="course · week 4" />
      <div className="hp-mock__body">
        {outline.map((item) => (
          <div key={item.title} className={`hp-mock__row${item.state === "active" ? " hp-mock__row--active" : ""}`}>
            <span className="hp-mock__label">
              {item.state === "done" ? <CheckCircleIcon /> : item.state === "active" ? <span className="hp-live-dot" aria-hidden="true" /> : <OpenCircleIcon />}
              <span>{item.title}</span>
            </span>
            <span className="hp-meta">{item.state === "active" ? "Live" : item.state === "done" ? "Watched" : "Due Sun"}</span>
          </div>
        ))}
        <div className="hp-mock__row" style={{ marginTop: 16, alignItems: "flex-start" }}>
          <span>
            <span className="hp-eyebrow">Question on lecture 2 · answered</span>
            <span style={{ display: "block", marginTop: 6 }}>“Is a cached page enough as a source?” — “Archive it yourself and cite both.”</span>
          </span>
        </div>
      </div>
    </div>
  );
}

/** A small line-art tile used by the roadmap and feature cards. */
export function ArtTile({ name }) {
  return (
    <span className="hp-card__art" aria-hidden="true">
      <LineArt name={name} />
    </span>
  );
}
