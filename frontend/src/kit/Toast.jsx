// Toast on Radix Toast (BUILD_PLAN §2.2 engagement row). OWNER: WS-KIT.
//
// <Toaster /> once near the root, then `toast({ title, description, kind })`
// from anywhere. Polite live region (assertive only for kind="critical"),
// 4 s by default, paused while hovered or focused (Radix), F8 jumps to the
// viewport, swipe to dismiss. Status = icon + word + luminance (StatusBadge
// kinds), never hue. Reduced motion: opacity only, no slide.
import * as ToastPrimitive from "@radix-ui/react-toast";
import { useSyncExternalStore } from "react";

import { STATUS_KINDS } from "./Badge";
import { Close } from "./icons";
import { cn } from "./lib/cn";

/* ---------------------------------------------------------------- store */

let items = [];
let nextId = 1;
const listeners = new Set();
const emit = () => listeners.forEach((listener) => listener());

/**
 * Shows a toast. Returns its id.
 * { title, description?, kind? ("done" | "attention" | "critical" | "progress" | "live" | ...),
 *   duration? (ms, default 4000), action?: { label, onClick, altText } }
 */
export function toast(options) {
  const entry = { id: nextId++, duration: 4000, kind: "neutral", ...(typeof options === "string" ? { title: options } : options) };
  items = [...items, entry].slice(-4);
  emit();
  return entry.id;
}

/** Removes one toast (or every toast without an id). */
export function dismissToast(id) {
  items = id === undefined ? [] : items.filter((entry) => entry.id !== id);
  emit();
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => items;

/** Current toasts (for tests or custom renderers). */
export function useToasts() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/* ---------------------------------------------------------------- view */

function ToastItem({ entry }) {
  const spec = STATUS_KINDS[entry.kind] || STATUS_KINDS.neutral;
  const Icon = spec.icon;
  const critical = entry.kind === "critical";
  return (
    <ToastPrimitive.Root
      duration={entry.duration}
      type={critical ? "foreground" : "background"}
      onOpenChange={(open) => {
        if (!open) dismissToast(entry.id);
      }}
      data-kind={entry.kind}
      className={cn(
        "group pointer-events-auto relative flex w-full items-start gap-3 rounded-lg border p-4 pr-11 shadow-window",
        critical ? "border-white bg-white text-black" : "border-white/10 bg-card-raised text-white",
        entry.kind === "attention" && "border-accent/40",
        "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none",
        "data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=cancel]:translate-x-0 data-[swipe=end]:animate-fade-out",
        "motion-safe:data-[swipe=cancel]:transition-transform"
      )}
    >
      {entry.kind === "live" ? (
        <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-accent shadow-[0_0_8px_rgb(243_226_179/.7)]" />
      ) : Icon ? (
        <Icon size={18} className={cn("mt-0.5 shrink-0", entry.kind === "attention" ? "text-accent" : critical ? "text-black" : "text-white")} />
      ) : null}
      <div className="min-w-0 flex-1">
        {spec.label && entry.kind !== "neutral" ? (
          <p className={cn("eyebrow", critical ? "text-black/70" : entry.kind === "attention" ? "text-accent" : "")}>{entry.label || spec.label}</p>
        ) : null}
        <ToastPrimitive.Title className="text-sm font-semibold leading-5">{entry.title}</ToastPrimitive.Title>
        {entry.description ? (
          <ToastPrimitive.Description className={cn("mt-1 text-sm leading-5", critical ? "text-black/75" : "text-muted-foreground")}>
            {entry.description}
          </ToastPrimitive.Description>
        ) : null}
        {entry.action ? (
          <ToastPrimitive.Action
            altText={entry.action.altText || entry.action.label}
            onClick={entry.action.onClick}
            className={cn(
              "mt-3 inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium transition-colors duration-150",
              critical ? "border-black/30 hover:bg-black hover:text-white" : "border-white/20 hover:bg-white/[.08]",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            )}
          >
            {entry.action.label}
          </ToastPrimitive.Action>
        ) : null}
      </div>
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className={cn(
          "absolute right-2 top-2 inline-flex size-8 items-center justify-center rounded-md transition-colors duration-150",
          critical ? "text-black/70 hover:bg-black/10" : "text-subtle hover:bg-white/[.06] hover:text-white",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        )}
      >
        <Close size={16} />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}

/** Mount once (e.g. in the app shell). `label` names the region for screen readers (F8 focuses it). */
export function Toaster({ label = "Notifications ({hotkey})", className }) {
  const list = useToasts();
  return (
    <ToastPrimitive.Provider swipeDirection="right" label="Notification">
      {list.map((entry) => (
        <ToastItem key={entry.id} entry={entry} />
      ))}
      <ToastPrimitive.Viewport
        label={label}
        className={cn(
          "fixed bottom-0 right-0 z-[100] m-0 flex w-full max-w-sm list-none flex-col gap-2 p-4 outline-none sm:bottom-4 sm:right-4 sm:p-0",
          "pb-[max(1rem,env(safe-area-inset-bottom))]",
          className
        )}
      />
    </ToastPrimitive.Provider>
  );
}

export default Toaster;
