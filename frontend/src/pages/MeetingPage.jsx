import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Button from "../components/Button";
import PageShell from "../components/PageShell";
import MeetingRoomExperience from "../components/realtime/MeetingRoomExperience";
import { listLiveClasses } from "../api/courses";
import {
  createRealtimeSession,
  endRealtimeSession,
  joinRealtimeSession,
  listRealtimeSessions,
} from "../api/realtime";
import { useAuth } from "../hooks/useAuth";
import { apiData, apiMessage } from "../utils/api";

const pageBackgroundImage =
  "https://i.pinimg.com/736x/7e/4d/a3/7e4da37224c6c189161ed24cd8fc2ab3.jpg";

const initialForm = {
  title: "",
  description: "",
  linked_live_class_id: "",
  meeting_capacity: 300,
};

const meetingMarketingCards = [
  {
    title: "Live Instructor Workshops",
    description: "High-engagement security workshops with direct audio/video collaboration.",
  },
  {
    title: "Guided Team Rooms",
    description: "Private room-style sessions for assessments, mentoring, and team coaching.",
  },
  {
    title: "Scale-Aware Sessions",
    description: "Automatic overflow to broadcasting mode once live room attendance reaches threshold.",
  },
];

const meetingHeroHighlights = ["Two-way interaction", "Auto-overflow at 300", "Scale to 50,000 viewers"];

const meetingWorkflow = [
  {
    step: "Create",
    detail: "Set a title and open an interactive room for instructors and students.",
  },
  {
    step: "Collaborate",
    detail: "Participants join with camera and microphone for live two-way communication.",
  },
  {
    step: "Scale",
    detail: "Once attendance reaches threshold, overflow is redirected to broadcast mode.",
  },
];

export default function MeetingPage() {
  const { isAuthenticated, user } = useAuth();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState([]);
  const [liveClassOptions, setLiveClassOptions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [form, setForm] = useState(initialForm);
  const [createState, setCreateState] = useState({ loading: false, error: "", success: "" });

  const [joinState, setJoinState] = useState({ loadingId: null, error: "" });
  const [deleteState, setDeleteState] = useState({ loadingId: null, error: "", info: "" });
  const [activeMeeting, setActiveMeeting] = useState(null);

  const loadSessions = async () => {
    try {
      const response = await listRealtimeSessions({ session_type: "meeting" });
      const data = apiData(response, []);
      setSessions(Array.isArray(data) ? data : []);
      setError("");
    } catch (err) {
      setError(apiMessage(err, "Unable to load meeting sessions."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await listLiveClasses();
        if (!active) return;
        const payload = apiData(response, []);
        const rows = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.results)
            ? payload.results
            : [];
        setLiveClassOptions(
          [...rows].sort((a, b) => {
            const monthDelta = Number(a?.month_number || 0) - Number(b?.month_number || 0);
            if (monthDelta !== 0) return monthDelta;
            return String(a?.title || "").localeCompare(String(b?.title || ""));
          })
        );
      } catch {
        if (!active) return;
        setLiveClassOptions([]);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const orderedSessions = useMemo(() => {
    return [...sessions].sort((a, b) => {
      const statusWeight = { live: 1, scheduled: 2, ended: 3 };
      const aWeight = statusWeight[a.status] || 4;
      const bWeight = statusWeight[b.status] || 4;
      if (aWeight !== bWeight) return aWeight - bWeight;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [sessions]);

  const joinSession = async (sessionId) => {
    const response = await joinRealtimeSession(sessionId, {
      display_name: user?.full_name || "",
    });
    const data = apiData(response, {});

    if (data.mode === "broadcast") {
      navigate(`/broadcasting?session=${sessionId}`, {
        state: { autoJoinPayload: data },
      });
      return data;
    }

    setActiveMeeting(data);
    return data;
  };

  const handleCreate = async (event) => {
    event.preventDefault();
    if (!form.linked_live_class_id) {
      setCreateState({ loading: false, error: "Select the linked live class for this meeting.", success: "" });
      return;
    }
    setCreateState({ loading: true, error: "", success: "" });

    try {
      const payload = {
        title: form.title,
        description: form.description,
        linked_live_class_id: Number(form.linked_live_class_id),
        session_type: "meeting",
        meeting_capacity: Number(form.meeting_capacity || 300),
        allow_overflow_broadcast: true,
        max_audience: 50000,
      };
      const response = await createRealtimeSession(payload);
      const created = apiData(response, null);
      if (created) {
        setSessions((prev) => [created, ...prev]);
        await joinSession(created.id);
      }
      setForm(initialForm);
      setJoinState({ loadingId: null, error: "" });
      setCreateState({ loading: false, error: "", success: "Meeting created and control opened." });
      await loadSessions();
    } catch (err) {
      setCreateState({ loading: false, error: apiMessage(err, "Unable to create meeting."), success: "" });
    }
  };

  const handleJoin = async (sessionId) => {
    setJoinState({ loadingId: sessionId, error: "" });

    try {
      await joinSession(sessionId);
      setJoinState({ loadingId: null, error: "" });
      await loadSessions();
    } catch (err) {
      setJoinState({ loadingId: null, error: apiMessage(err, "Unable to join meeting.") });
    }
  };

  const handleDeleteSession = async (session) => {
    const confirmed = window.confirm(`Delete "${session.title}"? This will end the live session.`);
    if (!confirmed) {
      return;
    }

    setDeleteState({ loadingId: session.id, error: "", info: "" });
    try {
      await endRealtimeSession(session.id);
      setSessions((prev) => prev.filter((row) => row.id !== session.id));
      if (activeMeeting?.session?.id === session.id) {
        setActiveMeeting(null);
      }
      setDeleteState({ loadingId: null, error: "", info: "Session deleted." });
    } catch (err) {
      setDeleteState({ loadingId: null, error: apiMessage(err, "Unable to delete session."), info: "" });
    }
  };

  return (
    <PageShell title="" subtitle="">
      <section className="relative mb-6 overflow-hidden rounded-[30px] border border-black bg-[#080808] shadow-[0_26px_70px_rgba(0,0,0,0.35)]">
        <div className="absolute inset-0">
          <img
            src={pageBackgroundImage}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover opacity-[0.16]"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-black/88 via-black/78 to-[#111111]/94" />
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_12%,rgba(192,192,192,0.12),transparent_36%)]" />
          <div className="absolute inset-0 opacity-15 [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:26px_26px]" />
        </div>

        <div className="relative space-y-6 p-5 sm:p-6">
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <div className="inline-flex items-center rounded-full border border-black bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.14em] text-[#DBDBDB]">
                MEETING MODE
              </div>
              <h1 className="mt-4 max-w-3xl font-reference text-3xl font-semibold leading-tight text-white sm:text-4xl">
                Focused rooms for live teaching and real-time collaboration
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-[#BBBBBB]">
                Keep sessions interactive with camera and microphone for up to 300 active
                participants. Additional attendees are routed to broadcast mode automatically.
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {meetingHeroHighlights.map((item) => (
                  <span
                    key={item}
                    className="rounded-full border border-black bg-[#131313]/88 px-3 py-1 text-xs text-[#DADADA]"
                  >
                    {item}
                  </span>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border border-black panel-gradient p-4 shadow-[0_16px_40px_rgba(0,0,0,0.28)] backdrop-blur-sm sm:p-5">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9A9A9A]">
                Start A Meeting
              </div>
              {isAuthenticated ? (
                <form onSubmit={handleCreate} className="mt-3 space-y-3">
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-[#949494]">
                      Linked Live Class
                    </label>
                    <select
                      className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                      value={form.linked_live_class_id}
                      onChange={(e) => setForm((prev) => ({ ...prev, linked_live_class_id: e.target.value }))}
                      required
                    >
                      <option value="">Select live class</option>
                      {liveClassOptions.map((liveClass) => (
                        <option key={liveClass.id} value={liveClass.id}>
                          {`${liveClass.title}${liveClass.linked_course_title ? ` - ${liveClass.linked_course_title}` : ""}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                    placeholder="Session title"
                    value={form.title}
                    onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                    required
                  />
                  <textarea
                    className="min-h-[96px] w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                    placeholder="Session description"
                    value={form.description}
                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                  />
                  <div>
                    <label className="mb-1 block text-[11px] uppercase tracking-[0.14em] text-[#949494]">
                      Interactive Capacity
                    </label>
                    <input
                      type="number"
                      min={2}
                      max={300}
                      className="w-full rounded-xl border border-black bg-[#101010] px-3 py-2 text-sm text-white outline-none focus:border-[#999999]"
                      value={form.meeting_capacity}
                      onChange={(e) => setForm((prev) => ({ ...prev, meeting_capacity: e.target.value }))}
                    />
                  </div>
                  <Button type="submit" className="w-full" loading={createState.loading}>
                    Create Meeting
                  </Button>
                  {createState.error ? <p className="text-xs text-red-300">{createState.error}</p> : null}
                  {createState.success ? <p className="text-xs text-zinc-300">{createState.success}</p> : null}
                </form>
              ) : (
                <div className="mt-4 space-y-3">
                  <p className="text-sm text-[#CBCBCB]">Login to create or join meeting rooms.</p>
                  <Link to="/login" state={{ from: "/meeting" }} className="inline-block">
                    <Button>Login</Button>
                  </Link>
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-black panel-gradient p-4 sm:p-5">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#949494]">
              Meeting Workflow
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {meetingWorkflow.map((item, index) => (
                <article key={item.step} className="rounded-xl border border-black panel-gradient p-3">
                  <div className="text-xs font-semibold text-[#DCDCDC]">{`0${index + 1}  ${item.step}`}</div>
                  <p className="mt-2 text-xs leading-6 text-[#B9B9B9]">{item.detail}</p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {joinState.error ? (
        <div className="mb-4 rounded-xl border border-red-300/30 bg-red-200/10 px-4 py-3 text-sm text-red-200">
          {joinState.error}
        </div>
      ) : null}

      {deleteState.error ? (
        <div className="mb-4 rounded-xl border border-red-300/30 bg-red-200/10 px-4 py-3 text-sm text-red-200">
          {deleteState.error}
        </div>
      ) : null}

      {deleteState.info ? (
        <div className="mb-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
          {deleteState.info}
        </div>
      ) : null}

      {activeMeeting?.mode === "meeting" ? (
        <MeetingRoomExperience payload={activeMeeting} onLeave={() => setActiveMeeting(null)} />
      ) : null}

      <section className="rounded-[26px] border border-black panel-gradient p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="font-reference text-xl font-semibold text-white">Meeting Rooms</h3>
            <p className="mt-1 text-xs text-[#949494]">Join active rooms or schedule a new instructor session.</p>
          </div>
          <span className="text-xs text-[#949494]">
            {loading ? "Loading..." : `${orderedSessions.length} room${orderedSessions.length === 1 ? "" : "s"}`}
          </span>
        </div>

        {isAuthenticated ? (
          <>
            {error ? (
              <div className="mb-4 rounded-xl border border-amber-300/30 bg-amber-100/10 px-4 py-3 text-sm text-amber-200">
                {error}
              </div>
            ) : null}
            {orderedSessions.length > 0 ? (
              <div className="space-y-3">
                {orderedSessions.map((session) => (
                  <article
                    key={session.id}
                    className="grid gap-3 rounded-2xl border border-black panel-gradient p-4 shadow-[0_14px_34px_rgba(0,0,0,0.22)] md:grid-cols-[1fr_auto] md:items-center"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="font-reference text-lg text-white">{session.title}</h4>
                        <span className="rounded-full border border-black bg-[#171717] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#CDCDCD]">
                          {session.status}
                        </span>
                        {session.linked_live_class?.title ? (
                          <span className="rounded-full border border-black bg-[#171717] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#CDCDCD]">
                            {session.linked_live_class.title}
                          </span>
                        ) : null}
                        {session.linked_course?.title ? (
                          <span className="rounded-full border border-black bg-[#171717] px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-[#CDCDCD]">
                            {session.linked_course.title}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-sm leading-6 text-[#BBBBBB]">
                        {session.description || "Interactive instructor-led meeting session."}
                      </p>
                    </div>
                    <div className="grid w-full gap-2 sm:grid-cols-2 md:w-[240px] md:grid-cols-1">
                      <Button
                        className="w-full"
                        loading={joinState.loadingId === session.id}
                        onClick={() => handleJoin(session.id)}
                      >
                        {session.is_host ? "Open Meeting Control" : "Join Meeting"}
                      </Button>
                      {session.is_host ? (
                        <Button
                          variant="danger"
                          className="w-full"
                          onClick={() => handleDeleteSession(session)}
                          loading={deleteState.loadingId === session.id}
                        >
                          Delete Session
                        </Button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
                No meeting rooms are available yet. Create one from the panel above.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="grid gap-4 lg:grid-cols-3">
              {meetingMarketingCards.map((card) => (
                <article
                  key={card.title}
                  className="rounded-2xl border border-black panel-gradient p-4 shadow-[0_14px_34px_rgba(0,0,0,0.22)]"
                >
                  <h4 className="font-reference text-lg text-white">{card.title}</h4>
                  <p className="mt-2 text-sm text-[#BBBBBB]">{card.description}</p>
                </article>
              ))}
            </div>
            <div className="mt-4 rounded-xl border border-black bg-[#161616] px-4 py-3 text-sm text-[#D9D9D9]">
              {loading
                ? "Preparing meeting schedule..."
                : "Sign in to access interactive rooms. Public view intentionally shows a marketing overview."}
              {error ? " Live meeting data is temporarily unavailable." : ""}
            </div>
          </>
        )}
      </section>
    </PageShell>
  );
}
