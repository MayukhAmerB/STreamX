// Zenith OSINT CTF Platform - Application Logic
document.addEventListener("DOMContentLoaded", () => {
    // ----------------------------------------------------
    // 1. STATE & STORAGE MANAGEMENT
    // ----------------------------------------------------
    let currentLang = localStorage.getItem("zenith_ctf_lang") || "en";
    if (currentLang !== "en" && currentLang !== "ur") {
        currentLang = "en";
    }

    let solvedQuestions = { realworld: Array(10).fill(false) };
    try {
        const storedProgress = JSON.parse(localStorage.getItem("zenith_ctf_solved"));
        if (storedProgress && Array.isArray(storedProgress.realworld)) {
            solvedQuestions = storedProgress;
        }
    } catch {
        localStorage.removeItem("zenith_ctf_solved");
    }
    if (!solvedQuestions.realworld || solvedQuestions.realworld.length < 10) {
        solvedQuestions.realworld = Array(10).fill(false);
    }
    solvedQuestions.realworld = solvedQuestions.realworld.slice(0, 10).map(Boolean);

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

    // ----------------------------------------------------
    // 2. QUESTION DEFINITIONS & TRANSLATIONS
    // ----------------------------------------------------
    const translations = {
        en: {
            brandLabs: "LABS",
            navHub: "CTF HUB",
            navLabs: "OSINT LABS",
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

        // 4. Render question cards
        renderQuestions("realworld");
        updateProgressIndicators();
    };

    const renderQuestions = (category) => {
        const container = document.getElementById(`${category}-questions`);
        if (!container) return;
        container.innerHTML = "";

        const dict = translations[currentLang];

        questionsData[currentLang].forEach((q, idx) => {
            const isSolved = solvedQuestions[category][idx];
            const safeQuestion = escapeHtml(q.q);
            const safeHeaderPrefix = escapeHtml(dict.qHeaderPrefix);
            const safePotential = escapeHtml(dict.qBadgePotential);
            const safePointsSuffix = escapeHtml(dict.ptsSuffix);
            const safePlaceholder = escapeHtml(dict.inputPlaceholder);
            const safeSolvedLabel = escapeHtml(dict.btnSolved);
            const safeSubmitLabel = escapeHtml(dict.btnSubmit);

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
                <p class="question-text">${safeQuestion}</p>
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
                        body: JSON.stringify({ category, question: idx, answer: val })
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
                } catch {
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

        ["realworld"].forEach(category => {
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
            if (badgeEl) badgeEl.textContent = `${count}/10 (${catScore.toFixed(1)}${dict.ptsSuffix})`;
        });

        // Overall progress
        const overallSolvedEl = document.getElementById("overall-solved");
        const overallScoreEl = document.getElementById("overall-score");
        const progressBarEl = document.getElementById("overall-progress-bar");

        if (overallSolvedEl) overallSolvedEl.textContent = totalSolved;
        if (overallScoreEl) overallScoreEl.textContent = totalScore.toFixed(1);
        if (progressBarEl) {
            const pct = (totalSolved / 10) * 100;
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
