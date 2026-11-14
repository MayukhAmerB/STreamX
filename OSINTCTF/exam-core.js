// AL SYED LABS - Examination tab: pure rules shared by exam.js and its tests.
//
// No DOM access here. In the browser this file defines window.LabsExamCore
// (loaded before exam.js); under Node (node --test) it is a CommonJS module.
(function (root, factory) {
    "use strict";
    const core = factory();
    if (typeof module === "object" && module && module.exports) {
        module.exports = core;
    } else {
        root.LabsExamCore = core;
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // Evidence still shipped inside the labs image (older exams).
    const LABS_MATERIAL_PATH = /^\/materials\/[A-Za-z0-9_\-./]+$/;
    // Evidence uploaded to the LMS: a short-lived signed URL on the LMS origin.
    const SIGNED_MATERIAL_PATH = /^\/api\/ctf\/materials\/[A-Za-z0-9_\-:.]+\/$/;

    const ELIGIBILITY_REASONS = ["ok", "no_batch", "access_expired", "not_assigned"];
    const START_REASONS = ["ok", "started", "completed", "not_open", "closed", "no_questions", "not_configured"];

    const originOf = (value) => {
        try {
            return new URL(String(value)).origin;
        } catch {
            return "";
        }
    };

    /** Only labs-relative evidence paths or signed LMS evidence URLs are rendered. */
    const materialUrlAllowed = (url, lmsOrigin) => {
        const value = String(url || "");
        if (!value || value.includes("..") || /[\s"'<>\\]/.test(value)) return false;
        if (value.startsWith("/")) return LABS_MATERIAL_PATH.test(value);
        let parsed;
        try {
            parsed = new URL(value);
        } catch {
            return false;
        }
        const expected = originOf(lmsOrigin);
        return Boolean(expected)
            && parsed.origin === expected
            && (parsed.protocol === "https:" || parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
            && !parsed.search
            && !parsed.hash
            && !parsed.username
            && SIGNED_MATERIAL_PATH.test(parsed.pathname);
    };

    /** Where "Sign in" (and "Accept the terms") sends the student: the LMS
     *  login page, which returns to this tab once the account can sit exams
     *  (it holds the return until the current Terms are accepted). */
    const returnUrl = (labsLocation) => {
        const origin = String((labsLocation && labsLocation.origin) || "");
        const path = String((labsLocation && labsLocation.pathname) || "/");
        return `${origin}${path}#exam`;
    };

    const signInUrl = (labsLocation, lmsOrigin) => `${lmsOrigin}/login?next=${encodeURIComponent(returnUrl(labsLocation))}`;

    const termsUrl = signInUrl;

    /**
     * How the Examination tab looks for an eligibility answer
     * (GET /api/ctf/eligibility/): the tab is always clickable, so the student
     * can read why it is locked, but it is marked locked and Start is never offered.
     */
    const eligibilityView = (eligibility) => {
        if (!eligibility || typeof eligibility !== "object") {
            return { locked: false, reason: "ok", action: null, nextExam: null };
        }
        const reason = ELIGIBILITY_REASONS.includes(eligibility.reason) ? eligibility.reason : "not_assigned";
        const locked = !eligibility.enabled;
        const action = eligibility.action && /^https?:\/\//.test(String(eligibility.action.url || ""))
            ? { label: String(eligibility.action.label || ""), url: String(eligibility.action.url) }
            : null;
        return {
            locked,
            reason: locked ? reason : "ok",
            action: locked ? action : null,
            nextExam: eligibility.next_exam || null,
            message: String(eligibility.message || ""),
        };
    };

    /** Start button state for one exam summary (from /api/ctf/exams/). */
    const startView = (exam) => {
        if (!exam) return { enabled: false, reason: "not_open" };
        const reason = START_REASONS.includes(exam.start_reason) ? exam.start_reason : (exam.can_start ? "ok" : "not_open");
        return { enabled: Boolean(exam.can_start) && reason === "ok", reason };
    };

    /** Classify an API failure the way the tab reacts to it. */
    const classifyFailure = (status, code, detail) => {
        const text = String(detail || "");
        if (status === 0) return "network";
        if (status === 401) return "signed_out";
        if (status === 403 && /csrf/i.test(text)) return "csrf";
        if (status === 403 && (code === "terms_acceptance_required" || /terms/i.test(text))) return "terms";
        return String(code || "fallback");
    };

    return {
        LABS_MATERIAL_PATH,
        SIGNED_MATERIAL_PATH,
        ELIGIBILITY_REASONS,
        START_REASONS,
        classifyFailure,
        eligibilityView,
        materialUrlAllowed,
        returnUrl,
        signInUrl,
        startView,
        termsUrl,
    };
});
