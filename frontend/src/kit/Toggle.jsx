// FilterChips and SegmentedToggle (Radix ToggleGroup, single select).
// OWNER: WS-KIT. PHILOSOPHY §2.7 pill chip / segmented toggle, M4.
//
// Chips WRAP at 390 (HackPath wraps; no sideways scroll). Rest: white/12
// border, text white/66; hover: border white/25, text white; active: white
// solid with black text. The segmented toggle is a rounded track with a white
// active pill (Monthly / Yearly), an optional small golden-white note
// ("Save 40%"). Single-select groups never allow "nothing selected".
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { forwardRef } from "react";

import { cn } from "./lib/cn";

/**
 * <FilterChips label="Filter courses" value onValueChange options={[{ value, label, count }]} />
 */
export const FilterChips = forwardRef(function FilterChips({ options = [], value, onValueChange, label, className, ...rest }, ref) {
  return (
    <ToggleGroupPrimitive.Root
      ref={ref}
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange?.(next);
      }}
      aria-label={label}
      className={cn("flex flex-wrap gap-2", className)}
      {...rest}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            "inline-flex h-10 items-center gap-2 whitespace-nowrap rounded-full border border-white/[.12] px-4 text-sm text-white/[.66]",
            "transition-colors duration-150 ease-standard motion-reduce:transition-none hover:border-white/25 hover:text-white",
            "data-[state=on]:border-white data-[state=on]:bg-white data-[state=on]:text-black",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          )}
        >
          {option.label}
          {option.count !== undefined ? <span className="tabular-nums opacity-70">{option.count}</span> : null}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
});

/**
 * <SegmentedToggle label="Billing period" value onValueChange options={[{ value: "monthly", label: "Monthly" },
 *   { value: "yearly", label: "Yearly", note: "Save 40%" }]} />
 */
export const SegmentedToggle = forwardRef(function SegmentedToggle({ options = [], value, onValueChange, label, className, ...rest }, ref) {
  return (
    <ToggleGroupPrimitive.Root
      ref={ref}
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange?.(next);
      }}
      aria-label={label}
      className={cn("grid w-full gap-1 rounded-full border border-white/10 bg-white/[.04] p-1", className)}
      style={{ gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0, 1fr))` }}
      {...rest}
    >
      {options.map((option) => (
        <ToggleGroupPrimitive.Item
          key={option.value}
          value={option.value}
          className={cn(
            "inline-flex h-9 items-center justify-center gap-2 rounded-full px-3 text-sm font-medium text-white/[.66]",
            "transition-colors duration-200 ease-standard motion-reduce:transition-none hover:text-white",
            "data-[state=on]:bg-white data-[state=on]:text-black",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          )}
        >
          {option.label}
          {option.note ? (
            <span className="text-[11px] font-semibold text-accent [[data-state=on]_&]:text-black/70">{option.note}</span>
          ) : null}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
});
