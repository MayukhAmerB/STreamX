import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { submitPublicEnrollmentLead } from "../api/courses";
import { apiMessage } from "../utils/api";
import Button from "./Button";
import FormInput from "./FormInput";

const EMPTY_FORM = {
  email: "",
  whatsapp_number: "",
  phone_number: "",
  message: "",
};

export default function PublicEnrollmentRequestModal({
  isOpen,
  onClose,
  targetType,
  targetId,
  targetName,
  sourcePath = "",
  loginPath = "/login",
}) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [state, setState] = useState({ loading: false, error: "", success: "" });

  const heading = useMemo(() => {
    if (targetType === "live_class") return "Live Class Enrollment Request";
    return "Course Enrollment Request";
  }, [targetType]);

  useEffect(() => {
    if (!isOpen) return;
    setForm(EMPTY_FORM);
    setState({ loading: false, error: "", success: "" });
  }, [isOpen, targetType, targetId]);

  if (!isOpen) return null;

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const numericTargetId = Number(targetId);
    if (!Number.isInteger(numericTargetId) || numericTargetId <= 0) {
      setState({
        loading: false,
        error: "Enrollment request is unavailable for this preview item.",
        success: "",
      });
      return;
    }
    if (form.message.trim().length < 3) {
      setState({
        loading: false,
        error: "Please enter at least 3 characters in your message.",
        success: "",
      });
      return;
    }
    setState({ loading: true, error: "", success: "" });
    try {
      const payload = {
        email: form.email.trim(),
        whatsapp_number: form.whatsapp_number.trim(),
        phone_number: form.phone_number.trim(),
        message: form.message.trim(),
        source_path: sourcePath || window.location.pathname || "",
      };
      if (targetType === "live_class") {
        payload.live_class_id = numericTargetId;
      } else {
        payload.course_id = numericTargetId;
      }
      const response = await submitPublicEnrollmentLead(payload);
      setState({
        loading: false,
        error: "",
        success: response?.data?.message || "Request submitted successfully.",
      });
      setForm(EMPTY_FORM);
    } catch (err) {
      const errors = err?.response?.data?.errors;
      const firstFieldError = errors
        ? Object.values(errors).find((value) => Array.isArray(value) && value.length)?.[0]
        : "";
      setState({
        loading: false,
        error: firstFieldError || apiMessage(err, "Unable to submit request. Please try again."),
        success: "",
      });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/80 px-4 py-8 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-black panel-gradient p-5 shadow-[0_28px_80px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
              Guest Enrollment
            </div>
            <h3 className="mt-1 font-reference text-2xl font-semibold text-white">{heading}</h3>
            <p className="mt-2 text-sm text-[#BBBBBB]">
              {targetName ? `Target: ${targetName}` : "Share your details and we will contact you for enrollment."}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg border border-black bg-[#161616] px-3 py-1.5 text-xs font-semibold text-[#DBDBDB] hover:bg-[#1C1C1C]"
            onClick={onClose}
          >
            Close
          </button>
        </div>

        <form className="grid gap-3" onSubmit={handleSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormInput
              label="Email"
              type="email"
              name="email"
              value={form.email}
              onChange={handleChange}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
            <FormInput
              label="Whatsapp Number"
              name="whatsapp_number"
              value={form.whatsapp_number}
              onChange={handleChange}
              placeholder="+91 98765 43210"
              required
              autoComplete="tel"
            />
          </div>

          <FormInput
            label="Phone Number"
            name="phone_number"
            value={form.phone_number}
            onChange={handleChange}
            placeholder="+91 98765 43210"
            required
            autoComplete="tel"
          />

          <FormInput
            as="textarea"
            rows={4}
            label="Why Do You Want To Enroll?"
            name="message"
            value={form.message}
            onChange={handleChange}
            placeholder="Write your reason for enrolling. This field is required."
            required
          />

          {state.error ? <p className="text-xs text-red-300">{state.error}</p> : null}
          {state.success ? <p className="text-xs text-zinc-300">{state.success}</p> : null}

          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Button type="submit" loading={state.loading}>
              Submit Request
            </Button>
            <Link to={loginPath} onClick={onClose} className="inline-flex">
              <Button type="button" variant="secondary">
                Login Instead
              </Button>
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
