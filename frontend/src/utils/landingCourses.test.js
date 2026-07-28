import { describe, expect, it } from "vitest";

import { selectHeroProgramCourse, selectLandingCourses } from "./landingCourses";

describe("selectLandingCourses", () => {
  it("includes open live courses and registration-closed previous batches", () => {
    const courses = selectLandingCourses([
      { id: 1, title: "Current course", launch_status: "live", registration_closed: false },
      {
        id: 2,
        title: "Previous batch",
        launch_status: "coming_soon",
        registration_closed: true,
      },
      { id: 3, title: "Future course", launch_status: "coming_soon", registration_closed: false },
    ]);

    expect(courses.map((course) => course.id)).toEqual([1, 2]);
  });

  it("keeps open enrollment programs before closed batches", () => {
    const courses = selectLandingCourses([
      { id: 2, title: "Archived batch", launch_status: "live", registration_closed: true },
      { id: 1, title: "Open batch", launch_status: "live", registration_closed: false },
    ]);

    expect(courses.map((course) => course.id)).toEqual([1, 2]);
  });
});

describe("selectHeroProgramCourse", () => {
  const featuredCourse = {
    id: 20,
    title: "Current public course",
    purchase_available: true,
  };

  it("prioritizes the newest active course returned by the student library", () => {
    const selected = selectHeroProgramCourse({
      featuredCourse,
      catalogCourses: [
        featuredCourse,
        { id: 11, title: "Previously purchased course", purchase_available: false },
      ],
      studentCourses: [
        { id: 11, title: "Previously purchased course", access_source: "purchased" },
      ],
    });

    expect(selected).toMatchObject({
      id: 11,
      title: "Previously purchased course",
      is_enrolled: true,
      enrollment_status: "approved",
    });
  });

  it("keeps the featured course for visitors without active course access", () => {
    expect(
      selectHeroProgramCourse({
        featuredCourse,
        catalogCourses: [featuredCourse],
        studentCourses: [],
      })
    ).toBe(featuredCourse);
  });
});
