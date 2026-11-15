// AL SYED LABS - application logic.
//
// Sections: Free CTFs (#hub) | Paid Labs (#paid) | Examination (#exam, exam.js)
// | Leaderboard (#leaderboard), and the labs: #realworld, #blackmeridian,
// #certification.
//
// Access (display; the server enforces what it can):
//   * Free CTFs (easy/medium cases): signed-in students with active course
//     access (Batch 2 / Batch 3: /ctf/eligibility/), Starter and CTF Labs
//     members, staff. The labs server enforces it when the LMS switch
//     "labs_membership_required" is on (labs-access.js).
//   * Paid labs (expert/professional): CTF Labs members (ctf_labs, billing
//     all_labs) and staff (/ctf/labs/entitlement/).
// No answer, hash or hint of a paid case is in this file.
document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    // ----------------------------------------------------
    // 1. STATE & STORAGE
    // ----------------------------------------------------
    const store = {
        get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
        set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
        remove: (key) => { try { localStorage.removeItem(key); } catch { /* private mode */ } },
    };

    let currentLang = store.get("zenith_ctf_lang") || "en";
    if (currentLang !== "en" && currentLang !== "ur") currentLang = "en";

    const labCategories = ["realworld", "blackmeridian", "certification"];
    let solvedQuestions = {
        realworld: Array(10).fill(false),
        blackmeridian: Array(10).fill(false),
        certification: Array(10).fill(false),
    };
    try {
        const storedProgress = JSON.parse(store.get("zenith_ctf_solved"));
        if (storedProgress && Array.isArray(storedProgress.realworld)) solvedQuestions = storedProgress;
    } catch {
        store.remove("zenith_ctf_solved");
    }
    labCategories.forEach((category) => {
        if (!Array.isArray(solvedQuestions[category]) || solvedQuestions[category].length < 10) {
            solvedQuestions[category] = Array(10).fill(false);
        }
        solvedQuestions[category] = solvedQuestions[category].slice(0, 10).map(Boolean);
    });

    const saveState = () => {
        store.set("zenith_ctf_solved", JSON.stringify(solvedQuestions));
        updateProgressIndicators();
    };

    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    })[character]);
    const esc = escapeHtml;

    const COURSES_URL = "https://alsyedinitiative.com/courses";
    const DEFAULT_API_BASE = "https://api.alsyedinitiative.com/api";

    const state = {
        tab: "hub",
        apiBase: "",
        siteUrl: "",
        selected: { realworld: 0, blackmeridian: 0, certification: 0 },
        drafts: {},
        feedback: {},
        access: {
            loaded: false,
            signedIn: false,
            lmsDown: false,
            staff: false,
            paidMember: false,
            starter: false,
            batch: false,
            batchReason: "",
            keys: [],
            server: { membershipRequired: false, allowedDifficulties: [], pass: false },
        },
        user: null,
        season: null,
        seasonBoard: null,
        hallOfFame: null,
        directory: null,
        directoryDone: new Set(),
        directoryXp: 0,
        directoryFromApi: false,
        dirFilter: "all",
        dirExpanded: {},
    };

    // ----------------------------------------------------
    // 2. CONTENT (practice labs; answers are checked by server.js)
    // ----------------------------------------------------
    const blackMeridianQuestions = {
        en: [
            {
                q: "Start from the real Instagram profile and recover the controlled GitHub operator cluster. Across the live branches, several public identities share weak habits, but only one survives device, cadence, and phrasing correlation. Submit the reused handle."
            },
            {
                q: "Inside the live public mirror branch, the same operator buried a contact route in a presentation-layer artifact. Recover the full mailbox that is not written as normal visible text."
            },
            {
                q: "Follow the live repository infrastructure trail until vanity names stop and operational DNS begins. Submit the apex domain that anchors the telemetry cluster."
            },
            {
                q: "The current edge is not the origin. Use historical resolution evidence from the live branch and ignore CDN/proxy records. Submit the original IPv4 address."
            },
            {
                q: "One archived HTTP response in the live evidence surface exposes the storage location used before cleanup. Submit the full storage URI exactly, including the scheme."
            },
            {
                q: "A live repository cleanup removed a value needed later. Version history residue preserves it. Submit the exact salt token."
            },
            {
                q: "A media artifact in the live movement repo leaks a northern coordinate in a non-decimal form. Convert it to signed decimal degrees as latitude,longitude rounded to four decimals."
            },
            {
                q: "Correlate the leaked coordinate with the cold-stop movement ledger and identify the physical asset tied to that stop. Submit the registration/tail code."
            },
            {
                q: "The operator rotated keys, but an automation note still identifies the encryption-only component. Submit the lowercase short key ID with 0x prefix."
            },
            {
                q: "The final payload in the live vault branch is locked behind evidence collected from earlier stages. Use the provided recovery tooling and submit the exact emitted flag."
            }
        ],
        ur: [
            {
                q: "Begin from the artifact index. Several public-facing identities share weak operational habits, but only one survives device, cadence, and phrasing correlation. Submit the reused handle."
            },
            {
                q: "The same operator buried a contact route in a presentation-layer artifact. Recover the full mailbox that is not written as normal visible text."
            },
            {
                q: "Follow the infrastructure trail until vanity names stop and operational DNS begins. Submit the apex domain that anchors the telemetry cluster."
            },
            {
                q: "The current edge is not the origin. Use historical resolution evidence and ignore CDN/proxy records. Submit the original IPv4 address."
            },
            {
                q: "One archived HTTP response exposes the storage location used before cleanup. Submit the full storage URI exactly, including the scheme."
            },
            {
                q: "A repository cleanup removed a value needed later. Version history residue preserves it. Submit the exact salt token."
            },
            {
                q: "A media artifact leaks a northern coordinate in a non-decimal form. Convert it to signed decimal degrees as latitude,longitude rounded to four decimals."
            },
            {
                q: "Correlate the leaked coordinate with the cold-stop movement ledger and identify the physical asset tied to that stop. Submit the registration/tail code."
            },
            {
                q: "The operator rotated keys, but an automation note still identifies the encryption-only component. Submit the lowercase short key ID with 0x prefix."
            },
            {
                q: "The final payload is locked behind evidence collected from earlier stages. Use the provided recovery tooling and submit the exact emitted flag."
            }
        ]
    };

    const certificationQuestions = {
        en: [
            {
                title: "The Borrowed Lens",
                briefing: [
                    "A tool name has been intentionally hidden as ROT13: Ze.Ubyzrf.",
                    "Decode the project name, identify the public maintainer footprint connected to that project, and follow the maintainer's public social trail. One reposted verification artifact exposes a six-digit code."
                ],
                task: "Recover the six-digit verification code visible in the public artifact.",
                constraints: "Do not submit the tool name, maintainer name, repository name, or profile handle.",
                answerFormat: "Six digits only."
            },
            {
                title: "The Expired Workstation",
                briefing: [
                    "A press-freedom publishing platform maintains a public onion presence. In its news archive, an interest notice describes a workstation dependency reaching the end of its supported lifecycle.",
                    "The item is not meant to be found through a clearnet headline alone. Treat the onion URL and publication date as the evidence pair."
                ],
                task: "Locate the notice and submit the exact onion URL of the article together with the article publication date.",
                constraints: "Use passive browsing only. Do not submit the software name by itself.",
                answerFormat: "URL | Month DD, YYYY"
            },
            {
                title: "The Camera Clock",
                briefing: [
                    "An artifact locator has been encoded before being placed in the case file. Decode the locator, inspect the photographic metadata at the destination, and avoid relying on page titles or surrounding text.",
                    "The required value is the original capture timestamp stored inside the image metadata."
                ],
                artifact: "aHR0cHM6Ly9waXhlbHBlZXBlci5ueWMzLmRpZ2l0YWxvY2VhbnNwYWNlcy5jb20vaW1hZ2VzLzIwMjQvMDIvNDMyeTR6NGJyYjkxbThkM2p5NWV5djAzOWQuanBn",
                task: "Submit the exact timestamp shown in the metadata field for when the image was taken.",
                constraints: "Do not submit camera model, lens model, upload time, or page scrape time.",
                answerFormat: "YYYY:MM:DD HH:MM:SS"
            },
            {
                title: "The Transport Trial",
                briefing: [
                    "A 2024 disruption of London's public transport network later surfaced in court reporting, where members of a well-known intrusion community were tied to the incident.",
                    "After identifying the group, pivot to defensive-intelligence reporting on tools used by that group. One malware entry is explicitly described as enabling remote access to targeted systems."
                ],
                task: "Submit the malware family name associated with that remote-access capability.",
                constraints: "Do not submit the group name, technique ID, victim name, or court article title.",
                answerFormat: "Malware name only."
            },
            {
                title: "The Comment Trail",
                briefing: [
                    "Begin with the public Instagram profile hackwithher. One mid-2024 breach meme on that profile contains a comment trail.",
                    "A reply from a leetspeak cyber handle leads to a related profile. On that related profile, a later aviation-tracking screenshot shows a military/government aircraft operating over the eastern Mediterranean.",
                    "The aircraft information is visible in the tracking interface, not in the meme itself."
                ],
                task: "Identify the aircraft type shown in the aviation-tracking screenshot.",
                constraints: "Do not submit the Instagram handle, aircraft registration, airport, or country.",
                answerFormat: "Aircraft type exactly as displayed."
            },
            {
                title: "The Lit Artery",
                briefing: [
                    "The evidence image shows a night skyline, a distinctive tower, and a brightly lit traffic corridor in the foreground. The task is to identify the street, not the city or the landmark.",
                    "Use visual geolocation and corroborate the foreground roadway against nearby landmarks."
                ],
                task: "Geolocate the foreground street visible in the image and submit the street name only.",
                constraints: "Do not submit the neighborhood, mall, hotel, city, or country.",
                answerFormat: "Street name only.",
                image: "/materials/certification/baghdad-street.jpg",
                imageAlt: "Night skyline over western Baghdad with a lit roadway in the foreground"
            },
            {
                title: "The Passive Host Pivot",
                briefing: [
                    "An indexed IPv4 for an exposed camera is encoded in the artifact below. Decode it only to identify the passive OSINT record. The device is not the target and must not be touched.",
                    "Use passive OSINT only. Pivot from the indexed service metadata to the provider's primary public domain, then resolve that provider domain."
                ],
                artifact: "ODYuMTA3LjE5OS42OA==",
                task: "Submit the public IPv4 address of the hosting provider's primary domain.",
                constraints: "Do not interact with the exposed camera or submit the camera IP. Do not submit the provider name or ASN.",
                answerFormat: "IPv4 address only."
            },
            {
                title: "The README Footer",
                briefing: [
                    "The target is an educational GitHub repository about search patterns. The dork lists themselves are not the answer; they are only a route to the repository.",
                    "At the end of the README, a final section label is encoded. Decode the label, locate that section, and read the sentence written beneath it."
                ],
                searchPatterns: [
                    "site:github.com \"Useful Github Dorks for BugBounty\"",
                    "site:github.com \"github-dorks\" \"BugBounty\" \"api_key\"",
                    "site:github.com \"extension:json\" \"api_key\" \"password\" \"github-dorks\""
                ],
                artifact: "64 69 73 63 6c 61 69 6d 65 72",
                task: "Submit the exact sentence written under the decoded final section label.",
                constraints: "Do not submit the decoded label itself. Do not submit any dork pattern.",
                answerFormat: "Exact sentence, preserving punctuation."
            },
            {
                title: "The Citizen Intelligence Trail",
                briefing: [
                    "A public code project styles itself as a citizen intelligence agency. The repository owner maintains a public organization footprint separate from the repository.",
                    "Pivot from the repository to the organization's public site and inspect the founder timeline. The earliest networking entry contains the required legacy network identifier."
                ],
                task: "Recover the Fidonet node from the earliest networking entry in the founder timeline.",
                constraints: "Do not submit the project name, organization name, website URL, founder name, or job title.",
                answerFormat: "Fidonet node exactly as written."
            },
            {
                title: "The Dinner Evacuation File",
                briefing: [
                    "OSINT Analysis - White House Correspondents' Dinner - April 25, 2026.",
                    "20:36 ET. Washington Hilton, Connecticut Avenue NW. The annual White House Correspondents' Dinner is in full swing when an evacuation is triggered. Five to eight gunshots are reported in the immediate vicinity of the perimeter. The President is extracted by the Secret Service. A suspect is apprehended on site.",
                    "You are the OSINT analyst on duty. Two public social posts show seized equipment. Press reporting initially exposes only a name and age. Your task is to reconstruct the MPDC-identified suspect file from the authorized public reporting set."
                ],
                task: "Provide the suspect's full name, age, and hometown as identified through the authorized public reporting set.",
                constraints: "Authorized sources: @tacticalporn status 2048303261988368630, @ippatel status 2048238523380297812, Secret Service, MPDC, NBC, CBS, Reuters, AP, and BBC press releases.",
                answerFormat: "OSINT{First_Middle_Last_Age_City}"
            }
        ],
        ur: []
    };

    const questionsData = {
        en: [
            {
                q: "The profile is not the identity; it is only a pointer. Recover the lowercase public username the operator reused elsewhere. Submit the username only."
            },
            {
                q: "A visual diagnostic leak contains material intended to unlock a restricted system. Recover the exact access phrase, preserving capitalization and separators."
            },
            {
                q: "A cleanup commit removed a development secret, but version control retained the evidence. Recover the exact salt value that existed immediately before the redaction."
            },
            {
                q: "An abandoned valuation schema reveals the storage constraint used for fractional multipliers. Submit the complete SQL type declaration exactly as defined."
            },
            {
                q: "Within the operator's corporate-research footprint, identify the registration number of the prominent British holding company and return its standard 256-bit digest as lowercase hexadecimal."
            },
            {
                q: "The operator's cryptographic material separates identity from message protection. Submit the lowercase short identifier, prefixed with 0x, of the key component that can encrypt but not sign."
            },
            {
                q: "An automation artifact reveals where protected output was intended to travel. Recover the complete recipient address, including its non-clearnet domain."
            },
            {
                q: "One captured boot sequence records the scheduler coming online. Submit the numeric process identifier assigned at startup."
            },
            {
                q: "A travel record ties SK-901 to a cold northern stop. Recover the signed Celsius observation recorded for that leg, including the degree symbol and unit."
            },
            {
                q: "The evidence recovered earlier forms the credential pair for a protected payload. Use the operator's own tooling and submit the final flag exactly as emitted."
            }
        ],
        ur: [
            {
                q: "پروفائل اصل شناخت نہیں بلکہ صرف ایک اشارہ ہے۔ وہ عوامی صارف نام تلاش کریں جسے آپریٹر نے کسی دوسری جگہ دوبارہ استعمال کیا ہے۔ صرف چھوٹے حروف میں صارف نام جمع کریں۔"
            },
            {
                q: "ایک بصری تشخیصی لیک میں محدود سسٹم تک رسائی کے لیے استعمال ہونے والا مواد موجود ہے۔ بڑے اور چھوٹے حروف اور جدا کرنے والی علامتیں برقرار رکھتے ہوئے مکمل رسائی فقرہ بازیافت کریں۔"
            },
            {
                q: "ایک صفائی والے کمٹ نے ترقیاتی راز حذف کیے، لیکن ورژن کنٹرول نے پرانا ثبوت محفوظ رکھا۔ ریڈیکشن سے فوراً پہلے موجود مکمل سالٹ قدر بازیافت کریں۔"
            },
            {
                q: "ایک ترک شدہ ویلیوایشن اسکیمہ بتاتا ہے کہ اعشاری ضرب کار کس اسٹوریج حد کے ساتھ محفوظ تھا۔ مکمل SQL ٹائپ ڈیکلریشن بالکل اسی شکل میں جمع کریں۔"
            },
            {
                q: "آپریٹر کی کارپوریٹ تحقیق میں نمایاں برطانوی ہولڈنگ کمپنی کا رجسٹریشن نمبر شناخت کریں اور اس کا معیاری 256 بٹ ڈائجسٹ چھوٹے حروف کی ہیکسا ڈیسیمل شکل میں جمع کریں۔"
            },
            {
                q: "آپریٹر کے کرپٹوگرافک مواد میں شناخت اور پیغام کی حفاظت الگ رکھی گئی ہے۔ اس کلیدی جزو کا مختصر شناختی نمبر چھوٹے حروف میں 0x کے ساتھ جمع کریں جو انکرپٹ کر سکتا ہے مگر دستخط نہیں۔"
            },
            {
                q: "ایک خودکار آرٹیفیکٹ ظاہر کرتا ہے کہ محفوظ آؤٹ پٹ کہاں بھیجا جانا تھا۔ نان کلیئرنیٹ ڈومین سمیت مکمل وصول کنندہ پتہ بازیافت کریں۔"
            },
            {
                q: "ایک محفوظ شدہ بوٹ سلسلے میں شیڈیولر کے آن لائن ہونے کا ریکارڈ موجود ہے۔ آغاز کے وقت دیا گیا عددی پروسیس شناختی نمبر جمع کریں۔"
            },
            {
                q: "ایک سفری ریکارڈ SK-901 کو شمال کے ایک سرد پڑاؤ سے جوڑتا ہے۔ اس مرحلے کے لیے درج شدہ علامتی سیلسیس مشاہدہ ڈگری نشان اور اکائی سمیت بازیافت کریں۔"
            },
            {
                q: "پہلے بازیافت کیے گئے شواہد ایک محفوظ پیلوڈ کے لیے درکار اسناد کا جوڑا بناتے ہیں۔ آپریٹر کے اپنے ٹول استعمال کریں اور حتمی فلیگ بالکل اسی طرح جمع کریں جیسے وہ ظاہر ہو۔"
            }
        ]
    };

    // Difficulty of every case (mirrors labs-access.js QUESTION_DIFFICULTY).
    const DIFFICULTY = {
        realworld: ["easy", "easy", "easy", "medium", "medium", "medium", "expert", "expert", "expert", "expert"],
        blackmeridian: Array(10).fill("expert"),
        certification: Array(10).fill("professional"),
    };
    const FREE_LEVELS = ["easy", "medium"];

    // Short case titles for the case lists (they never hint at the answer).
    const CASE_TITLES = {
        realworld: ["The pointer profile", "Diagnostic leak", "Redacted salt", "Valuation schema", "Holding company digest",
            "Encryption subkey", "Protected output route", "Scheduler boot", "The cold northern stop", "Final payload"],
        blackmeridian: ["Operator cluster", "Hidden mailbox", "Telemetry apex", "Origin before the edge", "Pre-cleanup storage",
            "Residual salt", "Northern coordinate", "Cold-stop asset", "Encryption-only key", "Vault payload"],
    };

    const LAB_INFO = {
        realworld: {
            starting: "@xcfwjoo310",
            evidenceNote: "Live investigation: no files are supplied. Start from the public profile and build the evidence chain yourself.",
        },
        blackmeridian: {
            starting: "@xcfwjoo310",
            evidenceNote: "Live evidence surface: the operator's public repositories and their history.",
            index: "/materials/black-meridian/START_HERE.md",
        },
        certification: { evidenceNote: "Each case carries its own evidence below." },
    };

    // ----------------------------------------------------
    // 3. UI STRINGS (English / Urdu)
    // ----------------------------------------------------
    const translations = {
        en: {
            brandLabs: "Labs",
            navHub: "Free CTFs",
            navPaid: "Paid Labs",
            navLeaderboard: "Leaderboard",
            navLabs: "Zenith Footprint",
            navBlackMeridian: "Black Meridian",
            navCertification: "Certification CTF",
            langToggle: "اردو",
            signIn: "Sign in",
            signedIn: "Signed in",
            checking: "Checking your access…",
            tierStaff: "Staff",
            tierMember: "Member",
            tierStarter: "Starter",
            tierBatch: "Batch student",
            rankLabel: "Rank",
            unranked: "Unranked",
            xp: "XP",
            free: "Free",
            paid: "Paid",
            open: "Open",
            locked: "Locked",
            complete: "Complete",
            comingSoon: "Coming soon",
            hubKicker: "Free CTFs",
            hubHeading: 'Investigate. <span class="text-demand">For free.</span>',
            hubLede: "Starter cases from our own labs and hand-picked free CTFs from the OSINT community. Included for Batch 2 and Batch 3 students.",
            freeLabsTitle: "Al Syed starter cases",
            freeLabsNote: "Checked on our server. Your progress is saved in this browser.",
            dirTitle: "Community free CTFs",
            dirNote: "Curated exercises on other platforms. They open in a new tab.",
            dirAll: "All",
            dirEmpty: "No exercises match this filter.",
            dirOpen: "Open on {platform}",
            dirDone: "Done",
            dirMarkDone: "Mark done",
            dirMinutes: "{n} min",
            dirSignIn: "Sign in to track",
            freeUnlockedTitle: "Free CTFs unlocked",
            freeUnlockedText: "Every free case is open to you. Answers are checked on our server.",
            freeSignedOutTitle: "Sign in to play",
            freeSignedOutText: "Free CTFs are included for Batch 2 and Batch 3 students. Sign in with your Al Syed account to submit answers.",
            freeNoBatchTitle: "Free CTFs come with your batch",
            freeNoBatchText: "Free CTFs are included for students of Batch 2 and Batch 3. Enrol in a batch to unlock them.",
            freeExpiredTitle: "Your course access has ended",
            freeExpiredText: "Renew your course access to reopen the free CTFs.",
            lmsDownText: "We could not reach your Al Syed account. Check your connection and try again.",
            retry: "Try again",
            browseCourses: "Browse courses",
            renewAccess: "Renew access",
            seeCourses: "See courses and plans",
            howToUnlock: "How to unlock",
            statStarter: "Starter cases",
            statPoints: "Practice points",
            statCommunity: "Community CTFs done",
            statXp: "XP",
            zenithStarterTitle: "The Zenith Footprint · Starter",
            zenithStarterCopy: "Start from one public handle and rebuild an operator's identities and mistakes. Cases 1 to 6.",
            communityCardTitle: "Community free CTFs",
            communityCardCopy: "Geolocation, image and people puzzles on Gralhix, Hacktoria, TryHackMe and more.",
            examCardTitle: "OSINT Examination",
            examCardCopy: "Timed, graded and recorded against your LMS account. For enrolled students.",
            cases: "Cases",
            exercises: "Exercises",
            examAccess: "For",
            examAccessValue: "Batch 2 · 3",
            showAll: "Show all {n}",
            showLess: "Show fewer",
            difficulty: "Difficulty",
            format: "Format",
            exactAnswer: "Exact answer",
            linkOut: "Link-out",
            graded: "Graded",
            openLab: "Open lab",
            previewLab: "Preview lab",
            browse: "Browse",
            openExam: "Go to examination",
            solvedOf: "{n} / {total} solved",
            paidKicker: "Paid labs",
            paidHeading: 'Labs that <span class="text-demand">demand</span> excellence.',
            paidLede: "Live, expert-level investigations with exact-answer checks. Unlocked with a CTF Labs membership or a course plan that includes all labs.",
            paidUnlockedTitle: "Paid labs unlocked",
            paidUnlockedText: "Your membership opens every paid lab.",
            paidLockedTitle: "Paid labs are locked",
            paidLockedText: "Unlock them with a CTF Labs membership or a course plan that includes all labs. You can preview what is inside each lab below.",
            inside: "Inside",
            zenithAdvTitle: "The Zenith Footprint · Advanced",
            zenithAdvCopy: "The last four stages of the Zenith operator: protected output, boot records, a cold northern stop and the final payload.",
            zenithAdvInside: ["Automation artifacts and mail routing", "Captured boot sequences", "Travel records and a protected payload"],
            blackCopy: "Expert correlation across branches, commit history, metadata, DNS residue and a protected payload.",
            blackInside: ["Ten chained stages in a live GitHub cluster", "Historical DNS and archived HTTP evidence", "Media metadata, key material and a vault payload"],
            certCopy: "Ten standalone cases with exact-answer checks. No hints and no walkthroughs.",
            certInside: ["Dark-web, metadata and geolocation cases", "Encoded artifacts and passive host pivots", "Exam-style: no hints, exact answers"],
            labLocked: "This lab is locked",
            caseLockedPaid: "This case is part of a paid lab",
            caseLockedPaidText: "Unlock it with a CTF Labs membership or a course plan that includes all labs.",
            caseLockedSignIn: "Sign in to play this case",
            caseLockedSignInText: "Free cases are included for Batch 2 and Batch 3 students.",
            caseLockedBatch: "Included with Batch 2 and Batch 3",
            caseLockedBatchText: "Enrol in a batch to submit answers to the free cases.",
            caseLabel: "Case",
            stepBrief: "Brief",
            stepEvidence: "Evidence",
            stepAnswer: "Answer",
            stepHints: "Hints",
            startingPoint: "Starting point",
            evidenceIndex: "Evidence index",
            artifactCard: "Artifact",
            artifactNote: "Use this supplied evidence exactly as part of the investigation.",
            searchPatterns: "Allowed search patterns",
            task: "Task",
            constraints: "Constraints",
            answerFormat: "Answer format",
            example: "Example",
            noHints: "No hints in this lab, by design. Work from the evidence.",
            hintCount: "{n} hint(s) available. Each one is revealed only when you ask.",
            revealHint: "Reveal hint {n}",
            hintN: "Hint {n}",
            prevCase: "Previous",
            nextCase: "Next case",
            potential: "{n} pt",
            solvedBadge: "Solved",
            btnSubmit: "Submit",
            btnChecking: "Checking…",
            btnSolved: "Solved ✓",
            inputPlaceholder: "Enter your answer…",
            feedbackSuccess: "[+] Correct. Case solved.",
            feedbackError: "[-] Incorrect. Re-check the evidence and try again.",
            feedbackUnavailable: "[-] The answer service is unavailable. Please try again.",
            feedbackMembers: "[-] This case is for members.",
            feedbackRate: "[-] Too many attempts. Wait one minute.",
            allCategories: "All",
            categories: "Categories",
            minutes: "{n} min",
            points: "{n} pts",
            leaderboardKicker: "Leaderboard",
            leaderboardHeading: 'The <span class="text-demand">board</span>.',
            leaderboardLede: "The Monthly OSINT CTF ranks every solver by time. Finalists join the Hall of Fame.",
            seasonTitle: "This month",
            seasonNone: "No monthly CTF is running right now. The next case opens at the start of the month.",
            seasonNoSolvers: "No one has solved this month's case yet. Be the first.",
            seasonSolvers: "{solvers} solvers · {participants} players",
            seasonPhase: { upcoming: "Opens soon", open: "Open now", closed: "Closed", results: "Results" },
            colRank: "#",
            colHandle: "Handle",
            colTime: "Time",
            colPenalty: "Wrong",
            you: "You",
            firstBlood: "First blood",
            hofTitle: "Hall of Fame",
            hofNone: "The Hall of Fame fills up when the first monthly season is finalised.",
            recordTitle: "Your labs record",
            recordFoot: "Practice progress is kept in this browser.",
            meTitle: "Your standing",
            streak: "Month streak",
            seasonsSolved: "Seasons solved",
            xpEarned: "XP earned",
            trophies: "Trophies",
            boardUnavailable: "The leaderboard is unavailable right now.",
            progressSolved: "Solved",
            progressScore: "Score",
            ptsSuffix: " pts",
            labStatSolved: "Solved",
            labStatScore: "Score",
            labStatPoints: "Points",
            labSubheading: "Live investigation",
            labTitle: "The Zenith Footprint",
            labDesc: "Start with @xcfwjoo310. Discover the operator's identities, infrastructure, historical mistakes and protected artifacts without being given the investigation path.",
            blackSubheading: "Elite investigation",
            blackTitle: "Black Meridian",
            blackDesc: "A live OSINT correlation lab. Start from @xcfwjoo310, pivot into the controlled GitHub account, and work across black-meridian branches, commit history, metadata, DNS residue, crypto notes and a protected payload.",
            certificationSubheading: "Certification practice",
            certificationTitle: "Certification CTF",
            certificationDesc: "Ten standalone OSINT cases. No hints, no walkthroughs and exact-answer validation.",
            crumbFree: "← Free CTFs",
            crumbPaid: "← Paid labs",
            groupFree: "Free · Starter",
            groupPaid: "Paid · Advanced",
            levels: { easy: "Easy", medium: "Medium", hard: "Hard", expert: "Expert", professional: "Professional", advanced: "Advanced", master: "Master" },
            footer: 'Practice cases from the <a href="https://alsyedinitiative.com/">Al Syed Initiative</a>. Passive research only: never contact, touch or attack a target.',
        },
        ur: {
            brandLabs: "لیبز",
            navHub: "مفت سی ٹی ایف",
            navPaid: "پیڈ لیبز",
            navLeaderboard: "لیڈر بورڈ",
            navLabs: "زینتھ فٹ پرنٹ",
            navBlackMeridian: "بلیک میریڈین",
            navCertification: "سرٹیفکیشن سی ٹی ایف",
            langToggle: "English",
            signIn: "سائن اِن",
            signedIn: "سائن اِن شدہ",
            checking: "آپ کی رسائی چیک کی جا رہی ہے…",
            tierStaff: "اسٹاف",
            tierMember: "ممبر",
            tierStarter: "اسٹارٹر",
            tierBatch: "بیچ کے طالب علم",
            rankLabel: "رینک",
            unranked: "بغیر رینک",
            xp: "XP",
            free: "مفت",
            paid: "پیڈ",
            open: "کھلا",
            locked: "مقفل",
            complete: "مکمل",
            comingSoon: "جلد آ رہا ہے",
            hubKicker: "مفت سی ٹی ایف",
            hubHeading: 'تفتیش کریں۔ <span class="text-demand">مفت۔</span>',
            hubLede: "ہماری اپنی لیبز کے ابتدائی کیس اور OSINT کمیونٹی کے منتخب مفت سی ٹی ایف۔ بیچ 2 اور بیچ 3 کے طلبہ کے لیے شامل۔",
            freeLabsTitle: "السید کے ابتدائی کیس",
            freeLabsNote: "جوابات ہمارے سرور پر جانچے جاتے ہیں۔ آپ کی پیش رفت اسی براؤزر میں محفوظ رہتی ہے۔",
            dirTitle: "کمیونٹی کے مفت سی ٹی ایف",
            dirNote: "دوسرے پلیٹ فارمز پر منتخب مشقیں۔ یہ نئی ٹیب میں کھلتی ہیں۔",
            dirAll: "سب",
            dirEmpty: "اس فلٹر سے کوئی مشق نہیں ملی۔",
            dirOpen: "{platform} پر کھولیں",
            dirDone: "مکمل",
            dirMarkDone: "مکمل نشان زد کریں",
            dirMinutes: "{n} منٹ",
            dirSignIn: "ٹریک کرنے کے لیے سائن اِن کریں",
            freeUnlockedTitle: "مفت سی ٹی ایف کھل گئے",
            freeUnlockedText: "ہر مفت کیس آپ کے لیے کھلا ہے۔ جوابات ہمارے سرور پر جانچے جاتے ہیں۔",
            freeSignedOutTitle: "کھیلنے کے لیے سائن اِن کریں",
            freeSignedOutText: "مفت سی ٹی ایف بیچ 2 اور بیچ 3 کے طلبہ کے لیے شامل ہیں۔ جواب جمع کرانے کے لیے اپنے السید اکاؤنٹ سے سائن اِن کریں۔",
            freeNoBatchTitle: "مفت سی ٹی ایف آپ کے بیچ کے ساتھ",
            freeNoBatchText: "مفت سی ٹی ایف بیچ 2 اور بیچ 3 کے طلبہ کے لیے شامل ہیں۔ انہیں کھولنے کے لیے کسی بیچ میں داخلہ لیں۔",
            freeExpiredTitle: "آپ کے کورس کی رسائی ختم ہو گئی ہے",
            freeExpiredText: "مفت سی ٹی ایف دوبارہ کھولنے کے لیے کورس کی رسائی کی تجدید کریں۔",
            lmsDownText: "آپ کے السید اکاؤنٹ تک رسائی نہیں ہو سکی۔ کنکشن چیک کر کے دوبارہ کوشش کریں۔",
            retry: "دوبارہ کوشش کریں",
            browseCourses: "کورسز دیکھیں",
            renewAccess: "رسائی کی تجدید",
            seeCourses: "کورسز اور پلان دیکھیں",
            howToUnlock: "کیسے کھولیں",
            statStarter: "ابتدائی کیس",
            statPoints: "پریکٹس پوائنٹس",
            statCommunity: "کمیونٹی سی ٹی ایف مکمل",
            statXp: "XP",
            zenithStarterTitle: "زینتھ فٹ پرنٹ · ابتدائی",
            zenithStarterCopy: "ایک عوامی ہینڈل سے آغاز کریں اور آپریٹر کی شناختیں اور غلطیاں دوبارہ ترتیب دیں۔ کیس 1 تا 6۔",
            communityCardTitle: "کمیونٹی کے مفت سی ٹی ایف",
            communityCardCopy: "Gralhix، Hacktoria، TryHackMe وغیرہ پر جغرافیائی، تصویری اور افراد کی پہیلیاں۔",
            examCardTitle: "او ایس آئی این ٹی امتحان",
            examCardCopy: "وقت کی پابندی کے ساتھ، گریڈ شدہ اور آپ کے LMS اکاؤنٹ میں ریکارڈ۔ داخل شدہ طلبہ کے لیے۔",
            cases: "کیس",
            exercises: "مشقیں",
            examAccess: "کس کے لیے",
            examAccessValue: "بیچ 2 · 3",
            showAll: "تمام {n} دکھائیں",
            showLess: "کم دکھائیں",
            difficulty: "مشکل",
            format: "طریقہ",
            exactAnswer: "درست جواب",
            linkOut: "بیرونی لنک",
            graded: "گریڈ شدہ",
            openLab: "لیب کھولیں",
            previewLab: "لیب کا جائزہ",
            browse: "دیکھیں",
            openExam: "امتحان پر جائیں",
            solvedOf: "{total} میں سے {n} حل",
            paidKicker: "پیڈ لیبز",
            paidHeading: 'لیبز جو <span class="text-demand">عمدگی</span> کا مطالبہ کرتی ہیں۔',
            paidLede: "درست جواب کی جانچ کے ساتھ ماہر سطح کی لائیو تحقیقات۔ CTF Labs ممبرشپ یا تمام لیبز والے کورس پلان سے کھلتی ہیں۔",
            paidUnlockedTitle: "پیڈ لیبز کھل گئیں",
            paidUnlockedText: "آپ کی ممبرشپ ہر پیڈ لیب کھولتی ہے۔",
            paidLockedTitle: "پیڈ لیبز مقفل ہیں",
            paidLockedText: "انہیں CTF Labs ممبرشپ یا تمام لیبز والے کورس پلان سے کھولیں۔ نیچے ہر لیب کے اندر کا جائزہ دیکھ سکتے ہیں۔",
            inside: "اندر کیا ہے",
            zenithAdvTitle: "زینتھ فٹ پرنٹ · ایڈوانسڈ",
            zenithAdvCopy: "زینتھ آپریٹر کے آخری چار مراحل: محفوظ آؤٹ پٹ، بوٹ ریکارڈ، شمال کا سرد پڑاؤ اور حتمی پیلوڈ۔",
            zenithAdvInside: ["خودکار آرٹیفیکٹس اور میل روٹنگ", "محفوظ شدہ بوٹ سلسلے", "سفری ریکارڈ اور محفوظ پیلوڈ"],
            blackCopy: "برانچز، کمٹ ہسٹری، میٹا ڈیٹا، DNS باقیات اور محفوظ پیلوڈ میں ماہرانہ ربط۔",
            blackInside: ["لائیو GitHub کلسٹر میں دس مربوط مراحل", "تاریخی DNS اور محفوظ HTTP شواہد", "میڈیا میٹا ڈیٹا، کلیدی مواد اور والٹ پیلوڈ"],
            certCopy: "درست جواب کی جانچ کے ساتھ دس الگ کیس۔ کوئی اشارہ یا رہنمائی نہیں۔",
            certInside: ["ڈارک ویب، میٹا ڈیٹا اور جغرافیائی کیس", "انکوڈ شدہ آرٹیفیکٹس اور غیر فعال ہوسٹ پیوٹس", "امتحانی انداز: کوئی اشارہ نہیں، درست جواب"],
            labLocked: "یہ لیب مقفل ہے",
            caseLockedPaid: "یہ کیس پیڈ لیب کا حصہ ہے",
            caseLockedPaidText: "اسے CTF Labs ممبرشپ یا تمام لیبز والے کورس پلان سے کھولیں۔",
            caseLockedSignIn: "یہ کیس کھیلنے کے لیے سائن اِن کریں",
            caseLockedSignInText: "مفت کیس بیچ 2 اور بیچ 3 کے طلبہ کے لیے شامل ہیں۔",
            caseLockedBatch: "بیچ 2 اور بیچ 3 کے ساتھ شامل",
            caseLockedBatchText: "مفت کیسز کے جواب جمع کرانے کے لیے کسی بیچ میں داخلہ لیں۔",
            caseLabel: "کیس",
            stepBrief: "خلاصہ",
            stepEvidence: "شواہد",
            stepAnswer: "جواب",
            stepHints: "اشارے",
            startingPoint: "نقطۂ آغاز",
            evidenceIndex: "شواہد کی فہرست",
            artifactCard: "آرٹیفیکٹ",
            artifactNote: "فراہم کردہ اس ثبوت کو تفتیش کے حصے کے طور پر بالکل اسی طرح استعمال کریں۔",
            searchPatterns: "اجازت یافتہ سرچ پیٹرن",
            task: "کام",
            constraints: "پابندیاں",
            answerFormat: "جواب کی شکل",
            example: "مثال",
            noHints: "اس لیب میں جان بوجھ کر کوئی اشارہ نہیں۔ شواہد سے کام کریں۔",
            hintCount: "{n} اشارے دستیاب ہیں۔ ہر اشارہ صرف مانگنے پر ظاہر ہوتا ہے۔",
            revealHint: "اشارہ {n} دکھائیں",
            hintN: "اشارہ {n}",
            prevCase: "پچھلا",
            nextCase: "اگلا کیس",
            potential: "{n} پوائنٹ",
            solvedBadge: "حل شدہ",
            btnSubmit: "جمع کرائیں",
            btnChecking: "جانچ جاری ہے…",
            btnSolved: "حل شدہ ✓",
            inputPlaceholder: "اپنا جواب درج کریں…",
            feedbackSuccess: "[+] درست۔ کیس حل ہو گیا۔",
            feedbackError: "[-] غلط جواب۔ شواہد دوبارہ دیکھیں اور کوشش کریں۔",
            feedbackUnavailable: "[-] توثیق کی سروس دستیاب نہیں ہے۔ دوبارہ کوشش کریں۔",
            feedbackMembers: "[-] یہ کیس ممبرز کے لیے ہے۔",
            feedbackRate: "[-] بہت زیادہ کوششیں۔ ایک منٹ انتظار کریں۔",
            allCategories: "سب",
            categories: "زمرے",
            minutes: "{n} منٹ",
            points: "{n} پوائنٹس",
            leaderboardKicker: "لیڈر بورڈ",
            leaderboardHeading: '<span class="text-demand">بورڈ</span>',
            leaderboardLede: "ماہانہ OSINT سی ٹی ایف ہر حل کرنے والے کو وقت کے لحاظ سے رینک کرتا ہے۔ فائنلسٹ ہال آف فیم میں شامل ہوتے ہیں۔",
            seasonTitle: "اس مہینے",
            seasonNone: "اس وقت کوئی ماہانہ سی ٹی ایف جاری نہیں۔ اگلا کیس مہینے کے آغاز پر کھلے گا۔",
            seasonNoSolvers: "اس مہینے کا کیس ابھی کسی نے حل نہیں کیا۔ پہلے بنیں۔",
            seasonSolvers: "{solvers} حل کرنے والے · {participants} کھلاڑی",
            seasonPhase: { upcoming: "جلد کھلے گا", open: "ابھی کھلا ہے", closed: "بند", results: "نتائج" },
            colRank: "#",
            colHandle: "ہینڈل",
            colTime: "وقت",
            colPenalty: "غلط",
            you: "آپ",
            firstBlood: "فرسٹ بلڈ",
            hofTitle: "ہال آف فیم",
            hofNone: "پہلا ماہانہ سیزن مکمل ہونے پر ہال آف فیم بھرے گا۔",
            recordTitle: "آپ کا لیبز ریکارڈ",
            recordFoot: "پریکٹس کی پیش رفت اسی براؤزر میں محفوظ رہتی ہے۔",
            meTitle: "آپ کی پوزیشن",
            streak: "مہینوں کا تسلسل",
            seasonsSolved: "حل شدہ سیزن",
            xpEarned: "حاصل شدہ XP",
            trophies: "ٹرافیاں",
            boardUnavailable: "لیڈر بورڈ اس وقت دستیاب نہیں۔",
            progressSolved: "حل شدہ",
            progressScore: "اسکور",
            ptsSuffix: " پوائنٹس",
            labStatSolved: "حل شدہ",
            labStatScore: "اسکور",
            labStatPoints: "پوائنٹس",
            labSubheading: "سرگرم تحقیقات",
            labTitle: "زینتھ فٹ پرنٹ",
            labDesc: "@xcfwjoo310 سے آغاز کریں۔ آپریٹر کی شناختیں، انفراسٹرکچر، تاریخی غلطیاں اور محفوظ شواہد خود دریافت کریں؛ تفتیش کا راستہ فراہم نہیں کیا جائے گا۔",
            blackSubheading: "ماہرانہ تحقیقات",
            blackTitle: "بلیک میریڈین",
            blackDesc: "ایک لائیو OSINT لیب: @xcfwjoo310 سے آغاز کریں اور برانچز، کمٹ ہسٹری، میٹا ڈیٹا، DNS باقیات، کرپٹو نوٹس اور محفوظ پیلوڈ تک پہنچیں۔",
            certificationSubheading: "سرٹیفکیشن کی مشق",
            certificationTitle: "سرٹیفکیشن سی ٹی ایف",
            certificationDesc: "دس الگ OSINT کیس۔ کوئی اشارہ، کوئی رہنمائی نہیں، اور درست جواب کی جانچ۔",
            crumbFree: "→ مفت سی ٹی ایف",
            crumbPaid: "→ پیڈ لیبز",
            groupFree: "مفت · ابتدائی",
            groupPaid: "پیڈ · ایڈوانسڈ",
            levels: { easy: "آسان", medium: "درمیانہ", hard: "مشکل", expert: "ماہر", professional: "پروفیشنل", advanced: "ایڈوانسڈ", master: "ماسٹر" },
            footer: 'پریکٹس کیس <a href="https://alsyedinitiative.com/">السید انیشی ایٹو</a> کی جانب سے۔ صرف غیر فعال تحقیق: کسی ہدف سے رابطہ، چھیڑ چھاڑ یا حملہ نہ کریں۔',
        },
    };

    const dict = () => translations[currentLang] || translations.en;
    const t = (key, vars = {}) => {
        const template = dict()[key] ?? translations.en[key] ?? key;
        if (typeof template !== "string") return template;
        return template.replace(/\{(\w+)\}/g, (_match, name) => (name in vars ? String(vars[name]) : ""));
    };
    const loc = (value) => {
        if (!value) return "";
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value;
        return value[currentLang] || value.en || "";
    };
    const levelLabel = (level) => (dict().levels || {})[level] || translations.en.levels[level] || String(level || "");
    const LEVEL_RANK = { easy: 1, medium: 2, hard: 3, advanced: 3, expert: 3, professional: 4, master: 4 };
    const levelDots = (level) => {
        const filled = LEVEL_RANK[level] || 1;
        return `<span class="level-dots" aria-hidden="true">${[1, 2, 3, 4].map((n) => `<i class="${n <= filled ? "on" : ""}"></i>`).join("")}</span>`;
    };

    const ICON = {
        lock: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M5 7V5a3 3 0 1 1 6 0v2h1v7H4V7h1Zm1.5 0h3V5a1.5 1.5 0 1 0-3 0v2Z"/></svg>',
        check: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.4 11.6 2.8 8l1.1-1.1 2.5 2.5 5.7-5.7 1.1 1.1-6.8 6.8Z"/></svg>',
        arrow: '<svg class="ico ico-arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9.3 3.3 13.9 8l-4.6 4.7-1.1-1.1 2.8-2.8H2.5V7.2H11L8.2 4.4l1.1-1.1Z"/></svg>',
        external: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 2h5v5h-1.5V4.6L7.3 9.8 6.2 8.7l5.2-5.2H9V2ZM3 4h4v1.5H4.5v6h6V9H12v4H3V4Z"/></svg>',
        open: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2Zm0 1.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z"/></svg>',
        file: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3.5 1.5H10l3 3v10H3.5v-13Zm1.5 1.5v10h6.5V5.1L9.4 3H5Z"/></svg>',
    };

    // ----------------------------------------------------
    // 4. ACCESS RULES
    // ----------------------------------------------------
    const access = () => state.access;
    const hasKey = (...keys) => keys.some((key) => access().keys.includes(key));
    const serverAllows = (level) => access().server.membershipRequired && access().server.allowedDifficulties.includes(level);
    const paidUnlocked = () => access().staff || access().paidMember || hasKey("all_labs") || serverAllows("expert");
    // Owner rule (16 Nov): CTFs need a CTF grant (billing free_ctfs / easy_ctfs / all_labs, Starter, Member or staff).
    // Course access alone (e.g. Batch 3) does not open any CTF.
    const freeUnlocked = () => paidUnlocked() || access().starter || hasKey("free_ctfs", "easy_ctfs");

    /** "open" | "signin" | "batch" | "paid" for one practice case. */
    const caseAccess = (lab, index) => {
        const level = DIFFICULTY[lab] ? DIFFICULTY[lab][index] : "expert";
        if (FREE_LEVELS.includes(level)) {
            if (freeUnlocked()) return "open";
            return access().signedIn ? "batch" : "signin";
        }
        return paidUnlocked() ? "open" : "paid";
    };
    const tierLabel = () => {
        if (access().staff) return t("tierStaff");
        if (paidUnlocked()) return t("tierMember");
        if (access().batch) return t("tierBatch");
        if (access().starter || hasKey("free_ctfs", "easy_ctfs")) return t("tierStarter");
        return "";
    };

    const siteOrigin = () => {
        if (state.siteUrl) return state.siteUrl;
        try {
            const url = new URL(state.apiBase || DEFAULT_API_BASE);
            url.hostname = url.hostname.replace(/^api\./, "");
            return url.origin;
        } catch {
            return "https://alsyedinitiative.com";
        }
    };
    const signInUrl = () => {
        const here = window.location && window.location.origin ? `${window.location.origin}${window.location.pathname || "/"}${window.location.hash || ""}` : "";
        return `${siteOrigin()}/login?next=${encodeURIComponent(here)}`;
    };

    // ----------------------------------------------------
    // 5. RENDERING HELPERS
    // ----------------------------------------------------
    const byId = (id) => document.getElementById(id);
    const setSafeText = (id, text, isHTML = false) => {
        const node = byId(id);
        if (!node) return;
        if (isHTML) node.innerHTML = text;
        else node.textContent = text;
    };
    const setHtml = (id, html) => {
        const node = byId(id);
        if (node) node.innerHTML = html;
    };
    const paragraphs = (items) => (Array.isArray(items) ? items : [items]).filter(Boolean).map((item) => `<p>${esc(item)}</p>`).join("");
    const button = (label, attrs = "", kind = "") => `<button type="button" class="btn ${kind}" ${attrs}>${label}</button>`;
    const linkButton = (label, href, kind = "", external = false) => `<a class="btn ${kind}" href="${esc(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;

    const questionSet = (lab) => {
        if (lab === "blackmeridian") return blackMeridianQuestions[currentLang] || blackMeridianQuestions.en;
        if (lab === "certification") return certificationQuestions[currentLang]?.length ? certificationQuestions[currentLang] : certificationQuestions.en;
        return questionsData[currentLang] || questionsData.en;
    };
    const caseTitle = (lab, index) => {
        const question = questionSet(lab)[index];
        if (question && question.title) return question.title;
        return (CASE_TITLES[lab] || [])[index] || `${t("caseLabel")} ${index + 1}`;
    };
    const solvedCount = (lab) => solvedQuestions[lab].filter(Boolean).length;
    const progressBar = (done, total) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        return `<div class="meter" role="img" aria-label="${esc(t("solvedOf", { n: done, total }))}"><span style="width:${pct}%"></span></div>`;
    };

    const banner = (kind, title, text, actions = "") => `
        <div class="banner banner-${kind}">
            <span class="banner-icon" aria-hidden="true">${kind === "ok" ? ICON.check : kind === "wait" ? ICON.open : ICON.lock}</span>
            <div class="banner-body"><p class="banner-title">${esc(title)}</p>${text ? `<p class="banner-text">${esc(text)}</p>` : ""}</div>
            ${actions ? `<div class="banner-actions">${actions}</div>` : ""}
        </div>`;

    const lockedActions = (reason) => {
        if (reason === "signin") return linkButton(esc(t("signIn")), signInUrl(), "btn-primary");
        if (reason === "batch") {
            return access().batchReason === "access_expired"
                ? linkButton(esc(t("renewAccess")), `${siteOrigin()}/my-courses`, "btn-primary", true)
                : linkButton(`${esc(t("browseCourses"))} ${ICON.external}`, COURSES_URL, "btn-primary", true);
        }
        const signIn = access().signedIn ? "" : linkButton(esc(t("signIn")), signInUrl(), "btn-ghost");
        return `${linkButton(`${esc(t("seeCourses"))} ${ICON.external}`, COURSES_URL, "btn-primary", true)}${signIn}`;
    };

    // ----------------------------------------------------
    // 6. HEADER (user chip)
    // ----------------------------------------------------
    const renderUser = () => {
        const slot = byId("user-slot");
        if (document.body && document.body.classList) document.body.classList.toggle("is-signed-in", Boolean(access().signedIn));
        if (!slot) return;
        if (!access().loaded) {
            slot.innerHTML = '<span class="user-skeleton" aria-hidden="true"></span>';
            return;
        }
        if (!access().signedIn) {
            slot.innerHTML = `<a class="btn btn-primary btn-sm signin-btn" href="${esc(signInUrl())}">${esc(t("signIn"))}</a>`;
            return;
        }
        const user = state.user || {};
        const handle = user.handle ? `@${user.handle}` : t("signedIn");
        const initial = (user.handle || "A").replace(/^@/, "").charAt(0).toUpperCase();
        const parts = [];
        const rank = state.season && state.season.me && state.season.me.rank;
        if (rank) parts.push(`${esc(t("rankLabel"))} #${esc(rank)}`);
        else if (state.season && state.season.phase === "open") parts.push(esc(t("unranked")));
        const xp = Number(user.xp_earned || 0) + Number(state.directoryXp || 0);
        parts.push(`${esc(xp)} ${esc(t("xp"))}`);
        const tier = tierLabel();
        slot.innerHTML = `
            <div class="user-chip" title="${esc(handle)}">
                <span class="avatar" aria-hidden="true">${esc(initial)}</span>
                <span class="user-text">
                    <span class="user-handle"><bdi>${esc(handle)}</bdi></span>
                    <span class="user-sub">${parts.join('<span class="dot-sep" aria-hidden="true">·</span>')}</span>
                </span>
                ${tier ? `<span class="tier-pill">${esc(tier)}</span>` : ""}
            </div>`;
    };

    // ----------------------------------------------------
    // 7. FREE CTFs
    // ----------------------------------------------------
    const freeBanner = () => {
        if (!access().loaded) return banner("wait", t("checking"), "");
        if (freeUnlocked()) return banner("ok", `${t("freeUnlockedTitle")}${tierLabel() ? ` · ${tierLabel()}` : ""}`, t("freeUnlockedText"));
        if (access().lmsDown) return banner("lock", t("freeSignedOutTitle"), t("lmsDownText"), button(esc(t("retry")), 'data-action="reload-access"', "btn-ghost"));
        if (!access().signedIn) return banner("lock", t("freeSignedOutTitle"), t("freeSignedOutText"), lockedActions("signin"));
        if (access().batchReason === "access_expired") return banner("lock", t("freeExpiredTitle"), t("freeExpiredText"), lockedActions("batch"));
        return banner("lock", t("freeNoBatchTitle"), t("freeNoBatchText"), lockedActions("batch"));
    };

    const stat = (label, value, sub = "") => `<div class="stat"><span class="stat-k">${esc(label)}</span><span class="stat-v">${value}</span>${sub ? `<span class="stat-s">${sub}</span>` : ""}</div>`;

    const labCard = ({ tier, title, copy, facts, inside, done, total, state: cardState, actions, soon }) => {
        const statusText = soon ? t("comingSoon") : cardState === "open" ? (total && done >= total ? t("complete") : t("open")) : t("locked");
        const statusIcon = cardState === "open" && !soon ? (total && done >= total ? ICON.check : ICON.open) : ICON.lock;
        return `
        <article class="lab-card ${cardState === "open" && !soon ? "is-open" : "is-locked"}">
            <div class="lab-card-top">
                <span class="tier-tag tier-${esc(tier)}">${esc(tier === "free" ? t("free") : t("paid"))}</span>
                <span class="lock-state">${statusIcon}${esc(statusText)}</span>
            </div>
            <h3 class="lab-card-title">${esc(title)}</h3>
            <p class="lab-card-copy">${esc(copy)}</p>
            <dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
            ${inside && inside.length ? `<div class="inside"><p class="inside-title">${esc(t("inside"))}</p><ul>${inside.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></div>` : ""}
            ${total ? `<div class="lab-progress">${progressBar(done, total)}<span>${esc(t("solvedOf", { n: done, total }))}</span></div>` : ""}
            <div class="lab-card-actions">${actions}</div>
        </article>`;
    };

    const levelRange = (from, to) => `${levelDots(to)}<span>${esc(from === to ? levelLabel(from) : `${levelLabel(from)}–${levelLabel(to)}`)}</span>`;

    const renderFree = () => {
        setHtml("free-access", freeBanner());
        const starterDone = solvedQuestions.realworld.slice(0, 6).filter(Boolean).length;
        const points = labCategories.reduce((sum, lab) => sum + solvedCount(lab), 0);
        const dirTotal = state.directory ? state.directory.items.length : 0;
        const stats = [
            stat(t("statStarter"), `${starterDone}<small>/6</small>`),
            stat(t("statPoints"), `${points}`),
            stat(t("statCommunity"), `${state.directoryDone.size}<small>/${dirTotal || "–"}</small>`),
        ];
        if (access().signedIn) stats.push(stat(t("statXp"), `${Number((state.user && state.user.xp_earned) || 0) + Number(state.directoryXp || 0)}`));
        setHtml("free-stats", stats.join(""));

        const freeState = freeUnlocked() ? "open" : "locked";
        const cards = [
            labCard({
                tier: "free",
                title: t("zenithStarterTitle"),
                copy: t("zenithStarterCopy"),
                facts: [[t("cases"), "6"], [t("difficulty"), levelRange("easy", "medium")], [t("format"), esc(t("exactAnswer"))]],
                done: starterDone,
                total: 6,
                state: freeState,
                actions: `<a class="btn ${freeState === "open" ? "btn-primary" : "btn-ghost"}" href="#realworld" data-action="goto" data-tab="realworld" data-select="0">${esc(freeState === "open" ? t("openLab") : t("previewLab"))} ${ICON.arrow}</a>${freeState === "open" || !access().loaded ? "" : lockedActions(access().signedIn ? "batch" : "signin")}`,
            }),
            labCard({
                tier: "free",
                title: t("communityCardTitle"),
                copy: t("communityCardCopy"),
                facts: [[t("exercises"), esc(dirTotal || "–")], [t("difficulty"), levelRange("easy", "hard")], [t("format"), esc(t("linkOut"))]],
                done: state.directoryDone.size,
                total: dirTotal,
                state: "open",
                actions: `<a class="btn btn-ghost" href="#free-dir-title" data-action="scroll" data-target="free-dir-title">${esc(t("browse"))} ${ICON.arrow}</a>`,
            }),
            labCard({
                tier: "free",
                title: t("examCardTitle"),
                copy: t("examCardCopy"),
                facts: [[t("format"), esc(t("graded"))], [t("difficulty"), levelRange("medium", "expert")], [t("examAccess"), esc(t("examAccessValue"))]],
                state: "open",
                actions: `<a class="btn btn-ghost" href="#exam" data-action="goto" data-tab="exam">${esc(t("openExam"))} ${ICON.arrow}</a>`,
            }),
        ];
        setHtml("free-labs", cards.join(""));
        renderDirectory();
    };

    const renderDirectory = () => {
        const filters = byId("free-dir-filters");
        const container = byId("free-directory");
        if (!filters || !container) return;
        const directory = state.directory;
        if (!directory) {
            filters.innerHTML = "";
            container.innerHTML = '<div class="skeleton-grid" aria-hidden="true"><span></span><span></span><span></span></div>';
            return;
        }
        const levels = ["all", ...["easy", "medium", "hard", "expert"].filter((level) => directory.items.some((item) => item.difficulty === level))];
        filters.innerHTML = levels.map((level) => {
            const count = level === "all" ? directory.items.length : directory.items.filter((item) => item.difficulty === level).length;
            const active = state.dirFilter === level;
            return `<button type="button" class="filter-chip${active ? " is-active" : ""}" aria-pressed="${active}" data-action="dir-filter" data-value="${esc(level)}">${esc(level === "all" ? t("dirAll") : levelLabel(level))}<span class="count">${count}</span></button>`;
        }).join("");
        const items = directory.items.filter((item) => state.dirFilter === "all" || item.difficulty === state.dirFilter);
        if (!items.length) {
            container.innerHTML = `<p class="empty">${esc(t("dirEmpty"))}</p>`;
            return;
        }
        const paths = (directory.paths || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
        const groups = paths.map((pathInfo) => ({ ...pathInfo, items: items.filter((item) => item.path === pathInfo.key) }))
            .filter((group) => group.items.length);
        const loose = items.filter((item) => !paths.some((pathInfo) => pathInfo.key === item.path));
        if (loose.length) groups.push({ key: "more", title: "More", summary: "", items: loose });
        container.innerHTML = groups.map((group) => `
            <section class="dir-group">
                <div class="dir-group-head"><h3>${esc(group.title)}</h3>${group.summary ? `<p>${esc(group.summary)}</p>` : ""}</div>
                <div class="dir-grid">${group.items.sort((a, b) => (a.path_order || 0) - (b.path_order || 0)).slice(0, state.dirExpanded[group.key] ? undefined : dirPreview()).map(directoryCard).join("")}</div>
                ${group.items.length > dirPreview() ? `<div class="dir-more">${button(esc(state.dirExpanded[group.key] ? t("showLess") : t("showAll", { n: group.items.length })), `data-action="dir-more" data-value="${esc(group.key)}" aria-expanded="${Boolean(state.dirExpanded[group.key])}"`, "btn-ghost btn-sm")}</div>` : ""}
            </section>`).join("");
    };

    // Each path shows its first cards (fewer on phones); "Show all" opens the rest.
    const dirPreview = () => (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 640px)").matches ? 4 : 8);
    const directoryCard = (item) => {
        const done = state.directoryDone.has(item.id);
        let action = "";
        if (state.directoryFromApi && access().signedIn && item.id) {
            action = `<button type="button" class="btn btn-sm ${done ? "btn-done" : "btn-ghost"}" aria-pressed="${done}" data-action="dir-done" data-id="${esc(item.id)}" data-slug="${esc(item.slug)}">${done ? ICON.check : ""}${esc(done ? t("dirDone") : t("dirMarkDone"))}</button>`;
        } else if (state.directoryFromApi && !access().signedIn) {
            action = `<a class="dir-signin" href="${esc(signInUrl())}">${esc(t("dirSignIn"))}</a>`;
        }
        const skills = (item.skills || []).slice(0, 3).map((skill) => `<span class="tag">${esc(skill)}</span>`).join("");
        let href = "";
        try {
            const url = new URL(String(item.url || ""));
            if (url.protocol === "https:") href = url.href;
        } catch { /* not a link */ }
        return `
            <article class="dir-card${done ? " is-done" : ""}">
                <div class="dir-card-top"><span class="platform">${esc(item.platform)}</span><span class="dir-level">${levelDots(item.difficulty)}${esc(levelLabel(item.difficulty))}</span></div>
                <h4 class="dir-title">${esc(item.title)}</h4>
                <p class="dir-summary">${esc(item.summary)}</p>
                <div class="tags">${skills}${item.estimated_minutes ? `<span class="tag tag-time">${esc(t("dirMinutes", { n: item.estimated_minutes }))}</span>` : ""}${item.xp ? `<span class="tag">${esc(item.xp)} XP</span>` : ""}</div>
                <div class="dir-actions">
                    ${href ? `<a class="btn btn-sm btn-primary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(t("dirOpen", { platform: item.platform }))} ${ICON.external}</a>` : ""}
                    ${action}
                </div>
                ${item.attribution ? `<p class="dir-attr">${esc(item.attribution)}</p>` : ""}
            </article>`;
    };

    // ----------------------------------------------------
    // 8. PAID LABS
    // ----------------------------------------------------
    const renderPaid = () => {
        const unlocked = paidUnlocked();
        setHtml("paid-access", !access().loaded
            ? banner("wait", t("checking"), "")
            : unlocked
                ? banner("ok", `${t("paidUnlockedTitle")}${tierLabel() ? ` · ${tierLabel()}` : ""}`, t("paidUnlockedText"))
                : banner("lock", t("paidLockedTitle"), t("paidLockedText"), lockedActions("paid")));
        const state_ = unlocked ? "open" : "locked";
        const actionsFor = (tab, open, select = "") => `<a class="btn ${open ? "btn-primary" : "btn-ghost"}" href="#${tab}" data-action="goto" data-tab="${tab}"${select !== "" ? ` data-select="${select}"` : ""}>${esc(open ? t("openLab") : t("previewLab"))} ${ICON.arrow}</a>${open ? "" : linkButton(`${esc(t("howToUnlock"))} ${ICON.external}`, COURSES_URL, "btn-text", true)}`;
        const advDone = solvedQuestions.realworld.slice(6).filter(Boolean).length;
        const cards = [
            labCard({
                tier: "paid", title: t("zenithAdvTitle"), copy: t("zenithAdvCopy"),
                facts: [[t("cases"), "4"], [t("difficulty"), levelRange("expert", "expert")], [t("format"), esc(t("exactAnswer"))]],
                inside: t("zenithAdvInside"), done: advDone, total: 4, state: state_, actions: actionsFor("realworld", unlocked, 6),
            }),
            labCard({
                tier: "paid", title: t("blackTitle"), copy: t("blackCopy"),
                facts: [[t("cases"), "10"], [t("difficulty"), levelRange("expert", "expert")], [t("format"), esc(t("exactAnswer"))]],
                inside: t("blackInside"), done: solvedCount("blackmeridian"), total: 10, state: state_, actions: actionsFor("blackmeridian", unlocked),
            }),
            labCard({
                tier: "paid", title: t("certificationTitle"), copy: t("certCopy"),
                facts: [[t("cases"), "10"], [t("difficulty"), levelRange("professional", "professional")], [t("format"), esc(t("exactAnswer"))]],
                inside: t("certInside"), done: solvedCount("certification"), total: 10, state: state_, actions: actionsFor("certification", unlocked),
            }),
        ];
        setHtml("paid-labs", cards.join(""));
    };

    // ----------------------------------------------------
    // 9. LAB VIEWS (case list + challenge detail)
    // ----------------------------------------------------
    const statusIcon = (status) => (status === "solved" ? ICON.check : status === "open" ? ICON.open : ICON.lock);

    const renderLabMeta = (lab) => {
        const metas = {
            realworld: [[t("cases"), "10"], [t("difficulty"), levelRange("easy", "expert")], [t("free"), "1–6"], [t("paid"), "7–10"]],
            blackmeridian: [[t("cases"), "10"], [t("difficulty"), levelRange("expert", "expert")], [t("paid"), "1–10"]],
            certification: [[t("cases"), "10"], [t("difficulty"), levelRange("professional", "professional")], [t("paid"), "1–10"]],
        };
        return metas[lab];
    };

    const renderLab = (lab) => {
        const metaNode = byId(`${lab}-meta`);
        if (metaNode) metaNode.innerHTML = renderLabMeta(lab).map(([k, v]) => `<span class="meta-chip"><span class="meta-k">${esc(k)}</span><span class="meta-v">${v}</span></span>`).join("");
        const list = byId(`${lab}-cases`);
        const detail = byId(`${lab}-detail`);
        if (!list || !detail) return;
        const set = questionSet(lab);
        const itemHtml = (index) => {
            const caseState = solvedQuestions[lab][index] ? "solved" : caseAccess(lab, index) === "open" ? "open" : "locked";
            const active = state.selected[lab] === index;
            return `<button type="button" class="case-item is-${caseState}${active ? " is-active" : ""}" data-action="select-case" data-lab="${lab}" data-case="${index}" aria-current="${active ? "true" : "false"}">
                <span class="case-num">${String(index + 1).padStart(2, "0")}</span>
                <span class="case-main"><span class="case-title">${esc(caseTitle(lab, index))}</span><span class="case-sub">${levelDots(DIFFICULTY[lab][index])}${esc(levelLabel(DIFFICULTY[lab][index]))}</span></span>
                <span class="case-state" aria-label="${esc(caseState === "solved" ? t("solvedBadge") : caseState === "open" ? t("open") : t("locked"))}">${statusIcon(caseState)}</span>
            </button>`;
        };
        const indexes = set.map((_q, index) => index);
        if (lab === "realworld") {
            list.innerHTML = `<p class="case-group">${esc(t("groupFree"))}</p>${indexes.slice(0, 6).map(itemHtml).join("")}<p class="case-group">${esc(t("groupPaid"))}</p>${indexes.slice(6).map(itemHtml).join("")}`;
        } else {
            list.innerHTML = indexes.map(itemHtml).join("");
        }
        detail.innerHTML = renderCaseDetail(lab, state.selected[lab]);
        restoreDraft(lab, state.selected[lab]);
    };

    const lockPanel = (reason, title, text) => `
        <div class="lock-panel">
            <span class="lock-badge" aria-hidden="true">${ICON.lock}</span>
            <h4>${esc(title)}</h4>
            <p>${esc(text)}</p>
            <div class="lock-actions">${lockedActions(reason)}</div>
        </div>`;

    const caseHeader = (lab, index, title, level, points, solved, extra = "") => `
        <header class="case-head">
            <p class="case-kicker"><span>${esc(t("caseLabel"))} ${String(index + 1).padStart(2, "0")}</span><span class="dot-sep" aria-hidden="true">·</span>${levelDots(level)}<span>${esc(levelLabel(level))}</span><span class="dot-sep" aria-hidden="true">·</span><span>${esc(points)}</span>${extra}</p>
            <h3 class="case-title-lg">${esc(title)}</h3>
            ${solved ? `<span class="solved-pill">${ICON.check}${esc(t("solvedBadge"))}</span>` : ""}
        </header>`;

    const step = (n, label, body, { open = true, collapsible = false, id = "" } = {}) => (collapsible
        ? `<details class="step"${open ? " open" : ""}${id ? ` id="${id}"` : ""}><summary><span class="step-n">${n}</span><span class="step-label">${esc(label)}</span></summary><div class="step-body">${body}</div></details>`
        : `<section class="step"${id ? ` id="${id}"` : ""}><h4 class="step-head"><span class="step-n">${n}</span><span class="step-label">${esc(label)}</span></h4><div class="step-body">${body}</div></section>`);

    const answerBlock = (lab, key, solved, placeholder) => {
        const feedback = state.feedback[`${lab}:${key}`];
        const ids = `${lab}-${key}`;
        return `
            <div class="answer-row">
                <input type="text" class="answer-input" id="input-${ids}" data-lab="${lab}" data-case="${esc(key)}"
                       aria-label="${esc(t("stepAnswer"))}" maxlength="512" autocomplete="off" spellcheck="false"
                       placeholder="${esc(placeholder || t("inputPlaceholder"))}" ${solved ? "disabled" : ""}>
                <button type="button" class="btn ${solved ? "btn-success" : "btn-primary"}" id="btn-${ids}" data-action="submit" data-lab="${lab}" data-case="${esc(key)}" ${solved ? "disabled" : ""}>${esc(solved ? t("btnSolved") : t("btnSubmit"))}</button>
            </div>
            <div class="feedback-text ${feedback ? esc(feedback.kind) : ""}" id="feedback-${ids}" aria-live="polite">${feedback ? esc(feedback.text) : ""}</div>`;
    };

    const caseNav = (lab, index, total) => `
        <footer class="case-nav">
            ${index > 0 ? button(`<span class="flip">${ICON.arrow}</span> ${esc(t("prevCase"))}`, `data-action="select-case" data-lab="${lab}" data-case="${index - 1}" data-scroll="1"`, "btn-ghost") : "<span></span>"}
            ${index < total - 1 ? button(`${esc(t("nextCase"))} ${ICON.arrow}`, `data-action="select-case" data-lab="${lab}" data-case="${index + 1}" data-scroll="1"`, "btn-ghost") : ""}
        </footer>`;

    const renderCaseDetail = (lab, index) => {
        const set = questionSet(lab);
        const question = set[index] || set[0];
        const level = DIFFICULTY[lab][index];
        const solved = solvedQuestions[lab][index];
        const title = caseTitle(lab, index);
        const head = caseHeader(lab, index, title, level, t("potential", { n: 1 }), solved);
        const caseState = solved ? "open" : caseAccess(lab, index);
        if (caseState === "paid") {
            return `${head}${lockPanel("paid", t("caseLockedPaid"), t("caseLockedPaidText"))}`;
        }
        // Brief
        let brief = "";
        if (question.briefing) brief += paragraphs(question.briefing);
        else if (question.q) brief += `<p>${esc(question.q)}</p>`;
        if (question.task) brief += `<div class="kv"><span class="kv-k">${esc(t("task"))}</span>${paragraphs(question.task)}</div>`;
        if (question.constraints) brief += `<div class="kv"><span class="kv-k">${esc(t("constraints"))}</span>${paragraphs(question.constraints)}</div>`;
        // Evidence
        const info = LAB_INFO[lab] || {};
        let evidence = "";
        if (info.starting) evidence += `<div class="evidence-item"><span class="kv-k">${esc(t("startingPoint"))}</span><code class="code-block">${esc(info.starting)}</code></div>`;
        if (info.index) evidence += `<div class="evidence-item"><span class="kv-k">${esc(t("evidenceIndex"))}</span><a class="file-link" href="${esc(info.index)}" target="_blank" rel="noopener">${ICON.file}<span>${esc(info.index.split("/").pop())}</span></a></div>`;
        if (question.artifact) evidence += `<div class="evidence-item question-artifact"><span class="kv-k">${esc(t("artifactCard"))}</span><p class="muted">${esc(t("artifactNote"))}</p><code class="code-block">${esc(question.artifact)}</code></div>`;
        if (question.searchPatterns) evidence += `<div class="evidence-item"><span class="kv-k">${esc(t("searchPatterns"))}</span><ul class="code-list">${question.searchPatterns.map((pattern) => `<li><code>${esc(pattern)}</code></li>`).join("")}</ul></div>`;
        if (question.image) evidence += `<figure class="evidence-figure"><img src="${esc(question.image)}" alt="${esc(question.imageAlt || "Case evidence")}" loading="lazy"><figcaption>${esc(question.imageAlt || "")}</figcaption></figure>`;
        if (!question.artifact && !question.searchPatterns && !question.image && info.evidenceNote) evidence += `<p class="muted">${esc(info.evidenceNote)}</p>`;
        // Answer
        let answer = "";
        if (question.answerFormat) answer += `<div class="kv"><span class="kv-k">${esc(t("answerFormat"))}</span>${paragraphs(question.answerFormat)}</div>`;
        answer += caseState === "open"
            ? answerBlock(lab, index, solved)
            : lockPanel(caseState, caseState === "signin" ? t("caseLockedSignIn") : t("caseLockedBatch"), caseState === "signin" ? t("caseLockedSignInText") : t("caseLockedBatchText"));
        const hints = `<p class="muted">${esc(t("noHints"))}</p>`;
        return `${head}
            <div class="steps">
                ${step(1, t("stepBrief"), brief)}
                ${step(2, t("stepEvidence"), evidence, { collapsible: true, open: true })}
                ${step(3, t("stepAnswer"), answer)}
                ${step(4, t("stepHints"), hints, { collapsible: true, open: false })}
            </div>
            ${caseNav(lab, index, set.length)}`;
    };

    const restoreDraft = (lab, key) => {
        const draft = state.drafts[`${lab}:${key}`];
        if (!draft) return;
        const input = document.querySelector(`.answer-input[data-lab="${lab}"][data-case="${key}"]`);
        if (input && !input.disabled) input.value = draft;
    };

    // ----------------------------------------------------
    // 10. LEADERBOARD
    // ----------------------------------------------------
    const duration = (seconds) => {
        const value = Number(seconds);
        if (!Number.isFinite(value) || value < 0) return "—";
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        const secs = Math.floor(value % 60);
        const pad = (n) => String(n).padStart(2, "0");
        return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
    };

    const renderLeaderboard = () => {
        const season = state.season;
        const note = byId("season-note");
        if (note) note.textContent = season ? `${loc(season.title)} · ${(t("seasonPhase") || {})[season.phase] || ""}` : "";
        const board = state.seasonBoard;
        let seasonHtml;
        if (state.season === undefined) seasonHtml = `<p class="empty">${esc(t("boardUnavailable"))}</p>`;
        else if (!season) seasonHtml = `<p class="empty">${esc(t("seasonNone"))}</p>`;
        else if (!board || !board.rows || !board.rows.length) seasonHtml = `<p class="empty">${esc(t("seasonNoSolvers"))}</p>`;
        else {
            const rows = [...board.rows, ...(board.me ? [{ ...board.me, is_me: true, separated: true }] : [])];
            seasonHtml = `
                <p class="panel-sub">${esc(t("seasonSolvers", { solvers: board.solvers ?? rows.length, participants: board.participants ?? "–" }))}</p>
                <div class="table-wrap"><table class="board-table">
                    <thead><tr><th scope="col">${esc(t("colRank"))}</th><th scope="col">${esc(t("colHandle"))}</th><th scope="col" class="num">${esc(t("colTime"))}</th><th scope="col" class="num">${esc(t("colPenalty"))}</th></tr></thead>
                    <tbody>${rows.map((row) => `<tr class="${row.is_me ? "is-me" : ""}${row.separated ? " is-sep" : ""}${row.rank <= 3 ? " is-podium" : ""}">
                        <td><span class="rank-badge">${esc(row.rank)}</span></td>
                        <td class="handle-cell">${esc(row.name)}${row.is_me ? ` <span class="you-pill">${esc(t("you"))}</span>` : ""}${row.first_blood ? ` <span class="tag">${esc(t("firstBlood"))}</span>` : ""}</td>
                        <td class="num mono">${esc(duration(row.score_seconds ?? row.solve_seconds))}</td>
                        <td class="num mono">${esc(row.wrong_attempts ?? 0)}</td></tr>`).join("")}</tbody>
                </table></div>`;
        }
        setHtml("season-board", seasonHtml);

        const hof = state.hallOfFame;
        setHtml("hof-board", !hof || !hof.length
            ? `<p class="empty">${esc(hof === undefined ? t("boardUnavailable") : t("hofNone"))}</p>`
            : hof.map((item) => `<div class="hof-season"><p class="hof-title">${esc(item.title)}<span>${esc(item.month || "")}</span></p>
                <ol class="hof-list">${(item.finalists || item.rows || []).slice(0, 10).map((row) => `<li><span class="rank-badge">${esc(row.rank)}</span><span>${esc(row.name)}</span><span class="mono">${esc(duration(row.score_seconds ?? row.solve_seconds))}</span></li>`).join("")}</ol></div>`).join(""));

        const record = byId("record-list");
        if (record) {
            const labs = [
                ["realworld", t("navLabs"), 10],
                ["blackmeridian", t("navBlackMeridian"), 10],
                ["certification", t("navCertification"), 10],
            ];
            record.innerHTML = labs.map(([lab, name, total]) => {
                const done = solvedCount(lab);
                return `<li><a href="#${lab}" data-action="goto" data-tab="${lab}"><span class="record-name">${esc(name)}</span><span class="record-count mono">${done}/${total}</span></a>${progressBar(done, total)}</li>`;
            }).join("");
        }
        const mePanel = byId("me-panel");
        if (mePanel) {
            const user = state.user;
            mePanel.hidden = !(access().signedIn && user);
            if (user) {
                setHtml("me-board", `<div class="me-head"><span class="avatar avatar-lg" aria-hidden="true">${esc((user.handle || "A").charAt(0).toUpperCase())}</span><div><p class="me-handle"><bdi>${esc(user.handle ? `@${user.handle}` : t("signedIn"))}</bdi></p>${tierLabel() ? `<p class="muted">${esc(tierLabel())}</p>` : ""}</div></div>
                    <dl class="me-stats">
                        <div><dt>${esc(t("rankLabel"))}</dt><dd>${esc(state.season && state.season.me && state.season.me.rank ? `#${state.season.me.rank}` : "—")}</dd></div>
                        <div><dt>${esc(t("xpEarned"))}</dt><dd>${esc(Number(user.xp_earned || 0) + Number(state.directoryXp || 0))}</dd></div>
                        <div><dt>${esc(t("streak"))}</dt><dd>${esc(user.streak_months || 0)}</dd></div>
                        <div><dt>${esc(t("seasonsSolved"))}</dt><dd>${esc(user.seasons_solved || 0)}</dd></div>
                    </dl>`);
            }
        }
    };

    // ----------------------------------------------------
    // 12. PROGRESS
    // ----------------------------------------------------
    const updateProgressIndicators = () => {
        let totalSolved = 0;
        let totalScore = 0;
        labCategories.forEach((category) => {
            const count = solvedQuestions[category].filter(Boolean).length;
            totalSolved += count;
            totalScore += count;
            setSafeText(`solved-${category}`, `${count}/10`);
            setSafeText(`score-${category}`, (count * 1.0).toFixed(1));
            setSafeText(`badge-${category}`, `${count}/${solvedQuestions[category].length}`);
        });
        const totalQuestions = labCategories.reduce((sum, category) => sum + solvedQuestions[category].length, 0);
        setSafeText("overall-solved", String(totalSolved));
        setSafeText("overall-score", totalScore.toFixed(1));
        setSafeText("overall-total", String(totalQuestions));
        const progressBarEl = byId("overall-progress-bar");
        if (progressBarEl) progressBarEl.style.width = `${totalQuestions ? (totalSolved / totalQuestions) * 100 : 0}%`;
    };

    // Lab switcher chips (by id: the [data-access-chip] list is also used by the config check below).
    const renderChips = () => {
        const set = (id, text, locked) => {
            const chip = byId(id);
            if (!chip) return;
            chip.textContent = text;
            if (chip.classList) chip.classList.toggle("nav-chip-locked", Boolean(locked));
        };
        const paid = paidUnlocked();
        set("chip-realworld", freeUnlocked() ? t("free") : t("locked"), !freeUnlocked());
        set("chip-blackmeridian", paid ? t("open") : t("paid"), !paid);
        set("chip-certification", paid ? t("open") : t("paid"), !paid);
        set("chip-paid", paid ? t("open") : t("locked"), !paid);
    };

    // ----------------------------------------------------
    // 13. LANGUAGE
    // ----------------------------------------------------
    const renderStatic = () => {
        setSafeText("brand-labs-text", t("brandLabs"));
        setSafeText("nav-hub-text", t("navHub"));
        setSafeText("nav-paid-text", t("navPaid"));
        setSafeText("nav-leaderboard-text", t("navLeaderboard"));
        setSafeText("nav-labs-text", t("navLabs"));
        setSafeText("nav-blackmeridian-text", t("navBlackMeridian"));
        setSafeText("nav-certification-text", t("navCertification"));
        setSafeText("lang-toggle", t("langToggle"));
        setSafeText("hub-subheading-text", t("hubKicker"));
        setSafeText("hub-heading-text", t("hubHeading"), true);
        setSafeText("hub-lede", t("hubLede"));
        setSafeText("free-labs-title", t("freeLabsTitle"));
        setSafeText("free-labs-note", t("freeLabsNote"));
        setSafeText("free-dir-title", t("dirTitle"));
        setSafeText("free-dir-note", t("dirNote"));
        setSafeText("paid-subheading-text", t("paidKicker"));
        setSafeText("paid-heading-text", t("paidHeading"), true);
        setSafeText("paid-lede", t("paidLede"));
        setSafeText("lab-subheading-text", t("labSubheading"));
        setSafeText("lab-title-text", t("labTitle"));
        setSafeText("lab-desc-text", t("labDesc"));
        setSafeText("black-subheading-text", t("blackSubheading"));
        setSafeText("black-title-text", t("blackTitle"));
        setSafeText("black-desc-text", t("blackDesc"));
        setSafeText("certification-subheading-text", t("certificationSubheading"));
        setSafeText("certification-title-text", t("certificationTitle"));
        setSafeText("certification-desc-text", t("certificationDesc"));
        ["lab", "black", "certification"].forEach((prefix) => {
            setSafeText(`${prefix}-stat-solved-label`, t("labStatSolved"));
            setSafeText(`${prefix}-stat-score-label`, t("labStatScore"));
        });
        setSafeText("realworld-crumb", t("crumbFree"));
        ["blackmeridian", "certification"].forEach((lab) => setSafeText(`${lab}-crumb`, t("crumbPaid")));
        setSafeText("leaderboard-subheading-text", t("leaderboardKicker"));
        setSafeText("leaderboard-heading-text", t("leaderboardHeading"), true);
        setSafeText("leaderboard-lede", t("leaderboardLede"));
        setSafeText("season-title", t("seasonTitle"));
        setSafeText("hof-title", t("hofTitle"));
        setSafeText("progress-header-text", t("recordTitle"));
        setSafeText("record-foot", t("recordFoot"));
        setSafeText("me-title", t("meTitle"));
        setSafeText("progress-solved-label", t("progressSolved"));
        setSafeText("progress-score-label", t("progressScore"));
        setSafeText("progress-pts-label", t("ptsSuffix"));
        const foot = document.querySelector(".site-foot p");
        if (foot) foot.innerHTML = t("footer");
    };

    const renderAll = () => {
        renderUser();
        renderFree();
        renderPaid();
        labCategories.forEach(renderLab);
        renderLeaderboard();
        renderChips();
        updateProgressIndicators();
    };

    const switchLanguage = (lang) => {
        currentLang = lang === "ur" ? "ur" : "en";
        store.set("zenith_ctf_lang", currentLang);
        if (currentLang === "ur") document.body.classList.add("ur-mode");
        else document.body.classList.remove("ur-mode");
        if (document.documentElement) {
            document.documentElement.setAttribute("lang", currentLang);
            document.documentElement.setAttribute("dir", currentLang === "ur" ? "rtl" : "ltr");
        }
        renderStatic();
        renderAll();
        // Let the Examination tab (exam.js) follow the language toggle.
        window.dispatchEvent(new CustomEvent("labs:langchange", { detail: { lang: currentLang } }));
    };

    const langToggleBtn = byId("lang-toggle");
    if (langToggleBtn) langToggleBtn.addEventListener("click", () => switchLanguage(currentLang === "en" ? "ur" : "en"));

    switchLanguage(currentLang);

    // ----------------------------------------------------
    // 14. NAVIGATION (tabs, deep links)
    // ----------------------------------------------------
    const navButtons = document.querySelectorAll(".nav-btn");
    const tabContents = document.querySelectorAll(".tab-content");
    // Extension point for a new lab: a rail button and a tab section in
    // index.html, its cases here (question set, DIFFICULTY, CASE_TITLES), its
    // answer hashes in server.js and its tier in labs-access.js.
    const LAB_TABS = ["realworld", "blackmeridian", "certification"];
    const PARENT = { realworld: "hub", blackmeridian: "paid", certification: "paid" };

    const markSegments = (tabId) => {
        const parent = PARENT[tabId] || tabId;
        document.querySelectorAll(".seg").forEach((segment) => {
            segment.classList.toggle("seg-parent", segment.getAttribute("data-tab") === parent && parent !== tabId);
        });
        if (document.body && document.body.setAttribute) document.body.setAttribute("data-group", LAB_TABS.includes(tabId) ? "lab" : "section");
    };

    navButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            navButtons.forEach((other) => {
                other.classList.remove("active");
                other.removeAttribute("aria-current");
            });
            tabContents.forEach((content) => content.classList.remove("active"));
            btn.classList.add("active");
            btn.setAttribute("aria-current", "page");
            if (typeof btn.scrollIntoView === "function") btn.scrollIntoView({ block: "nearest", inline: "nearest" });
            const tabId = btn.getAttribute("data-tab");
            const section = byId(`tab-${tabId}`);
            if (section) section.classList.add("active");
            state.tab = tabId;
            markSegments(tabId);
            // Deep links: the address follows the tab without adding history
            // entries. exam.js owns #exam for the Examination tab.
            if (tabId !== "exam" && window.location.hash !== `#${tabId}`) {
                window.history.replaceState(null, "", `#${tabId}`);
            }
            if (tabId === "leaderboard") loadLeaderboard();
        });
    });

    const navButtonFor = (tabId) => Array.from(navButtons).find((button_) => button_.getAttribute("data-tab") === tabId);
    const tabFromHash = () => {
        let tabId = "";
        try {
            tabId = decodeURIComponent(window.location.hash.replace(/^#/, ""));
        } catch {
            return "";
        }
        return navButtonFor(tabId) ? tabId : "";
    };
    const openTab = (tabId) => {
        const target = navButtonFor(tabId);
        if (target && !target.classList.contains("active")) target.click();
    };
    const scrollTop = () => {
        if (typeof window.scrollTo === "function") window.scrollTo({ top: 0, behavior: "auto" });
    };

    // #exam on first load is opened by exam.js once it has initialised.
    const initialTab = tabFromHash();
    if (initialTab && initialTab !== "exam") openTab(initialTab);
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
            const active = document.querySelector(".nav-btn.active");
            if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest", inline: "nearest" });
        }).catch(() => {});
    }

    window.addEventListener("hashchange", () => {
        const tabId = tabFromHash();
        if (tabId) openTab(tabId);
    });

    // Static in-page links (brand, crumbs).
    document.querySelectorAll("[data-goto]").forEach((link) => {
        link.addEventListener("click", (event) => {
            const tabId = link.getAttribute("data-goto");
            if (!navButtonFor(tabId)) return;
            event.preventDefault();
            openTab(tabId);
            if (tabId === "hub" && window.location.hash !== "#hub") window.history.replaceState(null, "", "#hub");
            scrollTop();
        });
    });

    // ----------------------------------------------------
    // 15. ACTIONS (delegated)
    // ----------------------------------------------------
    const selectCase = (lab, key, scroll) => {
        state.selected[lab] = Number(key);
        renderLab(lab);
        const detail = byId(`${lab}-detail`);
        const narrow = typeof window.matchMedia === "function" && window.matchMedia("(max-width: 960px)").matches;
        if (detail && (scroll || narrow) && typeof detail.scrollIntoView === "function") detail.scrollIntoView({ block: "start", behavior: "smooth" });
    };

    const submitAnswer = async (lab, key) => {
        const input = document.querySelector(`.answer-input[data-lab="${lab}"][data-case="${key}"]`);
        const btn = document.querySelector(`[data-action="submit"][data-lab="${lab}"][data-case="${key}"]`);
        if (!input || !btn) return;
        const value = input.value.trim();
        if (!value || btn.disabled) return;
        btn.disabled = true;
        btn.textContent = t("btnChecking");
        const feedbackKey = `${lab}:${key}`;
        let result = null;
        let kind = "error";
        let text = t("feedbackUnavailable");
        try {
            const response = await fetch("/api/validate", {
                method: "POST",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                credentials: "same-origin",
                body: JSON.stringify({ category: lab, question: Number(key), answer: value }),
            });
            result = await response.json().catch(() => ({}));
            if (response.status === 403) text = t("feedbackMembers");
            else if (response.status === 429) text = t("feedbackRate");
            else if (response.ok && result.correct) {
                kind = "success";
                text = t("feedbackSuccess");
                solvedQuestions[lab][Number(key)] = true;
                delete state.drafts[feedbackKey];
                saveState();
            } else if (response.ok) text = t("feedbackError");
        } catch {
            text = t("feedbackUnavailable");
        }
        state.feedback[feedbackKey] = { kind, text };
        renderLab(lab);
        if (kind === "success") {
            renderFree();
            renderPaid();
            renderLeaderboard();
            renderChips();
        } else {
            const fresh = document.querySelector(`.answer-input[data-lab="${lab}"][data-case="${key}"]`);
            if (fresh) {
                fresh.value = value;
                if (typeof fresh.focus === "function") fresh.focus();
            }
        }
    };

    const toggleDirectoryDone = async (id, slug) => {
        const done = state.directoryDone.has(id);
        try {
            const response = await lms(`/ctf/labs/directory/${encodeURIComponent(slug)}/progress/`, { method: "POST", body: { done: !done } });
            if (!response.ok) return;
            if (response.data && Array.isArray(response.data.done)) state.directoryDone = new Set(response.data.done);
            else if (done) state.directoryDone.delete(id);
            else state.directoryDone.add(id);
            if (response.data && typeof response.data.xp === "number") state.directoryXp = response.data.xp;
        } catch {
            return;
        }
        renderFree();
        renderUser();
    };

    const main = byId("main");
    if (main) {
        main.addEventListener("click", (event) => {
            const target = event.target && typeof event.target.closest === "function" ? event.target.closest("[data-action]") : null;
            if (!target) return;
            const action = target.getAttribute("data-action");
            const lab = target.getAttribute("data-lab");
            const key = target.getAttribute("data-case");
            if (action === "goto") {
                event.preventDefault();
                const tabId = target.getAttribute("data-tab");
                const select = target.getAttribute("data-select");
                if (select !== null && select !== "" && Object.hasOwn(state.selected, tabId)) {
                    state.selected[tabId] = Number(select);
                    renderLab(tabId);
                }
                openTab(tabId);
                scrollTop();
            } else if (action === "scroll") {
                event.preventDefault();
                const node = byId(target.getAttribute("data-target"));
                if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "start", behavior: "smooth" });
            } else if (action === "select-case") {
                selectCase(lab, key, target.getAttribute("data-scroll") === "1");
            } else if (action === "submit") {
                submitAnswer(lab, key);
            } else if (action === "dir-filter") {
                state.dirFilter = target.getAttribute("data-value") || "all";
                renderDirectory();
            } else if (action === "dir-more") {
                const groupKey = target.getAttribute("data-value");
                state.dirExpanded[groupKey] = !state.dirExpanded[groupKey];
                renderDirectory();
            } else if (action === "dir-done") {
                toggleDirectoryDone(Number(target.getAttribute("data-id")), target.getAttribute("data-slug"));
            } else if (action === "reload-access") {
                loadAccess();
            }
        });
        main.addEventListener("keydown", (event) => {
            const target = event.target;
            if (event.key !== "Enter" || !target || !target.classList || !target.classList.contains("answer-input")) return;
            if (!target.closest || !target.closest("#tab-exam")) {
                event.preventDefault();
                submitAnswer(target.getAttribute("data-lab"), target.getAttribute("data-case"));
            }
        });
        main.addEventListener("input", (event) => {
            const target = event.target;
            if (target && target.classList && target.classList.contains("answer-input") && target.getAttribute("data-lab")) {
                state.drafts[`${target.getAttribute("data-lab")}:${target.getAttribute("data-case")}`] = target.value;
            }
        });
    }

    // ----------------------------------------------------
    // 16. DATA: server access, the LMS account, directory
    // ----------------------------------------------------
    let csrf = "";
    const csrfToken = async () => {
        if (csrf) return csrf;
        const response = await fetch(`${state.apiBase}/auth/csrf/`, { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
        const payload = await response.json().catch(() => ({}));
        csrf = String((payload && payload.csrf_token) || "");
        return csrf;
    };
    const refreshSession = async () => {
        try {
            const response = await fetch(`${state.apiBase}/auth/refresh/`, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: { Accept: "application/json", "Content-Type": "application/json", "X-CSRFToken": await csrfToken() },
                body: "{}",
            });
            return Boolean(response && response.ok);
        } catch {
            return false;
        }
    };
    /** One LMS call with the student's own session; {ok, status, data}. Never throws. */
    const lms = async (path, { method = "GET", body, retry = false } = {}) => {
        try {
            const headers = { Accept: "application/json" };
            if (method !== "GET") {
                headers["Content-Type"] = "application/json";
                headers["X-CSRFToken"] = await csrfToken();
            }
            const response = await fetch(`${state.apiBase}${path}`, {
                method,
                credentials: "include",
                cache: "no-store",
                headers,
                body: method !== "GET" ? JSON.stringify(body || {}) : undefined,
            });
            if (response.status === 401 && retry && await refreshSession()) return lms(path, { method, body });
            const payload = await response.json().catch(() => ({}));
            const data = payload && typeof payload === "object" && payload.data && typeof payload.data === "object" ? payload.data : null;
            return { ok: Boolean(response.ok), status: Number(response.status) || 0, data };
        } catch {
            return { ok: false, status: 0, data: null };
        }
    };
    const labsJson = async (path, init = {}) => {
        try {
            const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
            if (!response.ok) return null;
            const body = await response.json();
            return body && typeof body === "object" ? body : null;
        } catch {
            return null;
        }
    };

    const readServerAccess = async () => {
        const body = await labsJson("/api/access");
        if (!body) return;
        access().server = {
            membershipRequired: body.membershipRequired === true,
            allowedDifficulties: Array.isArray(body.allowedDifficulties) ? body.allowedDifficulties : [],
            pass: body.pass === true,
            passExpiresAt: Number(body.passExpiresAt) || 0,
        };
    };

    // A labs pass lets this server enforce the members-only switch (labs-access.js).
    const ensurePass = async () => {
        const server = access().server;
        const soon = Math.floor(Date.now() / 1000) + 300;
        if (server.pass && server.passExpiresAt > soon) return;
        const issued = await lms("/ctf/labs/pass/", { method: "POST", body: {} });
        if (!issued.ok || !issued.data || !issued.data.token) return;
        const stored = await labsJson("/api/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: String(issued.data.token) }),
        });
        if (stored) await readServerAccess();
    };

    const loadDirectory = async () => {
        const response = await lms("/ctf/labs/directory/");
        const data = response.data;
        if (response.ok && data && Array.isArray(data.items) && data.items.length) {
            state.directory = { items: data.items, paths: Array.isArray(data.paths) ? data.paths : [] };
            state.directoryFromApi = true;
            if (data.me && Array.isArray(data.me.done)) state.directoryDone = new Set(data.me.done);
            if (data.me && typeof data.me.xp === "number") state.directoryXp = data.me.xp;
            return;
        }
        const fallback = await labsJson("/free-directory.json");
        state.directory = fallback && Array.isArray(fallback.items)
            ? { items: fallback.items, paths: Array.isArray(fallback.paths) ? fallback.paths : [] }
            : { items: [], paths: [] };
        state.directoryFromApi = false;
    };

    let leaderboardLoaded = false;
    const loadLeaderboard = async (force = false) => {
        if ((leaderboardLoaded && !force) || !state.apiBase) return;
        leaderboardLoaded = true;
        const [current, hof] = await Promise.all([lms("/ctf/seasons/current/"), lms("/ctf/seasons/hall-of-fame/")]);
        state.season = current.ok && current.data ? (current.data.season || null) : undefined;
        state.hallOfFame = hof.ok && hof.data ? (hof.data.seasons || []) : undefined;
        if (state.season && state.season.slug) {
            const board = await lms(`/ctf/seasons/${encodeURIComponent(state.season.slug)}/leaderboard/?limit=25`);
            state.seasonBoard = board.ok ? board.data : null;
        }
        renderLeaderboard();
        renderUser();
    };

    const loadAccess = async () => {
        const entitlement = await lms("/ctf/labs/entitlement/", { retry: true });
        const a = access();
        a.lmsDown = entitlement.status === 0;
        a.signedIn = Boolean(entitlement.ok && entitlement.data);
        if (a.signedIn) {
            const data = entitlement.data;
            a.staff = data.staff === true;
            a.paidMember = a.staff || Boolean(data.ctf_labs && data.ctf_labs.active);
            a.starter = Boolean(data.ctf_starter && data.ctf_starter.active);
            a.keys = (Array.isArray(data.entitlements) ? data.entitlements : []).map((item) => String((item && item.key) || ""));
            const [eligibility, me] = await Promise.all([lms("/ctf/eligibility/"), lms("/ctf/seasons/me/"), ensurePass()]);
            if (eligibility.ok && eligibility.data) {
                a.batchReason = String(eligibility.data.reason || "");
                // Active course access (Batch 2 / Batch 3): "ok" or "not_assigned".
                a.batch = a.batchReason === "ok" || a.batchReason === "not_assigned" || eligibility.data.enabled === true;
                const keys = (Array.isArray(eligibility.data.entitlements) ? eligibility.data.entitlements : []).map((item) => String((item && item.key) || ""));
                a.keys = [...new Set([...a.keys, ...keys])];
            }
            state.user = me.ok && me.data ? me.data : { handle: "" };
        } else {
            Object.assign(a, { staff: false, paidMember: false, starter: false, batch: false, batchReason: "", keys: [] });
            state.user = null;
            // Signed out of the LMS: drop a labs pass left from an earlier session.
            if (entitlement.status === 401 && a.server.pass) {
                await labsJson("/api/session/clear", { method: "POST" });
                await readServerAccess();
            }
        }
        a.loaded = true;
        renderAll();
    };

    // Access chips: "Members" when the server reports a members-only policy
    // (display only; access is enforced by the server). Then the LMS data.
    const configPromise = fetch("/api/config", { credentials: "same-origin" })
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null);
    configPromise.then((config) => {
        if (!config || config.membershipRequired !== true) return;
        document.querySelectorAll("[data-access-chip]").forEach((chip) => {
            chip.textContent = "Members";
            chip.classList.add("nav-chip-members");
        });
    });
    configPromise.then(async (config) => {
        const base = String((config && config.lmsApiBase) || "");
        state.apiBase = /^https?:\/\//.test(base) ? base.replace(/\/+$/, "") : DEFAULT_API_BASE;
        const site = String((config && config.siteUrl) || "");
        state.siteUrl = /^https?:\/\//.test(site) ? site.replace(/\/+$/, "") : "";
        await readServerAccess();
        await Promise.all([loadAccess(), loadDirectory().then(renderFree), loadLeaderboard()]);
        renderAll();
    }).catch(() => {});

    // Back from the LMS sign-in in another tab: re-check access.
    let lastCheck = Date.now();
    const recheck = () => {
        if (document.visibilityState && document.visibilityState !== "visible") return;
        if (access().signedIn || Date.now() - lastCheck < 5000 || !state.apiBase) return;
        lastCheck = Date.now();
        loadAccess();
    };
    if (typeof document.addEventListener === "function") document.addEventListener("visibilitychange", recheck);
    window.addEventListener("focus", recheck);
});
