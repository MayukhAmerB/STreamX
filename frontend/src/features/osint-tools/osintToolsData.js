// OSINT tools library data (moved verbatim from the original OsintToolsPage).
// Category titles are stable keys; use toSentenceCase() for display.

export const toolCategories = [
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
    title: "Phishing Simulation And Awareness",
    focus: "Use only for authorized awareness training, lab exercises, and defensive review.",
    useCase:
      "These references help students understand phishing campaign workflows, adversary-in-the-middle risk, reverse-proxy abuse, and the controls that reduce credential and session theft.",
    caution:
      "Do not target real users, credentials, sessions, domains, or brands without explicit written authorization. Keep simulations scoped, logged, and approved.",
    tools: [
      {
        name: "Gophish",
        type: "Awareness simulation",
        use: "Open-source framework reference for controlled phishing-awareness campaigns, templates, and result review.",
        url: "https://getgophish.com/",
      },
      {
        name: "Zphisher",
        type: "Training reference",
        use: "Template-driven phishing demonstration reference for discussing social-engineering risk in isolated training.",
        url: "https://github.com/htr-tech/zphisher",
      },
      {
        name: "Evilginx2",
        type: "AiTM risk reference",
        use: "Adversary-in-the-middle reference for understanding token and session theft risk and the defenses around it.",
        url: "https://github.com/kgretzky/evilginx2",
      },
      {
        name: "Modlishka",
        type: "Reverse proxy reference",
        use: "Reverse-proxy phishing research reference for controlled authentication and MFA-resilience discussion.",
        url: "https://github.com/drk1wi/Modlishka",
      },
      {
        name: "Muraena",
        type: "Reverse proxy reference",
        use: "Reverse-proxy research reference for studying post-phishing risk and defensive controls in approved labs.",
        url: "https://github.com/muraenateam/muraena",
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

export const allToolCount = toolCategories.reduce((total, category) => total + category.tools.length, 0);
export const categoryByTitle = new Map(toolCategories.map((category) => [category.title, category]));

export const beginnerPaths = [
  {
    title: "Username Or Email",
    prompt: "I have a handle, email, or account clue.",
    categoryTitle: "Username, Email And Identity Correlation",
    start: "Check public account presence first, then verify every identity pivot manually.",
  },
  {
    title: "Domain Or URL",
    prompt: "I have a domain, IP, service, or suspicious URL.",
    categoryTitle: "Domain, Email And Internet Infrastructure",
    start: "Start with passive domain, DNS, URL, and service context before any active interaction.",
  },
  {
    title: "Phone Or Vehicle",
    prompt: "I have a number or Indian registration clue.",
    categoryTitle: "Phone And Vehicle Lookups",
    start: "Prefer official or clearly scoped lookups and treat personal details as sensitive.",
  },
  {
    title: "Image Or Screenshot",
    prompt: "I need clues from a photo, frame, or screenshot.",
    categoryTitle: "Image And Screenshot Analysis",
    start: "Inspect visible clues and provenance before treating reverse-search matches as evidence.",
  },
  {
    title: "File Or Metadata",
    prompt: "I have a PDF, image, document, archive, or media file.",
    categoryTitle: "Metadata Analysis",
    start: "Preserve the original file and record what metadata method produced each clue.",
  },
  {
    title: "Older Web Evidence",
    prompt: "I need to compare a page with its history.",
    categoryTitle: "Archive And Historical Capture",
    start: "Compare captures, current pages, and collection times before concluding what changed.",
  },
  {
    title: "Writing Or Behavior",
    prompt: "I see repeated phrasing, timing, or interaction patterns.",
    categoryTitle: "Writing Style, Timing And Behavioral Patterns",
    start: "Use patterns to support a hypothesis, not to claim identity without corroboration.",
  },
  {
    title: "Authorized Phishing Lab",
    prompt: "I am studying awareness simulations and phishing defenses.",
    categoryTitle: "Phishing Simulation And Awareness",
    start: "Stay in an approved lab or written simulation scope and focus on controls and lessons.",
  },
  {
    title: "I Am Not Sure Yet",
    prompt: "I need a directory or toolkit to choose the right lane.",
    categoryTitle: "Directories And Search Starting Points",
    start: "Use broad toolkits to choose the clue type, then move into a focused category.",
  },
];
