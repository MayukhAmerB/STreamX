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
            hubDescP2: "This is a live, expert-level Open Source Intelligence training ground. To succeed, you must conduct active queries across the target's Instagram profile (<code>@xcfwjoo310</code>) and correlate it with associated public code repositories.",
            hubRulesTitle: "🔑 Scoring Rules",
            hubRulePoints: "<strong>Max Points per Question:</strong> 1.0 point.",
            hubRuleScore: "<strong>Overall Score:</strong> Your total score is calculated dynamically based on solved questions (Max total: 10.0 points).",
            hubInstructionsTitle: "🚀 Instructions",
            hubInstructionsDesc: "Select the <strong>OSINT LABS</strong> tab in the sidebar to view the questions. Locate the clues in the live Instagram bio, feed images, and GitHub repository branches/logs to crack the secure database vault and retrieve the final flag.",
            labSubheading: "ACTIVE INVESTIGATION",
            labTitle: "The Zenith Footprint",
            labDesc: "Conduct live queries on the target's Instagram profile (@xcfwjoo310) and correlate it with associated public GitHub repositories.",
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
            hubDescP2: "یہ ایک لائیو، ماہر سطح کا اوپن سورس انٹیلیجنس ٹریننگ گراؤنڈ ہے۔ کامیابی کے لیے ٹارگٹ کے انسٹاگرام پروفائل (<code>@xcfwjoo310</code>) پر تحقیق کریں اور اسے متعلقہ عوامی گٹ ہب ریپوزٹریز سے جوڑیں۔",
            hubRulesTitle: "🔑 اسکورنگ کے قواعد",
            hubRulePoints: "<strong>ہر سوال کے لیے زیادہ سے زیادہ پوائنٹس:</strong> 1.0 پوائنٹ۔",
            hubRuleScore: "<strong>مجموعی اسکور:</strong> آپ کے کل اسکور کا حساب متحرک طور پر حل شدہ سوالات کی بنیاد پر کیا جاتا ہے (کل زیادہ سے زیادہ: 10.0 پوائنٹس)۔",
            hubInstructionsTitle: "🚀 ہدایات",
            hubInstructionsDesc: "سوالات دیکھنے کے لیے سائڈبار میں <strong>او ایس آئی این ٹی لیبز</strong> ٹیب کو منتخب کریں۔ سیکیور والٹ کو توڑنے اور حتمی فلیگ حاصل کرنے کے لیے انسٹاگرام بائیو، فیڈ تصاویر، اور گٹ ہب لاگز میں سراغ تلاش کریں۔",
            labSubheading: "سرگرم تحقیقات",
            labTitle: "زینتھ فٹ پرنٹ",
            labDesc: "ٹارگٹ کے انسٹاگرام پروفائل (@xcfwjoo310) پر لائیو تحقیق کریں اور اسے متعلقہ عوامی گٹ ہب ریپوزٹریز سے جوڑیں۔",
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
                q: "The target's Instagram bio (@xcfwjoo310) contains an encrypted string representing the target's username. Decrypt the Vigenère cipher 'lmxixzswujhymi' using the startup's name in lowercase as the key to find the target's public username."
            },
            {
                q: "In the posted terminal screenshot on Instagram @xcfwjoo310, the target has obfuscated the vault passphrase as a raw hex string under the key 'SEC_SYS_RAW'. What is the decoded system access passphrase?"
            },
            {
                q: "In the 'public-archive' repository, look at the commit history logs of the secondary branch 'archived-config'. Locate the commit where configuration secrets were redacted. What was the exact value of the 'salt' key string before it was deleted in that commit's diff?"
            },
            {
                q: "In the 'CRBV' repository, look at the legacy database setup file under 'legacy/db_v1.sql'. What is the exact data type and precision defined for the 'multiplier' column? (Format: TYPE(X,Y))"
            },
            {
                q: "According to the registry file 'data/corporate_registry.json' in the 'CRBV' repository, what is the SHA-256 hash (in lowercase hex representation) of the company number listed for 'VIRGIN HOLDINGS LIMITED'?"
            },
            {
                q: "In the 'PGP' repository, inspect the public key file 'public_keys/apex_public_key.asc'. What is the subkey ID (with '0x' prefix in lowercase) that is configured for encryption only?"
            },
            {
                q: "In the 'PGP' repository, look at the script 'src/pgp_wrapper.sh'. What is the full recipient email address configured in the encryption command?"
            },
            {
                q: "In the 'Madsonrepo' repository, audit the syslog logs under 'logs/system_2026-05-10.log'. What is the Process ID (PID) associated with the 'cron' daemon process when it starts?"
            },
            {
                q: "According to the flight history logs ('flight_history_may_2026.csv' in 'Madsonrepo' under 'logs/'), what is the recorded weather temperature (including the minus sign, degree symbol, and C, e.g. -3°C) at Reykjavik (KEF) airport for flight SK-901?"
            },
            {
                q: "What is the final decrypted flag for the challenge (retrieved by decrypting secure-vault's flag.enc payload using decrypt.py)?"
            }
        ],
        ur: [
            {
                q: "ٹارگٹ کے انسٹاگرام بائیو (@xcfwjoo310) میں ایک خفیہ کردہ سٹرنگ ہے جو ٹارگٹ کے صارف نام کی نمائندگی کرتی ہے۔ ٹارگٹ کا عوامی گٹ ہب صارف نام معلوم کرنے کے لیے اسٹارٹ اپ کے نام کو چھوٹے حروف میں بطور کلید استعمال کرتے ہوئے ویجینیر سائفر 'lmxixzswujhymi' کو ڈکرپٹ کریں۔"
            },
            {
                q: "انسٹاگرام @xcfwjoo310 پر پوسٹ کیے گئے ٹرمینل اسکرین شاٹ میں، ٹارگٹ نے والٹ پاس فریز کو 'SEC_SYS_RAW' کلید کے تحت ایک خام ہیکس سٹرنگ کے طور پر مبہم کیا ہے۔ ڈیکوڈ شدہ سسٹم تک رسائی کا پاس فریز کیا ہے؟"
            },
            {
                q: "'public-archive' ریپوزٹری میں، سیکنڈری برانچ 'archived-config' کے کمٹ ہسٹری لاگز کو دیکھیں۔ وہ کمٹ تلاش کریں جہاں ترتیب کے رازوں کو حذف کیا گیا تھا۔ اس کمٹ کے فرق (diff) میں حذف ہونے سے پہلے 'salt' کی قدر کیا تھی؟"
            },
            {
                q: "'CRBV' ریپوزٹری میں، 'legacy/db_v1.sql' کے تحت پرانی ڈیٹا بیس سیٹ اپ فائل کو دیکھیں۔ 'multiplier' کالم کے لیے بیان کردہ ڈیٹا ٹائپ اور درستگی کیا ہے؟ (فارمیٹ: TYPE(X,Y))"
            },
            {
                q: "'CRBV' ریپوزٹری میں رجسٹری فائل 'data/corporate_registry.json' کے مطابق، 'VIRGIN HOLDINGS LIMITED' کے لیے درج کمپنی نمبر کا SHA-256 ہیش (چھوٹے حروف ہیکس میں) کیا ہے؟"
            },
            {
                q: "'PGP' ریپوزٹری میں، پبلک کی فائل 'public_keys/apex_public_key.asc' کا معائنہ کریں۔ سب کی (subkey) آئی ڈی (چھوٹے حروف میں '0x' لاحقے کے ساتھ) کیا ہے جو صرف انکرپشن کے لیے کنفیگر کی گئی ہے؟"
            },
            {
                q: "'PGP' ریپوزٹری میں، اسکرپٹ 'src/pgp_wrapper.sh' کو دیکھیں۔ انکرپشن کمانڈ میں کنفیگر کیا گیا وصول کنندہ کا مکمل ای میل ایڈریس کیا ہے؟"
            },
            {
                q: "'Madsonrepo' ریپوزٹری میں، 'logs/system_2026-05-10.log' کے تحت سسٹم لاگز کا آڈٹ کریں۔ جب 'cron' ڈیمن پروسیس شروع ہوتا ہے تو اس سے وابستہ پروسیس آئی ڈی (PID) کیا ہوتی ہے؟"
            },
            {
                q: "فلائٹ ہسٹری لاگز (Madsonrepo میں 'logs/flight_history_may_2026.csv') کے مطابق، فلائٹ SK-901 کے لیے ریکیاوک (KEF) ائیرپورٹ پر ریکارڈ شدہ درجہ حرارت (بشمول منفی نشان، ڈگری علامت، اور C، جیسے -3°C) کیا ہے؟"
            },
            {
                q: "چیلنج کا حتمی ڈکرپٹ شدہ فلیگ (flag) کیا ہے (جو decrypt.py کا استعمال کرتے ہوئے secure-vault کے flag.enc پیلوڈ کو ڈکرپٹ کرکے حاصل کیا گیا ہے)؟"
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
