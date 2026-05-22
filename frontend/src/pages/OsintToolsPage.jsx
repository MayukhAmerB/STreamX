import { useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";

const toolCategories = [
  {
    title: "Directories And Search Starting Points",
    focus: "Start here when you know the clue type but not the right OSINT resource yet.",
    useCase:
      "Directories and indexed search platforms help investigators move from an email, username, domain, file, or leak indicator to the next focused tool.",
    caution:
      "Treat breach and leak search results as sensitive. Use them only for legal research, exposure checks, and course exercises approved for that purpose.",
    tools: [
      {
        name: "OSINT Framework",
        type: "Directory",
        use: "Expandable OSINT resource map grouped by investigation input and workflow.",
        url: "https://osintframework.com/",
      },
      {
        name: "Bellingcat Online Investigation Toolkit",
        type: "Toolkit",
        use: "Curated open-source research toolkit organized by maps, geolocation, media verification, people, websites, transport, archiving, and analysis workflows.",
        url: "https://bellingcat.gitbook.io/toolkit",
      },
      {
        name: "Intelligence X",
        type: "Search",
        use: "Selector-based search across indexed public-web, paste, darknet, and leak-oriented buckets.",
        url: "https://intelx.io/",
      },
      {
        name: "Breach Detective",
        type: "Exposure check",
        use: "Breach-data search service for checking whether private data appears in aggregated leak records.",
        url: "https://breachdetective.com/",
      },
      {
        name: "SpiderFoot",
        type: "Automation",
        use: "Automates collection and correlation across many OSINT data sources.",
      },
      {
        name: "Recon-ng",
        type: "Framework",
        use: "Modular research framework for repeatable reconnaissance and evidence collection.",
      },
      {
        name: "Maltego",
        type: "Link analysis",
        use: "Builds graph views for entities, relationships, and investigation pivots.",
      },
    ],
  },
  {
    title: "Username, Email And Identity Correlation",
    focus: "Use when a handle, email address, or account clue needs footprint mapping.",
    useCase:
      "These tools check account presence, registration signals, public identifiers, and identity pivots across platforms. Validate results manually before drawing conclusions.",
    caution:
      "Do not use correlation results to harass, dox, or profile people outside authorized research.",
    tools: [
      {
        name: "user-scanner",
        type: "CLI",
        use: "Combined email and username OSINT scanner for checking public footprint signals across many platforms.",
        url: "https://github.com/kaifcodec/user-scanner",
      },
      {
        name: "MailAccess",
        type: "CLI",
        use: "Email OSINT utility focused on platform presence, identity clustering, and breach-detection checks.",
        url: "https://github.com/KatrielMoses/MailAccess",
      },
      {
        name: "Sherlock",
        type: "Username",
        use: "Searches username presence across public websites.",
      },
      {
        name: "Maigret (Python)",
        type: "Username",
        use: "Username research with profile checks and richer site metadata.",
        url: "https://github.com/soxoj/maigret",
      },
      {
        name: "WhatsMyName",
        type: "Username",
        use: "Username-focused resource for platform checks and false-positive review.",
      },
      {
        name: "Holehe",
        type: "Email",
        use: "Checks whether an email address is associated with selected public account flows.",
      },
      {
        name: "GHunt",
        type: "Account clue",
        use: "Researches public Google-account related clues where available.",
      },
      {
        name: "Have I Been Pwned",
        type: "Exposure check",
        use: "Checks whether an email or account indicator appears in known breach exposure data.",
        url: "https://haveibeenpwned.com/",
      },
      {
        name: "DeHashed",
        type: "Breach data",
        use: "Breach-data service that may support authorized exposure research where legally permitted.",
        url: "https://www.dehashed.com/",
      },
    ],
  },
  {
    title: "Domain, Email And Internet Infrastructure",
    focus: "Use when a domain, email pattern, IP, URL, or exposed internet service is the clue.",
    useCase:
      "These tools support domain pivots, email discovery, DNS review, URL and hash reputation checks, public internet-asset context, and passive infrastructure research.",
    caution:
      "Keep active scanning and target interaction inside authorized scope. Public search results are leads, not proof of ownership or vulnerability.",
    tools: [
      {
        name: "MXToolbox",
        type: "DNS and mail",
        use: "Checks MX, DNS, blacklist, and mail-delivery related records for a domain.",
        url: "https://mxtoolbox.com/",
      },
      {
        name: "Hunter",
        type: "Email research",
        use: "Finds and verifies professional email patterns associated with domains and companies.",
        url: "https://hunter.io/",
      },
      {
        name: "Shodan",
        type: "Internet search",
        use: "Searches publicly visible internet-connected services and device metadata.",
        url: "https://www.shodan.io/",
      },
      {
        name: "HackerTarget",
        type: "Network tools",
        use: "Provides DNS, host, and security assessment utilities for scoped infrastructure research.",
        url: "https://hackertarget.com/",
      },
      {
        name: "SecurityTrails",
        type: "DNS intelligence",
        use: "Domain, DNS, WHOIS, IP, subdomain, and historical infrastructure pivots.",
        url: "https://securitytrails.com/",
      },
      {
        name: "VirusTotal",
        type: "Artifact reputation",
        use: "Searches and analyzes file, URL, domain, IP, and hash artifacts for security context.",
        url: "https://www.virustotal.com/",
      },
      {
        name: "Grabify",
        type: "Link tracking",
        use: "IP-logger and tracked-link reference for controlled awareness exercises and link-analysis review.",
        url: "https://grabify.link/",
      },
    ],
  },
  {
    title: "Phone And Vehicle Lookups",
    focus: "Use when a phone-number clue or Indian vehicle-registration clue needs a lawful lookup path.",
    useCase:
      "Phone and registration lookups can help verify a clue source, separate official portals from third-party helpers, and decide what needs manual confirmation.",
    caution:
      "Phone and vehicle details can be personal data. Prefer official sources, follow local law and platform terms, and do not use lookup results for harassment or doxxing.",
    tools: [
      {
        name: "Truecaller Number Search",
        type: "Phone lookup",
        use: "Caller-ID and phone-number search starting point for checking a number clue.",
        url: "https://www.truecaller.com/",
      },
      {
        name: "Truecaller Bot Variants",
        type: "Third-party bot",
        use: "Changing third-party phone-lookup bot references; verify source, privacy, and terms before relying on results.",
      },
      {
        name: "Parivahan License And Registration Details",
        type: "Government portal",
        use: "Official Indian transport portal entry point for license and vehicle registration detail services.",
        url: "https://parivahan.gov.in/parivahan/en/content/license-registration-details",
      },
      {
        name: "CarInfo RTO Vehicle Registration Detail",
        type: "Third-party vehicle lookup",
        use: "Vehicle and RTO lookup helper; compare important details with official records.",
        url: "https://www.carinfo.app/rto-vehicle-registration-detail",
      },
    ],
  },
  {
    title: "Metadata Analysis",
    focus: "Inspect files before trusting what a document, photo, or archive claims.",
    useCase:
      "Metadata tools expose author names, device details, timestamps, file paths, editing software, GPS clues, and timezone hints from files.",
    caution:
      "Metadata can be missing, stripped, or misleading. Preserve originals and record the method used.",
    tools: [
      {
        name: "ExifTool",
        type: "File metadata",
        use: "Reads and writes metadata across images, video, documents, and many other formats.",
        url: "https://exiftool.org/",
      },
      {
        name: "Metadata2Go",
        type: "Web metadata",
        use: "Quick online metadata inspection for common uploaded file types.",
        url: "https://www.metadata2go.com/",
      },
      {
        name: "FOCA",
        type: "Document metadata",
        use: "Finds metadata and document clues in collected office and PDF files.",
      },
      {
        name: "MAT2",
        type: "Sanitization",
        use: "Metadata inspection and anonymisation workflow for supported files.",
      },
      {
        name: "file",
        type: "Terminal",
        use: "Identifies file type from content instead of trusting the extension.",
      },
      {
        name: "strings",
        type: "Terminal",
        use: "Extracts readable strings that can reveal paths, names, URLs, or build clues.",
      },
      {
        name: "PDFInfo",
        type: "PDF",
        use: "Reads PDF document properties and structural information.",
      },
      {
        name: "Local EXIF viewers",
        type: "Review",
        use: "Offline visual metadata review when a fast manual check is enough.",
      },
    ],
  },
  {
    title: "Archive And Historical Capture",
    focus: "Compare what a page said earlier with what it says now.",
    useCase:
      "Historical captures can recover removed clues, show site changes, and preserve supporting evidence for later review.",
    caution:
      "An archived copy is not automatically complete or authentic context. Compare captures and note collection time.",
    tools: [
      {
        name: "Wayback Machine",
        type: "Archive",
        use: "Historical snapshots of websites and selected resources.",
        url: "https://web.archive.org/",
      },
      {
        name: "archive.today / archive.ph",
        type: "Archive",
        use: "On-demand page captures that can preserve visible web content.",
        url: "https://archive.ph/",
      },
      {
        name: "ArchiveBox",
        type: "Self-hosted",
        use: "Creates local research archives from URLs and captured assets.",
      },
      {
        name: "Webrecorder",
        type: "Capture",
        use: "Interactive web capture for pages that need replayable browsing context.",
      },
      {
        name: "Common Crawl",
        type: "Web corpus",
        use: "Large crawl datasets for historical web research and bulk pivots.",
        url: "https://commoncrawl.org/",
      },
      {
        name: "Cached search results",
        type: "Search clue",
        use: "Review snippets and cached traces when source pages have changed.",
      },
      {
        name: "Hunchly captures",
        type: "Evidence capture",
        use: "Investigation-oriented browsing and capture workflow.",
      },
      {
        name: "Third-party screenshots",
        type: "Corroboration",
        use: "Compare saved screenshots with current and archived pages.",
      },
    ],
  },
  {
    title: "Image And Screenshot Analysis",
    focus: "Extract visual clues from reused images, screenshots, and frames.",
    useCase:
      "Image tools help reverse-search assets, read visible text, inspect reused graphics, and inspect screenshot context such as tabs, filenames, clocks, and notifications.",
    caution:
      "Reverse-image results are leads. Confirm source, date, crop history, and context before relying on them.",
    tools: [
      {
        name: "Google Lens",
        type: "Visual search",
        use: "Finds visual matches, text, products, places, and related images.",
      },
      {
        name: "Yandex Images",
        type: "Visual search",
        use: "Reverse image search for similar or reused imagery.",
      },
      {
        name: "TinEye",
        type: "Visual search",
        use: "Tracks image matches and reuse history.",
      },
      {
        name: "Bing Visual Search",
        type: "Visual search",
        use: "Searches visually similar images and objects.",
      },
      {
        name: "Tesseract OCR",
        type: "OCR",
        use: "Extracts text from screenshots and images for later searching.",
      },
      {
        name: "FotoForensics",
        type: "Forensics",
        use: "Image analysis helpers for compression and manipulation review.",
      },
      {
        name: "InVID / WeVerify",
        type: "Verification",
        use: "Media verification workflow for frames, thumbnails, and visual checks.",
      },
      {
        name: "Screenshot comparison tools",
        type: "Comparison",
        use: "Compare crops, changed pixels, timestamps, and UI clues.",
      },
    ],
  },
  {
    title: "Writing Style, Timing And Behavioral Patterns",
    focus: "Study repeated language and posting rhythm without overclaiming identity.",
    useCase:
      "Pattern analysis compares repeated phrasing, punctuation, slang, post timing, timezone clues, greetings, sign-offs, and interaction history.",
    caution:
      "Stylometry is probabilistic and sensitive to small samples. It should support a hypothesis, not replace evidence.",
    tools: [
      {
        name: "JStylo / Anonymouth",
        type: "Stylometry",
        use: "Writing-style research and comparison environment.",
      },
      {
        name: "Writeprints-style research tools",
        type: "Research",
        use: "Feature-based authorship and style comparison experiments.",
      },
      {
        name: "spaCy, NLTK And scikit-learn",
        type: "NLP",
        use: "Builds text-processing pipelines and comparison experiments.",
      },
      {
        name: "Maltego timeline graphs",
        type: "Timeline",
        use: "Maps behavioral pivots alongside linked entities.",
      },
      {
        name: "Gephi",
        type: "Graph",
        use: "Visualizes networks, clusters, and repeated interactions.",
      },
      {
        name: "Obsidian / spreadsheets",
        type: "Notes",
        use: "Manual timeline mapping and evidence comparison.",
      },
      {
        name: "Forum post history analysis",
        type: "Manual review",
        use: "Compares posting hours, phrases, habits, and topic shifts.",
      },
    ],
  },
  {
    title: "Enterprise OSINT And Threat Platforms",
    focus: "Commercial suites from the toolkit reference, grouped by the problem they target.",
    useCase:
      "These platforms usually combine search, enrichment, monitoring, link analysis, reports, or specialist datasets for professional teams.",
    caution:
      "Availability, licensing, and dataset scope vary. Check the vendor terms before including a platform in a workflow.",
    tools: [
      {
        name: "Skopenow, Social Links, ShadowDragon",
        type: "Social media",
        use: "Social-media intelligence, entity discovery, and relationship research.",
      },
      {
        name: "DarkBlue, DarkOwl Vision, NexVision",
        type: "Dark web",
        use: "Dark-web monitoring and specialist search datasets.",
      },
      {
        name: "Neotas, Factiva, Videris",
        type: "Due diligence",
        use: "Due-diligence research, media review, and risk context.",
      },
      {
        name: "Analysts Notebook, Siren, Recorded Future",
        type: "Link analysis",
        use: "Entity relationships, graph investigation, and intelligence context.",
      },
      {
        name: "Silobreaker, Media Sonar, Cobwebs",
        type: "Web intelligence",
        use: "Web monitoring, enrichment, and collection workflows.",
      },
      {
        name: "Maltego, Elephantastic, Pipl",
        type: "People ID",
        use: "People and identity-oriented lookup or correlation workflows.",
      },
      {
        name: "VoxCroft, Logically, Talkwalker",
        type: "Risk and crisis",
        use: "Narrative, media, risk, and crisis monitoring.",
      },
      {
        name: "PimEyes, CHAPSVISION, CameraForensics",
        type: "Images",
        use: "Image-oriented search, review, and intelligence workflows.",
      },
      {
        name: "KELA, Intel 471 Titan, CYWARE",
        type: "Threat intel",
        use: "Threat-intelligence collection, context, and team workflow tooling.",
      },
    ],
  },
];

const allToolCount = toolCategories.reduce((total, category) => total + category.tools.length, 0);
const categoryByTitle = new Map(toolCategories.map((category) => [category.title, category]));

const clueTree = [
  {
    title: "Person And Identity Clues",
    question: "Do you have a person-facing clue?",
    description: "Follow accounts, phone clues, public records, and repeated behavior.",
    forks: [
      {
        title: "Account Footprints",
        description: "Start from usernames, emails, phone numbers, or registration lookups.",
        categories: [
          "Username, Email And Identity Correlation",
          "Phone And Vehicle Lookups",
        ],
      },
      {
        title: "Patterns And Search",
        description: "Use behavior clues or broad OSINT directories to choose the next pivot.",
        categories: [
          "Writing Style, Timing And Behavioral Patterns",
          "Directories And Search Starting Points",
        ],
      },
    ],
  },
  {
    title: "Technical And Evidence Clues",
    question: "Do you have a digital artifact?",
    description: "Follow domains, services, media, files, archives, and threat datasets.",
    forks: [
      {
        title: "Infrastructure Signals",
        description: "Map domains, DNS, internet assets, and professional intel platforms.",
        categories: [
          "Domain, Email And Internet Infrastructure",
          "Enterprise OSINT And Threat Platforms",
        ],
      },
      {
        title: "Collected Evidence",
        description: "Inspect files, images, screenshots, and older web captures.",
        categories: [
          "Metadata Analysis",
          "Image And Screenshot Analysis",
          "Archive And Historical Capture",
        ],
      },
    ],
  },
];

function ToolCard({ tool }) {
  return (
    <article className="flex h-full flex-col rounded-2xl border border-black panel-gradient p-4 transition hover:border-[#414141] hover:bg-[#161616]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-reference text-lg font-semibold text-white">{tool.name}</h3>
          <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#AFAFAF]">
            {tool.type}
          </p>
        </div>
        {tool.url ? (
          <a
            href={tool.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-semibold text-[#EFEFEF] transition hover:bg-white/15"
          >
            Open Tool
          </a>
        ) : (
          <span className="rounded-full border border-black bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-[#AFAFAF]">
            Reference
          </span>
        )}
      </div>
      <p className="mt-4 text-sm leading-7 text-[#C2C2C2]">{tool.use}</p>
    </article>
  );
}

function TreeLeafButton({ title, selectedTitle, onSelect }) {
  const category = categoryByTitle.get(title);
  const isSelected = selectedTitle === title;

  return (
    <button
      type="button"
      className={`group relative w-full rounded-2xl border px-4 py-3 text-left transition ${
        isSelected
          ? "border-[#D8D8D8] bg-[#E8E8E8] text-[#171717] shadow-[0_16px_34px_rgba(226,226,226,0.18)]"
          : "border-black panel-gradient text-[#E4E4E4] hover:border-[#474747] hover:bg-[#181818]"
      }`}
      onClick={() => onSelect(title)}
      aria-pressed={isSelected}
    >
      <span
        className={`absolute left-0 top-1/2 h-px w-4 -translate-x-full transition lg:block ${
          isSelected ? "bg-[#EAEAEA]" : "bg-[#4C4C4C] group-hover:bg-[#AFAFAF]"
        }`}
      />
      <span className="block font-reference text-base font-semibold leading-6">{title}</span>
      <span
        className={`mt-2 inline-flex rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${
          isSelected
            ? "border-[#B8B8B8] bg-white text-[#292929]"
            : "border-black bg-white/[0.06] text-[#AFAFAF]"
        }`}
      >
        {category?.tools.length || 0} tools
      </span>
    </button>
  );
}

function TreeFork({ fork, selectedTitle, onSelect }) {
  return (
    <section className="relative rounded-[24px] border border-black bg-[#0D0D0D]/90 p-4 shadow-[0_18px_42px_rgba(0,0,0,0.28)]">
      <span className="absolute left-1/2 top-0 hidden h-5 w-px -translate-y-full bg-[#575757] lg:block" />
      <div className="rounded-2xl border border-black panel-gradient p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#959595]">
          Fork
        </div>
        <h3 className="mt-2 font-reference text-xl font-semibold text-white">{fork.title}</h3>
        <p className="mt-2 text-sm leading-6 text-[#BDBDBD]">{fork.description}</p>
      </div>

      <div className="relative mt-4 space-y-3 pl-4">
        <span className="absolute bottom-6 left-0 top-6 w-px bg-gradient-to-b from-[#777777] via-[#494949] to-transparent" />
        {fork.categories.map((categoryTitle) => (
          <TreeLeafButton
            key={categoryTitle}
            title={categoryTitle}
            selectedTitle={selectedTitle}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}

function CategoryDetailPanel({ category }) {
  return (
    <section className="relative mt-5 overflow-hidden rounded-[30px] border border-black bg-[#090909] p-5 shadow-[0_24px_68px_rgba(0,0,0,0.3)] sm:p-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(221,221,221,0.13),transparent_30%),radial-gradient(circle_at_100%_100%,rgba(117,117,117,0.14),transparent_34%)]" />
      <div className="relative">
        <div className="grid gap-4 xl:grid-cols-[1fr_auto] xl:items-end">
          <div>
            <div className="inline-flex rounded-full border border-black bg-white/[0.06] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#D8D8D8]">
              Selected Leaf
            </div>
            <h2 className="mt-3 font-reference text-3xl font-semibold text-white">{category.title}</h2>
            <p className="mt-2 max-w-4xl text-sm leading-7 text-[#C5C5C5]">{category.focus}</p>
          </div>
          <div className="rounded-2xl border border-black panel-gradient px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Tools On This Leaf
            </div>
            <div className="mt-1 text-3xl font-semibold text-white">{category.tools.length}</div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_0.9fr]">
          <div className="rounded-2xl border border-black panel-gradient p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#9A9A9A]">
              How It Helps
            </div>
            <p className="mt-3 text-sm leading-7 text-[#CECECE]">{category.useCase}</p>
          </div>
          <div className="rounded-2xl border border-[#4A2E2E] bg-[#170C0C] p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#F0B8B8]">
              Use With Care
            </div>
            <p className="mt-3 text-sm leading-7 text-[#E4C7C7]">{category.caution}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {category.tools.map((tool) => (
            <ToolCard key={tool.name} tool={tool} />
          ))}
        </div>
      </div>
    </section>
  );
}

export default function OsintToolsPage() {
  const [selectedCategoryTitle, setSelectedCategoryTitle] = useState(
    "Username, Email And Identity Correlation"
  );
  const selectedCategory =
    categoryByTitle.get(selectedCategoryTitle) || toolCategories[0];

  return (
    <PageShell
      title="OSINT Tools Library"
      subtitle="A categorized student reference for choosing the right research tool for the clue in front of you."
      badge="Student Toolkit"
      action={
        <Link to="/my-courses" className="inline-flex">
          <Button variant="secondary">Back To Your Courses</Button>
        </Link>
      }
    >
      <section className="relative overflow-hidden rounded-[30px] border border-black bg-[#080808] p-5 shadow-[0_24px_68px_rgba(0,0,0,0.34)] sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_8%_10%,rgba(232,232,232,0.14),transparent_28%),radial-gradient(circle_at_88%_6%,rgba(94,94,94,0.24),transparent_32%)]" />
        <div className="relative grid gap-5 xl:grid-cols-[1fr_0.84fr]">
          <div className="rounded-[26px] border border-black panel-gradient p-5 sm:p-6">
            <div className="inline-flex rounded-full border border-black bg-white/[0.06] px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#DDDDDD]">
              Choose By Investigation Task
            </div>
            <h2 className="mt-4 font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
              Keep the tool choice tied to the clue
            </h2>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-[#C0C0C0]">
              Open a category, read what the tools are meant to answer, and treat the result as a
              lead that needs verification. This library is for authorized learning, defensive
              research, and lawful OSINT work.
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              {["Username", "Email", "Metadata", "Archives", "Images", "Behavior"].map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-black bg-white/[0.05] px-3 py-1.5 text-xs font-semibold tracking-wide text-[#D8D8D8]"
                >
                  {item}
                </span>
              ))}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
            <div className="rounded-[24px] border border-black panel-gradient p-5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#989898]">
                Categories
              </div>
              <div className="mt-2 text-3xl font-semibold text-white">{toolCategories.length}</div>
              <p className="mt-2 text-sm leading-6 text-[#BDBDBD]">Expandable research lanes.</p>
            </div>
            <div className="rounded-[24px] border border-black panel-gradient p-5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#989898]">
                Tool Entries
              </div>
              <div className="mt-2 text-3xl font-semibold text-white">{allToolCount}</div>
              <p className="mt-2 text-sm leading-6 text-[#BDBDBD]">Reference cards and direct links.</p>
            </div>
            <div className="rounded-[24px] border border-black bg-gradient-to-br from-[#1A1A1A] to-[#0E0E0E] p-5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B6B6B6]">
                Research Rule
              </div>
              <p className="mt-3 text-sm leading-7 text-[#E0E0E0]">
                Cross-check important findings with more than one source and record how the clue
                was collected.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="relative mt-5 overflow-hidden rounded-[32px] border border-black bg-[#070707] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.34)] sm:p-6">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.07)_0,transparent_25%),radial-gradient(circle_at_50%_4%,rgba(188,188,188,0.18),transparent_22%)]" />
        <div className="relative">
          <div className="mx-auto max-w-xl rounded-[28px] border border-[#474747] bg-gradient-to-br from-[#F1F1F1] via-[#D8D8D8] to-[#9A9A9A] p-px shadow-[0_24px_62px_rgba(255,255,255,0.12)]">
            <div className="rounded-[27px] bg-[#111111] px-5 py-5 text-center sm:px-8">
              <div className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[#9E9E9E]">
                Investigation Root
              </div>
              <h2 className="mt-3 font-reference text-2xl font-semibold text-white sm:text-3xl">
                What clue do you have?
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#C6C6C6]">
                Pick the branch that matches the starting evidence. Every leaf opens the full tool
                guidance below.
              </p>
            </div>
          </div>

          <div className="pointer-events-none hidden lg:block">
            <span className="absolute left-1/2 top-[164px] h-11 w-px -translate-x-1/2 bg-gradient-to-b from-[#D6D6D6] to-[#5B5B5B]" />
            <span className="absolute left-[25%] right-[25%] top-[207px] h-px bg-gradient-to-r from-[#494949] via-[#D6D6D6] to-[#494949]" />
            <span className="absolute left-[25%] top-[207px] h-11 w-px bg-[#5B5B5B]" />
            <span className="absolute right-[25%] top-[207px] h-11 w-px bg-[#5B5B5B]" />
          </div>

          <div className="mt-5 flex justify-center lg:mt-11 lg:hidden">
            <span className="h-10 w-px bg-gradient-to-b from-[#D6D6D6] to-[#4B4B4B]" />
          </div>

          <div className="mt-2 grid gap-5 lg:mt-16 lg:grid-cols-2">
            {clueTree.map((branch) => (
              <article
                key={branch.title}
                className="relative rounded-[30px] border border-black bg-[#0A0A0A]/95 p-4 shadow-[0_20px_54px_rgba(0,0,0,0.3)] sm:p-5"
              >
                <div className="rounded-[24px] border border-black bg-[radial-gradient(circle_at_top_right,rgba(235,235,235,0.13),transparent_32%)] panel-gradient p-5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#9B9B9B]">
                    Primary Branch
                  </div>
                  <h3 className="mt-3 font-reference text-2xl font-semibold text-white">
                    {branch.title}
                  </h3>
                  <p className="mt-2 text-sm font-semibold text-[#E2E2E2]">{branch.question}</p>
                  <p className="mt-2 text-sm leading-7 text-[#BDBDBD]">{branch.description}</p>
                </div>

                <div className="relative mt-5 grid gap-4 xl:grid-cols-2">
                  <span className="absolute left-1/2 top-0 hidden h-px w-[calc(100%-7rem)] -translate-x-1/2 -translate-y-3 bg-[#545454] xl:block" />
                  {branch.forks.map((fork) => (
                    <TreeFork
                      key={fork.title}
                      fork={fork}
                      selectedTitle={selectedCategoryTitle}
                      onSelect={setSelectedCategoryTitle}
                    />
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <CategoryDetailPanel category={selectedCategory} />
    </PageShell>
  );
}
