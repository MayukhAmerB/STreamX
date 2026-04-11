import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { listAdminLectureQuestions } from "../api/courses";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import { apiData, apiMessage } from "../utils/api";

const statusOptions = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "reviewed", label: "Reviewed" },
  { value: "answered", label: "Answered" },
];

function formatDateTime(value) {
  if (!value) return "Not available";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not available";
  return parsed.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusClassName(status) {
  if (status === "answered") {
    return "border-emerald-300/35 bg-emerald-300/10 text-emerald-200";
  }
  if (status === "reviewed") {
    return "border-sky-300/35 bg-sky-300/10 text-sky-200";
  }
  return "border-amber-300/35 bg-amber-300/10 text-amber-100";
}

export default function LectureQuestionsPage() {
  const [questions, setQuestions] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [state, setState] = useState({ loading: true, error: "" });

  useEffect(() => {
    let active = true;
    setState({ loading: true, error: "" });

    listAdminLectureQuestions({
      paginate: 1,
      page,
      page_size: 50,
      status: statusFilter,
      search,
    })
      .then((response) => {
        if (!active) return;
        const payload = apiData(response);
        const results = Array.isArray(payload) ? payload : payload?.results || [];
        setQuestions(results);
        setPagination(Array.isArray(payload) ? null : payload?.pagination || null);
        setState({ loading: false, error: "" });
      })
      .catch((err) => {
        if (!active) return;
        setQuestions([]);
        setPagination(null);
        setState({ loading: false, error: apiMessage(err, "Unable to load lecture questions.") });
      });

    return () => {
      active = false;
    };
  }, [page, refreshKey, search, statusFilter]);

  const statusCounts = useMemo(
    () =>
      questions.reduce(
        (acc, question) => ({
          ...acc,
          [question.status]: (acc[question.status] || 0) + 1,
        }),
        {}
      ),
    [questions]
  );

  const handleSearchSubmit = (event) => {
    event.preventDefault();
    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleStatusChange = (value) => {
    setPage(1);
    setStatusFilter(value);
  };

  return (
    <PageShell
      title="Lecture Questions"
      subtitle="Review the questions students submit from course lecture pages."
      badge="ADMIN QUEUE"
    >
      <section className="rounded-[28px] border border-black panel-gradient p-4 shadow-[0_18px_44px_rgba(0,0,0,0.28)] sm:p-5">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-2xl border border-black bg-[#0B0B0B] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Loaded
            </div>
            <div className="mt-2 text-3xl font-semibold text-white">{questions.length}</div>
          </div>
          <div className="rounded-2xl border border-black bg-[#0B0B0B] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              New In View
            </div>
            <div className="mt-2 text-3xl font-semibold text-amber-100">{statusCounts.new || 0}</div>
          </div>
          <div className="rounded-2xl border border-black bg-[#0B0B0B] p-4">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Answered In View
            </div>
            <div className="mt-2 text-3xl font-semibold text-emerald-200">{statusCounts.answered || 0}</div>
          </div>
        </div>

        <form className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]" onSubmit={handleSearchSubmit}>
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by student, email, course, lecture, or question..."
            className="min-h-11 rounded-2xl border border-[#2E2E2E] bg-black/55 px-4 text-sm text-white outline-none transition placeholder:text-[#777777] focus:border-[#D8D8D8]/70"
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Search</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                setPage(1);
              }}
            >
              Clear
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRefreshKey((current) => current + 1)}
            >
              Refresh
            </Button>
          </div>
        </form>

        <div className="mt-4 flex flex-wrap gap-2">
          {statusOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleStatusChange(option.value)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition ${
                statusFilter === option.value
                  ? "border-[#D8D8D8] bg-[#F1F1F1] text-[#101010]"
                  : "border-[#2E2E2E] bg-black/40 text-[#BDBDBD] hover:border-[#D8D8D8]/60"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-5 rounded-[28px] border border-black panel-gradient p-4 shadow-[0_18px_44px_rgba(0,0,0,0.28)] sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#949494]">
              Question Queue
            </div>
            <p className="mt-2 text-sm text-[#BDBDBD]">
              Student questions from lecture pages. Questions are reviewed and answered every Friday.
            </p>
          </div>
          {pagination ? (
            <div className="text-xs text-[#A7A7A7]">
              Page {pagination.page} of {pagination.pages || 1} | {pagination.total} total
            </div>
          ) : null}
        </div>

        {state.error ? <p className="mt-4 rounded-2xl border border-red-400/25 bg-red-500/10 p-3 text-sm text-red-200">{state.error}</p> : null}

        {state.loading ? (
          <p className="mt-5 text-sm text-[#A7A7A7]">Loading lecture questions...</p>
        ) : questions.length ? (
          <div className="mt-5 grid gap-4">
            {questions.map((question) => (
              <article
                key={question.id}
                className="rounded-2xl border border-[#2B2B2B] bg-[linear-gradient(145deg,#101010,#050505)] p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white">
                      {question.student_name || question.student_email || "Unknown student"}
                    </div>
                    <div className="mt-1 text-xs text-[#9D9D9D]">{question.student_email}</div>
                  </div>
                  <span
                    className={`rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${statusClassName(question.status)}`}
                  >
                    {question.status_label || question.status}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <div className="rounded-2xl border border-black bg-black/35 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8F8F8F]">
                      Course
                    </div>
                    <div className="mt-1 text-sm font-semibold text-[#E3E3E3]">
                      {question.course_title || "Course unavailable"}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-black bg-black/35 p-3">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8F8F8F]">
                      Lecture
                    </div>
                    <div className="mt-1 text-sm font-semibold text-[#E3E3E3]">
                      {question.lecture_title || "Lecture unavailable"}
                    </div>
                  </div>
                </div>

                <p className="mt-4 whitespace-pre-wrap rounded-2xl border border-[#242424] bg-black/45 p-4 text-sm leading-7 text-[#E6E6E6]">
                  {question.question}
                </p>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-[#8F8F8F]">
                  <span>Asked {formatDateTime(question.created_at)}</span>
                  {question.course_id ? (
                    <Link to={`/learn/${question.course_id}`} className="font-semibold text-[#D7D7D7] hover:text-white">
                      Open course player
                    </Link>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-5 rounded-2xl border border-[#252525] bg-black/35 p-4 text-sm text-[#A7A7A7]">
            No lecture questions match this view yet.
          </p>
        )}

        {pagination ? (
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!pagination.has_previous}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!pagination.has_next}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </section>
    </PageShell>
  );
}
