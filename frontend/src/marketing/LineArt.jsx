// Our own single-stroke, monochrome line art (currentColor, 1.5 px). Drawn for
// this site: tiers, topics and labs. The card inversion (white card, black
// stroke) works because every stroke follows currentColor.
const SHAPES = {
  // Foundations: a foundation block with a keystone.
  foundations: (
    <>
      <path d="M20 70h80M26 70V48h68v22M38 48V34h44v14M50 34V22h20v12" />
      <path d="M56 22l4-6 4 6" />
      <path d="M32 59h10M52 59h16M78 59h10" strokeDasharray="2 4" />
    </>
  ),
  terminal: (
    <>
      <rect x="18" y="16" width="84" height="58" rx="6" />
      <path d="M18 28h84" />
      <circle cx="26" cy="22" r="1.6" />
      <circle cx="32" cy="22" r="1.6" />
      <circle cx="38" cy="22" r="1.6" />
      <path d="M28 42l8 6-8 6M42 56h18" />
    </>
  ),
  chip: (
    <>
      <rect x="38" y="24" width="44" height="42" rx="4" />
      <rect x="50" y="36" width="20" height="18" rx="2" />
      <path d="M46 24v-8M60 24v-8M74 24v-8M46 66v8M60 66v8M74 66v8M38 34h-8M38 45h-8M38 56h-8M82 34h8M82 45h8M82 56h8" />
    </>
  ),
  packets: (
    <>
      <circle cx="26" cy="45" r="8" />
      <circle cx="94" cy="24" r="8" />
      <circle cx="94" cy="66" r="8" />
      <path d="M34 42l52-15M34 48l52 15" />
      <rect x="52" y="30" width="10" height="6" rx="1" />
      <rect x="64" y="54" width="10" height="6" rx="1" />
    </>
  ),
  radar: (
    <>
      <circle cx="60" cy="45" r="30" />
      <circle cx="60" cy="45" r="19" />
      <circle cx="60" cy="45" r="8" />
      <path d="M60 45l21-21" />
      <circle cx="74" cy="34" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="45" cy="56" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  bolt: (
    <>
      <path d="M64 12L40 50h18l-6 28 26-40H60z" />
      <path d="M24 70h12M84 22h12M88 62h8" strokeDasharray="2 4" />
    </>
  ),
  people: (
    <>
      <circle cx="44" cy="34" r="9" />
      <path d="M28 70c0-11 7-18 16-18s16 7 16 18" />
      <circle cx="78" cy="30" r="7" />
      <path d="M66 62c1-9 6-14 12-14s12 5 13 14" />
      <path d="M60 22c4-5 9-7 14-6" strokeDasharray="2 3" />
    </>
  ),
  browser: (
    <>
      <rect x="16" y="16" width="88" height="58" rx="6" />
      <path d="M16 28h88" />
      <rect x="28" y="38" width="30" height="24" rx="2" />
      <path d="M66 40h26M66 48h20M66 56h24" />
      <path d="M86 22h12" />
    </>
  ),
  eye: (
    <>
      <path d="M16 45c12-18 28-26 44-26s32 8 44 26c-12 18-28 26-44 26S28 63 16 45z" />
      <circle cx="60" cy="45" r="12" />
      <circle cx="60" cy="45" r="4" fill="currentColor" stroke="none" />
    </>
  ),
  compass: (
    <>
      <circle cx="60" cy="45" r="28" />
      <path d="M60 17v6M60 67v6M32 45h6M82 45h6" />
      <path d="M68 35l-5 13-11 7 5-13z" />
    </>
  ),
  tree: (
    <>
      <rect x="50" y="12" width="20" height="14" rx="2" />
      <rect x="20" y="62" width="20" height="14" rx="2" />
      <rect x="50" y="62" width="20" height="14" rx="2" />
      <rect x="80" y="62" width="20" height="14" rx="2" />
      <path d="M60 26v18M30 62V44h60v18M60 44v18" />
    </>
  ),
  ladder: (
    <>
      <path d="M44 78V12M76 78V12M44 24h32M44 38h32M44 52h32M44 66h32" />
      <path d="M86 18l6-6 6 6M92 12v20" />
    </>
  ),
  window: (
    <>
      <rect x="22" y="18" width="76" height="54" rx="4" />
      <path d="M60 18v54M22 45h76" />
      <path d="M84 8l6-6 6 6M90 2v12" transform="translate(0 2)" />
    </>
  ),
  magnifier: (
    <>
      <circle cx="52" cy="40" r="22" />
      <path d="M68 56l18 18" strokeWidth="3" />
      <path d="M42 34c2-5 6-8 11-8" />
    </>
  ),
  pin: (
    <>
      <path d="M60 76s22-22 22-38a22 22 0 1 0-44 0c0 16 22 38 22 38z" />
      <circle cx="60" cy="38" r="8" />
      <path d="M22 80h76" strokeDasharray="3 4" />
    </>
  ),
  flag: (
    <>
      <path d="M40 80V12" />
      <path d="M40 16h42l-8 12 8 12H40" />
      <path d="M28 80h28" />
    </>
  ),
  certificate: (
    <>
      <rect x="18" y="14" width="84" height="52" rx="4" />
      <path d="M30 28h40M30 38h56M30 48h32" />
      <circle cx="84" cy="58" r="10" />
      <path d="M78 66l-3 14 9-5 9 5-3-14" />
    </>
  ),
  path: (
    <>
      <path d="M18 74c18 0 18-20 36-20s14-18 32-18 16-20 16-20" strokeDasharray="4 5" />
      <circle cx="18" cy="74" r="4" />
      <circle cx="54" cy="54" r="4" />
      <circle cx="86" cy="36" r="4" />
      <path d="M100 8l4 8-8 0z" />
    </>
  ),
  wifi: (
    <>
      <path d="M24 38a52 52 0 0 1 72 0M34 50a36 36 0 0 1 52 0M45 62a20 20 0 0 1 30 0" />
      <circle cx="60" cy="72" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  phone: (
    <>
      <rect x="42" y="10" width="36" height="70" rx="6" />
      <path d="M54 18h12M56 72h8" />
      <path d="M50 36h20M50 44h14M50 52h18" />
    </>
  ),
  key: (
    <>
      <circle cx="40" cy="45" r="14" />
      <path d="M54 45h44M84 45v10M94 45v8" />
    </>
  ),
  mail: (
    <>
      <rect x="18" y="20" width="84" height="50" rx="4" />
      <path d="M18 24l42 26 42-26" />
      <path d="M86 12l12 12M98 12L86 24" />
    </>
  ),
  live: (
    <>
      <rect x="18" y="20" width="84" height="52" rx="6" />
      <circle cx="60" cy="46" r="10" />
      <circle cx="60" cy="46" r="3" fill="currentColor" stroke="none" />
      <path d="M40 80h40" />
    </>
  ),
  globe: (
    <>
      <circle cx="60" cy="45" r="30" />
      <path d="M30 45h60M60 15c-10 9-15 19-15 30s5 21 15 30M60 15c10 9 15 19 15 30s-5 21-15 30" />
    </>
  ),
};

export const LINE_ART_KEYS = Object.freeze(Object.keys(SHAPES));

/** Picks a drawing for a course from its slug/title keywords; stable for the same course. */
export function lineArtFor(course) {
  const text = `${course?.slug || ""} ${course?.title || ""} ${course?.card_title || ""}`.toLowerCase();
  const rules = [
    [/security-thinking|first principles|principle/, "foundations"],
    [/command[- ]line|terminal|shell|bash/, "terminal"],
    [/operating system|os-internals|internals/, "chip"],
    [/packet|protocol|network/, "packets"],
    [/recon|scan/, "radar"],
    [/exploit/, "bolt"],
    [/human|social|phish/, "people"],
    [/web|api|application/, "browser"],
    [/detect|incident|respon/, "eye"],
    [/hunt/, "compass"],
    [/active directory|domain/, "tree"],
    [/linux.*privilege|linux-privesc/, "ladder"],
    [/windows.*privilege|windows-privesc/, "window"],
    [/post-exploitation|tradecraft/, "key"],
    [/breach|password/, "key"],
    [/fake login|fake-login|login page/, "mail"],
    [/wi-?fi/, "wifi"],
    [/phone/, "phone"],
    [/traffic|visibility/, "eye"],
    [/geo|location|map/, "pin"],
    [/ctf|flag|challenge/, "flag"],
    [/exam|certif/, "certificate"],
    [/osint|intelligence|investigat/, "magnifier"],
  ];
  const hit = rules.find(([pattern]) => pattern.test(text));
  return hit ? hit[1] : course?.category === "osint" ? "magnifier" : "foundations";
}

/** Decorative drawing; `name` from LINE_ART_KEYS. */
export default function LineArt({ name = "foundations", className, title }) {
  const shape = SHAPES[name] || SHAPES.foundations;
  return (
    <svg
      className={className}
      viewBox="0 0 120 90"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {shape}
    </svg>
  );
}
