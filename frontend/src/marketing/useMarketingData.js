// One place for what the public pages read: the existing course list
// (GET /api/courses/?catalog=current, cached; unchanged data source) plus the
// public catalogue contract (gates, plans, stats, labs). The tiers always come
// from the course list's `tier` field; the catalogue only renames them.
import { useMemo } from "react";

import { useLandingCatalog } from "../pages/landing/useLandingData";
import { pentestingGate, useCatalog } from "./catalogApi";
import { groupPentestingTiers, moduleCount, osintCourses, PENTESTING_TIERS } from "./tiers";

export function tiersFromData(courses, catalogTiers = []) {
  const groups = groupPentestingTiers(courses);
  const byKey = new Map((catalogTiers || []).map((tier) => [tier.key, tier]));
  return groups.map((group) => {
    const server = byKey.get(group.key);
    return server ? { ...group, label: server.title || group.label, summary: server.summary || group.summary } : group;
  });
}

/** Totals for stat strips: server stats when present, else counted from the courses. */
export function catalogStats(courses, stats = {}) {
  const list = Array.isArray(courses) ? courses : [];
  const pick = (key, fallback) => (Number.isFinite(Number(stats?.[key])) && stats?.[key] !== null && stats?.[key] !== undefined ? Number(stats[key]) : fallback);
  return {
    courses: pick("course_count", list.length),
    modules: pick("module_count", list.reduce((sum, course) => sum + moduleCount(course), 0)),
    freeChallenges: pick("free_challenge_count", null),
    liveCohorts: pick("live_cohort_count", osintCourses(list).length),
    pentestingCourses: list.filter((course) => course?.category === "web_pentesting").length,
    pentestingModules: list.filter((course) => course?.category === "web_pentesting").reduce((sum, course) => sum + moduleCount(course), 0),
  };
}

export function useMarketingData() {
  const courses = useLandingCatalog();
  const catalog = useCatalog();
  return useMemo(() => {
    const gate = pentestingGate(catalog, courses.tracks);
    const tiers = tiersFromData(courses.courses, catalog.tiers);
    return {
      courses,
      catalog,
      gate,
      tiers,
      osint: osintCourses(courses.courses),
      stats: catalogStats(courses.courses, catalog.stats),
      tierCount: PENTESTING_TIERS.length,
    };
  }, [courses, catalog]);
}
