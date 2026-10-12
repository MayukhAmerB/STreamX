import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import apiClient from "../api/client";
import PaymentPlanPicker, { availablePaymentPlans } from "../components/PaymentPlanPicker";
import "../components/PaymentPlanPicker.css";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { getCourse } from "../api/courses";
import { createPaymentOrder, verifyPayment } from "../api/payments";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { formatINR } from "../utils/currency";
import { siteBrand } from "../config/siteBrand";
import {
  clearCheckoutRecovery,
  loadCheckoutRecovery,
  loadCourseApplicationReference,
  saveCheckoutRecovery,
  saveCourseApplicationReference,
} from "../utils/paymentRecovery";

const pageBackgroundImage = "";

export const checkoutSteps = [
  { id: "plan", label: "Payment plan" },
  { id: "identity", label: "Your name", summaryKey: "buyer_name" },
  { id: "email", label: "Email", summaryKey: "buyer_email" },
  { id: "contact", label: "WhatsApp", summaryKey: "whatsapp_number" },
];

const inputClassName =
  "mt-4 min-h-14 w-full rounded-xl border border-white/15 bg-black/65 px-4 py-3 text-base text-white outline-none transition placeholder:text-[#606060] focus:border-white/50 focus:bg-black";

function ArrowIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-6 w-6">
      <rect x="3.5" y="5.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 3.5v4M17 3.5v4M3.5 10h17M8 14h2M14 14h2M8 17h2M14 17h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-5 w-5">
      <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="m9.5 12 1.7 1.7 3.5-3.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SuccessIcon() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true" className="h-20 w-20 sm:h-24 sm:w-24">
      <circle cx="32" cy="32" r="30" stroke="currentColor" strokeWidth="1.2" opacity="0.24" />
      <circle cx="32" cy="32" r="23" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
      <path
        d="m20 32 8 8 17-18"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-6 w-6">
      <path d="M6 3h12v18l-2-1.2L14 21l-2-1.2L10 21l-2-1.2L6 21V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-6 w-6">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-7 w-7">
      <path
        d="M20 11.6a8 8 0 0 1-11.7 7.1L4 20l1.3-4.1A8 8 0 1 1 20 11.6Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9 8.2c.3-.5.6-.5.9-.5h.3c.2 0 .4.1.5.4l.8 1.8c.1.3.1.5-.1.7l-.6.8c-.2.2-.1.4 0 .6.6 1 1.4 1.8 2.4 2.4.2.1.4.2.6 0l.8-1c.2-.2.4-.3.7-.2l1.8.9c.3.1.4.3.4.5 0 .3-.1 1.3-.7 1.8-.5.5-1.3.8-2.1.6-1.1-.2-2.7-.8-4.4-2.3-1.4-1.3-2.4-2.8-2.7-4-.3-.9.1-1.8.4-2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}


function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const timeout = window.setTimeout(
      () => reject(new Error("Razorpay checkout took too long to load.")),
      12000,
    );
    const resolveLoaded = () => {
      window.clearTimeout(timeout);
      if (window.Razorpay) resolve(true);
      else reject(new Error("Razorpay checkout is unavailable."));
    };
    const rejectLoad = () => {
      window.clearTimeout(timeout);
      reject(new Error("Failed to load Razorpay checkout SDK."));
    };
    const existing = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener("load", resolveLoaded, { once: true });
      existing.addEventListener("error", rejectLoad, { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = resolveLoaded;
    script.onerror = rejectLoad;
    document.body.appendChild(script);
  });
}

export function createCheckoutIdempotencyKey() {
  const randomPart = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `checkout-${randomPart}`;
}

export function hasPermanentCourseAccess(course) {
  return Boolean(
    course?.is_enrolled && course?.enrollment_access_type !== "installment"
  );
}

export function shouldRotateCheckoutIntentAfterError(error) {
  return Number(error?.response?.status) === 503
    && error?.response?.data?.data?.rotate_checkout_key === true;
}

function paymentRecoveryStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function isValidPhone(value) {
  const text = value.trim();
  const digitCount = text.replace(/\D/g, "").length;
  return /^\+?[0-9][0-9 ()-]{7,22}$/.test(text) && digitCount >= 8 && digitCount <= 15;
}

function isValidEmail(value) {
  const text = value.trim();
  return (
    text.length <= 254 &&
    !containsUnsafeText(text) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
  );
}

function containsUnsafeText(value) {
  const text = String(value || "");
  const hasControlCharacter = Array.from(text).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
  return (
    hasControlCharacter ||
    /[<>]/.test(text) ||
    /(?:javascript\s*:|data\s*:\s*text\/html|\bon\w+\s*=)/i.test(text) ||
    /\b(?:union\s+(?:all\s+)?select|drop\s+table|alter\s+table|truncate\s+table|information_schema|pg_catalog|sleep\s*\(|benchmark\s*\(|pg_sleep\s*\()\b/i.test(
      text
    )
  );
}

function isValidFullName(value) {
  const text = value.normalize("NFKC").trim();
  const letterCount = (text.match(/\p{L}/gu) || []).length;
  return (
    text.length >= 2 &&
    text.length <= 120 &&
    letterCount >= 2 &&
    !containsUnsafeText(text) &&
    /^[\p{L}\p{M} .'\u2019-]+$/u.test(text)
  );
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function stepSummary(step, profile, plan, course) {
  if (step.id === "plan") {
    return plan === "bundle" ? `Bundle - ${formatINR(course?.bundle_price)}` : plan === "monthly"
      ? `Monthly - ${formatINR(course?.monthly_price)}`
      : `One-time - ${formatINR(course?.price)}`;
  }
  if (step.id === "contact" && profile.alternate_number) {
    return `${profile.whatsapp_number} - Alternate added`;
  }
  return profile[step.summaryKey] || "Not completed";
}

export default function CoursePaymentPage() {
  const { id } = useParams();
  const location = useLocation();
  const [initialCheckoutRecovery] = useState(() => loadCheckoutRecovery(
    paymentRecoveryStorage(),
    Number(id),
  ));
  const [applicationReady, setApplicationReady] = useState(false);
  const [applicationReference] = useState(() => {
    try {
      return location.state?.applicationReference
        || loadCourseApplicationReference(paymentRecoveryStorage(), Number(id))
        || initialCheckoutRecovery?.applicationReference
        || sessionStorage.getItem(`pentesting-application:${id}`)
        || "";
    } catch {
      return location.state?.applicationReference
        || loadCourseApplicationReference(paymentRecoveryStorage(), Number(id))
        || initialCheckoutRecovery?.applicationReference
        || "";
    }
  });
  const { user } = useAuth();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [currentStep, setCurrentStep] = useState(
    initialCheckoutRecovery?.pendingVerification ? checkoutSteps.length - 1 : 0,
  );
  const [plan, setPlan] = useState(initialCheckoutRecovery?.plan || "full");
  const [paymentResult, setPaymentResult] = useState(null);
  const [pendingVerification, setPendingVerification] = useState(
    initialCheckoutRecovery?.pendingVerification || null,
  );
  const checkoutIntentKey = useRef(
    initialCheckoutRecovery?.idempotencyKey || createCheckoutIdempotencyKey(),
  );
  const [checkoutProfile, setCheckoutProfile] = useState({
    buyer_name: location.state?.applicant?.buyer_name || user?.full_name || "",
    buyer_email: location.state?.applicant?.buyer_email || user?.email || "",
    whatsapp_number: location.state?.applicant?.whatsapp_number || user?.phone_number || "",
    alternate_number: "",
  });

  useEffect(() => {
    setCheckoutProfile((current) => ({
      ...current,
      buyer_name: current.buyer_name || user?.full_name || "",
      buyer_email: current.buyer_email || user?.email || "",
      whatsapp_number: current.whatsapp_number || user?.phone_number || "",
    }));
  }, [user?.email, user?.full_name, user?.phone_number]);

  useEffect(() => {
    if (applicationReference) {
      saveCourseApplicationReference(
        paymentRecoveryStorage(),
        Number(id),
        applicationReference,
      );
    }
  }, [applicationReference, id]);

  useEffect(() => {
    if (paymentResult) return;
    saveCheckoutRecovery(paymentRecoveryStorage(), Number(id), {
      idempotencyKey: checkoutIntentKey.current,
      pendingVerification,
      plan,
      applicationReference,
    });
  }, [applicationReference, id, paymentResult, pendingVerification, plan]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getCourse(id);
        if (!active) return;
        const loadedCourse = apiData(response);
        setCourse(loadedCourse);
        if (loadedCourse?.category === "web_pentesting") {
          await apiClient.post(`/courses/${id}/application-checkout/`, { reference: applicationReference });
          if (!active) return;
        }
        setApplicationReady(true);
        const available = availablePaymentPlans(loadedCourse);
        if (!initialCheckoutRecovery?.plan) {
          setPlan(available.find((item) => item.id === "full")?.id || available[0]?.id || "full");
        }
      } catch (err) {
        if (active) setError(apiMessage(err, "Failed to load payment details."));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [id, applicationReference, initialCheckoutRecovery?.plan]);

  const launchStatus = useMemo(() => getCourseLaunchStatus(course), [course]);
  const activeStep = checkoutSteps[currentStep];
  const hasPermanentAccess = hasPermanentCourseAccess(course);

  const handleProfileChange = (event) => {
    const { name, value } = event.target;
    setCheckoutProfile((current) => ({ ...current, [name]: value }));
    setError("");
  };

  const validateStep = (stepId) => {
    if (stepId === "identity" && !isValidFullName(checkoutProfile.buyer_name)) {
      return "Enter a valid full name using letters, spaces, apostrophes, periods, or hyphens.";
    }
    if (stepId === "email" && !isValidEmail(checkoutProfile.buyer_email)) {
      return "Enter a valid email address.";
    }
    if (stepId === "contact") {
      if (!isValidPhone(checkoutProfile.whatsapp_number)) {
        return "Enter a valid WhatsApp number with country code.";
      }
      if (
        checkoutProfile.alternate_number.trim() &&
        !isValidPhone(checkoutProfile.alternate_number)
      ) {
        return "Enter a valid alternate WhatsApp number or leave it blank.";
      }
      if (
        checkoutProfile.alternate_number.trim() &&
        phoneDigits(checkoutProfile.alternate_number) ===
          phoneDigits(checkoutProfile.whatsapp_number)
      ) {
        return "Alternate WhatsApp number must be different from your primary number.";
      }
    }
    if (
      stepId === "plan" &&
      !availablePaymentPlans(course || {}).some((item) => item.id === plan)
    ) {
      return "Choose an available payment plan.";
    }
    return "";
  };

  const moveForward = (event) => {
    event.preventDefault();
    const validationError = validateStep(activeStep.id);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    setCurrentStep((step) => Math.min(step + 1, checkoutSteps.length - 1));
  };

  const continueWithPlan = (selectedPlan) => {
    if (!course?.purchase_available) return;
    setPlan(selectedPlan);
    setError("");
    setCurrentStep(1);
  };

  const confirmCapturedPayment = async (verificationPayload) => {
    if (!verificationPayload) return;
    setPaying(true);
    setError("");
    try {
      const verifyResponse = await verifyPayment(verificationPayload);
      clearCheckoutRecovery(paymentRecoveryStorage(), Number(id));
      setPendingVerification(null);
      setPaymentResult(apiData(verifyResponse));
    } catch (verifyError) {
      const verificationMessage = apiMessage(verifyError, "Payment verification is still pending.");
      setError(`${verificationMessage} Retry verification below; do not make another payment.`);
    } finally {
      setPaying(false);
    }
  };

  const handlePayNow = async (event) => {
    event.preventDefault();
    if (pendingVerification) {
      await confirmCapturedPayment(pendingVerification);
      return;
    }
    for (const [index, step] of checkoutSteps.entries()) {
      const validationError = validateStep(step.id);
      if (validationError) {
        setError(validationError);
        setCurrentStep(index);
        return;
      }
    }
    if (
      !course ||
      launchStatus.isComingSoon ||
      hasPermanentAccess ||
      !course.purchase_available
    ) {
      return;
    }

    setPaying(true);
    setError("");
    try {
      await loadRazorpayScript();
      const orderResponse = await createPaymentOrder(
        {
          course_id: Number(id),
          ...(course.category === "web_pentesting" ? { application_reference: applicationReference } : {}),
          plan,
          buyer_name: checkoutProfile.buyer_name.trim(),
          buyer_email: checkoutProfile.buyer_email.trim(),
          whatsapp_number: checkoutProfile.whatsapp_number.trim(),
          alternate_number: checkoutProfile.alternate_number.trim(),
        },
        checkoutIntentKey.current,
      );
      const orderData = apiData(orderResponse);

      if (orderData?.already_enrolled) {
        setError("This account already has active access to the course.");
        setPaying(false);
        return;
      }

      if (orderData?.payment_verified) {
        clearCheckoutRecovery(paymentRecoveryStorage(), Number(id));
        setPendingVerification(null);
        setPaymentResult(orderData);
        setPaying(false);
        return;
      }

      const razorpayKey = orderData?.key_id || import.meta.env.VITE_RAZORPAY_KEY_ID;
      if (!razorpayKey) {
        throw new Error("Razorpay is not configured for this environment.");
      }
      const checkoutPlan = orderData?.plan || plan;
      const selectedPlan = availablePaymentPlans(course).find((item) => item.id === checkoutPlan);
      const recognizedCheckoutPlan = ["full", "monthly", "bundle"].includes(checkoutPlan);
      const validServerAmount = Number.isSafeInteger(Number(orderData?.amount))
        && Number(orderData.amount) > 0
        && orderData?.currency === "INR";
      if (
        !recognizedCheckoutPlan
        || !validServerAmount
        || (
          !orderData?.resumed
          && (!selectedPlan || Number(orderData.amount) !== Math.round(selectedPlan.amount * 100))
        )
      ) {
        throw new Error("Course pricing changed before checkout. Refresh the page and confirm the current plan price.");
      }
      if (checkoutPlan !== plan) setPlan(checkoutPlan);

      const checkout = new window.Razorpay({
        key: razorpayKey,
        amount: orderData.amount,
        currency: orderData.currency,
        order_id: orderData.razorpay_order_id,
        name: siteBrand.name,
        description:
          checkoutPlan === "bundle" ? "Three-month course bundle" : checkoutPlan === "monthly"
            ? "Monthly course installment"
            : "One-time course payment",
        theme: { color: "#111111" },
        prefill: {
          name: orderData?.checkout_profile?.name || checkoutProfile.buyer_name,
          email: orderData?.checkout_profile?.email || checkoutProfile.buyer_email,
          contact: orderData?.checkout_profile?.contact || checkoutProfile.whatsapp_number,
        },
        notes: {
          course_id: String(course.id),
          course_title: course.title,
          access_plan: checkoutPlan,
        },
        handler: async (response) => {
          const verificationPayload = {
            course_id: Number(id),
            checkout_reference: orderData.checkout_reference,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          };
          saveCheckoutRecovery(paymentRecoveryStorage(), Number(id), {
            idempotencyKey: checkoutIntentKey.current,
            pendingVerification: verificationPayload,
            plan: checkoutPlan,
            applicationReference,
          });
          setPendingVerification(verificationPayload);
          await confirmCapturedPayment(verificationPayload);
        },
        modal: {
          ondismiss: () => setPaying(false),
        },
      });
      checkout.on?.("payment.failed", () => {
        setError("Payment was not completed. No enrollment has been created; review the details and try again.");
        setPaying(false);
      });
      checkout.open();
    } catch (err) {
      if (shouldRotateCheckoutIntentAfterError(err)) {
        checkoutIntentKey.current = createCheckoutIdempotencyKey();
        saveCheckoutRecovery(paymentRecoveryStorage(), Number(id), {
          idempotencyKey: checkoutIntentKey.current,
          pendingVerification: null,
          plan,
          applicationReference,
        });
      }
      setError(apiMessage(err, "Unable to start payment."));
      setPaying(false);
    }
  };

  if (loading) {
    return <PageShell title="Secure checkout">Loading checkout...</PageShell>;
  }

  if (!course) {
    return (
      <PageShell title="Secure checkout">
        <p className="text-sm text-red-400">{error || "Course not found."}</p>
      </PageShell>
    );
  }

  if (course.category === "web_pentesting" && !applicationReady) {
    return <PageShell title="Complete your registration"><p role="alert">{error || "Submit your Pentesting application before viewing the fee and payment plans."}</p><Link to={`/courses/${id}/register`}>Register now ?</Link></PageShell>;
  }

  if (hasPermanentAccess) {
    return (
      <PageShell title="You already have access" subtitle={course.title}>
        <div className="max-w-2xl rounded-2xl border border-white/15 bg-white/[0.04] p-6 sm:p-8">
          <p className="text-sm leading-7 text-[#B8C0CC]">
            This account is already enrolled, so another payment has not been started.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link to={`/learn/${course.id}`}>
              <Button type="button">Continue learning</Button>
            </Link>
            <Link to={`/courses/${course.id}`}>
              <Button type="button" variant="secondary">View course details</Button>
            </Link>
          </div>
        </div>
      </PageShell>
    );
  }

  if (paymentResult) {
    const transactionId =
      paymentResult.transaction_id || paymentResult.invoice_number || "Recorded";
    const selectedPlan =
      paymentResult.plan_label ||
      (plan === "monthly"
        ? "Plan 1 - Monthly Payment"
        : plan === "bundle"
          ? "Plan 3 - Three-Month Bundle"
          : "Plan 2 - One-Time Payment");
    const accessDuration =
      paymentResult.access_duration ||
      (plan === "monthly"
        ? `${course.installment_access_days || 30} days`
        : plan === "bundle"
          ? `${course.bundle_access_days || 90} days`
          : "Lifetime course access");

    return (
      <PageShell
        title=""
        subtitle=""
        containerClassName="max-w-[1040px] py-4 sm:py-8"
      >
        <div className="mx-auto max-w-[900px]">
          <section className="relative overflow-hidden rounded-[30px] border border-white/20 bg-[#080808] px-5 py-9 shadow-[0_26px_80px_rgba(0,0,0,0.55)] sm:px-12 sm:py-12">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_14%,rgba(255,255,255,0.055),transparent_34%)]" />

            <div className="relative text-center">
              <div className="mx-auto flex max-w-[700px] items-center gap-4 sm:gap-7">
                <span className="h-px flex-1 bg-[linear-gradient(to_right,transparent,rgba(255,255,255,0.2))]" />
                <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full border border-white/20 text-white shadow-[0_0_32px_rgba(255,255,255,0.05)] sm:h-36 sm:w-36">
                  <SuccessIcon />
                </div>
                <span className="h-px flex-1 bg-[linear-gradient(to_left,transparent,rgba(255,255,255,0.2))]" />
              </div>
              <p className="mt-7 text-[11px] font-semibold uppercase tracking-[0.28em] text-[#BEBEBE] sm:text-sm">
                Payment successful
              </p>
              <h1 className="mt-3 font-reference text-4xl font-semibold tracking-[-0.035em] text-white sm:text-6xl">
                Payment Successful!
              </h1>
              <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-[#B8B8B8] sm:text-lg sm:leading-8">
                Your payment has been received and verified securely. Thank you for
                enrolling with us.
              </p>
            </div>

            <dl className="relative mt-8 overflow-hidden rounded-2xl border border-white/15 bg-black/45 px-4 sm:mt-10 sm:px-7">
              <div className="grid grid-cols-[40px_1fr] items-center gap-3 border-b border-white/10 py-5 sm:grid-cols-[48px_1fr_auto]">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 text-white sm:h-11 sm:w-11">
                  <ReceiptIcon />
                </span>
                <dt className="text-sm text-[#D0D0D0] sm:text-base">Transaction ID</dt>
                <dd className="col-span-2 break-all pl-[52px] text-right text-sm font-semibold text-white sm:col-span-1 sm:pl-0 sm:text-base">
                  {transactionId}
                </dd>
              </div>
              <div className="grid grid-cols-[40px_1fr] items-center gap-3 border-b border-white/10 py-5 sm:grid-cols-[48px_1fr_auto]">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 text-white sm:h-11 sm:w-11">
                  <CalendarIcon />
                </span>
                <dt className="text-sm text-[#D0D0D0] sm:text-base">Plan Selected</dt>
                <dd className="col-span-2 pl-[52px] text-right text-sm font-semibold text-white sm:col-span-1 sm:pl-0 sm:text-base">
                  {selectedPlan}
                </dd>
              </div>
              <div className="grid grid-cols-[40px_1fr] items-center gap-3 py-5 sm:grid-cols-[48px_1fr_auto]">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/15 text-white sm:h-11 sm:w-11">
                  <ClockIcon />
                </span>
                <dt className="text-sm text-[#D0D0D0] sm:text-base">Access Duration</dt>
                <dd className="col-span-2 pl-[52px] text-right text-sm font-semibold text-white sm:col-span-1 sm:pl-0 sm:text-base">
                  {accessDuration}
                </dd>
              </div>
            </dl>

            <div className="relative mt-7 rounded-2xl border border-white/15 bg-black/45 p-5 sm:p-7">
              <div className="grid gap-5 sm:grid-cols-[120px_1fr] sm:items-center">
                <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-white/15 text-white sm:mx-0">
                  <WhatsAppIcon />
                </div>
                <div className="border-white/20 text-center sm:border-l sm:pl-7 sm:text-left">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#A0A0A0]">
                    Next step
                  </p>
                  <h2 className="mt-2 font-reference text-2xl font-medium text-white sm:text-3xl">
                    Talk to our team for the remaining enrollment process.
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-[#9C9C9C]">
                    Our team will guide you through verification and credential delivery.
                  </p>
                </div>
              </div>

              {paymentResult.support_whatsapp_url ? (
                <a
                  href={paymentResult.support_whatsapp_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-6 flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border border-white/70 bg-transparent px-5 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white hover:text-black sm:text-sm"
                >
                  <WhatsAppIcon />
                  Message us on WhatsApp
                  <ArrowIcon />
                </a>
              ) : (
                <Link
                  to="/courses"
                  className="mt-6 flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border border-white/70 px-5 text-xs font-semibold uppercase tracking-[0.12em] text-white transition hover:bg-white hover:text-black sm:text-sm"
                >
                  Return to courses
                  <ArrowIcon />
                </Link>
              )}
            </div>

            <div className="relative mt-7 flex items-start justify-center gap-3 text-left text-xs leading-5 text-[#888] sm:text-sm">
              <span className="mt-0.5 shrink-0">
                <ShieldIcon />
              </span>
              <p>
                Your payment and enrollment information are stored securely. Sensitive
                gateway details are never exposed on this page.
              </p>
            </div>
          </section>

          <div className="mt-6 flex items-center justify-center gap-2 text-xs text-[#777] sm:text-sm">
            <ShieldIcon />
            <span>Secure Enrollment</span>
            <span aria-hidden="true">-</span>
            <span>Verified Payment</span>
          </div>
        </div>
      </PageShell>
    );
  }

  const isFinalStep = currentStep === checkoutSteps.length - 1;
  const isPlanStep = activeStep.id === "plan";

  return (
    <PageShell
      title={isPlanStep ? "" : "Course checkout"}
      subtitle={isPlanStep ? "" : "Confirm your details, then continue to the secure Razorpay checkout"}
      containerClassName={isPlanStep ? "max-w-[1180px] py-4 sm:py-8" : ""}
    >
      <section className="relative overflow-hidden rounded-[28px] border border-white/10 bg-[#080808] shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={course.thumbnail || pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.08]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/95 via-black/90 to-[#111111]/95" />
        </div>

        <div className={`relative min-h-[610px] ${isPlanStep ? "" : "grid lg:grid-cols-[310px_1fr]"}`}>
          {!isPlanStep ? (
          <aside className="border-b border-white/10 bg-white/[0.025] p-5 lg:border-b-0 lg:border-r lg:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#888]">
              Secure enrollment
            </p>
            <h2 className="mt-3 font-reference text-xl font-semibold text-white">
              {course.title}
            </h2>

            <ol className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-1">
              {checkoutSteps.map((step, index) => {
                const complete = index < currentStep;
                const active = index === currentStep;
                const canNavigate = index <= currentStep && !pendingVerification;
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      disabled={!canNavigate}
                      onClick={() => {
                        if (canNavigate) {
                          setCurrentStep(index);
                          setError("");
                        }
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        active
                          ? "border-white/45 bg-white/[0.1]"
                          : "border-white/[0.07] bg-black/30"
                      } ${canNavigate ? "cursor-pointer" : "cursor-default"}`}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                            complete
                              ? "bg-white text-black"
                              : active
                                ? "border border-white text-white"
                                : "border border-white/15 text-[#666]"
                          }`}
                        >
                          {complete ? "OK" : index + 1}
                        </span>
                        <span className="text-xs font-semibold text-white">{step.label}</span>
                      </span>
                      <span className="mt-2 hidden truncate pl-8 text-[11px] text-[#777] lg:block">
                        {stepSummary(step, checkoutProfile, plan, course)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>

            <div className="mt-6 hidden rounded-xl border border-white/[0.08] bg-black/40 p-4 lg:block">
              <p className="text-[10px] uppercase tracking-[0.16em] text-[#777]">
                Payment security
              </p>
              <p className="mt-2 text-xs leading-5 text-[#999]">
                The amount is calculated by our server. Card and UPI details are handled only by
                Razorpay.
              </p>
            </div>
          </aside>
          ) : null}

          <form
            className={`flex min-w-0 flex-col justify-between ${
              isPlanStep ? "mx-auto w-full max-w-6xl p-3 sm:p-8 lg:px-14 lg:py-12" : "p-5 sm:p-8 lg:p-12"
            }`}
            onSubmit={isFinalStep ? handlePayNow : moveForward}
          >
            <div key={activeStep.id} className="animate-[checkoutStepIn_260ms_ease-out]">
              {!isPlanStep ? (
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#858585]">
                  Step {currentStep + 1} of {checkoutSteps.length}
                </p>
              ) : null}

              {activeStep.id === "identity" ? (
                <div className="mt-5 max-w-2xl">
                  <h3 className="font-reference text-3xl font-semibold text-white sm:text-4xl">
                    What is your full name?
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#999]">
                    Use the name that should appear in the payment and verification record.
                  </p>
                  <label className="sr-only" htmlFor="checkout-buyer-name">Full name</label>
                  <input
                    id="checkout-buyer-name"
                    className={inputClassName}
                    name="buyer_name"
                    value={checkoutProfile.buyer_name}
                    onChange={handleProfileChange}
                    autoComplete="name"
                    autoFocus
                    minLength={2}
                    maxLength={120}
                    placeholder="Enter your full name"
                  />
                </div>
              ) : null}

              {activeStep.id === "email" ? (
                <div className="mt-5 max-w-2xl">
                  <h3 className="font-reference text-3xl font-semibold text-white sm:text-4xl">
                    Where should we record your invoice?
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#999]">
                    Enter an email you can access. It will also help our admin match your
                    documents to this payment.
                  </p>
                  <label className="sr-only" htmlFor="checkout-buyer-email">Email address</label>
                  <input
                    id="checkout-buyer-email"
                    className={inputClassName}
                    type="email"
                    name="buyer_email"
                    value={checkoutProfile.buyer_email}
                    onChange={handleProfileChange}
                    autoComplete="email"
                    autoFocus
                    maxLength={254}
                    placeholder="you@example.com"
                  />
                </div>
              ) : null}

              {activeStep.id === "contact" ? (
                <div className="mt-5 max-w-2xl">
                  <h3 className="font-reference text-3xl font-semibold text-white sm:text-4xl">
                    How can our team reach you?
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#999]">
                    Include the country code. The alternate WhatsApp number is optional.
                  </p>
                  <div className="mt-5 grid gap-4 sm:grid-cols-2">
                    <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#AFAFAF]">
                      WhatsApp number
                      <input
                        className={inputClassName}
                        type="tel"
                        name="whatsapp_number"
                        value={checkoutProfile.whatsapp_number}
                        onChange={handleProfileChange}
                        autoComplete="tel"
                        autoFocus
                        placeholder="+91 98765 43210"
                        maxLength={24}
                      />
                    </label>
                    <label className="text-xs font-semibold uppercase tracking-[0.12em] text-[#AFAFAF]">
                      Alternate WhatsApp
                      <input
                        className={inputClassName}
                        type="tel"
                        name="alternate_number"
                        value={checkoutProfile.alternate_number}
                        onChange={handleProfileChange}
                        placeholder="Optional"
                        maxLength={24}
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              {activeStep.id === "plan" ? (
                <div className="mx-auto w-full max-w-5xl">
                  <header className="pt-3 text-center sm:pt-0">
                    <div className="mx-auto flex max-w-3xl items-center gap-4 sm:gap-7">
                      <span className="h-px flex-1 bg-[linear-gradient(90deg,transparent,rgba(147,166,194,0.45))]" aria-hidden="true" />
                      <p className="max-w-[68vw] text-[0.66rem] font-semibold uppercase tracking-[0.25em] text-[#AAB5C7] sm:text-xs">
                        {course.title}
                      </p>
                      <span className="h-px flex-1 bg-[linear-gradient(90deg,rgba(147,166,194,0.45),transparent)]" aria-hidden="true" />
                    </div>
                    <h1 className="mt-4 font-reference text-4xl font-semibold uppercase tracking-[0.04em] text-white sm:text-6xl">
                      Choose Your Plan
                    </h1>
                    <p className="mx-auto mt-4 flex max-w-2xl flex-wrap items-center justify-center gap-x-3 gap-y-1 text-sm text-[#AAB3C1] sm:text-base">
                      <span>Live instruction</span>
                      <span aria-hidden="true">•</span>
                      <span>Server-verified pricing</span>
                      <span aria-hidden="true">•</span>
                      <span>Secure Razorpay checkout</span>
                    </p>
                  </header>

                  <PaymentPlanPicker
                    course={course}
                    value={plan}
                    onChange={(selected) => { setPlan(selected); setError(""); }}
                    onContinue={continueWithPlan}
                    disabled={!course.purchase_available}
                  />

                  <div className="mt-8 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-[#8C98AA] sm:gap-x-4 sm:text-xs sm:tracking-[0.2em]">
                    <span className="h-px w-6 bg-white/15 sm:w-24" aria-hidden="true" />
                    <span className="whitespace-nowrap">Learn</span><span aria-hidden="true">•</span><span className="whitespace-nowrap">Investigate</span><span aria-hidden="true">•</span><span className="whitespace-nowrap">Make an impact</span>
                    <span className="h-px w-6 bg-white/15 sm:w-24" aria-hidden="true" />
                  </div>
                </div>
              ) : null}

              {error ? (
                <div role="alert" aria-live="polite" className="mt-6 max-w-3xl rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              ) : null}
            </div>

            {isPlanStep ? (
              <div className="mx-auto mt-7 flex w-full max-w-5xl items-center justify-center border-t border-white/[0.07] pt-5">
                <Link to={`/courses/${course.id}`} className="text-sm text-[#8490A2] transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#6FA5FF]">
                  View course details
                </Link>
              </div>
            ) : (
              <div className="mt-10 flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={Boolean(pendingVerification)}
                  onClick={() => {
                    setCurrentStep((step) => step - 1);
                    setError("");
                  }}
                >
                  Back
                </Button>

                {!course.purchase_available ? (
                  <Button type="button" disabled>Purchase unavailable</Button>
                ) : (
                  <Button type="submit" loading={paying} className="min-w-44">
                    {pendingVerification
                      ? "Retry payment verification"
                      : isFinalStep
                        ? "Continue to Razorpay"
                        : "Continue"}
                  </Button>
                )}
              </div>
            )}
          </form>
        </div>
      </section>
    </PageShell>
  );
}
