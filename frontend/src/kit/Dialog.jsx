// Dialog and Sheet (Radix Dialog: focus trap, Esc, focus restore, aria-modal).
// OWNER: WS-KIT. PHILOSOPHY §2.7 mobile menu / §5 N1.
//
// Dialog: centred #111 panel, white/10 hairline, .625rem radius, 150 ms fade.
// Sheet: a full-height black panel from the top (the mobile menu) or a side
// panel; it opens instantly or with a 150 ms fade, never slides under reduced motion.
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { forwardRef, useRef } from "react";

import { Close } from "./icons";
import { cn } from "./lib/cn";

/**
 * Focus restore for dialogs opened WITHOUT a Radix Trigger (a shortcut or a
 * controlled `open`): Radix only refocuses its own trigger, so we remember
 * what had focus when the dialog opened and return there on close. With a
 * trigger it is the same element. Returns the two Content handlers.
 */
export function useReturnFocus({ onOpenAutoFocus, onCloseAutoFocus } = {}) {
  const previous = useRef(null);
  return {
    onOpenAutoFocus: (event) => {
      if (typeof document !== "undefined") previous.current = document.activeElement;
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event) => {
      onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      const target = previous.current;
      previous.current = null;
      if (target && typeof target.focus === "function" && target.isConnected && target !== document.body) {
        event.preventDefault();
        target.focus({ preventScroll: true });
      }
    },
  };
}

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export const DialogOverlay = forwardRef(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        "fixed inset-0 z-[80] bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none",
        className
      )}
      {...props}
    />
  );
});

function CloseButton({ className }) {
  return (
    <DialogPrimitive.Close
      className={cn(
        "inline-flex size-10 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-white/[.06] hover:text-white",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
    >
      <Close size={18} />
      <span className="sr-only">Close</span>
    </DialogPrimitive.Close>
  );
}

export const DialogContent = forwardRef(function DialogContent(
  { className, children, hideClose = false, overlayClassName, onOpenAutoFocus, onCloseAutoFocus, ...props },
  ref
) {
  const focus = useReturnFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-[81] w-[calc(100vw-2.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2",
          "max-h-[calc(100dvh-2.5rem)] overflow-y-auto rounded-lg border border-white/10 bg-card-raised p-6 text-white shadow-window",
          "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none",
          "focus-visible:outline-none",
          className
        )}
        {...props}
        {...focus}
      >
        {children}
        {hideClose ? null : <CloseButton className="absolute right-3 top-3" />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export function DialogHeader({ className, ...props }) {
  return <div className={cn("flex flex-col gap-2 pr-10", className)} {...props} />;
}

export function DialogFooter({ className, ...props }) {
  return <div className={cn("mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end", className)} {...props} />;
}

export const DialogTitle = forwardRef(function DialogTitle({ className, ...props }, ref) {
  return <DialogPrimitive.Title ref={ref} className={cn("text-xl font-semibold leading-tight text-white", className)} {...props} />;
});

export const DialogDescription = forwardRef(function DialogDescription({ className, ...props }, ref) {
  return <DialogPrimitive.Description ref={ref} className={cn("text-sm leading-6 text-muted-foreground", className)} {...props} />;
});

/* ---------------------------------------------------------------- Sheet */

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;

const SHEET_SIDES = {
  // The mobile menu: full height under a 64px bar, black, gutters px-5.
  top: "inset-x-0 top-16 h-[calc(100dvh-4rem)] w-full border-t border-white/10",
  full: "inset-0 h-[100dvh] w-full",
  right: "inset-y-0 right-0 h-[100dvh] w-[min(26rem,100vw)] border-l border-white/10",
  left: "inset-y-0 left-0 h-[100dvh] w-[min(22rem,100vw)] border-r border-white/10",
  bottom: "inset-x-0 bottom-0 max-h-[85dvh] w-full rounded-t-lg border-t border-white/10",
};

export const SheetContent = forwardRef(function SheetContent(
  { side = "right", className, children, hideClose = false, overlay = true, onOpenAutoFocus, onCloseAutoFocus, ...props },
  ref
) {
  const focus = useReturnFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPortal>
      {overlay ? <DialogOverlay className={side === "top" ? "top-16 bg-black" : undefined} /> : null}
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed z-[81] flex flex-col overflow-y-auto bg-black px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-5 text-white sm:px-8",
          "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none",
          "focus-visible:outline-none",
          SHEET_SIDES[side] || SHEET_SIDES.right,
          className
        )}
        {...props}
        {...focus}
      >
        {children}
        {hideClose ? null : <CloseButton className="absolute right-3 top-3" />}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});

export const SheetTitle = DialogTitle;
export const SheetDescription = DialogDescription;

/**
 * A mobile-menu row: 18px link + right chevron, separated by hairlines (about 69px tall).
 * Render inside <SheetContent side="top">; pass `asChild` content such as a router Link.
 */
export function SheetNavList({ className, ...props }) {
  return <ul className={cn("divide-y divide-white/10 border-b border-white/10", className)} {...props} />;
}
