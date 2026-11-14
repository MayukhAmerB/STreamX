// Questions list (WS-D2): status is icon + word, cards name the course and
// lecture, the list reads both response shapes.
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { describe, expect, it } from "vitest";

import { QUESTION_FILTERS, QuestionCard, questionsPage, QuestionStatus } from ".";

const html = (element) => renderToStaticMarkup(<StaticRouter location="/console/admin/community">{element}</StaticRouter>);

describe("questions", () => {
  it("offers All · New · Reviewed · Answered", () => {
    expect(QUESTION_FILTERS.map((item) => item.label)).toEqual(["All", "New", "Reviewed", "Answered"]);
  });

  it("shows status as an icon and a word", () => {
    const markup = html(<QuestionStatus status="answered" />);
    expect(markup).toContain("<svg");
    expect(markup).toContain("Answered");
  });

  it("renders a question with who, where and a way to the lecture", () => {
    const markup = html(
      <ul>
        <QuestionCard
          question={{
            id: 1,
            question: "Why <b>does</b> this work?",
            status: "new",
            status_label: "New",
            student_name: "Asha Rao",
            student_email: "asha@example.com",
            course_id: 4,
            course_title: "OSINT Foundations",
            lecture_title: "Operators",
            created_at: "2026-11-13T10:00:00Z",
          }}
        />
      </ul>
    );
    expect(markup).toContain("Asha Rao");
    expect(markup).toContain("OSINT Foundations · Operators");
    expect(markup).toContain("Why &lt;b&gt;does&lt;/b&gt; this work?");
    expect(markup).toContain('href="/learn/4"');
  });

  it("reads plain and paginated responses", () => {
    expect(questionsPage([{ id: 1 }])).toEqual({ items: [{ id: 1 }], pagination: null });
    expect(questionsPage({ results: [{ id: 2 }], pagination: { page: 1 } })).toEqual({ items: [{ id: 2 }], pagination: { page: 1 } });
    expect(questionsPage(null)).toEqual({ items: [], pagination: null });
  });
});
