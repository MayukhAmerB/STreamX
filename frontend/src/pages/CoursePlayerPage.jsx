import { useParams } from "react-router-dom";
import CoursePlayer from "../features/course-player/CoursePlayer";

/** /learn/:courseId — the Carbon course player (see features/course-player). */
export default function CoursePlayerPage() {
  const { courseId } = useParams();
  // Remount per course so playback, progress and engagement state never leak across courses.
  return <CoursePlayer key={courseId} courseId={courseId} />;
}
