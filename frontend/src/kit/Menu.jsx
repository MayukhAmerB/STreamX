// DropdownMenu and Tooltip (Radix: roving focus, typeahead, Esc, collision
// handling). OWNER: WS-KIT. Panels are #111 with a white/10 hairline and the
// .625rem radius; items are 14px, highlighted with white/6, never a hue.
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { forwardRef } from "react";

import { Check, ChevronRight } from "./icons";
import { cn } from "./lib/cn";

const panel =
  "z-[90] min-w-[12rem] overflow-hidden rounded-lg border border-white/10 bg-card-raised p-1 text-white shadow-window data-[state=open]:animate-fade-in motion-reduce:animate-none";
const item =
  "relative flex min-h-10 cursor-default select-none items-center gap-2 rounded-md px-3 text-sm text-white/[.82] outline-none transition-colors duration-150 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-white/[.06] data-[highlighted]:text-white";

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownMenuTrigger = DropdownPrimitive.Trigger;
export const DropdownMenuGroup = DropdownPrimitive.Group;
export const DropdownMenuPortal = DropdownPrimitive.Portal;
export const DropdownMenuSub = DropdownPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownPrimitive.RadioGroup;

export const DropdownMenuContent = forwardRef(function DropdownMenuContent({ className, sideOffset = 8, align = "start", ...props }, ref) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content ref={ref} sideOffset={sideOffset} align={align} className={cn(panel, className)} {...props} />
    </DropdownPrimitive.Portal>
  );
});

export const DropdownMenuItem = forwardRef(function DropdownMenuItem({ className, inset, ...props }, ref) {
  return <DropdownPrimitive.Item ref={ref} className={cn(item, inset && "pl-8", className)} {...props} />;
});

export const DropdownMenuCheckboxItem = forwardRef(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DropdownPrimitive.CheckboxItem ref={ref} className={cn(item, "pl-8", className)} {...props}>
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <DropdownPrimitive.ItemIndicator>
          <Check size={14} />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.CheckboxItem>
  );
});

export const DropdownMenuRadioItem = forwardRef(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
  return (
    <DropdownPrimitive.RadioItem ref={ref} className={cn(item, "pl-8", className)} {...props}>
      <span className="absolute left-2.5 flex size-4 items-center justify-center">
        <DropdownPrimitive.ItemIndicator>
          <span className="size-1.5 rounded-full bg-white" />
        </DropdownPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownPrimitive.RadioItem>
  );
});

export const DropdownMenuLabel = forwardRef(function DropdownMenuLabel({ className, ...props }, ref) {
  return <DropdownPrimitive.Label ref={ref} className={cn("px-3 pb-1 pt-2 text-eyebrow font-medium uppercase text-subtle", className)} {...props} />;
});

export const DropdownMenuSeparator = forwardRef(function DropdownMenuSeparator({ className, ...props }, ref) {
  return <DropdownPrimitive.Separator ref={ref} className={cn("-mx-1 my-1 h-px bg-white/10", className)} {...props} />;
});

export const DropdownMenuSubTrigger = forwardRef(function DropdownMenuSubTrigger({ className, children, ...props }, ref) {
  return (
    <DropdownPrimitive.SubTrigger ref={ref} className={cn(item, "data-[state=open]:bg-white/[.06]", className)} {...props}>
      {children}
      <ChevronRight size={14} className="ml-auto" />
    </DropdownPrimitive.SubTrigger>
  );
});

export const DropdownMenuSubContent = forwardRef(function DropdownMenuSubContent({ className, ...props }, ref) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.SubContent ref={ref} className={cn(panel, className)} {...props} />
    </DropdownPrimitive.Portal>
  );
});

export function DropdownMenuShortcut({ className, ...props }) {
  return <span className={cn("ml-auto font-mono text-xs tracking-wider text-subtle", className)} {...props} />;
}

/* -------------------------------------------------------------- Tooltip */

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * <Tooltip content="Copy link"><button …/></Tooltip>
 * Opens on hover AND keyboard focus, closes on Esc; never the only place a
 * required piece of information lives (use DisabledReason for reasons).
 */
export function Tooltip({ content, children, side = "top", delayDuration = 300, open, defaultOpen, onOpenChange }) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={8}
            className="z-[95] max-w-xs rounded-md border border-white/10 bg-card-raised px-3 py-2 text-xs leading-5 text-white shadow-window data-[state=delayed-open]:animate-fade-in motion-reduce:animate-none"
          >
            {content}
            <TooltipPrimitive.Arrow className="fill-[#111111]" width={10} height={5} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
