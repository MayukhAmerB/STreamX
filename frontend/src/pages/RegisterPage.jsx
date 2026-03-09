import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import FormInput from "../components/FormInput";
import PageShell from "../components/PageShell";
import { useAuth } from "../hooks/useAuth";
import { apiMessage } from "../utils/api";

export default function RegisterPage() {
  const navigate = useNavigate();
  const { register, registrationEnabled } = useAuth();
  const [form, setForm] = useState({
    full_name: "",
    email: "",
    phone_number: "",
    password: "",
    role: "student",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await register(form);
      navigate("/");
    } catch (err) {
      setError(apiMessage(err, "Registration failed."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageShell title="Register" subtitle="Create a new account.">
      <div className="mx-auto max-w-md rounded-2xl border border-black panel-gradient p-6 shadow-[0_16px_40px_rgba(0,0,0,0.28)]">
        {registrationEnabled ? (
          <>
            <form onSubmit={handleSubmit} className="space-y-4">
              <FormInput
                label="Full Name"
                value={form.full_name}
                onChange={(e) => setForm((prev) => ({ ...prev, full_name: e.target.value }))}
                required
              />
              <FormInput
                label="Email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
                required
              />
              <FormInput
                label="Phone Number"
                value={form.phone_number}
                onChange={(e) => setForm((prev) => ({ ...prev, phone_number: e.target.value }))}
                placeholder="+91 98765 43210"
                required
              />
              <FormInput
                label="Password"
                type="password"
                minLength={8}
                value={form.password}
                onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                required
              />
              <label className="block">
                <span className="mb-2 block text-sm text-[#D7D7D7]">Role</span>
                <select
                  className="w-full rounded-lg border border-black bg-[#111111] px-3 py-2 text-sm text-white focus:border-[#C0C0C0] focus:outline-none"
                  value={form.role}
                  onChange={(e) => setForm((prev) => ({ ...prev, role: e.target.value }))}
                >
                  <option value="student">Student</option>
                  <option value="instructor">Instructor</option>
                </select>
              </label>
              {error ? <p className="text-sm text-red-400">{error}</p> : null}
              <Button className="w-full" type="submit" loading={loading}>
                Create Account
              </Button>
            </form>
            <p className="mt-5 text-sm text-[#BBBBBB]">
              Already have an account?{" "}
              <Link to="/login" className="text-white hover:underline">
                Login
              </Link>
            </p>
          </>
        ) : (
          <div className="space-y-4">
            <p className="rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
              Registration is disabled. Contact the admin to get your login credentials.
            </p>
            <Link to="/login" className="block">
              <Button className="w-full">Go to Login</Button>
            </Link>
          </div>
        )}
      </div>
    </PageShell>
  );
}

