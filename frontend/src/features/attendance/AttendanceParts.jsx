// Shared attendance UI pieces (kit-based, restylable). OWNER: WS-ATTENDANCE.
// Palette law: black, greys, whites, golden white only; status = icon + label + luminance.
import { Card } from "../../kit/Card";
import { CheckCircle, Circle, ClockDashed, HalfCircle, Info } from "../../kit/icons";
import { cn } from "../../kit/lib/cn";

import { barWidth, statusMeta } from "./attendanceModel";

const ICONS = { check: CheckCircle, half: HalfCircle, circle: Circle, info: Info, dashed: ClockDashed };
const TONES = {
  strong: "border-white/40 text-white",
  mid: "border-white/20 text-white/75",
  dim: "border-dashed border-white/20 text-white/50",
};

/** [icon] LABEL — the attendance status chip. */
export function AttendanceStatus({ status, className, label }) {
  const meta = statusMeta(status);
  const Icon = ICONS[meta.icon] || Circle;
  return (
    <span
      data-attendance={status || "unknown"}
      title={meta.description || undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide",
        TONES[meta.tone] || TONES.dim,
        className
      )}
    >
      <Icon size={12} />
      <span>{label || meta.label}</span>
    </span>
  );
}

export function StatTile({ label, value, hint, emphasis = false }) {
  return (
    <Card tone="surface" className="flex min-w-0 flex-col gap-1 p-4">
      <span className="text-xs uppercase tracking-wide text-white/55">{label}</span>
      <span className={cn("text-2xl font-semibold tabular-nums", emphasis ? "text-accent" : "text-white")}>{value}</span>
      {hint ? <span className="text-xs leading-5 text-white/55">{hint}</span> : null}
    </Card>
  );
}

/** A plain luminance bar (no hue): white fill on a dark track. */
export function PercentBar({ percent, label }) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-white/10"
      role="img"
      aria-label={label || `${Math.round(Number(percent) || 0)} percent`}
    >
      <div className="h-full rounded-full bg-white/80" style={{ width: barWidth(percent) }} />
    </div>
  );
}

export function OffState({ title = "Attendance is switched off", children }) {
  return (
    <Card tone="surface" className="flex flex-col gap-2 border-dashed p-6" role="status">
      <h2 className="text-base font-semibold text-white">{title}</h2>
      <p className="text-sm leading-6 text-white/65">
        {children || "An admin switched this section off for now. Your live classes work as usual."}
      </p>
    </Card>
  );
}

export function InlineError({ children }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm leading-6 text-white">
      <Info size={14} className="mt-1 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function PageIntro({ title, children, actions }) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {children ? <p className="max-w-2xl text-sm leading-6 text-white/65">{children}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

export function Loading({ label = "Loading…" }) {
  return (
    <p className="text-sm text-white/55" role="status" aria-live="polite">
      {label}
    </p>
  );
}
