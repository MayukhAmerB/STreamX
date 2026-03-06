import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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

function formatCategory(category) {
  if (category === "web_pentesting") return "Web Pentesting";
  if (category === "osint") return "OSINT";
  return "Cybersecurity";
}

function formatLevel(level) {
  if (!level) return "Program";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function loadRazorpayScript() {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.onload = () => resolve(true);
    script.onerror = () => reject(new Error("Failed to load Razorpay checkout SDK."));
    document.body.appendChild(script);
  });
}

export default function CoursePaymentPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { refreshUser } = useAuth();
  const [course, setCourse] = useState(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await getCourse(id);
        if (!active) return;
        setCourse(apiData(response));
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
  const lectureCount = useMemo(
    () =>
      course?.sections?.reduce((acc, section) => acc + ((section.lectures || []).length || 0), 0) || 0,
    [course]
  );

  const handlePayNow = async () => {
    if (!course || launchStatus.isComingSoon || course.is_enrolled) return;

    setPaying(true);
    setError("");
    try {
      await loadRazorpayScript();
      const orderResponse = await createPaymentOrder({ course_id: Number(id) });
      const orderData = apiData(orderResponse);

      if (orderData?.already_enrolled) {
        navigate(`/learn/${id}`);
        return;
      }

      const rzp = new window.Razorpay({
        key: import.meta.env.VITE_RAZORPAY_KEY_ID,
        amount: orderData.amount,
        currency: orderData.currency,
        order_id: orderData.razorpay_order_id,
        name: "Al syed Initiative",
        description: course.title,
        theme: { color: "#111111" },
        handler: async (response) => {
          try {
            await verifyPayment({
              course_id: Number(id),
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            await refreshUser();
            navigate(`/learn/${id}`);
          } catch (verifyErr) {
            setError(apiMessage(verifyErr, "Payment verification failed."));
          }
        },
        modal: {
          ondismiss: () => setPaying(false),
        },
      });

      rzp.open();
    } catch (err) {
      setError(apiMessage(err, "Unable to start payment."));
    } finally {
      setPaying(false);
    }
  };

  if (loading) {
    return <PageShell title="Payment">Loading...</PageShell>;
  }

  if (!course) {
    return (
      <PageShell title="Payment">
        <p className="text-sm text-red-400">{error || "Course not found."}</p>
      </PageShell>
    );
  }

  return (
    <PageShell title="Payment" subtitle="Secure checkout powered by Razorpay">
      <section className="relative overflow-hidden rounded-[28px] border border-[#cfd8c5]/10 bg-[#070907] shadow-[0_24px_60px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={course.thumbnail || pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.14]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/90 via-black/80 to-[#0d130f]/95" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_85%_15%,rgba(185,199,171,0.1),transparent_36%)]" />
        </div>

        <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-white/70 bg-white/90 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-neutral-900">
                {formatCategory(course.category)}
              </span>
              <span className="rounded-full border border-[#d7e0cc]/20 bg-[#0f1410]/85 px-3 py-1 text-[10px] font-semibold tracking-[0.14em] text-[#d7e0cc]">
                {formatLevel(course.level)}
              </span>
              <span
                className={`rounded-full px-3 py-1 text-[10px] font-semibold tracking-[0.14em] ${
                  launchStatus.isLive
                    ? "border border-[#d7e4ce] bg-[#eef3e8] text-[#1f2d21]"
                    : "border border-amber-200/90 bg-amber-50 text-amber-900"
                }`}
              >
                {launchStatus.label}
              </span>
            </div>

            <h2 className="mt-4 font-reference text-2xl font-semibold leading-tight text-white sm:text-3xl">
              {course.title}
            </h2>
            <p className="mt-3 text-sm leading-7 text-[#b7c0b0]">
              Review your course details and continue to secure payment. Enrollment is activated
              after successful Razorpay verification.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/90 p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Price</div>
                <div className="mt-1 text-lg font-semibold text-white">{formatINR(course.price)}</div>
              </div>
              <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/90 p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Modules</div>
                <div className="mt-1 text-lg font-semibold text-white">{course.sections?.length || 0}</div>
              </div>
              <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/90 p-3">
                <div className="text-[10px] uppercase tracking-[0.16em] text-[#8f9989]">Lectures</div>
                <div className="mt-1 text-lg font-semibold text-white">{lectureCount}</div>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-[#243025] bg-[#0d120f]/92 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.22)]">
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8f9989]">
              Checkout
            </div>
            <div className="mt-2 font-reference text-3xl font-semibold text-white">
              {launchStatus.isComingSoon ? "Coming Soon" : formatINR(course.price)}
            </div>
            <p className="mt-2 text-sm leading-6 text-[#b7c0b0]">
              Razorpay secure checkout for Card, UPI, and supported payment methods.
            </p>

            <div className="mt-4 space-y-2">
              <div className="rounded-lg border border-[#1f2820] bg-[#101610] px-3 py-2 text-sm text-[#c4cdba]">
                Course: {course.title}
              </div>
              <div className="rounded-lg border border-[#1f2820] bg-[#101610] px-3 py-2 text-sm text-[#c4cdba]">
                Access: {launchStatus.label}
              </div>
            </div>

            {error ? (
              <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            <div className="mt-4 space-y-2">
              {launchStatus.isComingSoon ? (
                <Button
                  className="w-full border border-amber-300/20 bg-amber-100/5 text-amber-200 hover:bg-amber-100/5"
                  disabled
                >
                  Coming Soon
                </Button>
              ) : course.is_enrolled ? (
                <Link to={`/learn/${course.id}`} className="block">
                  <Button className="w-full">Go to Course</Button>
                </Link>
              ) : (
                <Button className="w-full" onClick={handlePayNow} loading={paying}>
                  Buy Now
                </Button>
              )}

              <Link to={`/courses/${course.id}`} className="block">
                <Button variant="secondary" className="w-full">
                  Back to Course
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </section>
    </PageShell>
  );
}

