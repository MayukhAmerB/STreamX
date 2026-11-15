// AL SYED LABS - Examination tab.
//
// Talks to the LMS API (/api/ctf/) with the student's own LMS session
// (credentials: "include"; labs and the LMS are the same site). The server
// checks and records every answer; this file holds no answers, no hashes and
// stores nothing about the exam in the browser.
(() => {
    "use strict";

    const DEFAULT_API_BASE = "https://alsyedinitiative.com/api";
    const MAX_ANSWER_LENGTH = 512;
    const MATERIAL_PATH = /^\/materials\/[A-Za-z0-9_\-./]+$/;
    const WARNING_SECONDS = 5 * 60;

    const STRINGS = {
        en: {
            nav: "EXAMINATION",
            subheading: "PROCTORED EXAMINATION",
            heading: "OSINT Examination",
            intro: "A timed, graded OSINT examination. Every answer you submit is recorded against your LMS account, and your score is visible to your instructors.",
            scoreLabel: "SCORE:",
            solvedLabel: "SOLVED:",
            timeLabel: "TIME LEFT:",
            loading: "Loading your examinations...",
            empty: "No examination is available for your batch right now.",
            signedOut: "Sign in to the LMS to take the examination.",
            signInLink: "Sign in at alsyedinitiative.com",
            termsRequired: "Accept the current Terms and Conditions on the LMS before taking the examination.",
            termsLink: "Open alsyedinitiative.com",
            retry: "Try again",
            open: "Open",
            startExam: "Start examination",
            resume: "Continue",
            viewResult: "View result",
            back: "All examinations",
            questions: "questions",
            points: "pts",
            minutes: "min",
            noTimeLimit: "No time limit",
            opens: "Opens",
            closes: "Closes",
            windowNotOpen: "NOT OPEN YET",
            windowOpen: "OPEN",
            windowClosed: "CLOSED",
            statusActive: "IN PROGRESS",
            statusSubmitted: "SUBMITTED",
            statusExpired: "TIME OVER",
            yourScore: "Your score",
            briefing: "Briefing",
            rules: "Rules",
            startTitle: "Ready when you are",
            startText: "The timer starts when you press Start and cannot be paused. Questions appear after you start.",
            notOpenText: "This examination has not opened yet.",
            confirmStart: "Start the examination now? The timer cannot be paused.",
            confirmFinish: "Submit the examination now? You will not be able to answer any more questions.",
            finish: "Submit examination",
            overTitle: "Examination over",
            overText: "Your answers are recorded. Final score: {score} / {total} points ({solved} solved).",
            question: "QUESTION",
            sectionBriefing: "Briefing",
            sectionArtifact: "Artifact Card",
            artifactNote: "Use this supplied evidence exactly as part of the investigation.",
            sectionPatterns: "Allowed search patterns",
            sectionTask: "Task",
            sectionConstraints: "Constraints",
            sectionFormat: "Answer format",
            sectionMaterials: "Evidence files",
            placeholder: "Type your exact answer...",
            submit: "SUBMIT",
            checking: "Checking...",
            solved: "SOLVED",
            locked: "LOCKED",
            attempts: "Attempts: {used} / {max}",
            correct: "[+] Correct. +{points} points recorded.",
            incorrect: "[-] Incorrect. {left} attempt(s) left for this question.",
            incorrectLast: "[-] Incorrect. No attempts left for this question.",
            tooLong: "Answers can be at most 512 characters.",
            difficulty: { medium: "MEDIUM", hard: "HARD", expert: "EXPERT", insane: "INSANE" },
            errors: {
                network: "Could not reach the LMS. Check your connection and try again.",
                ctf_exam_not_found: "This examination is not available to you.",
                ctf_question_not_found: "This question is no longer part of the examination.",
                ctf_not_started: "Start the examination before answering.",
                ctf_exam_time_over: "Your time for this examination is over.",
                ctf_exam_closed: "This examination has closed.",
                ctf_exam_not_open: "This examination has not opened yet.",
                ctf_exam_not_ready: "This examination is not ready yet.",
                ctf_question_already_solved: "You have already solved this question.",
                ctf_attempts_exhausted: "You have used every attempt for this question.",
                ctf_participation_submitted: "You have already submitted this examination.",
                ctf_attempt_conflict: "Another answer was recorded at the same moment. Refresh and try again.",
                ctf_not_configured: "Answer checking is not available right now. Tell your instructor.",
                ctf_answer_key_mismatch: "The answer key is being updated. Try again in a minute.",
                rate_limited: "Too many answers too quickly. Wait a moment and try again.",
                idempotency_in_progress: "Your previous answer is still being checked. Wait a moment.",
                validation_failed: "Check your answer and try again.",
                fallback: "Something went wrong. Please try again.",
            },
        },
        ur: {
            nav: "امتحان",
            subheading: "نگرانی میں امتحان",
            heading: "OSINT امتحان",
            intro: "وقت کی پابندی والا، نمبروں والا OSINT امتحان۔ آپ کا ہر جواب آپ کے LMS اکاؤنٹ کے ساتھ محفوظ ہوتا ہے اور آپ کا اسکور آپ کے اساتذہ دیکھ سکتے ہیں۔",
            scoreLabel: "اسکور:",
            solvedLabel: "حل شدہ:",
            timeLabel: "باقی وقت:",
            loading: "آپ کے امتحانات لوڈ ہو رہے ہیں...",
            empty: "اس وقت آپ کے بیچ کے لیے کوئی امتحان دستیاب نہیں ہے۔",
            signedOut: "امتحان دینے کے لیے LMS میں سائن ان کریں۔",
            signInLink: "alsyedinitiative.com پر سائن ان کریں",
            termsRequired: "امتحان سے پہلے LMS پر موجودہ شرائط و ضوابط قبول کریں۔",
            termsLink: "alsyedinitiative.com کھولیں",
            retry: "دوبارہ کوشش کریں",
            open: "کھولیں",
            startExam: "امتحان شروع کریں",
            resume: "جاری رکھیں",
            viewResult: "نتیجہ دیکھیں",
            back: "تمام امتحانات",
            questions: "سوالات",
            points: "پوائنٹس",
            minutes: "منٹ",
            noTimeLimit: "وقت کی کوئی حد نہیں",
            opens: "شروع",
            closes: "اختتام",
            windowNotOpen: "ابھی شروع نہیں ہوا",
            windowOpen: "جاری",
            windowClosed: "بند",
            statusActive: "جاری ہے",
            statusSubmitted: "جمع شدہ",
            statusExpired: "وقت ختم",
            yourScore: "آپ کا اسکور",
            briefing: "بریفنگ",
            rules: "قواعد",
            startTitle: "جب آپ تیار ہوں",
            startText: "اسٹارٹ دبانے پر ٹائمر شروع ہو جائے گا اور روکا نہیں جا سکتا۔ سوالات شروع کرنے کے بعد نظر آئیں گے۔",
            notOpenText: "یہ امتحان ابھی شروع نہیں ہوا۔",
            confirmStart: "کیا ابھی امتحان شروع کریں؟ ٹائمر روکا نہیں جا سکتا۔",
            confirmFinish: "کیا ابھی امتحان جمع کریں؟ اس کے بعد آپ مزید جواب نہیں دے سکیں گے۔",
            finish: "امتحان جمع کریں",
            overTitle: "امتحان ختم",
            overText: "آپ کے جوابات محفوظ ہیں۔ حتمی اسکور: {score} / {total} پوائنٹس ({solved} حل شدہ)۔",
            question: "سوال",
            sectionBriefing: "بریفنگ",
            sectionArtifact: "شواہد کارڈ",
            artifactNote: "فراہم کردہ شواہد کو بالکل اسی طرح تحقیق میں استعمال کریں۔",
            sectionPatterns: "اجازت شدہ سرچ پیٹرن",
            sectionTask: "کام",
            sectionConstraints: "پابندیاں",
            sectionFormat: "جواب کا فارمیٹ",
            sectionMaterials: "شواہد کی فائلیں",
            placeholder: "اپنا درست جواب لکھیں...",
            submit: "جمع کریں",
            checking: "جانچ جاری ہے...",
            solved: "حل شدہ",
            locked: "بند",
            attempts: "کوششیں: {used} / {max}",
            correct: "[+] درست۔ +{points} پوائنٹس محفوظ ہو گئے۔",
            incorrect: "[-] غلط۔ اس سوال کے لیے {left} کوشش(یں) باقی ہیں۔",
            incorrectLast: "[-] غلط۔ اس سوال کے لیے کوئی کوشش باقی نہیں۔",
            tooLong: "جواب زیادہ سے زیادہ 512 حروف کا ہو سکتا ہے۔",
            difficulty: { medium: "درمیانہ", hard: "مشکل", expert: "ماہر", insane: "انتہائی مشکل" },
            errors: {
                network: "LMS سے رابطہ نہیں ہو سکا۔ اپنا کنکشن چیک کر کے دوبارہ کوشش کریں۔",
                ctf_exam_not_found: "یہ امتحان آپ کے لیے دستیاب نہیں ہے۔",
                ctf_question_not_found: "یہ سوال اب امتحان کا حصہ نہیں ہے۔",
                ctf_not_started: "جواب دینے سے پہلے امتحان شروع کریں۔",
                ctf_exam_time_over: "اس امتحان کے لیے آپ کا وقت ختم ہو گیا ہے۔",
                ctf_exam_closed: "یہ امتحان بند ہو چکا ہے۔",
                ctf_exam_not_open: "یہ امتحان ابھی شروع نہیں ہوا۔",
                ctf_exam_not_ready: "یہ امتحان ابھی تیار نہیں ہے۔",
                ctf_question_already_solved: "آپ یہ سوال پہلے ہی حل کر چکے ہیں۔",
                ctf_attempts_exhausted: "آپ اس سوال کی تمام کوششیں استعمال کر چکے ہیں۔",
                ctf_participation_submitted: "آپ یہ امتحان پہلے ہی جمع کر چکے ہیں۔",
                ctf_attempt_conflict: "اسی لمحے ایک اور جواب محفوظ ہوا۔ صفحہ تازہ کر کے دوبارہ کوشش کریں۔",
                ctf_not_configured: "جوابات کی جانچ ابھی دستیاب نہیں۔ اپنے استاد کو بتائیں۔",
                ctf_answer_key_mismatch: "جوابات کی کلید اپڈیٹ ہو رہی ہے۔ ایک منٹ بعد کوشش کریں۔",
                rate_limited: "بہت تیزی سے جوابات بھیجے گئے۔ تھوڑا انتظار کریں۔",
                idempotency_in_progress: "آپ کا پچھلا جواب ابھی جانچا جا رہا ہے۔ تھوڑا انتظار کریں۔",
                validation_failed: "اپنا جواب چیک کر کے دوبارہ کوشش کریں۔",
                fallback: "کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔",
            },
        },
    };

    const state = {
        lang: document.body && document.body.classList.contains("ur-mode") ? "ur" : "en",
        apiBase: "",
        csrf: "",
        exams: null,
        detail: null,
        slug: "",
        clockOffsetMs: 0,
        timer: null,
        refreshingAfterDeadline: false,
        busy: new Set(),
        pending: new Map(),
        feedback: new Map(),
        banner: null,
        loading: false,
    };

    const el = (id) => document.getElementById(id);

    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
    })[character]);

    const dict = () => STRINGS[state.lang] || STRINGS.en;

    const t = (key, vars = {}) => {
        const template = dict()[key] ?? STRINGS.en[key] ?? key;
        return String(template).replace(/\{(\w+)\}/g, (_match, name) => (name in vars ? String(vars[name]) : ""));
    };

    const errorText = (code) => dict().errors[code] || STRINGS.en.errors[code] || dict().errors.fallback;

    const localized = (value) => {
        if (!value || typeof value !== "object") return String(value || "");
        return value[state.lang] || value.en || "";
    };

    const formatMoment = (iso) => {
        if (!iso) return "";
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        try {
            return date.toLocaleString(state.lang === "ur" ? "ur-PK" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
        } catch {
            return date.toISOString();
        }
    };

    const newKey = () => {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };

    // ------------------------------------------------------------------
    // LMS API client
    // ------------------------------------------------------------------
    class ApiError extends Error {
        constructor(status, code, message) {
            super(message || code || "error");
            this.status = status;
            this.code = code;
        }
    }

    const loadConfig = async () => {
        if (state.apiBase) return;
        try {
            const response = await fetch("/api/config", { cache: "no-store" });
            const payload = await response.json();
            const base = String(payload.lmsApiBase || "");
            state.apiBase = /^https?:\/\//.test(base) ? base.replace(/\/+$/, "") : DEFAULT_API_BASE;
        } catch {
            state.apiBase = DEFAULT_API_BASE;
        }
    };

    const lmsOrigin = () => {
        try {
            return new URL(state.apiBase || DEFAULT_API_BASE).origin;
        } catch {
            return "https://alsyedinitiative.com";
        }
    };

    const csrfToken = async (force = false) => {
        if (state.csrf && !force) return state.csrf;
        const response = await fetch(`${state.apiBase}/auth/csrf/`, {
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        state.csrf = String(payload.csrf_token || "");
        return state.csrf;
    };

    const refreshSession = async () => {
        try {
            const response = await fetch(`${state.apiBase}/auth/refresh/`, {
                method: "POST",
                credentials: "include",
                cache: "no-store",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    "X-CSRFToken": await csrfToken(true),
                },
                body: "{}",
            });
            return response.ok;
        } catch {
            return false;
        }
    };

    const api = async (path, options = {}, retried = { auth: false, csrf: false }) => {
        await loadConfig();
        const method = options.method || "GET";
        const unsafe = method !== "GET";
        const headers = { Accept: "application/json" };
        let response;
        try {
            if (unsafe) {
                headers["Content-Type"] = "application/json";
                headers["X-CSRFToken"] = await csrfToken();
            }
            if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
            response = await fetch(`${state.apiBase}${path}`, {
                method,
                credentials: "include",
                cache: "no-store",
                headers,
                body: unsafe ? JSON.stringify(options.body || {}) : undefined,
            });
        } catch {
            throw new ApiError(0, "network", errorText("network"));
        }
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload.data;

        const errors = payload && typeof payload.errors === "object" && payload.errors ? payload.errors : {};
        const code = String(errors.code || payload.code || "");
        const detail = String(errors.detail || payload.message || "");
        if (response.status === 401 && !retried.auth) {
            if (await refreshSession()) return api(path, options, { ...retried, auth: true });
            throw new ApiError(401, "signed_out", t("signedOut"));
        }
        if (response.status === 401) throw new ApiError(401, "signed_out", t("signedOut"));
        if (response.status === 403 && /csrf/i.test(detail) && !retried.csrf) {
            state.csrf = "";
            return api(path, options, { ...retried, csrf: true });
        }
        if (response.status === 403 && (code === "terms_acceptance_required" || /terms/i.test(detail))) {
            throw new ApiError(403, "terms_acceptance_required", t("termsRequired"));
        }
        throw new ApiError(response.status, code, errorText(code));
    };

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------
    const setText = (id, text) => {
        const node = el(id);
        if (node) node.textContent = text;
    };

    const renderStatic = () => {
        setText("nav-exam-text", t("nav"));
        setText("exam-subheading-text", t("subheading"));
        setText("exam-heading-text", t("heading"));
        setText("exam-intro-text", t("intro"));
        setText("exam-stat-score-label", t("scoreLabel"));
        setText("exam-stat-solved-label", t("solvedLabel"));
        setText("exam-stat-time-label", t("timeLabel"));
    };

    const showBanner = (kind, message) => {
        state.banner = kind ? { kind, message } : null;
        renderBanner();
    };

    const renderBanner = () => {
        const banner = el("exam-banner");
        if (!banner) return;
        if (!state.banner) {
            banner.hidden = true;
            banner.innerHTML = "";
            return;
        }
        const { kind, message } = state.banner;
        let action = "";
        if (kind === "signed_out") {
            action = `<a class="btn btn-primary exam-link-btn" href="${esc(`${lmsOrigin()}/login`)}" target="_blank" rel="noopener">${esc(t("signInLink"))}</a>
                <button type="button" class="btn exam-secondary-btn" data-action="reload">${esc(t("retry"))}</button>`;
        } else if (kind === "terms") {
            action = `<a class="btn btn-primary exam-link-btn" href="${esc(lmsOrigin())}" target="_blank" rel="noopener">${esc(t("termsLink"))}</a>
                <button type="button" class="btn exam-secondary-btn" data-action="reload">${esc(t("retry"))}</button>`;
        } else if (kind === "error") {
            action = `<button type="button" class="btn exam-secondary-btn" data-action="reload">${esc(t("retry"))}</button>`;
        }
        banner.className = `exam-banner exam-banner-${kind}`;
        banner.innerHTML = `<p>${esc(message)}</p>${action ? `<div class="exam-banner-actions">${action}</div>` : ""}`;
        banner.hidden = false;
    };

    const windowLabel = (exam) => ({
        not_open: t("windowNotOpen"),
        open: t("windowOpen"),
        closed: t("windowClosed"),
    })[exam.window] || "";

    const statusLabel = (participation) => ({
        active: t("statusActive"),
        submitted: t("statusSubmitted"),
        expired: t("statusExpired"),
    })[participation && participation.status] || "";

    const renderList = () => {
        const list = el("exam-list");
        const view = el("exam-view");
        if (!list || !view) return;
        view.hidden = true;
        list.hidden = false;
        el("exam-stats").hidden = true;
        if (state.exams === null) {
            list.innerHTML = state.loading ? `<p class="exam-muted">${esc(t("loading"))}</p>` : "";
            return;
        }
        if (!state.exams.length) {
            list.innerHTML = `<div class="desc-card exam-empty"><p>${esc(t("empty"))}</p></div>`;
            return;
        }
        list.innerHTML = state.exams.map((exam) => {
            const participation = exam.participation;
            const limit = exam.time_limit_minutes ? `${exam.time_limit_minutes} ${t("minutes")}` : t("noTimeLimit");
            let label = t("open");
            if (participation && participation.status === "active") label = t("resume");
            else if (participation) label = t("viewResult");
            else if (exam.can_start) label = t("startExam");
            const result = participation
                ? `<div class="exam-card-result">${esc(t("yourScore"))}: <strong>${esc(participation.score)}</strong> / ${esc(exam.total_points)} ${esc(t("points"))} · ${esc(statusLabel(participation))}</div>`
                : "";
            const opens = exam.opens_at ? `<span>${esc(t("opens"))}: ${esc(formatMoment(exam.opens_at))}</span>` : "";
            const closes = exam.closes_at ? `<span>${esc(t("closes"))}: ${esc(formatMoment(exam.closes_at))}</span>` : "";
            return `
                <div class="question-card exam-card">
                    <div class="q-header">
                        <h4>${esc(localized(exam.title))}</h4>
                        <span class="q-badge exam-window exam-window-${esc(exam.window)}">${esc(windowLabel(exam))}</span>
                    </div>
                    <div class="exam-card-meta">
                        <span>${esc(exam.question_count)} ${esc(t("questions"))}</span>
                        <span>${esc(exam.total_points)} ${esc(t("points"))}</span>
                        <span>${esc(limit)}</span>
                        ${opens}
                        ${closes}
                    </div>
                    ${result}
                    <div class="answer-row">
                        <button type="button" class="btn btn-primary" data-action="open" data-slug="${esc(exam.slug)}">${esc(label)}</button>
                    </div>
                </div>`;
        }).join("");
    };

    const renderLines = (lines) => (Array.isArray(lines) ? lines : [lines])
        .filter(Boolean)
        .map((line) => `<p>${esc(line)}</p>`)
        .join("");

    const renderPrompt = (question) => {
        const prompt = (question.prompt && (question.prompt[state.lang] || question.prompt.en)) || {};
        const sections = [`<h5 class="question-title">${esc(localized(question.title))}</h5>`];
        if (prompt.briefing && prompt.briefing.length) {
            sections.push(`<div class="question-section"><span>${esc(t("sectionBriefing"))}</span>${renderLines(prompt.briefing)}</div>`);
        }
        if (prompt.artifact) {
            sections.push(`
                <div class="question-section question-info-card question-artifact">
                    <span>${esc(t("sectionArtifact"))}</span>
                    <p class="question-artifact-note">${esc(t("artifactNote"))}</p>
                    <div class="question-artifact-value"><code>${esc(prompt.artifact)}</code></div>
                </div>`);
        }
        if (prompt.search_patterns && prompt.search_patterns.length) {
            const patterns = prompt.search_patterns.map((pattern) => `<li><code>${esc(pattern)}</code></li>`).join("");
            sections.push(`<div class="question-section question-info-card"><span>${esc(t("sectionPatterns"))}</span><ul class="question-patterns">${patterns}</ul></div>`);
        }
        if (prompt.task) sections.push(`<div class="question-section"><span>${esc(t("sectionTask"))}</span>${renderLines(prompt.task)}</div>`);
        if (prompt.constraints) sections.push(`<div class="question-section"><span>${esc(t("sectionConstraints"))}</span>${renderLines(prompt.constraints)}</div>`);
        if (prompt.answer_format) sections.push(`<div class="question-section"><span>${esc(t("sectionFormat"))}</span>${renderLines(prompt.answer_format)}</div>`);
        return `<div class="question-longform">${sections.join("")}</div>`;
    };

    const renderMaterials = (question) => {
        const items = (question.materials || []).filter((item) => MATERIAL_PATH.test(String(item.url || "")) && !String(item.url).includes(".."));
        const images = items
            .filter((item) => item.kind === "image")
            .map((item) => `<figure class="question-evidence"><img src="${esc(item.url)}" alt="${esc(localized(item.alt) || localized(item.label))}" loading="lazy"><figcaption>${esc(localized(item.label))}</figcaption></figure>`)
            .join("");
        const files = items
            .filter((item) => item.kind !== "image")
            .map((item) => `<li><a href="${esc(item.url)}" download rel="noopener">${esc(localized(item.label))}</a></li>`)
            .join("");
        const fileList = files
            ? `<div class="question-section question-info-card"><span>${esc(t("sectionMaterials"))}</span><ul class="question-patterns exam-files">${files}</ul></div>`
            : "";
        return images + fileList;
    };

    const examIsLive = () => {
        const participation = state.detail && state.detail.participation;
        return Boolean(participation && participation.status === "active" && remainingSeconds() !== 0);
    };

    const renderQuestion = (question, index) => {
        const live = examIsLive();
        const exhausted = !question.solved && question.attempts_used >= question.max_attempts;
        const locked = question.solved || exhausted || !live;
        const badge = question.solved
            ? `<span class="q-badge score-badge exam-earned">${esc(question.points_awarded)} / ${esc(question.points)} ${esc(t("points"))}</span>`
            : `<span class="q-badge score-badge">${esc(question.points)} ${esc(t("points"))}</span>`;
        const difficulty = (dict().difficulty || {})[question.difficulty] || String(question.difficulty || "").toUpperCase();
        let buttonLabel = t("submit");
        if (question.solved) buttonLabel = t("solved");
        else if (locked) buttonLabel = t("locked");
        const feedback = state.feedback.get(question.key);
        return `
            <div class="question-card exam-question ${question.solved ? "solved" : ""} ${locked && !question.solved ? "exam-locked" : ""}" id="exam-q-${esc(question.key)}" data-key="${esc(question.key)}">
                <div class="q-header">
                    <h4>${esc(t("question"))} ${index + 1}</h4>
                    <div class="exam-badges">
                        ${badge}
                        <span class="q-badge">${esc(String(question.category || "").toUpperCase())} • ${esc(difficulty)}</span>
                    </div>
                </div>
                ${renderPrompt(question)}
                ${renderMaterials(question)}
                <div class="answer-row">
                    <input type="text" class="answer-input" maxlength="${MAX_ANSWER_LENGTH}" autocomplete="off" spellcheck="false"
                           data-key="${esc(question.key)}" placeholder="${esc(t("placeholder"))}" ${locked ? "disabled" : ""}>
                    <button type="button" class="btn ${question.solved ? "btn-success" : "btn-primary"}" data-action="answer" data-key="${esc(question.key)}" ${locked ? "disabled" : ""}>${esc(buttonLabel)}</button>
                </div>
                <div class="exam-attempts">${esc(t("attempts", { used: question.attempts_used, max: question.max_attempts }))}</div>
                <div class="feedback-text ${feedback ? esc(feedback.kind) : ""}" aria-live="polite">${feedback ? esc(feedback.text) : ""}</div>
            </div>`;
    };

    const renderExam = () => {
        const view = el("exam-view");
        const list = el("exam-list");
        if (!view || !list || !state.detail) return;
        // Keep whatever the student is typing across re-renders (language switch).
        const drafts = new Map();
        view.querySelectorAll(".answer-input").forEach((input) => drafts.set(input.dataset.key, input.value));

        const { exam, participation, questions } = state.detail;
        list.hidden = true;
        view.hidden = false;
        const parts = [`<button type="button" class="btn exam-secondary-btn exam-back" data-action="back">${state.lang === "ur" ? "→" : "←"} ${esc(t("back"))}</button>`];
        parts.push(`<div class="exam-title-row"><h3 class="exam-title">${esc(localized(exam.title))}</h3><span class="q-badge exam-window exam-window-${esc(exam.window)}">${esc(participation ? statusLabel(participation) : windowLabel(exam))}</span></div>`);

        const briefing = (exam.briefing && (exam.briefing[state.lang] || exam.briefing.en)) || [];
        const rules = (exam.rules && (exam.rules[state.lang] || exam.rules.en)) || [];
        if (briefing.length || rules.length) {
            parts.push(`<div class="desc-card exam-brief">
                ${briefing.length ? `<h3>${esc(t("briefing"))}</h3>${renderLines(briefing)}` : ""}
                ${rules.length ? `<div class="rules-box"><h4>${esc(t("rules"))}</h4><ul>${rules.map((rule) => `<li>${esc(rule)}</li>`).join("")}</ul></div>` : ""}
            </div>`);
        }

        if (!participation) {
            const canStart = exam.can_start;
            parts.push(`<div class="certification-lock-panel exam-start-panel">
                <h3>${esc(t("startTitle"))}</h3>
                <p>${esc(canStart ? t("startText") : (exam.window === "not_open" ? t("notOpenText") : errorText("ctf_exam_closed")))}</p>
                <p class="exam-muted">${esc(exam.question_count)} ${esc(t("questions"))} · ${esc(exam.total_points)} ${esc(t("points"))} · ${esc(exam.time_limit_minutes ? `${exam.time_limit_minutes} ${t("minutes")}` : t("noTimeLimit"))}</p>
                ${canStart ? `<div class="certification-unlock-row"><button type="button" class="btn btn-primary" data-action="start">${esc(t("startExam"))}</button></div>` : ""}
            </div>`);
        } else {
            if (!examIsLive()) {
                parts.push(`<div class="certification-lock-panel exam-over-panel"><h3>${esc(t("overTitle"))}</h3><p>${esc(t("overText", {
                    score: participation.score,
                    total: exam.total_points,
                    solved: participation.solved_count,
                }))}</p></div>`);
            }
            parts.push(`<div class="questions-container exam-questions">${questions.map(renderQuestion).join("")}</div>`);
            if (examIsLive()) {
                parts.push(`<div class="exam-finish-row"><button type="button" class="btn exam-secondary-btn" data-action="finish">${esc(t("finish"))}</button></div>`);
            }
        }
        view.innerHTML = parts.join("");
        view.querySelectorAll(".answer-input").forEach((input) => {
            if (drafts.has(input.dataset.key) && !input.disabled) input.value = drafts.get(input.dataset.key);
        });
        renderStats();
    };

    const remainingSeconds = () => {
        const participation = state.detail && state.detail.participation;
        if (!participation || !participation.deadline_at) return null;
        const deadline = Date.parse(participation.deadline_at);
        if (Number.isNaN(deadline)) return null;
        return Math.max(0, Math.floor((deadline - (Date.now() + state.clockOffsetMs)) / 1000));
    };

    const formatDuration = (seconds) => {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        const pad = (value) => String(value).padStart(2, "0");
        return hours ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
    };

    const renderStats = () => {
        const stats = el("exam-stats");
        const participation = state.detail && state.detail.participation;
        if (!stats) return;
        if (!participation) {
            stats.hidden = true;
            return;
        }
        stats.hidden = false;
        setText("exam-score", `${participation.score}`);
        setText("exam-solved", `${participation.solved_count}/${state.detail.questions.length}`);
        const timer = el("exam-timer");
        if (!timer) return;
        const remaining = remainingSeconds();
        if (participation.status !== "active") {
            timer.textContent = statusLabel(participation);
        } else {
            timer.textContent = remaining === null ? "∞" : formatDuration(remaining);
        }
        timer.classList.toggle("exam-timer-warning", remaining !== null && remaining <= WARNING_SECONDS && participation.status === "active");
    };

    const startClock = () => {
        if (state.timer) clearInterval(state.timer);
        state.timer = setInterval(() => {
            if (!state.detail || !state.detail.participation) return;
            renderStats();
            const remaining = remainingSeconds();
            if (remaining === 0 && state.detail.participation.status === "active" && !state.refreshingAfterDeadline) {
                state.refreshingAfterDeadline = true;
                loadExam(state.slug).finally(() => {
                    state.refreshingAfterDeadline = false;
                });
            }
        }, 1000);
    };

    const stopClock = () => {
        if (state.timer) clearInterval(state.timer);
        state.timer = null;
    };

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    const handleError = (error) => {
        if (error.code === "signed_out") {
            showBanner("signed_out", t("signedOut"));
        } else if (error.code === "terms_acceptance_required") {
            showBanner("terms", t("termsRequired"));
        } else {
            showBanner("error", error.message || errorText("fallback"));
        }
    };

    const loadExams = async () => {
        state.loading = true;
        state.detail = null;
        state.slug = "";
        stopClock();
        renderList();
        try {
            const data = await api("/ctf/exams/");
            state.exams = Array.isArray(data) ? data : (data && data.results) || [];
            showBanner(null);
        } catch (error) {
            state.exams = state.exams || [];
            handleError(error);
        } finally {
            state.loading = false;
            renderList();
        }
    };

    const loadExam = async (slug) => {
        try {
            const data = await api(`/ctf/exams/${encodeURIComponent(slug)}/`);
            const serverTime = Date.parse(data.server_time);
            state.clockOffsetMs = Number.isNaN(serverTime) ? 0 : serverTime - Date.now();
            state.detail = data;
            state.slug = slug;
            showBanner(null);
            renderExam();
            startClock();
        } catch (error) {
            handleError(error);
            if (error.status === 404) loadExams();
        }
    };

    const startExam = async () => {
        if (!state.detail || !window.confirm(t("confirmStart"))) return;
        try {
            await api(`/ctf/exams/${encodeURIComponent(state.slug)}/start/`, { method: "POST", body: {} });
        } catch (error) {
            handleError(error);
        }
        await loadExam(state.slug);
    };

    const finishExam = async () => {
        if (!state.detail || !window.confirm(t("confirmFinish"))) return;
        try {
            await api(`/ctf/exams/${encodeURIComponent(state.slug)}/submit/`, { method: "POST", body: {} });
        } catch (error) {
            handleError(error);
        }
        await loadExam(state.slug);
    };

    const setFeedback = (key, kind, text) => {
        state.feedback.set(key, { kind, text });
        const node = document.querySelector(`#exam-q-${CSS.escape(key)} .feedback-text`);
        if (node) {
            node.className = `feedback-text ${kind}`;
            node.textContent = text;
        }
    };

    const submitAnswer = async (key) => {
        if (!state.detail || state.busy.has(key)) return;
        const card = document.getElementById(`exam-q-${key}`);
        const input = card && card.querySelector(".answer-input");
        const button = card && card.querySelector('[data-action="answer"]');
        if (!input || !button || input.disabled) return;
        const answer = input.value;
        if (!answer.trim()) return;
        if (answer.length > MAX_ANSWER_LENGTH) {
            setFeedback(key, "error", t("tooLong"));
            return;
        }
        // Retrying the same text after a network failure reuses its key, so the
        // server records it at most once.
        let pending = state.pending.get(key);
        if (!pending || pending.answer !== answer) {
            pending = { answer, id: newKey() };
            state.pending.set(key, pending);
        }
        state.busy.add(key);
        button.disabled = true;
        input.disabled = true;
        button.textContent = t("checking");
        try {
            const data = await api(
                `/ctf/exams/${encodeURIComponent(state.slug)}/questions/${encodeURIComponent(key)}/attempts/`,
                { method: "POST", body: { answer }, idempotencyKey: pending.id },
            );
            state.pending.delete(key);
            const question = state.detail.questions.find((item) => item.key === key);
            if (question) {
                question.attempts_used = data.attempt.attempt_number;
                if (data.attempt.correct) {
                    question.solved = true;
                    question.points_awarded = data.attempt.points_awarded;
                }
            }
            state.detail.participation = data.participation;
            if (data.attempt.correct) {
                state.feedback.set(key, { kind: "success", text: t("correct", { points: data.attempt.points_awarded }) });
            } else if (data.attempt.attempts_remaining > 0) {
                state.feedback.set(key, { kind: "error", text: t("incorrect", { left: data.attempt.attempts_remaining }) });
            } else {
                state.feedback.set(key, { kind: "error", text: t("incorrectLast") });
            }
            renderExam();
            const nextInput = document.querySelector(`#exam-q-${CSS.escape(key)} .answer-input`);
            if (nextInput && !nextInput.disabled) {
                nextInput.value = answer;
                nextInput.focus();
                nextInput.select();
            }
        } catch (error) {
            const definitive = error.status >= 400 && error.status < 500 && error.code !== "idempotency_in_progress";
            if (definitive) state.pending.delete(key);
            if (error.code === "signed_out" || error.code === "terms_acceptance_required") {
                handleError(error);
            }
            setFeedback(key, "error", `[-] ${error.message || errorText("fallback")}`);
            if (["ctf_question_already_solved", "ctf_attempts_exhausted", "ctf_exam_time_over", "ctf_exam_closed", "ctf_participation_submitted", "ctf_question_not_found"].includes(error.code)) {
                await loadExam(state.slug);
                return;
            }
            const freshButton = document.querySelector(`#exam-q-${CSS.escape(key)} [data-action="answer"]`);
            const freshInput = document.querySelector(`#exam-q-${CSS.escape(key)} .answer-input`);
            if (freshButton && freshInput && examIsLive()) {
                freshButton.disabled = false;
                freshInput.disabled = false;
                freshButton.textContent = t("submit");
            }
        } finally {
            state.busy.delete(key);
        }
    };

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------
    const onClick = (event) => {
        const target = event.target.closest("[data-action]");
        if (!target) return;
        const action = target.dataset.action;
        if (action === "open") loadExam(target.dataset.slug);
        else if (action === "back") loadExams();
        else if (action === "start") startExam();
        else if (action === "finish") finishExam();
        else if (action === "answer") submitAnswer(target.dataset.key);
        else if (action === "reload") (state.slug ? loadExam(state.slug) : loadExams());
    };

    const onKeydown = (event) => {
        if (event.key !== "Enter" || !event.target.classList.contains("answer-input")) return;
        event.preventDefault();
        submitAnswer(event.target.dataset.key);
    };

    let activated = false;
    const activate = () => {
        if (activated) return;
        activated = true;
        loadExams();
    };

    const init = () => {
        const section = el("tab-exam");
        if (!section) return;
        state.lang = document.body.classList.contains("ur-mode") ? "ur" : "en";
        renderStatic();
        section.addEventListener("click", onClick);
        section.addEventListener("keydown", onKeydown);

        const navButton = el("nav-exam-btn");
        if (navButton) {
            navButton.addEventListener("click", () => {
                activate();
                if (window.location.hash !== "#exam") window.history.replaceState(null, "", "#exam");
            });
        }
        document.querySelectorAll('.nav-btn:not([data-tab="exam"])').forEach((button) => {
            button.addEventListener("click", () => {
                if (window.location.hash === "#exam") window.history.replaceState(null, "", window.location.pathname);
            });
        });

        window.addEventListener("labs:langchange", (event) => {
            const next = event.detail && event.detail.lang;
            state.lang = next === "ur" ? "ur" : "en";
            renderStatic();
            renderBanner();
            if (state.detail) renderExam();
            else renderList();
        });

        if (window.location.hash === "#exam" && navButton) navButton.click();
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
