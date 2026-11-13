import { Children, useCallback, useEffect, useId, useRef, useState } from "react";

import { ChevronLeftIcon, ChevronRightIcon } from "./icons";
import { cx, prefersReducedMotion } from "./utils";

/**
 * Horizontal carousel (plan §7.3 Bestsellers): native scrolling with
 * scroll-snap, so touch swipe and trackpads work; visible previous/next
 * buttons; the track is a focusable, labelled region that pages with the
 * arrow keys (Home/End jump to the ends). Slides per view come from CSS:
 * `perView` = { sm, md, lg } (default 1 / 2 / 4).
 *
 * Previous/next are aria-disabled (never removed) at the ends, so their
 * labels stay discoverable. When every slide already fits (measured, also on
 * resize), there is nothing to page and the buttons are not shown. Labels are configurable to keep existing copy.
 * `toolbar` (optional) sits at the start of the controls row, e.g. a sort note.
 */
export default function Carousel({
  label,
  children,
  perView = { sm: 1, md: 2, lg: 4 },
  previousLabel = "Previous",
  nextLabel = "Next",
  toolbar = null,
  className,
  ...rest
}) {
  const trackRef = useRef(null);
  const trackId = useId();
  const slides = Children.toArray(children).filter(Boolean);
  // `fits` is only true once measured with a real width (unknown keeps the buttons).
  const [edges, setEdges] = useState({ atStart: true, atEnd: slides.length <= 1, fits: false });

  const measure = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const max = Math.max(0, (track.scrollWidth || 0) - (track.clientWidth || 0));
    const left = track.scrollLeft || 0;
    const fits = (track.clientWidth || 0) > 0 && max <= 1;
    setEdges((previous) => {
      const next = { atStart: left <= 1, atEnd: max <= 1 || left >= max - 1, fits };
      return previous.atStart === next.atStart && previous.atEnd === next.atEnd && previous.fits === next.fits ? previous : next;
    });
  }, []);

  useEffect(() => {
    measure();
    if (typeof window === "undefined") return undefined;
    window.addEventListener?.("resize", measure);
    const observer =
      typeof window.ResizeObserver === "function" && trackRef.current ? new window.ResizeObserver(() => measure()) : null;
    if (observer) observer.observe(trackRef.current);
    return () => {
      window.removeEventListener?.("resize", measure);
      observer?.disconnect();
    };
  }, [measure, slides.length]);

  const page = (direction) => {
    const track = trackRef.current;
    if (!track || typeof track.scrollBy !== "function") return;
    track.scrollBy({
      left: direction * Math.max(track.clientWidth || 0, 1),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  const jump = (toEnd) => {
    const track = trackRef.current;
    if (!track || typeof track.scrollTo !== "function") return;
    track.scrollTo({ left: toEnd ? track.scrollWidth : 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget) return; // keys inside a slide (links) keep their meaning
    const actions = { ArrowLeft: () => page(-1), ArrowRight: () => page(1), Home: () => jump(false), End: () => jump(true) };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  const control = (direction) => {
    const disabled = direction < 0 ? edges.atStart : edges.atEnd;
    return (
      <button
        type="button"
        className="sk-carousel__control"
        aria-label={direction < 0 ? previousLabel : nextLabel}
        aria-controls={trackId}
        aria-disabled={disabled ? "true" : undefined}
        onClick={() => {
          if (!disabled) page(direction);
        }}
      >
        {direction < 0 ? <ChevronLeftIcon /> : <ChevronRightIcon />}
      </button>
    );
  };

  // Nothing to show: the caller renders its EmptyState instead of an empty rail.
  if (slides.length === 0) return null;

  const style = {
    "--sk-per-view-sm": perView.sm ?? 1,
    "--sk-per-view-md": perView.md ?? 2,
    "--sk-per-view-lg": perView.lg ?? 4,
    "--sk-slide-count": slides.length,
  };
  const showButtons = slides.length > 1 && !edges.fits;

  return (
    <div className={cx("sk-carousel", className)} style={style} {...rest}>
      {toolbar || showButtons ? (
        <div className="sk-carousel__controls">
          {toolbar ? <div className="sk-carousel__toolbar">{toolbar}</div> : null}
          {showButtons ? (
            <div className="sk-carousel__buttons">
              {control(-1)}
              {control(1)}
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        id={trackId}
        ref={trackRef}
        className="sk-carousel__track"
        role="region"
        aria-roledescription="carousel"
        aria-label={label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={measure}
      >
        {slides.map((slide, index) => (
          <div
            key={slide.key ?? index}
            className="sk-carousel__slide"
            role="group"
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${slides.length}`}
          >
            {slide}
          </div>
        ))}
      </div>
    </div>
  );
}
