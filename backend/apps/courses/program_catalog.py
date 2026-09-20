"""Initial, admin-editable content transcribed from the supplied course references.

Used only when creating new program records. Never overwrites existing content.
"""

from datetime import date
from decimal import Decimal

PROGRAMS = [
    {
        "slug": "osint-professional-training-batch-iv",
        "category": "osint",
        "title": "OSINT PROFESSIONAL TRAINING PROGRAM",
        "batch": "Batch IV",
        "card_title": "OSINT",
        "card_subtitle": "Open source intelligence",
        "card_summary": "Build a complete OSINT workflow across search intelligence, research tools, operational privacy, infrastructure mapping, dark-web research, CTF practice and professional reporting.",
        "card_highlights": [
            "Beginner to advanced OSINT pathway",
            "Search, tools, infrastructure & dark-web research",
            "Browser OPSEC, reporting & Python foundations",
            "Practical CTF training and casework",
        ],
        "description": "Progress from OSINT foundations to advanced investigation workflows through search intelligence, research tools, operational security, infrastructure mapping, dark-web research, CTF practice and professional reporting.",
        "about_the_course": "OSINT Professional Training Program Batch IV is a practical learning path built from the investigation methods taught across Al Syed Initiative classes. It connects foundational concepts with repeatable research methodology, safe tooling, source verification, operational privacy, organizational reconnaissance, challenge-based practice and evidence-led reporting.",
        "course_overview": "Build a professional open-source intelligence workflow from the ground up. Begin with OSINT, cybersecurity and networking concepts, then develop search-engine research, Python foundations, tool selection, Kali Linux familiarity and defensive phishing analysis. Advance into browser hardening, fingerprinting, Tor architecture, anonymous research, organizational attack-surface mapping, threat-intelligence platforms and API-assisted workflows. Consolidate the program through CTF exercises, case analysis and structured reporting.",
        "duration": "3 months",
        "batch_size_label": "Limited seats",
        "what_you_will_learn": [
            "Apply a structured, ethical OSINT methodology from collection to reporting",
            "Use Google and Yandex search operators for targeted public-source research",
            "Select and validate OSINT tools, directories and Telegram research resources",
            "Build Python foundations for repeatable research and basic automation",
            "Work confidently with Kali Linux as an OSINT research environment",
            "Recognize phishing infrastructure and indicators through defensive analysis",
            "Harden browsers and manage fingerprinting, privacy and investigator OPSEC",
            "Understand Tor architecture, Tails, Whonix and responsible dark-web research",
            "Map organizational infrastructure, exposure and public attack surfaces",
            "Use threat-intelligence platforms, exposure monitoring and API-assisted research",
            "Solve OSINT CTF challenges and document evidence clearly",
            "Produce structured target, case and intelligence reports",
        ],
        "expected_outcomes": [
            "Plan and execute a repeatable public-source investigation workflow",
            "Collect, verify and correlate findings across search engines and research tools",
            "Maintain safer operational practices during sensitive online research",
            "Map organizational infrastructure and identify publicly exposed assets",
            "Complete practical OSINT challenges using defensible evidence",
            "Present findings in a clear professional report with sources and methodology",
        ],
        "course_card_features": [
            {
                "icon": "live",
                "title": "Live instructor-led classes",
                "description": "Follow the OSINT workflow with live demonstrations, guided practice and instructor feedback.",
            },
            {
                "icon": "chat",
                "title": "Live broadcast chat room",
                "description": "Ask questions and resolve research, tooling and methodology doubts during sessions.",
            },
            {
                "icon": "recording",
                "title": "Lifetime recorded access",
                "description": "Revisit class demonstrations, investigation workflows and supporting materials anytime.",
            },
            {
                "icon": "check",
                "title": "Practical CTF and casework",
                "description": "Apply research methods through guided challenges, walkthroughs and evidence analysis.",
            },
            {
                "icon": "certificate",
                "title": "Course completion certificate",
                "description": "Receive a certificate after meeting the published completion requirements.",
            },
            {
                "icon": "support",
                "title": "Investigation support",
                "description": "Get help with research methodology, reporting structure and responsible tool usage.",
            },
        ],
        "public_curriculum": [
            {
                "title": "OSINT Foundations, Cybersecurity & Networking",
                "description": "Build the conceptual and ethical foundation required for professional public-source research.",
                "topics": [
                    "OSINT: what it is, how it works and where it is used",
                    "Cybersecurity and basic networking concepts for investigators",
                    "Investigation methodology, source validation and evidence handling",
                ],
            },
            {
                "title": "Search Engine Intelligence",
                "description": "Move from basic searching to structured discovery across major search engines.",
                "topics": [
                    "Google Dorking fundamentals and advanced operators",
                    "Multi-stage Google Dorking research workflows",
                    "Yandex Dorking and cross-engine verification",
                    "Recording queries, sources and reproducible findings",
                ],
            },
            {
                "title": "Python Foundations for OSINT",
                "description": "Develop the basic programming literacy needed for repeatable research tasks.",
                "topics": [
                    "Python basics I: values, variables and control flow",
                    "Python basics II: collections, functions and files",
                    "Python basics III: structured data and simple research automation",
                ],
            },
            {
                "title": "OSINT Tools, Directories & Telegram Research",
                "description": "Learn how to choose, validate and combine tools without treating tool output as verified evidence.",
                "topics": [
                    "OSINT tools introduction and evaluation",
                    "Advanced tool selection and research directories",
                    "Telegram bots and public-channel research resources",
                    "Cross-checking results and documenting tool limitations",
                ],
            },
            {
                "title": "Kali Linux Research Environment",
                "description": "Become familiar with a structured Linux workspace for authorized OSINT research.",
                "topics": [
                    "Introduction to Kali Linux for investigators",
                    "Filesystem, terminal and package-management essentials",
                    "Organizing research artifacts and maintaining a clean workspace",
                ],
            },
            {
                "title": "Defensive Phishing Analysis",
                "description": "Study phishing as an investigation and defense problem, focusing on indicators and public infrastructure.",
                "topics": [
                    "Phishing concepts, indicators and common delivery patterns",
                    "Public-source analysis of domains, links and supporting infrastructure",
                    "Evidence capture, risk communication and defensive reporting",
                ],
            },
            {
                "title": "Browser Hardening, Fingerprinting & Operational Privacy",
                "description": "Reduce avoidable research exposure and understand how browsers reveal investigator characteristics.",
                "topics": [
                    "Browser hardening and safer research profiles",
                    "Browser fingerprinting concepts and exposure analysis",
                    "Firefox hardening and practical investigator OPSEC",
                ],
            },
            {
                "title": "Tor Architecture & Responsible Dark-Web Research",
                "description": "Understand anonymity technologies and the operational discipline required for lawful research.",
                "topics": [
                    "Tor architecture and anonymity fundamentals",
                    "Tails and Whonix research environments",
                    "Responsible dark-web navigation and source evaluation",
                    "Operational boundaries, evidence safety and research notes",
                ],
            },
            {
                "title": "Infrastructure, Attack Surface & Threat Intelligence",
                "description": "Map public organizational exposure and connect infrastructure findings into an intelligence picture.",
                "topics": [
                    "Introduction to organizational OSINT and attack-surface mapping",
                    "Organizational reconnaissance and public infrastructure correlation",
                    "Threat-intelligence platforms and exposure monitoring",
                    "API-assisted collection and repeatable monitoring workflows",
                ],
            },
            {
                "title": "CTF Practice, Case Analysis & Professional Reporting",
                "description": "Consolidate the program through guided challenges, casework and defensible reporting.",
                "topics": [
                    "OSINT CTF walkthroughs and challenge methodology",
                    "CTF training, examination and solution review",
                    "Report analysis and target-focused reporting",
                    "Building a clear methodology, evidence trail and final intelligence report",
                ],
            },
        ],
        "price": Decimal("0"),
        "monthly_price": Decimal("0"),
        "full_payment_enabled": False,
        "installment_payment_enabled": False,
        "installments_required": 3,
        "image_alt": "",
        "modules": [
            (
                "Introduction to OSINT",
                "Foundations and real-world applications.",
                ["What is OSINT?", "Intelligence research workflows", "Ethical investigation and source verification"],
            ),
            (
                "Search Engine Techniques",
                "Advanced Google dorking and search strategies.",
                [
                    "Search operators and targeted research",
                    "Finding and validating public information",
                    "Documenting sources and evidence",
                ],
            ),
            (
                "Social Media Intelligence",
                "Track, analyse and map digital footprints.",
                ["Digital footprint analysis", "Online identity investigation", "Social media and web intelligence"],
            ),
            (
                "Tools & Resources",
                "Essential OSINT tools and platforms.",
                ["Open-source tools and resources", "Advanced research techniques", "Tool selection and verification"],
            ),
            (
                "Practical Investigations",
                "Apply professional investigation workflows.",
                ["Real-world case studies", "Evidence analysis and correlation", "Prepare an investigation report"],
            ),
        ],
    },
    {
        "slug": "web-api-pentesting-six-month-2027",
        "category": "web_pentesting",
        "launch_status": "coming_soon",
        "title": "6-MONTH WEB & API PENTESTING COURSE",
        "batch": "January 2027",
        "card_title": "PENTESTING",
        "card_subtitle": "Web application & API security",
        "card_summary": "From foundations to professional pentesting: a structured, Al Mikael-led journey through web security, API testing and real-world vulnerability research.",
        "card_highlights": [
            "6 phases · 24 weeks · 48 live classes",
            "Web application & API security",
            "6 graded milestone projects",
            "Professional capstone assessment",
        ],
        "description": "From zero to professional pentester. Build practical skills in web application security, API testing and vulnerability research through an Al Mikael-led, six-phase program.",
        "course_overview": "Progress from Linux, networking and HTTP foundations to advanced web vulnerabilities, REST and GraphQL API testing, automation and a full authorized capstone assessment. Two interactive classes each week combine practical labs with six graded milestone projects to build a professional portfolio.",
        "duration": "6 months / 24 weeks",
        "start_date": date(2027, 1, 1),
        "schedule": "Monday & Thursday (or as scheduled) · 2 classes/week",
        "total_classes": 48,
        "total_hours_label": "Approx. 100–120 hours",
        "snapshot_instructor": "Al Mikael",
        "what_you_will_learn": [
            "Cybersecurity, Linux, networking and HTTP foundations",
            "Web application testing and reconnaissance",
            "Authorization, SQL injection, XSS and file vulnerabilities",
            "Advanced web security and business logic",
            "REST and GraphQL API security",
            "Python automation and vulnerability chaining",
            "Professional reporting, remediation and capstone defence",
        ],
        "expected_outcomes": [
            "Week 4: First Web Assessment",
            "Week 8: Authentication & Authorization Assessment",
            "Week 12: OWASP-style Full Web Pentest",
            "Week 16: Advanced Web Application Assessment",
            "Week 20: REST + GraphQL API Security Assessment",
            "Week 24: Full Professional Web + API Pentest — presented and defended",
        ],
        "course_card_features": [
            {
                "icon": "live",
                "title": "48 Al Mikael-led classes",
                "description": "Two live classes each week; approximately 100–120 hours of instruction.",
            },
            {
                "icon": "recording",
                "title": "Permanent recorded access",
                "description": "Rewatch every live session from your account.",
            },
            {
                "icon": "support",
                "title": "24/7 team chat support",
                "description": "Advanced Digital Lawforce Front support between classes.",
            },
            {
                "icon": "chat",
                "title": "Live session chat",
                "description": "Ask questions and interact with Al Mikael during class.",
            },
            {
                "icon": "check",
                "title": "6 milestone projects",
                "description": "Build a portfolio from your first assessment to a full professional pentest.",
            },
            {
                "icon": "check",
                "title": "Practical security labs",
                "description": "OWASP Juice Shop, DVWA, WebGoat and PortSwigger Web Security Academy.",
            },
        ],
        "price": Decimal("18999"),
        "monthly_price": Decimal("4299"),
        "full_payment_enabled": True,
        "installment_payment_enabled": True,
        "installments_required": 6,
        "installment_access_days": 30,
        "bundle_payment_enabled": True,
        "bundle_price": Decimal("10999"),
        "bundle_installments": 2,
        "bundle_access_days": 90,
        "image_alt": "",
        "modules": [
            (
                "Phase 1 — Cybersecurity & Linux Foundations",
                "Weeks 1–4",
                [
                    "Pentesting lifecycle: planning, recon, enumeration, discovery, validation, reporting and retesting",
                    "Linux CLI: filesystem, permissions, processes, curl, SSH and package management",
                    "Networking: OSI, TCP/IP, DNS, Nmap and service discovery",
                    "HTTP methods, status codes, headers, HTTPS/TLS, Burp proxy and Intruder",
                ],
            ),
            (
                "Phase 2 — Web Application Fundamentals",
                "Weeks 5–7",
                [
                    "JavaScript, DOM, cookies and session management",
                    "Authentication bypass testing in authorized labs",
                    "Recon with Subfinder, Amass, httpx, ffuf, Gobuster and WhatWeb",
                ],
            ),
            (
                "Phase 3 — Web Pentesting Core",
                "Weeks 8–12",
                [
                    "Authorization and IDOR/BOLA: horizontal and vertical privilege escalation",
                    "SQL injection: error, union, blind and time-based; controlled SQLMap validation",
                    "Reflected, stored and DOM XSS; CSP, HttpOnly and output encoding",
                    "Path traversal, LFI and file upload validation",
                    "Command injection and SSRF: impact and controlled validation",
                ],
            ),
            (
                "Phase 4 — Advanced Web Security",
                "Weeks 13–16",
                [
                    "XXE and server-side template injection detection and impact",
                    "CSRF, CORS, SameSite and origin validation",
                    "JWT and OAuth 2.0: token validation, redirects and scopes",
                    "Business logic and race conditions: price manipulation, coupons and TOCTOU",
                ],
            ),
            (
                "Phase 5 — API Pentesting",
                "Weeks 17–20",
                [
                    "REST and GraphQL security assessment",
                    "BOLA, BFLA and mass assignment",
                    "Excessive data exposure and rate limiting",
                    "Postman and API testing tooling",
                ],
            ),
            (
                "Phase 6 — Automation, Chaining & Capstone",
                "Weeks 21–24",
                [
                    "Recon automation: Subfinder, httpx, Nuclei, Katana, ffuf and Burp",
                    "Python HTTP tools using requests, argparse, subprocess and JSON",
                    "Vulnerability chaining and impact analysis in authorized labs",
                    "Full authorized web, REST API and GraphQL assessment",
                    "Professional report: executive summary, risk ratings, evidence, business impact and remediation",
                ],
            ),
        ],
    },
]
