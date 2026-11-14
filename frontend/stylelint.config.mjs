// Motion performance rule (UI overhaul plan §2.4). OWNER: WS-A.
// Only transform and opacity animate (colour transitions <= 110 ms are fine;
// stroke-dashoffset on icons <= 24 px is fine). Transitions and keyframes
// must never animate layout or paint-heavy properties.
//
// This is a standard stylelint config, ready for when stylelint is added as a
// dev dependency. Until then the same rule runs without any dependency in
// `npm run lint:motion` (scripts/check-motion.mjs reads BANNED_MOTION_PROPERTIES
// from this file) and is part of `npm run lint`.

/** Properties that must never be transitioned or animated. */
export const BANNED_MOTION_PROPERTIES = [
  "all",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "inline-size",
  "block-size",
  "min-inline-size",
  "max-inline-size",
  "min-block-size",
  "max-block-size",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "margin-block",
  "margin-block-start",
  "margin-block-end",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
  "padding-block",
  "padding-block-start",
  "padding-block-end",
  "inset",
  "inset-inline",
  "inset-inline-start",
  "inset-inline-end",
  "inset-block",
  "inset-block-start",
  "inset-block-end",
  "top",
  "right",
  "bottom",
  "left",
  "flex-basis",
  "flex",
  "grid-template",
  "grid-template-columns",
  "grid-template-rows",
  "box-shadow",
  "background-position",
  "background-size",
  "filter",
  "backdrop-filter",
];

const alternation = BANNED_MOTION_PROPERTIES.map((name) => name.replace(/-/g, "\\-")).join("|");

export default {
  // Applies to frontend/src/**/*.{css,scss} and the Django admin's enterprise.css.
  rules: {
    "declaration-property-value-disallowed-list": {
      transition: [new RegExp(`(^|,)\\s*(${alternation})(\\s|,|$)`)],
      "transition-property": [new RegExp(`(^|,)\\s*(${alternation})(\\s|,|$)`)],
    },
    // Inside @keyframes only transform, opacity, colours and stroke-dashoffset may change.
    "keyframe-declaration-no-important": true,
  },
};
