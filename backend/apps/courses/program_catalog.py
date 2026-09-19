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
        "card_summary": "Master the art of finding, verifying and analysing open-source information for real-world investigations and intelligence gathering.",
        "card_highlights": [
            "Real-world investigation workflows",
            "Social media & web intelligence",
            "Advanced research techniques",
            "Practical labs & case studies",
        ],
        "description": "Master open-source intelligence. Build real-world skills. Investigate, analyse and expose with a structured professional workflow.",
        "course_overview": "This structured OSINT training program teaches practical, open-source intelligence investigation techniques. Learn to analyse digital footprints, investigate online identities and conduct real-world intelligence research using professional investigation workflows.",
        "duration": "3 months",
        "batch_size_label": "Limited seats",
        "what_you_will_learn": [
            "Digital footprint analysis",
            "Online identity investigation",
            "Search engine intelligence",
            "Social media intelligence",
            "Open-source tools and resources",
            "Research techniques and practical investigations",
        ],
        "course_card_features": [
            {
                "icon": "live",
                "title": "Live instructor-led classes",
                "description": "Real-time guidance from industry experts.",
            },
            {
                "icon": "chat",
                "title": "Live broadcast chat room",
                "description": "Get your doubts cleared during sessions.",
            },
            {
                "icon": "recording",
                "title": "Lifetime recorded access",
                "description": "Access all sessions and learning materials anytime.",
            },
            {
                "icon": "check",
                "title": "3 exclusive live Q&A sessions",
                "description": "Join live Q&A sessions with the Al Syed team.",
            },
            {
                "icon": "certificate",
                "title": "Course completion certificate",
                "description": "Receive a certificate upon successful completion.",
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
