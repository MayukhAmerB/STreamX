// Syed Carbon component gallery (dev only, UI overhaul §7.5 WS-A). OWNER: WS-A.
// Every §2.5 component in its real states, inside the Console theme
// (.cds-app, Carbon g100) and, for the shared site kit, on a light band.
import { Add, Education, Flag } from "@carbon/icons-react";
import { Button } from "@carbon/react";
import { useEffect, useState } from "react";
import "../../features/app-shell/styles/carbon-app.scss";
import {
  BulkBar,
  ConfirmDialog,
  DisabledReason,
  DropZone,
  EmptyState,
  ErrorState,
  NotFoundState,
  PageHeader,
  ProgressMeter,
  ResponsiveTable,
  ScrollTabs,
  SegmentedSwitch,
  SidePanel,
  StatusTag,
  STATUS_VOCABULARY,
  StickyActionBar,
  T3Detail,
  ToastProvider,
  Toolbar,
  useToast,
} from "../../features/app-shell/ui";
import { BarList, Sparkline, StatTile } from "../data";
import { CountUp, LiveDot, Meter, RollingDigits, useStagger } from "../motion";
import "./kit.css";

const ROWS = [
  { id: 1, name: "Sana Shaikh", course: "OSINT Foundations", requested: "2 days ago", status: "due" },
  { id: 2, name: "Imran Ali", course: "Web Application Pentesting", requested: "5 hours ago", status: "processing" },
  { id: 3, name: "Ayesha Khan", course: "OSINT Foundations", requested: "Yesterday", status: "late" },
  { id: 4, name: "Rahul Verma", course: "OSINT Live Classes, Batch IV", requested: "3 days ago", status: "published" },
];

function Section({ id, title, children, active }) {
  if (active && active !== id) return null;
  return (
    <section className="kit-section" id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="kit-section__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Countdown() {
  const [minutes, setMinutes] = useState(268);
  useEffect(() => {
    const timer = setInterval(() => setMinutes((value) => (value > 0 ? value - 1 : 268)), 2000);
    return () => clearInterval(timer);
  }, []);
  const text = `${String(Math.floor(minutes / 60)).padStart(2, "0")} h ${String(minutes % 60).padStart(2, "0")} m`;
  return <RollingDigits value={text} />;
}

function ToastButtons() {
  const { showToast } = useToast();
  return (
    <div className="kit-row">
      <Button kind="tertiary" size="md" onClick={() => showToast({ kind: "success", title: "Approved", subtitle: "Sana Shaikh · OSINT Foundations", action: { label: "Undo", onClick() {} } })}>
        Show a toast
      </Button>
      <Button kind="ghost" size="md" onClick={() => showToast({ kind: "error", title: "Couldn't publish the recording", subtitle: "Try again in a minute." })}>
        Show an error toast
      </Button>
    </div>
  );
}

function Tiles() {
  const enter = useStagger(true);
  return (
    <div className="kit-grid">
      {["Enrolment requests", "Reports to grade", "Recordings to review"].map((label, index) => (
        <article key={label} className="kit-tile" {...enter(index)}>
          <p className="kit-tile__label">{label}</p>
          <p className="kit-tile__count">
            <CountUp value={[4, 12, 1][index]} sessionKey={`kit:${label}`} />
          </p>
          <p className="kit-tile__meta">oldest {["2 d", "3 d", "5 h"][index]}</p>
          <Button size="md" kind={index === 1 ? "primary" : "tertiary"} className={index === 1 ? "sc-button--accent" : undefined}>
            {index === 1 ? "Open queue" : "Review"}
          </Button>
        </article>
      ))}
    </div>
  );
}

export default function KitGallery({ section }) {
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState("all");
  const [selection, setSelection] = useState([]);
  const [workspace, setWorkspace] = useState("learn");
  const [tab, setTab] = useState("week");
  const [panel, setPanel] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const rows = ROWS.filter((row) => row.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="cds-app kit" data-shell-layout="desktop">
      <ToastProvider>
        <main className="kit-main">
          {!section ? (
            <header className="kit-intro">
              <p className="cds-page-header__eyebrow">Syed Carbon · dev gallery</p>
              <h1 className="cds-page-header__title">Components and motion</h1>
              <p className="cds-page-header__description">Every UI overhaul component in its real states. Try ?radius=4 and ?motion=reduce.</p>
            </header>
          ) : null}

          <Section id="header" title="Page header" active={section}>
            <PageHeader
              title="Requests"
              description="Approve or reject enrolment and live-class requests."
              breadcrumbs={[{ label: "Admin", href: "/console/admin" }, { label: "Requests" }]}
              secondaryAction={{ label: "Export", onClick() {} }}
              primaryAction={{ label: "Review 4", onClick() {}, accent: true }}
              overflowActions={[{ label: "Open back office", href: "/admin/" }, { label: "Delete filters", onClick() {}, danger: true }]}
            />
          </Section>

          <Section id="buttons" title="Buttons, status and live" active={section}>
            <div className="kit-row">
              <Button className="sc-button--accent">Join live</Button>
              <Button kind="primary">Save</Button>
              <Button kind="tertiary">Secondary</Button>
              <Button kind="ghost" renderIcon={Add}>
                Ghost
              </Button>
              <Button kind="danger--ghost">Delete</Button>
              <Button kind="primary" disabled>
                Disabled
              </Button>
            </div>
            <div className="kit-row">
              {Object.keys(STATUS_VOCABULARY).map((status) => (
                <StatusTag key={status} status={status} />
              ))}
            </div>
            <div className="kit-row kit-row--text">
              <span className="kit-inline">
                <LiveDot state="live" /> On air
              </span>
              <span className="kit-inline">
                <LiveDot state="reconnecting" /> Host reconnecting · 0:41
              </span>
              <span className="kit-inline">
                Opens in <Countdown />
              </span>
            </div>
          </Section>

          <Section id="data" title="Numbers and charts" active={section}>
            <Tiles />
            <div className="kit-grid kit-grid--2">
              <div className="kit-card">
                <BarList
                  caption="Marks by week"
                  max={10}
                  target={7.2}
                  data={[
                    { label: "Week of 19-25 Oct", value: 6.5 },
                    { label: "Week of 26 Oct-1 Nov", value: 7 },
                    { label: "Week of 2-8 Nov", value: 8 },
                    { label: "Week of 9-15 Nov", value: 8.5, highlight: true },
                  ]}
                />
              </div>
              <div className="kit-card kit-card--stack">
                <div className="kit-stats">
                  <StatTile label="Average" value={7.8} delta={12} sessionKey="kit:avg" />
                  <StatTile label="Late reports" value={3} delta={-4} sessionKey="kit:late" />
                </div>
                <Sparkline caption="Enrolments this week" points={[2, 4, 3, 6, 5, 8, 9]} />
                <ProgressMeter progress={{ percent: 40, summary: "8 of 20 lessons done" }} name="OSINT Foundations" />
                <Meter value={1} label="Upload complete" />
              </div>
            </div>
          </Section>

          <Section id="list" title="List: toolbar, table, bulk bar" active={section}>
            <Toolbar
              search={{ value: query, onChange: setQuery, placeholder: "Search requests" }}
              chips={[
                { key: "all", label: "All", count: 4, active: chip === "all" },
                { key: "due", label: "Waiting", count: 2, active: chip === "due" },
                { key: "late", label: "Older than 2 days", count: 1, active: chip === "late" },
              ]}
              onChipClick={(item) => setChip(item.key)}
              count={rows.length}
              countLabel={`${rows.length} requests`}
            />
            <ResponsiveTable
              caption="Requests"
              selectable
              selected={selection}
              onSelectionChange={setSelection}
              columns={[
                { key: "name", header: "Student" },
                { key: "course", header: "Course" },
                { key: "requested", header: "Requested" },
                { key: "status", header: "Status", render: (row) => <StatusTag status={row.status} /> },
              ]}
              rows={rows}
              getRowHref={(row) => `/console/admin/requests?open=${row.id}`}
              emptyState={<EmptyState icon={Education} title="No requests match" body="Clear the search to see every request." />}
            />
            <BulkBar
              count={selection.length}
              actions={[{ label: "Approve", onClick() {} }, { label: "Reject", onClick() {}, danger: true }]}
              onClear={() => setSelection([])}
            />
          </Section>

          <Section id="nav" title="Switch and tabs" active={section}>
            <SegmentedSwitch
              value={workspace}
              onChange={setWorkspace}
              options={[
                { key: "learn", label: "Learn", state: "enabled" },
                { key: "teach", label: "Teach", state: "disabled", reason: "Teaching tools are switched off for now. An admin can turn them on." },
              ]}
            />
            <SegmentedSwitch
              value={workspace === "teach" ? "learn" : workspace}
              onChange={setWorkspace}
              options={[
                { key: "learn", label: "Learn", state: "enabled" },
                { key: "admin", label: "Admin", state: "enabled" },
              ]}
            />
            <ScrollTabs
              activeKey={tab}
              tabs={[
                { key: "week", label: "This week", badge: 1, onClick: () => setTab("week") },
                { key: "grades", label: "Grades", onClick: () => setTab("grades") },
                { key: "exams", label: "Exams", onClick: () => setTab("exams") },
                { key: "notes", label: "Notes", onClick: () => setTab("notes") },
                { key: "comments", label: "Comments", onClick: () => setTab("comments") },
              ]}
            />
            <div className="kit-row kit-row--text">
              <DisabledReason as="button" reason="Choose a file first.">
                Check file
              </DisabledReason>
            </div>
          </Section>

          <Section id="forms" title="Drop zone and form actions" active={section}>
            <div className="kit-form">
              <DropZone accept=".json" maxBytes={2 * 1024 * 1024} onFiles={() => {}} label="Drop the exam JSON here" hint="One .json file, up to 2 MB." icon={Flag} />
              <DropZone onFiles={() => {}} disabledReason="Link a class to a course first." label="Drop the OBS recording here" />
              <StickyActionBar dirty primary={<Button>Save changes</Button>} secondary={<Button kind="ghost">Cancel</Button>} />
            </div>
          </Section>

          <Section id="states" title="Empty, error and not found" active={section}>
            <EmptyState icon={Education} title="You're not enrolled yet" body="Pick a course to start learning." action={<Button kind="tertiary">Browse courses</Button>} />
            <ErrorState error="We couldn't reach the server." onRetry={() => {}} lastUpdated={new Date(2026, 10, 14, 14, 2)} />
            <NotFoundState title="This exam does not exist" backHref="/console/admin/exams" backLabel="Back to Exams" />
          </Section>

          <Section id="overlays" title="Overlays and toasts" active={section}>
            <div className="kit-row">
              <Button kind="tertiary" onClick={() => setPanel(true)}>
                Open side panel
              </Button>
              <Button kind="danger--ghost" onClick={() => setConfirm(true)}>
                Delete class
              </Button>
            </div>
            <ToastButtons />
            <SidePanel
              open={panel}
              title="Week 3 recording"
              subtitle="OSINT Foundations · uploaded 2 h ago"
              onClose={() => setPanel(false)}
              tabs={[
                { key: "summary", label: "Summary", content: <p className="kit-copy">Ready to publish. 1 h 12 m, 1080p.</p> },
                { key: "activity", label: "Activity", content: <p className="kit-copy">Uploaded by Sana · checked for viruses.</p> },
                { key: "advanced", label: "Advanced", content: <p className="kit-copy">Open in the back office.</p> },
              ]}
              footer={
                <>
                  <Button kind="secondary" onClick={() => setPanel(false)}>
                    Cancel
                  </Button>
                  <Button className="sc-button--accent">Publish</Button>
                </>
              }
            />
            <ConfirmDialog
              open={confirm}
              title="Delete this class?"
              objectName="E2E OBS broadcast"
              body="Students lose the join link. Recordings stay."
              confirmLabel="Delete"
              danger
              reason="required"
              onConfirm={() => setConfirm(false)}
              onCancel={() => setConfirm(false)}
            />
          </Section>

          <Section id="template" title="Template T3 (detail)" active={section}>
            <T3Detail
              header={<PageHeader title="OSINT Foundations" description="12 modules · 48 lessons" />}
              main={<div className="kit-card kit-copy">Main column (2/3). Curriculum, lessons and the editor live here.</div>}
              aside={
                <div className="kit-card kit-copy">
                  <StatusTag status="published" /> Side column (1/3): meta and actions.
                </div>
              }
            />
          </Section>

          <Section id="light" title="Shared kit on a light band" active={section}>
            <div data-theme="white" className="kit-light">
              <StatTile label="Learners trained" value={1240} sessionKey="kit:learners" />
              <BarList caption="Seats filled" max={40} data={[{ label: "Batch III", value: 32 }, { label: "Batch IV", value: 38, highlight: true }]} />
              <span className="kit-inline">
                <LiveDot state="live" /> Live now
              </span>
            </div>
          </Section>
        </main>
      </ToastProvider>
    </div>
  );
}
