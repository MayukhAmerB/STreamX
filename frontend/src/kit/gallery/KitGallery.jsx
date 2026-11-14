// The kit gallery (dev only, /__kit). OWNER: WS-KIT.
// Every kit component in its states, in our words, on the black canvas, so
// the kit can be screenshotted at 390 and 1440 and checked by keyboard.
import { useState } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../Accordion";
import { Badge, StatusBadge, STATUS_KINDS } from "../Badge";
import { Button } from "../Button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, LinkCard } from "../Card";
import { CommandPalette, useCommandShortcut } from "../Command";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Sheet, SheetClose, SheetContent, SheetNavList, SheetTitle, SheetTrigger } from "../Dialog";
import { DisabledReason } from "../DisabledReason";
import { Checkbox, Field, Input, Label, Select, Switch, Textarea, UnderlineField } from "../Form";
import { ArrowUpRight, ChevronRight, Command as CommandIcon, Search, Terminal as TerminalIcon } from "../icons";
import { Avatar, AvatarStack, Frame, Notice, Progress, Section, Separator, Skeleton, StatStrip, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "../Layout";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, Tooltip } from "../Menu";
import { Reveal } from "../motion";
import { Terminal, Timeline, TimelineStep } from "../Story";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs";
import { Toaster, toast } from "../Toast";
import { FilterChips, SegmentedToggle } from "../Toggle";
import { ChapterLabel, DisplayHeading, Eyebrow, Hand, Kicker, Lead, PageTitle, SectionHeading, Tagline } from "../Typography";

const SWATCHES = [
  ["--background", "#000000", "canvas"],
  ["--surface-1", "#070707", "catalogue cells"],
  ["--card", "#0a0a0a", "cards, panels"],
  ["--card-raised", "#111111", "dialogs, the highlighted plan"],
  ["--muted", "#171717", "chips, skeletons"],
  ["--subtle-foreground", "#8a8a8a", "text floor (5.6:1)"],
  ["--muted-foreground", "#a1a1a1", "body copy (8.0:1)"],
  ["--foreground", "#fafafa", "text"],
  ["--accent", "#f3e2b3", "golden white, one per viewport"],
  ["--accent-strong", "#f8edcf", "hover"],
  ["--accent-deep", "#e6d29c", "pressed"],
];

function Block({ id, title, note, children }) {
  return (
    <Section id={id} rhythm="tight" className="border-t border-white/10" aria-labelledby={`${id}-h`}>
      <Frame>
        <SectionHeading as="h2" id={`${id}-h`} eyebrow="Kit" title={title} description={note} />
        <div className="mt-8">{children}</div>
      </Frame>
    </Section>
  );
}

function Art() {
  return (
    <svg viewBox="0 0 120 90" width="160" height="120" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="52" cy="42" r="22" />
      <path d="M68 58l22 22M40 42h24M52 30v24" />
    </svg>
  );
}

const COMMANDS = [
  { id: "home", label: "Console home", group: "Learn", hint: "G H" },
  { id: "courses", label: "My courses", group: "Learn", keywords: ["enrolled", "learning"] },
  { id: "reports", label: "Weekly reports", group: "Learn" },
  { id: "today", label: "Teach today", group: "Teach" },
  { id: "features", label: "Admin features", group: "Admin", keywords: ["switches", "toggles"] },
  { id: "pentest", label: "Buy a Pentesting course", group: "Admin", disabled: true, reason: "Coming soon" },
];

export default function KitGallery({ section }) {
  const [chip, setChip] = useState("all");
  const [period, setPeriod] = useState("monthly");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [lastCommand, setLastCommand] = useState("");
  useCommandShortcut(setPaletteOpen);

  const sections = {
    hero: (
      <Section rhythm="band" className="pt-28 text-center md:pt-32" aria-labelledby="hero-h">
        <Frame className="flex flex-col items-center">
          <Tagline tone="soft">a kit for careful investigators</Tagline>
          <DisplayHeading as="h1" size="hero" id="hero-h" className="mt-6 max-w-5xl">
            Learn to <Hand>look</Hand> closer
          </DisplayHeading>
          <Lead className="mt-6">Black canvas, white voice, one handwritten touch and one golden-white accent. Every component below is the real thing.</Lead>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button size="lg" trailing="chevron">Start free</Button>
            <Button size="lg" variant="secondary">Browse courses</Button>
          </div>
          <StatStrip
            className="mt-12"
            items={[
              { value: "4", label: "free labs" },
              { value: "20", label: "courses" },
              { value: "24/7", label: "lab access" },
              { value: "1", label: "certificate" },
            ]}
          />
          <AvatarStack
            className="mt-6"
            label="Learners from 40+ cities"
            people={[{ name: "A" }, { name: "S" }, { name: "R" }, { name: "M" }]}
          />
        </Frame>
      </Section>
    ),
    type: (
      <Block id="type" title="Type" note="Geist for the voice, Handlee for one touch per headline, Geist Mono for code.">
        <div className="space-y-10">
          <DisplayHeading size="section" lines={["Read first", "Act after"]} periods />
          <DisplayHeading size="sub">
            Choose what you want to <Hand>master</Hand>
          </DisplayHeading>
          <div className="flex flex-col items-start gap-4">
            <Kicker lead="Course" className="justify-start">Members only</Kicker>
            <Eyebrow>Eyebrow · 10px · 0.14em</Eyebrow>
            <Eyebrow tone="accent">Learning roadmap</Eyebrow>
            <PageTitle>Inner page title</PageTitle>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">Body copy sits at #a1a1a1 on black. Meta and labels never go below #8a8a8a.</p>
            <code className="rounded bg-white/[.06] px-1.5 py-0.5 font-mono text-[13px] text-white/[.82]">whois example.org</code>
          </div>
          <ChapterLabel>Chapter 02</ChapterLabel>
        </div>
      </Block>
    ),
    palette: (
      <Block id="palette" title="Palette law" note="Black, greys, whites and golden white. Status uses icon, word and luminance, never hue.">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {SWATCHES.map(([token, hex, use]) => (
            <li key={token} className="overflow-hidden rounded-lg border border-white/10">
              <div className="h-16 border-b border-white/10" style={{ background: hex }} />
              <div className="p-3">
                <p className="font-mono text-xs text-white">{token}</p>
                <p className="font-mono text-xs text-subtle">{hex}</p>
                <p className="mt-1 text-xs text-muted-foreground">{use}</p>
              </div>
            </li>
          ))}
        </ul>
      </Block>
    ),
    buttons: (
      <Block id="buttons" title="Buttons" note="Plain rectangles with an 8px corner. Golden white is reserved for one CTA per viewport.">
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="invert">Invert on hover</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" trailing="chevron">Small h-10</Button>
            <Button size="md" trailing="arrow">Medium h-11</Button>
            <Button size="lg" trailing="external">Large h-12</Button>
            <Button size="icon" variant="secondary" aria-label="Search">
              <Search size={18} />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="accent" size="lg">Sign in</Button>
            <Button variant="accent" size="lg" shape="pill" tactile>
              Join the membership
            </Button>
          </div>
          <div className="grid gap-6 sm:grid-cols-2">
            <DisabledReason reason="Pentesting opens soon. You can browse every module now; enrolment opens at launch.">Enrol</DisabledReason>
            <DisabledReason reason="Price at launch: the owner has not confirmed it yet." shape="pill" block icon="lock" align="center">
              Choose plan
            </DisabledReason>
          </div>
        </div>
      </Block>
    ),
    badges: (
      <Block id="badges" title="Badges and status" note="Every status shows an icon and its word.">
        <div className="flex flex-wrap gap-3">
          {Object.keys(STATUS_KINDS)
            .filter((kind) => kind !== "neutral")
            .map((kind) => (
              <StatusBadge key={kind} kind={kind} />
            ))}
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Badge>Outline</Badge>
          <Badge variant="solid">Solid</Badge>
          <Badge variant="accent">Most popular</Badge>
          <Badge variant="muted">Soon</Badge>
          <Badge variant="chip">No card required</Badge>
          <Badge size="micro">Free</Badge>
        </div>
      </Block>
    ),
    cards: (
      <Block id="cards" title="Cards" note="Catalogue cards share hairlines and turn white on hover or keyboard focus (shown white on phones).">
        <div className="hairline-grid md:grid-cols-3">
          {[
            ["Reading a domain", "Beginner · Free", "free"],
            ["Tracing an image", "Intermediate · Membership", "open"],
            ["Network reconnaissance", "Advanced · Pentesting", "soon"],
          ].map(([title, eyebrow, status]) => (
            <LinkCard
              key={title}
              href="#cards"
              title={title}
              eyebrow={eyebrow}
              status={<StatusBadge kind={status} />}
              art={<Art />}
              description="Work through a real case step by step, with notes you can keep and a check at the end of every module."
              meta="6 modules · 3h"
              action="Open"
            />
          ))}
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Weekly report</CardTitle>
              <CardDescription>Due Friday, 18:00 IST</CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={62} label="Report progress" />
              <p className="mt-3 text-sm text-muted-foreground">3 of 5 sections written</p>
            </CardContent>
            <CardFooter strip>
              <span className="text-sm text-subtle">Saved 2 minutes ago</span>
              <Button size="xs" variant="secondary" trailing="arrow">Continue</Button>
            </CardFooter>
          </Card>
          <Notice eyebrow="Coming soon" title="Pentesting opens later this year">
            Browse every track, course and module outline now. Enrolment and payment open when the section launches.
          </Notice>
        </div>
      </Block>
    ),
    controls: (
      <Block id="controls" title="Tabs, chips and toggles" note="Radix roving focus: arrow keys move, the active item is white solid.">
        <FilterChips
          label="Filter courses"
          value={chip}
          onValueChange={setChip}
          options={[
            { value: "all", label: "All", count: 20 },
            { value: "foundations", label: "Foundations", count: 4 },
            { value: "offensive", label: "Offensive", count: 4 },
            { value: "defensive", label: "Defensive", count: 2 },
            { value: "quick", label: "Quick wins", count: 6 },
          ]}
        />
        <div className="mt-6 max-w-xs">
          <SegmentedToggle
            label="Billing period"
            value={period}
            onValueChange={setPeriod}
            options={[
              { value: "monthly", label: "Monthly" },
              { value: "yearly", label: "Yearly", note: "-40%" },
            ]}
          />
        </div>
        <Tabs defaultValue="overview" className="mt-8">
          <TabsList aria-label="Course sections">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="modules">Modules</TabsTrigger>
            <TabsTrigger value="reviews">Reviews</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="pt-4 text-sm text-muted-foreground">An overview of the course.</TabsContent>
          <TabsContent value="modules" className="pt-4 text-sm text-muted-foreground">Six modules, one case each.</TabsContent>
          <TabsContent value="reviews" className="pt-4 text-sm text-muted-foreground">What learners say.</TabsContent>
        </Tabs>
        <Tabs defaultValue="general" variant="pill" className="mt-8">
          <TabsList aria-label="Question topics">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="billing">Billing</TabsTrigger>
            <TabsTrigger value="support">Support</TabsTrigger>
          </TabsList>
        </Tabs>
      </Block>
    ),
    accordion: (
      <Block id="accordion" title="Accordion" note="Numbered module outline and FAQ.">
        <Accordion type="single" collapsible defaultValue="m1">
          {[
            ["m1", "Reading a domain", "WHOIS, DNS history and certificates, and what each one tells you."],
            ["m2", "Following a username", "Where handles repeat, and how to prove two accounts are one person."],
            ["m3", "Placing a photo", "Shadows, signs and skylines: pin a picture to a street."],
          ].map(([value, title, body], index) => (
            <AccordionItem key={value} value={value}>
              <AccordionTrigger index={index + 1} meta="25 min">
                {title}
              </AccordionTrigger>
              <AccordionContent>{body}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Block>
    ),
    forms: (
      <Block id="forms" title="Form controls" note="Labels are always visible; errors carry an icon and words.">
        <div className="grid gap-10 lg:grid-cols-2">
          <div className="space-y-5">
            <Field label="Full name" hint="As it should appear on your certificate.">
              <Input placeholder="Your name" autoComplete="name" />
            </Field>
            <Field label="Email" error="Enter an email address like name@example.com.">
              <Input type="email" defaultValue="not-an-email" />
            </Field>
            <Field label="What do you want to learn?">
              <Textarea placeholder="A sentence or two" />
            </Field>
            <Field label="Track">
              <Select defaultValue="osint">
                <option value="osint">OSINT</option>
                <option value="pentesting">Pentesting (coming soon)</option>
              </Select>
            </Field>
            <div className="flex items-center gap-3">
              <Checkbox id="remember" defaultChecked />
              <Label htmlFor="remember">Remember me</Label>
            </div>
            <div className="flex items-center gap-3">
              <Switch id="feature" aria-describedby="feature-note" />
              <Label htmlFor="feature">Pentesting purchases</Label>
              <span id="feature-note" className="text-xs text-subtle">Off</span>
            </div>
          </div>
          <div className="rounded-lg bg-card p-6 sm:p-10">
            <h3 className="text-4xl font-normal sm:text-6xl">Welcome back</h3>
            <p className="mt-3 text-sm text-subtle">Sign in to continue your cases.</p>
            <div className="mt-10 grid gap-8 sm:grid-cols-2">
              <UnderlineField label="Email" type="email" placeholder="you@example.com" autoComplete="email" />
              <UnderlineField label="Password" type="password" placeholder="Your password" autoComplete="current-password" />
            </div>
            <Button variant="accent" size="lg" block trailing="chevron" className="mt-10 font-semibold">
              Sign in
            </Button>
          </div>
        </div>
      </Block>
    ),
    overlays: (
      <Block id="overlays" title="Overlays" note="Focus is trapped while open and returns to the opener on close. Press Ctrl+K for the palette.">
        <div className="flex flex-wrap gap-3">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Leave this case?</DialogTitle>
                <DialogDescription>Your notes are saved. You can come back to this case at any time.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="secondary">Stay</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button>Leave</Button>
                </DialogClose>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">Open menu sheet</Button>
            </SheetTrigger>
            <SheetContent side="right" aria-describedby={undefined}>
              <SheetTitle className="mb-4">Menu</SheetTitle>
              <SheetNavList>
                {["Courses", "Pentesting", "Roadmap", "Pricing"].map((item) => (
                  <li key={item}>
                    <SheetClose asChild>
                      <a href="#overlays" className="flex items-center justify-between py-5 text-lg text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                        {item}
                        <ChevronRight size={18} className="text-subtle" />
                      </a>
                    </SheetClose>
                  </li>
                ))}
              </SheetNavList>
            </SheetContent>
          </Sheet>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" trailing="chevron">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Explore</DropdownMenuLabel>
              <DropdownMenuItem>Watch</DropdownMenuItem>
              <DropdownMenuItem>About</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                Free labs <ArrowUpRight size={14} className="ml-auto" />
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip content="Copy the case link">
            <Button variant="secondary" size="icon" aria-label="Copy link">
              <TerminalIcon size={18} />
            </Button>
          </Tooltip>
          <Button variant="secondary" leading={<CommandIcon size={16} />} onClick={() => setPaletteOpen(true)}>
            Command palette
          </Button>
          <Button
            variant="secondary"
            onClick={() => toast({ kind: "done", title: "Report submitted", description: "Your mentor will review it this week." })}
          >
            Show toast
          </Button>
          <Button variant="secondary" onClick={() => toast({ kind: "attention", title: "Lab time ends in 10 minutes" })}>
            Attention toast
          </Button>
          <Button variant="secondary" onClick={() => toast({ kind: "critical", title: "Upload failed", description: "Check your connection and try again.", action: { label: "Retry", onClick: () => {} } })}>
            Error toast
          </Button>
        </div>
        <p className="mt-4 text-sm text-subtle" aria-live="polite">
          {lastCommand ? `Last command: ${lastCommand}` : ""}
        </p>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} items={COMMANDS} onSelect={(item) => setLastCommand(item.label)} />
      </Block>
    ),
    data: (
      <Block id="data" title="Table, progress, avatar, skeleton">
        <Table minWidth="36rem">
          <TableCaption>Status is a word and an icon, never a colour.</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Learner</TableHead>
              <TableHead>Case</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Score</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                <span className="flex items-center gap-3">
                  <Avatar size="sm" fallback="R" />
                  rook_17
                </span>
              </TableCell>
              <TableCell>Reading a domain</TableCell>
              <TableCell>
                <StatusBadge kind="done" />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">92</TableCell>
            </TableRow>
            <TableRow highlighted>
              <TableCell>
                <span className="flex items-center gap-3">
                  <Avatar size="sm" fallback="N" />
                  night_owl
                </span>
              </TableCell>
              <TableCell>Placing a photo</TableCell>
              <TableCell>
                <StatusBadge kind="progress" />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">—</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <span className="flex items-center gap-3">
                  <Avatar size="sm" fallback="K" />
                  kestrel
                </span>
              </TableCell>
              <TableCell>Following a username</TableCell>
              <TableCell>
                <StatusBadge kind="attention" label="Late" />
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">71</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="space-y-3">
            <Progress value={40} label="Course progress" />
            <Progress value={75} tone="white" label="Lab progress" />
          </div>
          <div className="space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
        <Separator className="my-8" />
        <div className="flex items-center gap-3">
          <Avatar fallback="AS" />
          <Avatar size="lg" fallback="OS" />
        </div>
      </Block>
    ),
    story: (
      <Block id="story" title="Timeline and terminal" note="Static at rest; the terminal types once in view (full text under reduced motion).">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:gap-16">
          <div className="lg:sticky lg:top-28 lg:self-start">
            <Eyebrow>How a case runs</Eyebrow>
            <h3 className="mt-3 text-3xl font-semibold leading-tight sm:text-4xl">Understand the trail before you follow it</h3>
            <p className="mt-4 text-sm leading-6 text-muted-foreground">Each step is real product UI, not a picture of it.</p>
          </div>
          <Timeline>
            <TimelineStep number={1} kicker="Brief" title="Read the case" sub="A short brief with one clear question.">
              <Reveal>
                <Card>
                  <CardContent className="pt-5 sm:pt-6">
                    <p className="text-sm text-muted-foreground">Who registered the domain behind this invoice, and when?</p>
                  </CardContent>
                </Card>
              </Reveal>
            </TimelineStep>
            <TimelineStep number={2} kicker="Lab" title="Work in the lab" sub="Your tools, your notes, a terminal that remembers.">
              <Reveal>
                <Terminal title="lab-01" typing lines={["$ whois invoice-example.org", "Registrar: Example Registrar", "Created: 2019-04-02", "Answer accepted: 2019-04-02"]} />
              </Reveal>
            </TimelineStep>
            <TimelineStep number={3} kicker="Proof" title="Show your reasoning" sub="Submit the answer and how you found it." last>
              <Reveal>
                <Card>
                  <CardContent className="flex items-center justify-between gap-4 pt-5 sm:pt-6">
                    <span className="text-sm">Case closed</span>
                    <StatusBadge kind="done" />
                  </CardContent>
                </Card>
              </Reveal>
            </TimelineStep>
          </Timeline>
        </div>
      </Block>
    ),
  };

  const order = Object.keys(sections);
  const shown = section && sections[section] ? [section] : order;
  return (
    <main className="min-h-screen bg-black font-sans text-white antialiased">
      <a href="#type" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-black">
        Skip to components
      </a>
      {shown.map((key) => (
        <div key={key}>{sections[key]}</div>
      ))}
      <Toaster />
    </main>
  );
}
