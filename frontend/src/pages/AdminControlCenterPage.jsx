import { Link } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import WorkflowGuidePanel from "../components/admin/WorkflowGuidePanel";
import { resolveDjangoAdminUrl } from "../utils/backendUrl";

const operationsCards = [
  {
    title: "Identity & Access",
    detail: "Manage admin-created user accounts, registration toggle, and account lifecycle from Django Admin.",
    action: { label: "Open Django Admin", href: "/admin/", external: true },
  },
  {
    title: "Meeting Operations",
    detail: "Launch interactive classes up to 200 participants with auto-overflow to broadcast mode.",
    action: { label: "Open Meeting Control", href: "/meeting", external: false },
  },
  {
    title: "Broadcast Operations",
    detail: "Run high-scale one-to-many streams with host studio controls and moderated audience chat.",
    action: { label: "Open Broadcast Control", href: "/broadcasting", external: false },
  },
];

const adminPlaybook = [
  {
    title: "Provision",
    description: "Create admin/student/instructor users in Django Admin and keep public registration disabled by default.",
  },
  {
    title: "Operate",
    description: "Create sessions from Meeting or Broadcasting control, then monitor live state and delete stale sessions.",
  },
  {
    title: "Audit",
    description: "Review API security logs, failed login events, and rotate secrets/env keys on a scheduled cadence.",
  },
];

const securityChecklist = [
  "Enforce HTTPS + secure cookie flags in production environment.",
  "Keep registration disabled unless campaign onboarding is active.",
  "Rotate JWT/API/LiveKit/Owncast secrets on a fixed schedule.",
  "Review failed login and lockout events from backend audit logs daily.",
  "Restrict DB access by IP/VPC and use managed backups with retention.",
];

export default function AdminControlCenterPage() {
  const djangoAdminUrl = resolveDjangoAdminUrl();

  return (
    <PageShell
      title="Admin Control Center"
      subtitle="Operational cockpit for users, content, live sessions, and platform governance."
      badge="ADMIN OPERATIONS"
    >
      <div className="grid gap-4 lg:grid-cols-3">
        {operationsCards.map((card) => (
          <article
            key={card.title}
            className="rounded-2xl border border-black panel-gradient p-4 shadow-[0_14px_34px_rgba(0,0,0,0.24)]"
          >
            <h3 className="font-reference text-lg text-white">{card.title}</h3>
            <p className="mt-2 text-sm leading-7 text-[#BBBBBB]">{card.detail}</p>
            <div className="mt-4">
              {card.action.external ? (
                <a
                  href={card.action.href === "/admin/" ? djangoAdminUrl : card.action.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Button className="w-full">{card.action.label}</Button>
                </a>
              ) : (
                <Link to={card.action.href}>
                  <Button className="w-full">{card.action.label}</Button>
                </Link>
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="mt-5">
        <WorkflowGuidePanel
          title="Admin Workflow"
          subtitle="Use this sequence for safe day-to-day operations."
          steps={adminPlaybook}
        />
      </div>

      <section className="mt-5 rounded-2xl border border-black panel-gradient p-4 shadow-[0_16px_34px_rgba(0,0,0,0.26)] sm:p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
          Security Runbook
        </div>
        <ul className="mt-3 space-y-2 text-sm text-[#CBCBCB]">
          {securityChecklist.map((item) => (
            <li key={item} className="rounded-lg border border-black panel-gradient px-3 py-2">
              {item}
            </li>
          ))}
        </ul>
      </section>
    </PageShell>
  );
}
