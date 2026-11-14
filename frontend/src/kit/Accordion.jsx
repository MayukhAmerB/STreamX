// Accordion (Radix; PHILOSOPHY §2.7 FAQ, M17; BUILD_PLAN module outline). OWNER: WS-KIT.
// Inside one rounded #0a0a0a frame, items divided by white/10 hairlines;
// 16px 600 triggers, chevron turns 180° in 200 ms, content 14px leading-7.
// `numbered` prefixes each trigger with a mono tabular index ("01").
// The content fades in (opacity + 4px): no height animation (motion rule).
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { createContext, forwardRef, useContext } from "react";

import { ChevronDown } from "./icons";
import { cn } from "./lib/cn";

const FramedContext = createContext(true);

export const Accordion = forwardRef(function Accordion({ className, framed = true, ...props }, ref) {
  return (
    <FramedContext.Provider value={framed}>
      <AccordionPrimitive.Root
        ref={ref}
        className={cn(framed && "rounded-lg border border-white/10 bg-card px-5 sm:px-6", className)}
        {...props}
      />
    </FramedContext.Provider>
  );
});

export const AccordionItem = forwardRef(function AccordionItem({ className, ...props }, ref) {
  useContext(FramedContext);
  return <AccordionPrimitive.Item ref={ref} className={cn("border-b border-white/10 last:border-b-0", className)} {...props} />;
});

export const AccordionTrigger = forwardRef(function AccordionTrigger({ className, children, index, meta, headingLevel = 3, ...props }, ref) {
  return (
    <AccordionPrimitive.Header asChild>
      {headingLevel === 4 ? (
        <h4 className="flex">
          <TriggerInner ref={ref} className={className} index={index} meta={meta} {...props}>
            {children}
          </TriggerInner>
        </h4>
      ) : (
        <h3 className="flex">
          <TriggerInner ref={ref} className={className} index={index} meta={meta} {...props}>
            {children}
          </TriggerInner>
        </h3>
      )}
    </AccordionPrimitive.Header>
  );
});

const TriggerInner = forwardRef(function TriggerInner({ className, children, index, meta, ...props }, ref) {
  return (
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "group/acc flex flex-1 items-center gap-4 py-6 text-left text-base font-semibold text-white",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
      {...props}
    >
      {index !== undefined ? (
        <span className="w-8 shrink-0 font-mono text-sm font-normal tabular-nums text-subtle">{String(index).padStart(2, "0")}</span>
      ) : null}
      <span className="min-w-0 flex-1">{children}</span>
      {meta ? <span className="hidden shrink-0 text-sm font-normal text-subtle sm:inline">{meta}</span> : null}
      <ChevronDown
        size={16}
        className="shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[state=open]/acc:rotate-180 motion-reduce:transition-none"
      />
    </AccordionPrimitive.Trigger>
  );
});

export const AccordionContent = forwardRef(function AccordionContent({ className, children, ...props }, ref) {
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className="overflow-hidden text-sm leading-7 text-muted-foreground data-[state=open]:animate-accordion-down motion-reduce:animate-none"
      {...props}
    >
      <div className={cn("pb-6", className)}>{children}</div>
    </AccordionPrimitive.Content>
  );
});
