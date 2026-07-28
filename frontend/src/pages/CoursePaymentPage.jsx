import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { getCourse } from "../api/courses";
import { createPaymentOrder, verifyPayment } from "../api/payments";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";
import { getCourseLaunchStatus } from "../utils/courseStatus";
import { formatINR } from "../utils/currency";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const steps = [
  { id: "identity", label: "Your name", summaryKey: "buyer_name" },
  { id: "email", label: "Email", summaryKey: "buyer_email" },
  { id: "contact", label: "WhatsApp", summaryKey: "whatsapp_number" },
  { id: "plan", label: "Payment plan" },
];

const inputClassName =
  "mt-4 min-h-14 w-full rounded-xl border border-white/15 bg-black/65 px-4 py-3 text-base text-white outline-none transition placeholder:text-[#606060] focus:border-white/50 focus:bg-black";

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-4 w-4 sm:h-5 sm:w-5">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.7" />
      <path d="m8 12 2.6 2.6L16.5 9" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlanIcon({ type }) {
  if (type === "calendar") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-8 w-8">
        <rect x="3.5" y="5.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <path d="M7 3.5v4M17 3.5v4M3.5 10h17M8 14h2M14 14h2M8 17h2M14 17h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "tag") {
    return (
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-8 w-8">
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H13l7 7-9 9-7-7V5.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="8.2" cy="8.2" r="1.2" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className="h-10 w-10">
      <path d="M4 7.5h14a2 2 0 0 1 2 2v9H6a2 2 0 0 1-2-2v-9Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="m5 7.5 10-3v3M16 12h5v4h-5a2 2 0 1 1 0-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function ArrowIcon({ className = "h-5 w-5" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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

function PlanFeature({ children }) {
  return (
    <li className="flex min-w-0 items-start gap-1.5 text-[11px] leading-4 text-[#D3D3D3] sm:gap-3 sm:text-base sm:leading-6">
      <span className="mt-0.5 shrink-0 text-[#79A5FF]">
        <CheckIcon />
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const existing = document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
    if (existing) {
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("Failed to load Razorpay checkout SDK.")),
        { once: true }
      );
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error("Failed to load Razorpay checkout SDK."));
    document.body.appendChild(script);
  });
}

function isValidPhone(value) {
  return /^\+?[0-9][0-9 ()-]{7,22}$/.test(value.trim());
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function stepSummary(step, profile, plan, course) {
  if (step.id === "plan") {
    return plan === "monthly"
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
  const { user } = useAuth();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [currentStep, setCurrentStep] = useState(0);
  const [plan, setPlan] = useState("full");
  const [paymentResult, setPaymentResult] = useState(null);
  const [checkoutProfile, setCheckoutProfile] = useState({
    buyer_name: user?.full_name || "",
    buyer_email: user?.email || "",
    whatsapp_number: user?.phone_number || "",
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
    let active = true;
    (async () => {
      try {
        const response = await getCourse(id);
        if (!active) return;
        const loadedCourse = apiData(response);
        setCourse(loadedCourse);
        if (!loadedCourse?.full_payment_enabled && loadedCourse?.installment_payment_enabled) {
          setPlan("monthly");
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
  }, [id]);

  const launchStatus = useMemo(() => getCourseLaunchStatus(course), [course]);
  const activeStep = steps[currentStep];

  const handleProfileChange = (event) => {
    const { name, value } = event.target;
    setCheckoutProfile((current) => ({ ...current, [name]: value }));
    setError("");
  };

  const validateCurrentStep = () => {
    if (activeStep.id === "identity" && checkoutProfile.buyer_name.trim().length < 2) {
      return "Enter your full name to continue.";
    }
    if (activeStep.id === "email" && !isValidEmail(checkoutProfile.buyer_email)) {
      return "Enter a valid email address.";
    }
    if (activeStep.id === "contact") {
      if (!isValidPhone(checkoutProfile.whatsapp_number)) {
        return "Enter a valid WhatsApp number with country code.";
      }
      if (
        checkoutProfile.alternate_number.trim() &&
        !isValidPhone(checkoutProfile.alternate_number)
      ) {
        return "Enter a valid alternate WhatsApp number or leave it blank.";
      }
    }
    if (
      activeStep.id === "plan" &&
      ((plan === "full" && !course?.full_payment_enabled) ||
        (plan === "monthly" && !course?.installment_payment_enabled))
    ) {
      return "Choose an available payment plan.";
    }
    return "";
  };

  const moveForward = (event) => {
    event.preventDefault();
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError("");
    setCurrentStep((step) => Math.min(step + 1, steps.length - 1));
  };

  const handlePayNow = async (event) => {
    event.preventDefault();
    const validationError = validateCurrentStep();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (
      !course ||
      launchStatus.isComingSoon ||
      course.is_enrolled ||
      !course.purchase_available
    ) {
      return;
    }

    setPaying(true);
    setError("");
    try {
      await loadRazorpayScript();
      const orderResponse = await createPaymentOrder({
        course_id: Number(id),
        plan,
        buyer_name: checkoutProfile.buyer_name.trim(),
        buyer_email: checkoutProfile.buyer_email.trim(),
        whatsapp_number: checkoutProfile.whatsapp_number.trim(),
        alternate_number: checkoutProfile.alternate_number.trim(),
      });
      const orderData = apiData(orderResponse);

      if (orderData?.already_enrolled) {
        setError("This account already has active access to the course.");
        setPaying(false);
        return;
      }

      const razorpayKey = orderData?.key_id || import.meta.env.VITE_RAZORPAY_KEY_ID;
      if (!razorpayKey) {
        throw new Error("Razorpay is not configured for this environment.");
      }

      const checkout = new window.Razorpay({
        key: razorpayKey,
        amount: orderData.amount,
        currency: orderData.currency,
        order_id: orderData.razorpay_order_id,
        name: "Al syed Initiative",
        description: `${course.title} - ${plan === "monthly" ? "Monthly" : "One-time"}`,
        theme: { color: "#111111" },
        prefill: {
          name: orderData?.checkout_profile?.name || checkoutProfile.buyer_name,
          email: orderData?.checkout_profile?.email || checkoutProfile.buyer_email,
          contact: orderData?.checkout_profile?.contact || checkoutProfile.whatsapp_number,
        },
        notes: {
          course_id: String(course.id),
          course_title: course.title,
          access_plan: plan,
        },
        handler: async (response) => {
          try {
            const verifyResponse = await verifyPayment({
              course_id: Number(id),
              checkout_reference: orderData.checkout_reference,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            setPaymentResult(apiData(verifyResponse));
          } catch (verifyError) {
            setError(apiMessage(verifyError, "Payment verification failed."));
          } finally {
            setPaying(false);
          }
        },
        modal: {
          ondismiss: () => setPaying(false),
        },
      });
      checkout.open();
    } catch (err) {
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

  if (paymentResult) {
    return (
      <PageShell
        title="Payment successful"
        subtitle="Your payment was verified and recorded securely"
      >
        <section className="mx-auto max-w-3xl overflow-hidden rounded-[28px] border border-white/15 bg-[#090909] shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
          <div className="border-b border-white/10 bg-white/[0.04] p-6 sm:p-8">
            <div className="flex h-14 w-14 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-400/10 text-2xl text-emerald-300">
              OK
            </div>
            <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300">
              Razorpay payment verified
            </p>
            <h2 className="mt-2 font-reference text-3xl font-semibold text-white">
              Your enrollment is recorded
            </h2>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-[#BDBDBD]">
              Your invoice, payment, buyer details, generated login, course access, and linked
              live-class access are saved. Contact our team on WhatsApp to complete document
              verification and receive your password.
            </p>
          </div>

          <dl className="grid gap-3 p-6 sm:grid-cols-2 sm:p-8">
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-[#858585]">Invoice</dt>
              <dd className="mt-2 break-all text-base font-semibold text-white">
                {paymentResult.invoice_number || "Recorded"}
              </dd>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-[#858585]">
                Generated login
              </dt>
              <dd className="mt-2 break-all text-base font-semibold text-white">
                {paymentResult.generated_login || "Pending"}
              </dd>
            </div>
            <div className="rounded-2xl border border-white/10 bg-white/[0.035] p-4 sm:col-span-2">
              <dt className="text-[10px] uppercase tracking-[0.16em] text-[#858585]">
                Credential status
              </dt>
              <dd className="mt-2 text-sm leading-6 text-[#D0D0D0]">
                Password pending admin verification. The generated login becomes usable only
                after our team issues your credentials.
              </dd>
            </div>
          </dl>

          <div className="flex flex-col gap-3 border-t border-white/10 p-6 sm:flex-row sm:p-8">
            {paymentResult.support_whatsapp_url ? (
              <a
                href={paymentResult.support_whatsapp_url}
                target="_blank"
                rel="noreferrer"
                className="flex-1"
              >
                <Button type="button" className="w-full">
                  Contact us on WhatsApp
                </Button>
              </a>
            ) : null}
            <Link to="/courses" className="flex-1">
              <Button type="button" variant="secondary" className="w-full">
                Return to courses
              </Button>
            </Link>
          </div>
        </section>
      </PageShell>
    );
  }

  const isFinalStep = currentStep === steps.length - 1;

  return (
    <PageShell
      title={isFinalStep ? "" : "Course checkout"}
      subtitle={isFinalStep ? "" : "Complete one short step at a time, then continue to Razorpay"}
      containerClassName={isFinalStep ? "max-w-[1180px] py-4 sm:py-8" : ""}
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

        <div className={`relative min-h-[610px] ${isFinalStep ? "" : "grid lg:grid-cols-[310px_1fr]"}`}>
          {!isFinalStep ? (
          <aside className="border-b border-white/10 bg-white/[0.025] p-5 lg:border-b-0 lg:border-r lg:p-7">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[#888]">
              Secure enrollment
            </p>
            <h2 className="mt-3 font-reference text-xl font-semibold text-white">
              {course.title}
            </h2>
            <p className="mt-2 text-sm text-[#8F8F8F]">
              {plan === "monthly"
                ? `${formatINR(course.monthly_price)} every 30 days`
                : `${formatINR(course.price)} one-time`}
            </p>

            <ol className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-1">
              {steps.map((step, index) => {
                const complete = index < currentStep;
                const active = index === currentStep;
                return (
                  <li key={step.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (index <= currentStep) {
                          setCurrentStep(index);
                          setError("");
                        }
                      }}
                      className={`w-full rounded-xl border p-3 text-left transition ${
                        active
                          ? "border-white/45 bg-white/[0.1]"
                          : "border-white/[0.07] bg-black/30"
                      } ${index <= currentStep ? "cursor-pointer" : "cursor-default"}`}
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
              isFinalStep ? "mx-auto w-full max-w-6xl p-3 sm:p-8 lg:px-14 lg:py-12" : "p-5 sm:p-8 lg:p-12"
            }`}
            onSubmit={isFinalStep ? handlePayNow : moveForward}
          >
            <div key={activeStep.id} className="animate-[checkoutStepIn_260ms_ease-out]">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#858585]">
                Step {currentStep + 1} of {steps.length}
              </p>

              {activeStep.id === "identity" ? (
                <div className="mt-5 max-w-2xl">
                  <h3 className="font-reference text-3xl font-semibold text-white sm:text-4xl">
                    What is your full name?
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-[#999]">
                    Use the name that should appear in the payment and verification record.
                  </p>
                  <input
                    className={inputClassName}
                    name="buyer_name"
                    value={checkoutProfile.buyer_name}
                    onChange={handleProfileChange}
                    autoComplete="name"
                    autoFocus
                    minLength={2}
                    maxLength={255}
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
                  <input
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
                  <div className="flex items-center gap-5" aria-hidden="true">
                    <span className="h-px flex-1 bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.15))]" />
                    <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/45 text-white sm:h-28 sm:w-28">
                      <PlanIcon type="wallet" />
                    </span>
                    <span className="h-px flex-1 bg-[linear-gradient(90deg,rgba(255,255,255,0.15),transparent)]" />
                  </div>

                  <div className="mt-7 text-center">
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#B7B7B7] sm:text-sm">
                      Enrollment step {currentStep + 1} of {steps.length}
                    </p>
                    <h3 className="mt-3 font-reference text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">
                      Choose Your Plan
                    </h3>
                    <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-[#A5A5A5] sm:text-lg sm:leading-8">
                      Select the plan that best fits your goals and start your OSINT journey.
                    </p>
                  </div>

                  <div className="mt-7 grid grid-cols-2 gap-2 sm:mt-9 sm:gap-4 lg:gap-5">
                    {course.installment_payment_enabled ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPlan("monthly");
                          setError("");
                        }}
                        aria-pressed={plan === "monthly"}
                        className={`flex min-h-[430px] min-w-0 flex-col rounded-xl border p-3 text-left transition sm:min-h-[490px] sm:rounded-2xl sm:p-7 ${
                          plan === "monthly"
                            ? "border-[#79A5FF] bg-[#10141C] text-white shadow-[0_0_0_1px_rgba(121,165,255,0.2)]"
                            : "border-white/15 bg-black/55 text-white hover:border-white/35"
                        }`}
                      >
                        <span className="block text-center text-base font-semibold sm:text-2xl">
                          Plan 1
                        </span>
                        <span className="mt-1 block text-center text-[10px] leading-4 text-[#C3C3C3] sm:mt-2 sm:text-base">
                          Monthly Payment Plan
                        </span>
                        <span className="mt-4 block border-t border-white/10 pt-4 text-xl font-semibold leading-tight sm:mt-6 sm:pt-7 sm:text-5xl">
                          {formatINR(course.monthly_price)}
                          <span className="mt-1 block text-[10px] font-normal text-[#B5B5B5] sm:ml-2 sm:mt-0 sm:inline sm:text-sm">/ month</span>
                        </span>
                        <ul className="mt-4 space-y-2 sm:mt-7 sm:space-y-3">
                          <PlanFeature>
                            Pay <span className="text-[#79A5FF]">{formatINR(course.monthly_price)}</span> every month
                          </PlanFeature>
                          <PlanFeature>For 3 months (3 installments)</PlanFeature>
                        </ul>
                        <span className="mt-auto flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.045] p-2 sm:gap-4 sm:rounded-xl sm:p-4">
                          <span className="hidden shrink-0 text-white sm:block"><PlanIcon type="calendar" /></span>
                          <span className="min-w-0">
                            <span className="block text-[11px] font-semibold leading-4 sm:text-base">3 Monthly Payments</span>
                            <span className="mt-1 block text-[10px] leading-4 text-[#A7A7A7] sm:text-sm">
                              {formatINR(course.monthly_price)} x 3 months
                            </span>
                          </span>
                        </span>
                      </button>
                    ) : null}
                    {course.full_payment_enabled ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPlan("full");
                          setError("");
                        }}
                        aria-pressed={plan === "full"}
                        className={`relative flex min-h-[430px] min-w-0 flex-col rounded-xl border p-3 text-left transition sm:min-h-[490px] sm:rounded-2xl sm:p-7 ${
                          plan === "full"
                            ? "border-[#79A5FF] bg-[#10141C] text-white shadow-[0_0_0_1px_rgba(121,165,255,0.25)]"
                            : "border-white/15 bg-black/55 text-white hover:border-white/35"
                        }`}
                      >
                        <span className="mx-auto -mt-1 mb-2 rounded-md bg-[#79A5FF] px-2 py-1 text-[8px] font-bold uppercase tracking-[0.08em] text-[#07101F] sm:mb-3 sm:rounded-lg sm:px-4 sm:text-[10px] sm:tracking-[0.12em]">
                          Most chosen
                        </span>
                        <span className="block text-center text-base font-semibold text-[#79A5FF] sm:text-2xl">
                          Plan 2
                        </span>
                        <span className="mt-1 block text-center text-[10px] leading-4 text-[#C3C3C3] sm:mt-2 sm:text-base">
                          One-Time Payment
                        </span>
                        <span className="mt-4 block border-t border-white/10 pt-4 text-xl font-semibold leading-tight sm:mt-6 sm:pt-7 sm:text-5xl">
                          {formatINR(course.price)}
                        </span>
                        <ul className="mt-4 space-y-2 sm:mt-7 sm:space-y-3">
                          <PlanFeature>One-time payment</PlanFeature>
                          <PlanFeature>Full duration: 3 months</PlanFeature>
                          <PlanFeature>Full access to all live sessions</PlanFeature>
                          <PlanFeature>Lifetime access to recordings</PlanFeature>
                          <PlanFeature>Certificate of completion</PlanFeature>
                          <PlanFeature>24x7 team chat support</PlanFeature>
                        </ul>
                        <span className="mt-auto flex min-w-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.045] p-2 sm:gap-4 sm:rounded-xl sm:p-4">
                          <span className="hidden shrink-0 text-white sm:block"><PlanIcon type="tag" /></span>
                          <span className="min-w-0">
                            <span className="block text-[11px] font-semibold leading-4 sm:text-base">One-Time Payment</span>
                            <span className="mt-1 block text-[10px] leading-4 text-[#A7A7A7] sm:text-sm">Pay once, learn fully</span>
                          </span>
                        </span>
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {error ? (
                <div className="mt-6 max-w-3xl rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              ) : null}
            </div>

            <div className={`mt-10 ${
              isFinalStep
                ? "mx-auto flex w-full max-w-5xl flex-col gap-5"
                : "flex flex-col-reverse gap-3 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between"
            }`}>
              {isFinalStep ? (
                <>
                  {!course.purchase_available ? (
                    <Button type="button" disabled className="min-h-16 w-full rounded-xl text-base uppercase tracking-[0.12em]">
                      Purchase unavailable
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      loading={paying}
                      className="min-h-16 w-full rounded-xl text-base uppercase tracking-[0.12em]"
                    >
                      Proceed to payment
                      <ArrowIcon />
                    </Button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentStep((step) => step - 1);
                      setError("");
                    }}
                    className="mx-auto inline-flex items-center gap-2 text-sm text-[#8B8B8B] transition hover:text-white"
                  >
                    <ArrowIcon className="h-4 w-4 rotate-180" />
                    Back
                  </button>
                  <p className="flex items-center justify-center gap-2 border-t border-white/[0.08] pt-5 text-xs text-[#8F8F8F] sm:text-sm">
                    <ShieldIcon />
                    Secure Enrollment
                    <span aria-hidden="true">•</span>
                    Limited Seats
                  </p>
                </>
              ) : (
                <>
              <div className="flex gap-2">
                {currentStep > 0 ? (
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setCurrentStep((step) => step - 1);
                      setError("");
                    }}
                  >
                    Back
                  </Button>
                ) : (
                  <Link to={`/courses/${course.id}`}>
                    <Button type="button" variant="secondary">
                      Cancel
                    </Button>
                  </Link>
                )}
              </div>

              {!course.purchase_available ? (
                <Button type="button" disabled>
                  Purchase unavailable
                </Button>
              ) : (
                <Button type="submit" loading={paying} className="min-w-44">
                  {isFinalStep ? "Continue to Razorpay" : "Continue"}
                </Button>
              )}
                </>
              )}
            </div>
          </form>
        </div>
      </section>
    </PageShell>
  );
}
