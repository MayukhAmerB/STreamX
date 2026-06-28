// Zenith OSINT CTF Platform - Application Logic
document.addEventListener("DOMContentLoaded", () => {
    // ----------------------------------------------------
    // 1. STATE & STORAGE MANAGEMENT
    // ----------------------------------------------------
    let currentLang = localStorage.getItem("zenith_ctf_lang") || "en";
    if (currentLang !== "en" && currentLang !== "ur") {
        currentLang = "en";
    }

    const labCategories = ["realworld", "blackmeridian", "certification"];
    let solvedQuestions = {
        realworld: Array(10).fill(false),
        blackmeridian: Array(10).fill(false),
        certification: Array(10).fill(false)
    };
    try {
        const storedProgress = JSON.parse(localStorage.getItem("zenith_ctf_solved"));
        if (storedProgress && Array.isArray(storedProgress.realworld)) {
            solvedQuestions = storedProgress;
        }
    } catch {
        localStorage.removeItem("zenith_ctf_solved");
    }
    labCategories.forEach((category) => {
        if (!solvedQuestions[category] || solvedQuestions[category].length < 10) {
            solvedQuestions[category] = Array(10).fill(false);
        }
        solvedQuestions[category] = solvedQuestions[category].slice(0, 10).map(Boolean);
    });

    // Helper to save state
    const saveState = () => {
        localStorage.setItem("zenith_ctf_solved", JSON.stringify(solvedQuestions));
        updateProgressIndicators();
    };

    const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    })[character]);

    const renderQuestionBody = (question) => {
        if (!question.title && !question.briefing && !question.task && !question.answerFormat && !question.constraints && !question.artifact && !question.searchPatterns) {
            return `<p class="question-text">${escapeHtml(question.q)}</p>`;
        }

        const renderParagraphs = (items) => (Array.isArray(items) ? items : [items])
            .filter(Boolean)
            .map((item) => `<p>${escapeHtml(item)}</p>`)
            .join("");

        const sections = [];
        if (question.title) {
            sections.push(`<h5 class="question-title">${escapeHtml(question.title)}</h5>`);
        }
        if (question.briefing) {
            sections.push(`<div class="question-section"><span>Briefing</span>${renderParagraphs(question.briefing)}</div>`);
        }
        if (question.artifact) {
            sections.push(`
                <div class="question-section question-info-card question-artifact">
                    <span>Artifact Card</span>
                    <p class="question-artifact-note">Use this supplied evidence exactly as part of the investigation.</p>
                    <div class="question-artifact-value">
                        <code>${escapeHtml(question.artifact)}</code>
                    </div>
                </div>
            `);
        }
        if (question.searchPatterns) {
            const patterns = question.searchPatterns
                .map((pattern) => `<li><code>${escapeHtml(pattern)}</code></li>`)
                .join("");
            sections.push(`<div class="question-section question-info-card"><span>Allowed search patterns</span><ul class="question-patterns">${patterns}</ul></div>`);
        }
        if (question.task) {
            sections.push(`<div class="question-section"><span>Task</span>${renderParagraphs(question.task)}</div>`);
        }
        if (question.constraints) {
            sections.push(`<div class="question-section"><span>Constraints</span>${renderParagraphs(question.constraints)}</div>`);
        }
        if (question.answerFormat) {
            sections.push(`<div class="question-section"><span>Answer format</span>${renderParagraphs(question.answerFormat)}</div>`);
        }

        return `<div class="question-longform">${sections.join("")}</div>`;
    };

    // ----------------------------------------------------
    // 2. QUESTION DEFINITIONS & TRANSLATIONS
    // ----------------------------------------------------
    const translations = {
        en: {
            brandLabs: "LABS",
            navHub: "CTF HUB",
            navLabs: "OSINT LABS",
            navBlackMeridian: "BLACK MERIDIAN",
            navCertification: "CERTIFICATION CTF",
            progressHeader: "Overall Progress",
            progressSolved: "SOLVED:",
            progressScore: "SCORE:",
            hubSubheading: "INTELLIGENCE LABS",
            hubHeading: 'Labs that<br><span class="text-demand">demand</span><br>excellence.',
            hubDescTitle: "The Zenith Footprint",
            hubDescP1: "Welcome, Investigator. We need your live OSINT skills to identify an unknown operator and trace their digital footprint.",
            hubDescP2: "This is a live, expert-level Open Source Intelligence investigation. Begin with the target's public profile (<code>@xcfwjoo310</code>), discover the operator's wider footprint, and build the evidence chain yourself.",
            hubRulesTitle: "🔑 Scoring Rules",
            hubRulePoints: "<strong>Max Points per Question:</strong> 1.0 point.",
            hubRuleScore: "<strong>Overall Score:</strong> Your total score is calculated dynamically based on solved questions (Max total: 10.0 points).",
            hubInstructionsTitle: "🚀 Instructions",
            hubInstructionsDesc: "Select <strong>OSINT LABS</strong> to receive investigative objectives. Prompts intentionally omit file paths, repository names, branches, encodings, and tools. Pivot between public identities and artifacts until the evidence supports an exact answer.",
            labSubheading: "ACTIVE INVESTIGATION",
            labTitle: "The Zenith Footprint",
            labDesc: "Start with @xcfwjoo310. Discover the operator's identities, infrastructure, historical mistakes, and protected artifacts without being given the investigation path.",
            labStatSolved: "SOLVED:",
            labStatScore: "SCORE:",
            blackSubheading: "ELITE INVESTIGATION",
            blackTitle: "Black Meridian",
            blackDesc: "A 10/10 live OSINT correlation lab. Start from @xcfwjoo310, pivot into the controlled GitHub account, and work across black-meridian branches, commit history, metadata, DNS residue, crypto notes, and a protected payload.",
            certificationSubheading: "CERTIFICATION EXAM",
            certificationTitle: "Certification CTF",
            certificationDesc: "A 10-question OSINT certification exam. No hints, no walkthroughs, and exact-answer validation.",
            qHeaderPrefix: "Question",
            qBadgePotential: "Potential: 1.0 pt",
            qBadgeSolved: "1.0 / 1.0 pt",
            btnSubmit: "Submit",
            btnSolved: "Solved ✓",
            inputPlaceholder: "Enter your answer...",
            feedbackSuccess: "[+] Success! Correct Answer.",
            feedbackError: "[-] Incorrect. Double-check your clues and try again.",
            ptsSuffix: " pts"
        },
        ur: {
            brandLabs: "لیبز",
            navHub: "سی ٹی ایف ہب",
            navLabs: "او ایس آئی این ٹی لیبز",
            navBlackMeridian: "BLACK MERIDIAN",
            progressHeader: "مجموعی پیش رفت",
            progressSolved: "حل شدہ:",
            progressScore: "اسکور:",
            hubSubheading: "انٹیلیجنس لیبز",
            hubHeading: 'لیبز جو<br><span class="text-demand">مطالبہ کرتی ہیں</span><br>عمدگی کا۔',
            hubDescTitle: "زینتھ فٹ پرنٹ",
            hubDescP1: "خوش آمدید، تفتیش کار۔ ایک نامعلوم آپریٹر کی شناخت اور اس کے ڈیجیٹل فٹ پرنٹ کو ٹریس کرنے کے لیے ہمیں آپ کی لائیو OSINT صلاحیتوں کی ضرورت ہے۔",
            hubDescP2: "یہ ایک لائیو، ماہر سطح کی اوپن سورس انٹیلیجنس تفتیش ہے۔ ٹارگٹ کے عوامی پروفائل (<code>@xcfwjoo310</code>) سے آغاز کریں، آپریٹر کا وسیع ڈیجیٹل نقش دریافت کریں، اور شواہد کی مکمل زنجیر خود بنائیں۔",
            hubRulesTitle: "🔑 اسکورنگ کے قواعد",
            hubRulePoints: "<strong>ہر سوال کے لیے زیادہ سے زیادہ پوائنٹس:</strong> 1.0 پوائنٹ۔",
            hubRuleScore: "<strong>مجموعی اسکور:</strong> آپ کے کل اسکور کا حساب متحرک طور پر حل شدہ سوالات کی بنیاد پر کیا جاتا ہے (کل زیادہ سے زیادہ: 10.0 پوائنٹس)۔",
            hubInstructionsTitle: "🚀 ہدایات",
            hubInstructionsDesc: "تحقیقی مقاصد دیکھنے کے لیے <strong>او ایس آئی این ٹی لیبز</strong> منتخب کریں۔ سوالات جان بوجھ کر فائل پاتھ، ریپوزٹری نام، برانچ، انکوڈنگ اور مطلوبہ ٹول ظاہر نہیں کرتے۔ درست جواب تک پہنچنے کے لیے عوامی شناختوں اور شواہد کے درمیان خود روابط قائم کریں۔",
            labSubheading: "سرگرم تحقیقات",
            labTitle: "زینتھ فٹ پرنٹ",
            labDesc: "@xcfwjoo310 سے آغاز کریں۔ آپریٹر کی شناختیں، انفراسٹرکچر، تاریخی غلطیاں اور محفوظ شواہد خود دریافت کریں؛ تفتیش کا راستہ فراہم نہیں کیا جائے گا۔",
            labStatSolved: "حل شدہ:",
            labStatScore: "اسکور:",
            blackSubheading: "ELITE INVESTIGATION",
            blackTitle: "Black Meridian",
            blackDesc: "A 10/10 live OSINT correlation lab. Start from @xcfwjoo310, pivot into the controlled GitHub account, and work across black-meridian branches, commit history, metadata, DNS residue, crypto notes, and a protected payload.",
            qHeaderPrefix: "سوال",
            qBadgePotential: "امکانی: 1.0 پوائنٹ",
            qBadgeSolved: "1.0 / 1.0 پوائنٹ",
            btnSubmit: "جمع کرائیں",
            btnSolved: "حل شدہ ✓",
            inputPlaceholder: "اپنا جواب درج کریں...",
            feedbackSuccess: "[+] کامیابی! درست جواب۔",
            feedbackError: "[-] غلط جواب۔ اپنے سراغ دوبارہ چیک کریں اور کوشش کریں۔",
            ptsSuffix: " پوائنٹس"
        }
    };

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

    // ----------------------------------------------------
    // 3. UI TRANSLATION AND RENDERING
    // ----------------------------------------------------
    const switchLanguage = (lang) => {
        if (lang !== "en" && lang !== "ur") {
            lang = "en";
        }
        currentLang = lang;
        localStorage.setItem("zenith_ctf_lang", lang);

        // Add/remove ur-mode class on body for RTL support
        if (lang === "ur") {
            document.body.classList.add("ur-mode");
        } else {
            document.body.classList.remove("ur-mode");
        }

        const dict = translations[lang];

        const setSafeText = (id, text, isHTML = false) => {
            const el = document.getElementById(id);
            if (el) {
                if (isHTML) el.innerHTML = text;
                else el.textContent = text;
            } else {
                console.warn(`Translation element missing: ${id}`);
            }
        };

        // 1. Sidebar static texts
        setSafeText("brand-labs-text", dict.brandLabs);
        setSafeText("nav-hub-text", dict.navHub);
        setSafeText("nav-labs-text", dict.navLabs);
        setSafeText("nav-blackmeridian-text", dict.navBlackMeridian || "BLACK MERIDIAN");
        setSafeText("nav-certification-text", dict.navCertification || "CERTIFICATION CTF");
        setSafeText("progress-header-text", dict.progressHeader);
        setSafeText("progress-solved-label", dict.progressSolved);
        setSafeText("progress-score-label", dict.progressScore);
        setSafeText("progress-pts-label", dict.ptsSuffix);

        // 2. Hub tab static texts
        setSafeText("hub-subheading-text", dict.hubSubheading);
        setSafeText("hub-heading-text", dict.hubHeading, true);
        setSafeText("hub-desc-title", dict.hubDescTitle);
        setSafeText("hub-desc-p1", dict.hubDescP1, true);
        setSafeText("hub-desc-p2", dict.hubDescP2, true);
        setSafeText("hub-rules-title", dict.hubRulesTitle);
        setSafeText("hub-rule-points", dict.hubRulePoints, true);
        setSafeText("hub-rule-score", dict.hubRuleScore, true);
        setSafeText("hub-instructions-title", dict.hubInstructionsTitle);
        setSafeText("hub-instructions-desc", dict.hubInstructionsDesc, true);

        // 3. Lab tab static texts
        setSafeText("lab-subheading-text", dict.labSubheading);
        setSafeText("lab-title-text", dict.labTitle);
        setSafeText("lab-desc-text", dict.labDesc);
        setSafeText("lab-stat-solved-label", dict.labStatSolved);
        setSafeText("lab-stat-score-label", dict.labStatScore);
        setSafeText("black-subheading-text", dict.blackSubheading || "ELITE INVESTIGATION");
        setSafeText("black-title-text", dict.blackTitle || "Black Meridian");
        setSafeText("black-desc-text", dict.blackDesc || "");
        setSafeText("black-stat-solved-label", dict.labStatSolved);
        setSafeText("black-stat-score-label", dict.labStatScore);
        setSafeText("certification-subheading-text", dict.certificationSubheading || "CERTIFICATION EXAM");
        setSafeText("certification-title-text", dict.certificationTitle || "Certification CTF");
        setSafeText("certification-desc-text", dict.certificationDesc || "A 10-question OSINT certification exam.");
        setSafeText("certification-stat-solved-label", dict.labStatSolved);
        setSafeText("certification-stat-score-label", dict.labStatScore);

        // 4. Render question cards
        renderQuestions("realworld");
        renderQuestions("blackmeridian");
        renderQuestions("certification");
        updateProgressIndicators();
    };

    const renderQuestions = (category) => {
        const container = document.getElementById(`${category}-questions`);
        if (!container) return;
        container.innerHTML = "";

        const dict = translations[currentLang];

        let questionSet = questionsData[currentLang] || questionsData.en;
        if (category === "blackmeridian") {
            questionSet = blackMeridianQuestions[currentLang] || blackMeridianQuestions.en;
        }
        if (category === "certification") {
            questionSet = certificationQuestions[currentLang]?.length
                ? certificationQuestions[currentLang]
                : certificationQuestions.en;
        }

        questionSet.forEach((q, idx) => {
            const isSolved = solvedQuestions[category][idx];
            const questionBodyHtml = renderQuestionBody(q);
            const safeHeaderPrefix = escapeHtml(dict.qHeaderPrefix);
            const safePotential = escapeHtml(dict.qBadgePotential);
            const safePointsSuffix = escapeHtml(dict.ptsSuffix);
            const safePlaceholder = escapeHtml(dict.inputPlaceholder);
            const safeSolvedLabel = escapeHtml(dict.btnSolved);
            const safeSubmitLabel = escapeHtml(dict.btnSubmit);
            const evidenceImageHtml = q.image
                ? `<figure class="question-evidence"><img src="${escapeHtml(q.image)}" alt="${escapeHtml(q.imageAlt || "Question evidence image")}" loading="lazy"></figure>`
                : "";

            let scoreBadgeHtml = "";
            if (isSolved) {
                scoreBadgeHtml = `<span class="q-badge score-badge" id="score-badge-${category}-${idx}" style="background-color: rgba(0, 255, 102, 0.1); color: var(--accent-green); border: 1px solid rgba(0, 255, 102, 0.2);">1.0 / 1.0 ${safePointsSuffix}</span>`;
            } else {
                scoreBadgeHtml = `<span class="q-badge score-badge" id="score-badge-${category}-${idx}">${safePotential}</span>`;
            }

            const card = document.createElement("div");
            card.className = `question-card ${isSolved ? "solved" : ""}`;
            card.id = `q-${category}-${idx}`;

            card.innerHTML = `
                <div class="q-header">
                    <h4>${safeHeaderPrefix} ${idx + 1}</h4>
                    <div style="display: flex; gap: 8px; align-items: center;">
                        ${scoreBadgeHtml}
                        <span class="q-badge">${category.toUpperCase()} • Q${idx + 1}</span>
                    </div>
                </div>
                ${questionBodyHtml}
                ${evidenceImageHtml}
                <div class="answer-row">
                    <input type="text" class="answer-input" id="input-${category}-${idx}"
                           placeholder="${safePlaceholder}" ${isSolved ? "disabled" : ""}>
                    <button class="btn ${isSolved ? "btn-success" : "btn-primary"}" id="btn-${category}-${idx}" ${isSolved ? "disabled" : ""}>
                        ${isSolved ? safeSolvedLabel : safeSubmitLabel}
                    </button>
                </div>
                <div class="feedback-text" id="feedback-${category}-${idx}"></div>
            `;

            container.appendChild(card);

            // Bind submit action
            const btn = card.querySelector(`#btn-${category}-${idx}`);
            const input = card.querySelector(`#input-${category}-${idx}`);
            const feedback = card.querySelector(`#feedback-${category}-${idx}`);

            const checkAnswer = async () => {
                const val = input.value.trim();
                if (!val || btn.disabled) return;

                btn.disabled = true;
                btn.textContent = currentLang === "ur" ? "جانچ جاری ہے..." : "Checking...";
                feedback.className = "feedback-text";
                feedback.textContent = "";

                try {
                    const response = await fetch("/api/validate", {
                        method: "POST",
                        headers: { "Content-Type": "application/json; charset=utf-8" },
                        body: JSON.stringify({
                            category,
                            question: idx,
                            answer: val
                        })
                    });
                    const result = await response.json().catch(() => ({}));

                    if (!response.ok) {
                        throw new Error(result.error || "Validation service unavailable.");
                    }

                    if (result.correct) {
                        solvedQuestions[category][idx] = true;
                        card.classList.add("solved");
                        input.disabled = true;
                        btn.disabled = true;
                        btn.className = "btn btn-success";
                        btn.textContent = dict.btnSolved;
                        feedback.className = "feedback-text success";
                        feedback.textContent = dict.feedbackSuccess;

                        // Update score badge
                        const scoreBadge = card.querySelector(`#score-badge-${category}-${idx}`);
                        if (scoreBadge) {
                            scoreBadge.textContent = `1.0 / 1.0 ${dict.ptsSuffix}`;
                            scoreBadge.style.backgroundColor = "rgba(0, 255, 102, 0.1)";
                            scoreBadge.style.color = "var(--accent-green)";
                            scoreBadge.style.borderColor = "rgba(0, 255, 102, 0.2)";
                        }

                        saveState();
                    } else {
                        btn.disabled = false;
                        btn.textContent = dict.btnSubmit;
                        feedback.className = "feedback-text error";
                        feedback.textContent = dict.feedbackError;
                    }
                } catch (error) {
                    btn.disabled = false;
                    btn.textContent = dict.btnSubmit;
                    feedback.className = "feedback-text error";
                    feedback.textContent = currentLang === "ur"
                        ? "[-] توثیق کی سروس دستیاب نہیں ہے۔ دوبارہ کوشش کریں۔"
                        : "[-] Validation service unavailable. Please try again.";
                }
            };

            btn.addEventListener("click", checkAnswer);
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    checkAnswer();
                }
            });
        });
    };

    // ----------------------------------------------------
    // 4. PROGRESS UPDATES
    // ----------------------------------------------------
    const updateProgressIndicators = () => {
        let totalSolved = 0;
        let totalScore = 0.0;

        labCategories.forEach(category => {
            const count = solvedQuestions[category].filter(Boolean).length;
            totalSolved += count;

            let catScore = count * 1.0;
            totalScore += catScore;

            // Update individual lab page scoreboard panels
            const solvedEl = document.getElementById(`solved-${category}`);
            const scoreEl = document.getElementById(`score-${category}`);
            if (solvedEl) solvedEl.textContent = count;
            if (scoreEl) scoreEl.textContent = catScore.toFixed(1);

            // Update sidebar navigation badges with solved count & separate score
            const badgeEl = document.getElementById(`badge-${category}`);
            const dict = translations[currentLang];
            const totalQuestions = solvedQuestions[category].length;
            if (badgeEl) badgeEl.textContent = `${count}/${totalQuestions} (${catScore.toFixed(1)}${dict.ptsSuffix})`;
        });

        // Overall progress
        const overallSolvedEl = document.getElementById("overall-solved");
        const overallScoreEl = document.getElementById("overall-score");
        const progressBarEl = document.getElementById("overall-progress-bar");
        const overallTotalEl = document.getElementById("overall-total");
        const totalQuestions = labCategories.reduce((sum, category) => sum + solvedQuestions[category].length, 0);

        if (overallSolvedEl) overallSolvedEl.textContent = totalSolved;
        if (overallScoreEl) overallScoreEl.textContent = totalScore.toFixed(1);
        if (overallTotalEl) overallTotalEl.textContent = totalQuestions;
        if (progressBarEl) {
            const pct = totalQuestions ? (totalSolved / totalQuestions) * 100 : 0;
            progressBarEl.style.width = `${pct}%`;
        }
    };

    // Initialize Language Selector Click Event
    const langToggleBtn = document.getElementById("lang-toggle");
    if (langToggleBtn) {
        langToggleBtn.addEventListener("click", () => {
            const newLang = currentLang === "en" ? "ur" : "en";
            switchLanguage(newLang);
        });
    }

    // Set initial language and render
    switchLanguage(currentLang);

    // ----------------------------------------------------
    // 5. SIDEBAR NAVIGATION
    // ----------------------------------------------------
    const navButtons = document.querySelectorAll(".nav-btn");
    const tabContents = document.querySelectorAll(".tab-content");

    navButtons.forEach(btn => {
        btn.addEventListener("click", () => {
            navButtons.forEach(b => b.classList.remove("active"));
            tabContents.forEach(tc => tc.classList.remove("active"));

            btn.classList.add("active");
            const tabId = btn.getAttribute("data-tab");
            document.getElementById(`tab-${tabId}`).classList.add("active");
        });
    });
});
