import { Information, PlayFilledAlt, Video } from "@carbon/icons-react";
import { Button, ProgressBar, Tag, Tile } from "@carbon/react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { resolveCourseArtwork, resolveCourseArtworkFallback } from "../../utils/courseArtwork";
import { formatCourseCategory, getCourseActionLabel, getCourseProgress } from "../../utils/courseProgress";

/**
 * One owned course: artwork, title, progress and a single clear primary
 * action (Start / Continue / Review), with Live and Details as secondary.
 */
export default function CourseProgressTile({ course }) {
  const courseId = Number(course?.id || 0);
  const title = course?.title || "Your course";
  const progress = getCourseProgress(course);
  const [artwork, setArtwork] = useState(() => resolveCourseArtwork(course));
  const fallbackArtwork = resolveCourseArtworkFallback(course?.category);

  useEffect(() => {
    setArtwork(resolveCourseArtwork({ category: course?.category, thumbnail: course?.thumbnail }));
  }, [course?.category, course?.thumbnail]);

  return (
    <Tile className="cds-course-tile">
      <div className="cds-course-tile__media">
        {artwork ? (
          <img
            src={artwork}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setArtwork(fallbackArtwork && artwork !== fallbackArtwork ? fallbackArtwork : "")}
          />
        ) : null}
      </div>
      <div className="cds-course-tile__body">
        <div className="cds-course-tile__tags">
          <Tag type="blue" size="sm">
            {formatCourseCategory(course?.category)}
          </Tag>
          {progress.status === "completed" ? (
            <Tag type="green" size="sm">
              Completed
            </Tag>
          ) : null}
        </div>
        <h2 className="cds-course-tile__title">{title}</h2>
        <ProgressBar
          className="cds-course-tile__progress"
          label={`${progress.percent}% complete`}
          helperText={progress.summary}
          value={progress.percent}
          size="small"
          status={progress.status === "completed" ? "finished" : "active"}
        />
        <div className="cds-course-tile__actions">
          <Button
            as={Link}
            to={`/learn/${courseId}`}
            renderIcon={PlayFilledAlt}
            className="cds-course-tile__primary"
            aria-label={`${getCourseActionLabel(progress)}: ${title}`}
          >
            {getCourseActionLabel(progress)}
          </Button>
          <Button as={Link} to={`/courses/${courseId}/live`} kind="ghost" renderIcon={Video}>
            Live
          </Button>
          <Button as={Link} to={`/courses/${courseId}`} kind="ghost" renderIcon={Information}>
            Details
          </Button>
        </div>
      </div>
    </Tile>
  );
}
