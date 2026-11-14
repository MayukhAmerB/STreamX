// Tabs (Radix) in two looks (PHILOSOPHY T8 tab bar, §2.7 pill chip/tab). OWNER: WS-KIT.
// - variant="bar": tabs between two hairlines, active = white solid rectangle.
// - variant="pill": rounded-full chips, active = white solid (FAQ categories).
// Arrow keys, Home/End and roles come from Radix.
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { createContext, forwardRef, useContext } from "react";

import { cn } from "./lib/cn";

const VariantContext = createContext("bar");

export const Tabs = forwardRef(function Tabs({ variant = "bar", className, ...props }, ref) {
  return (
    <VariantContext.Provider value={variant}>
      <TabsPrimitive.Root ref={ref} className={cn("w-full", className)} {...props} />
    </VariantContext.Provider>
  );
});

export const TabsList = forwardRef(function TabsList({ className, ...props }, ref) {
  const variant = useContext(VariantContext);
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        "flex flex-wrap items-center gap-2",
        variant === "bar" && "border-y border-white/10 py-2",
        className
      )}
      {...props}
    />
  );
});

export const TabsTrigger = forwardRef(function TabsTrigger({ className, ...props }, ref) {
  const variant = useContext(VariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium",
        "transition-colors duration-150 ease-standard motion-reduce:transition-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        variant === "pill"
          ? "h-10 rounded-full border border-white/[.12] px-4 text-white/[.66] hover:border-white/25 hover:text-white data-[state=active]:border-white data-[state=active]:bg-white data-[state=active]:text-black"
          : "rounded-md px-4 py-2 text-muted-foreground hover:bg-white/[.06] hover:text-white data-[state=active]:bg-white data-[state=active]:text-black",
        className
      )}
      {...props}
    />
  );
});

export const TabsContent = forwardRef(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content
      ref={ref}
      className={cn("mt-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring", className)}
      {...props}
    />
  );
});
