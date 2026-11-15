import "./CoursePlayer.scss";

import { Education } from "@carbon/icons-react";
import { Button, Tab, TabList, TabPanel, TabPanels, Tabs } from "@carbon/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { getCourse } from "../../api/courses";
import { useAuth } from "../../hooks/useAuth";
import { apiData, apiMessage } from "../../utils/api";
import { EmptyState, PageNotification } from "../app-shell/ui";
import { useToast } from "../app-shell/ui/toast";
import { useBreakpoint, useMediaQuery } from "../app-shell/useBreakpoint";
import CommentComposer from "./CommentComposer";
import CommentsPanel from "./CommentsPanel";
import CourseOutline from "./CourseOutline";
import LessonActions from "./LessonActions";
import LessonHeader from "./LessonHeader";
import OverviewPanel from "./OverviewPanel";
import {
  applyLectureProgressSnapshot,
  buildCourseOutline,
  findFirstPreviewLecture,
  findNextPlayableLecture,
  flattenCourseLectures,
  hasFullCourseAccess,
  isLectureLocked,
  pickInitialLecture,
  resolveAdjacentLectures,
  resolveLectureDescriptions,
} from "./outlineModel";
import PlayerSkeleton from "./PlayerSkeleton";
import PlayerStage from "./PlayerStage";
import { NotesPanel, QuestionsPanel } from "./StudyPanels";
import { useCountdown, useElementHeight, useKeyboardInset } from "./useLayoutMetrics";
import { useLectureEngagement } from "./useLectureEngagement";
import { useLecturePlayback } from "./useLecturePlayback";
import { useLectureNotes, useLectureQuestions } from "./useLectureStudyTools";
import { usePlayerShortcuts } from "./usePlayerShortcuts";

export const UP_NEXT_SECONDS = 5;
export const DESKTOP_TABS = ["overview", "comments", "notes", "questions"];
export const MOBILE_TABS = ["lessons", "comments", "overview", "notes", "questions"];
const TAB_LABELS = {
  lessons: "Lessons",
  overview: "Overview",
  comments: "Comments",
  notes: "Notes",
  questions: "Q&A",
};

function useCourse(courseId, preferredLectureId) {
  const [state, setState] = useState({ status: "loading", course: null, message: "", initialLectureId: null });
  const tokenRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++tokenRef.current;
    setState({ status: "loading", course: null, message: "", initialLectureId: null });
    try {
      const course = apiData(await getCourse(courseId));
      if (token !== tokenRef.current) return;
      if (!course) throw new Error("Course not found.");
      setState({
        status: "ready",
        course,
        message: "",
        initialLectureId: pickInitialLecture(course, { preferredLectureId })?.id ?? null,
      });
    } catch (error) {
      if (token !== tokenRef.current) return;
      const status = Number(error?.response?.status) || 0;
      setState({
        status: status === 404 ? "not-found" : "error",
        course: null,
        message: apiMessage(error, "Failed to load course player."),
        initialLectureId: null,
      });
    }
  }, [courseId, preferredLectureId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyProgress = useCallback((lectureId, snapshot) => {
    setState((current) =>
      current.course ? { ...current, course: applyLectureProgressSnapshot(current.course, lectureId, snapshot) } : current
    );
  }, []);

  return { ...state, reload: load, applyProgress };
}

/**
 * Course player: video, lesson actions, tabs (overview, comments, notes,
 * Q&A) and the course outline. Desktop: outline in a right rail. Phones and
 * tablets: sticky video on top and a "Lessons" tab, with the comment box
 * docked above the bottom navigation.
 */
export default function CoursePlayer({ courseId }) {
  const auth = useAuth() || {};
  const user = auth.user || null;
  const isAuthenticated = Boolean(auth.isAuthenticated);
  const { isDesktop } = useBreakpoint();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [preferredLectureId] = useState(() => searchParams.get("lesson"));
  const { showToast } = useToast();

  const courseData = useCourse(courseId, preferredLectureId);
  const { course, applyProgress } = courseData;

  // The learner's pick; until they pick, the course's initial lesson plays.
  const [pickedId, setPickedId] = useState(null);
  const [tabChoice, setTabChoice] = useState(null);
  const [focusRequest, setFocusRequest] = useState(null);
  const [upNext, setUpNext] = useState(null);
  const [completing, setCompleting] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const pageRef = useRef(null);
  const playerRef = useRef(null);
  const dockRef = useRef(null);
  // Panel headings, focused when a tab is opened from elsewhere (e.g. the Comments chip).
  const headingRefs = useRef({
    overview: { current: null },
    comments: { current: null },
    notes: { current: null },
    questions: { current: null },
  }).current;

  // First lecture once the course arrives (deep link, last watched, first
  // playable) is derived synchronously, so nothing renders without it.
  const selectedId = pickedId ?? courseData.initialLectureId;

  // Keep "2h ago" fresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const fullAccess = hasFullCourseAccess(course);
  const orderedLectures = useMemo(() => flattenCourseLectures(course), [course]);
  const currentLecture = useMemo(
    () => orderedLectures.find((lecture) => String(lecture.id) === String(selectedId)) || null,
    [orderedLectures, selectedId]
  );
  const locked = currentLecture ? isLectureLocked(currentLecture, fullAccess) : false;
  const outline = useMemo(() => buildCourseOutline(course, { currentLectureId: selectedId }), [course, selectedId]);
  const adjacent = useMemo(() => resolveAdjacentLectures(orderedLectures, selectedId), [orderedLectures, selectedId]);
  const nextPlayable = useMemo(
    () => findNextPlayableLecture(orderedLectures, selectedId, fullAccess),
    [orderedLectures, selectedId, fullAccess]
  );
  const previewLecture = useMemo(() => (fullAccess ? null : findFirstPreviewLecture(course)), [course, fullAccess]);
  const descriptions = useMemo(() => resolveLectureDescriptions(currentLecture, course), [currentLecture, course]);

  const nextPlayableRef = useRef(nextPlayable);
  nextPlayableRef.current = nextPlayable;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const handleEnded = useCallback(() => {
    const target = nextPlayableRef.current;
    if (!target) return;
    setUpNext({ fromId: selectedIdRef.current, lecture: target });
    setLiveMessage(`Up next: ${target.title || "next lesson"}. Starts in ${UP_NEXT_SECONDS} seconds.`);
  }, []);

  const playback = useLecturePlayback(currentLecture, {
    locked,
    onProgressSaved: applyProgress,
    onEnded: handleEnded,
  });
  const engagement = useLectureEngagement(currentLecture?.id, {
    enabled: isAuthenticated && Boolean(currentLecture) && !locked,
  });
  const studyEnabled = isAuthenticated && Boolean(currentLecture) && !locked;
  const notes = useLectureNotes(currentLecture?.id, { enabled: studyEnabled });
  const questions = useLectureQuestions(currentLecture?.id, { enabled: studyEnabled });

  const { requestAutoStart } = playback;
  const selectLecture = useCallback(
    (lecture, { autoStart = false, scrollToPlayer = false } = {}) => {
      if (!lecture) return;
      setUpNext(null);
      if (String(lecture.id) === String(selectedIdRef.current)) return;
      if (autoStart) requestAutoStart();
      setPickedId(lecture.id);
      setLiveMessage(`Now playing: ${lecture.title || "lesson"}`);
      if (scrollToPlayer && typeof window !== "undefined" && window.scrollY > 0) {
        window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
      }
    },
    [requestAutoStart, reducedMotion]
  );

  const goToPrevious = useCallback(() => selectLecture(adjacent.previous), [adjacent.previous, selectLecture]);
  const goToNext = useCallback(() => selectLecture(adjacent.next), [adjacent.next, selectLecture]);

  usePlayerShortcuts({
    videoRef: playback.videoRef,
    containerRef: pageRef,
    onNext: goToNext,
    onPrevious: goToPrevious,
    enabled: courseData.status === "ready",
  });

  // Up next: 5-second countdown, cancellable, after the video ends.
  const upNextActive = Boolean(upNext && String(upNext.fromId) === String(selectedId));
  const secondsLeft = useCountdown(upNextActive, UP_NEXT_SECONDS, () => {
    if (upNext) selectLecture(upNext.lecture, { autoStart: true });
  });

  // Tabs.
  const tabIds = isDesktop ? DESKTOP_TABS : MOBILE_TABS;
  const activeTab = tabChoice && tabIds.includes(tabChoice) ? tabChoice : tabIds[0];
  const openTab = useCallback((id, { focus = false } = {}) => {
    setTabChoice(id);
    if (focus) setFocusRequest({ id, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!focusRequest || focusRequest.id !== activeTab) return;
    const heading = headingRefs[activeTab]?.current;
    if (!heading) return;
    heading.focus?.({ preventScroll: true });
    heading.scrollIntoView?.({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    setFocusRequest(null);
  }, [focusRequest, activeTab, reducedMotion, headingRefs]);

  // Phone layout metrics: sticky player height and the docked composer.
  const showDockedComposer =
    !isDesktop &&
    activeTab === "comments" &&
    isAuthenticated &&
    Boolean(currentLecture) &&
    !locked &&
    engagement.summaryStatus !== "forbidden";
  const playerHeight = useElementHeight(playerRef, !isDesktop && courseData.status === "ready");
  const dockHeight = useElementHeight(dockRef, showDockedComposer);
  const keyboardInset = useKeyboardInset(showDockedComposer);

  const author = useMemo(
    () => ({
      id: user?.id ?? null,
      display_name: user?.full_name || user?.email?.split("@")[0] || "You",
      is_instructor: Boolean(user && course?.instructor?.id === user.id),
    }),
    [user, course?.instructor?.id]
  );

  const completed = Boolean(currentLecture?.progress?.completed);
  const toggleComplete = useCallback(async () => {
    if (!currentLecture || completing) return;
    const lectureId = currentLecture.id;
    const previous = currentLecture.progress || null;
    const target = !previous?.completed;
    setCompleting(true);
    applyProgress(lectureId, { ...(previous || {}), completed: target });
    const result = await playback.setCompleted(target);
    setCompleting(false);
    if (result?.status === "error") {
      applyProgress(lectureId, previous);
      showToast({ kind: "error", title: "Couldn't update this lesson", subtitle: "Check your connection and try again." });
    } else if (result?.status === "saved" && !target && result.snapshot?.completed) {
      showToast({ kind: "info", title: "This lesson stays complete", subtitle: "You've already watched most of it." });
    }
  }, [currentLecture, completing, applyProgress, playback, showToast]);

  const loginState = useMemo(() => ({ from: location.pathname + location.search }), [location.pathname, location.search]);
  const enrollHref = courseId ? `/courses/${courseId}` : "";

  if (courseData.status === "loading") {
    return <PlayerSkeleton desktop={isDesktop} />;
  }

  if (courseData.status === "not-found") {
    return (
      <div className="cp-page cp-page--message">
        <EmptyState
          icon={Education}
          text="This course isn't available. It may have been moved or unpublished."
          action={
            <Button as={Link} to="/my-courses" kind="primary">
              Go to My courses
            </Button>
          }
        />
      </div>
    );
  }

  if (courseData.status === "error") {
    return (
      <div className="cp-page cp-page--message">
        <PageNotification
          kind="error"
          title="Couldn't load this course."
          subtitle={courseData.message}
          actionLabel="Try again"
          onAction={courseData.reload}
        />
      </div>
    );
  }

  if (!orderedLectures.length) {
    return (
      <div className="cp-page cp-page--message">
        <h1 className="cp-lesson-header__title cp-page__title">{course?.title}</h1>
        <EmptyState
          icon={Education}
          text="No lessons have been published in this course yet."
          action={
            <Button as={Link} to={`/courses/${courseId}/live`} kind="primary">
              See live classes
            </Button>
          }
        />
      </div>
    );
  }

  const outlineProps = {
    outline,
    courseId,
    courseTitle: course?.title,
    currentLectureId: selectedId,
  };

  const panels = {
    lessons: () => (
      <CourseOutline
        {...outlineProps}
        headingId="cp-panel-heading-lessons"
        onSelect={(lecture) => selectLecture(lecture)}
      />
    ),
    overview: () => (
      <OverviewPanel
        ref={headingRefs.overview}
        lecture={currentLecture}
        descriptions={descriptions}
        resources={locked ? [] : currentLecture?.resources || []}
        progress={currentLecture?.progress}
        locked={locked}
        showShortcuts={isDesktop && !locked}
      />
    ),
    comments: () => (
      <CommentsPanel
        ref={headingRefs.comments}
        engagement={engagement}
        isAuthenticated={isAuthenticated}
        locked={locked}
        enrollHref={enrollHref}
        loginState={loginState}
        author={author}
        docked={!isDesktop}
        now={now}
      />
    ),
    notes: () => <NotesPanel ref={headingRefs.notes} notes={notes} locked={locked || !isAuthenticated} />,
    questions: () => (
      <QuestionsPanel ref={headingRefs.questions} questions={questions} locked={locked || !isAuthenticated} now={now} />
    ),
  };

  const pageStyle = {
    "--cp-player-height": `${isDesktop ? 0 : playerHeight}px`,
    "--cp-dock-height": `${showDockedComposer ? dockHeight : 0}px`,
  };

  return (
    <div
      ref={pageRef}
      className={`cp-page${showDockedComposer ? " has-dock" : ""}`}
      data-layout={isDesktop ? "desktop" : "mobile"}
      style={pageStyle}
    >
      <p className="cds--visually-hidden" aria-live="polite">
        {liveMessage}
      </p>
      <div className="cp-layout">
        <div className="cp-main">
          <section ref={playerRef} className="cp-player" aria-label="Video player">
            <PlayerStage
              playback={playback}
              lecture={currentLecture}
              locked={locked}
              enrollHref={enrollHref}
              previewLecture={previewLecture}
              onWatchPreview={(lecture) => selectLecture(lecture)}
              loginState={loginState}
              onVideoPlay={() => setUpNext(null)}
              upNext={
                upNextActive
                  ? {
                      lecture: upNext.lecture,
                      secondsLeft,
                      onPlayNow: () => selectLecture(upNext.lecture, { autoStart: true }),
                      onCancel: () => setUpNext(null),
                    }
                  : null
              }
            />
          </section>

          <div className="cp-body">
            <LessonHeader
              lecture={currentLecture}
              position={adjacent.index + 1}
              total={adjacent.total}
              locked={locked}
              fullAccess={fullAccess}
            />
            <LessonActions
              engagement={engagement}
              isAuthenticated={isAuthenticated}
              locked={locked}
              loginState={loginState}
              previousLecture={adjacent.previous}
              nextLecture={adjacent.next}
              onPrevious={goToPrevious}
              onNext={goToNext}
              onOpenComments={() => openTab("comments", { focus: true })}
              completed={completed}
              completing={completing}
              onToggleComplete={toggleComplete}
            />
            {playback.progressStatus.state === "error" || playback.progressStatus.state === "throttled" ? (
              <PageNotification
                kind="warning"
                title="Progress not saved yet."
                subtitle={playback.progressStatus.message}
              />
            ) : null}

            <div className="cp-tabs">
              <Tabs
                selectedIndex={tabIds.indexOf(activeTab)}
                onChange={({ selectedIndex }) => openTab(tabIds[selectedIndex])}
              >
                <TabList aria-label="Lesson sections" className="cp-tabs__list">
                  {tabIds.map((id) => (
                    <Tab key={id} className="cp-tabs__tab">
                      {TAB_LABELS[id]}
                    </Tab>
                  ))}
                </TabList>
                <TabPanels>
                  {tabIds.map((id) => (
                    <TabPanel key={id} className="cp-tabs__panel">
                      {panels[id]()}
                    </TabPanel>
                  ))}
                </TabPanels>
              </Tabs>
            </div>
          </div>
        </div>

        {isDesktop ? (
          <aside className="cp-rail" aria-labelledby="cp-outline-title">
            <CourseOutline
              {...outlineProps}
              autoScrollToCurrent
              onSelect={(lecture) => selectLecture(lecture, { scrollToPlayer: true })}
            />
          </aside>
        ) : null}
      </div>

      {showDockedComposer ? (
        <div
          ref={dockRef}
          className="cp-dock"
          style={{ "--cp-keyboard-inset": `${keyboardInset}px` }}
        >
          <CommentComposer
            key={currentLecture.id}
            variant="docked"
            author={author}
            placeholder="Add a comment…"
            onSubmit={(body) => engagement.addComment(body, author)}
          />
        </div>
      ) : null}
    </div>
  );
}
