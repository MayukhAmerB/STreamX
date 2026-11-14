// Hand-built data viz: a figure, a caption and a real table every time.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BarList, Sparkline, StatTile } from ".";

describe("BarList", () => {
  const data = [
    { label: "Week of 2-8 Nov", value: 6 },
    { label: "Week of 9-15 Nov", value: 8.5, highlight: true },
  ];

  it("is a figure with a caption and the values as a table", () => {
    const html = renderToStaticMarkup(<BarList caption="Marks by week" data={data} target={7} max={10} />);
    expect(html).toMatch(/^<figure class="sc-bar-list">/);
    expect(html).toContain('<figcaption class="sc-chart__caption">Marks by week</figcaption>');
    expect(html).toMatch(/<table class="sc-visually-hidden"><caption>Marks by week<\/caption>/);
    expect(html).toContain("<th scope=\"row\">Week of 9-15 Nov</th><td>8.5</td>");
    expect(html).toContain("<th scope=\"row\">Target</th><td>7</td>");
  });

  it("grows bars with transform only, marks the current series and draws the target tick", () => {
    const html = renderToStaticMarkup(<BarList caption="Marks" data={data} target={7} max={10} />);
    expect(html).toContain("sc-bar-list__row--you");
    expect(html).toMatch(/class="sc-bar-list__bar" style="transform:scaleX\(0\)/);
    expect(html).not.toMatch(/style="[^"]*width:/);
    expect(html).toContain('class="sc-bar-list__target" style="left:70%"');
  });
});

describe("Sparkline", () => {
  it("draws a polyline with the last point as a dot, plus a table", () => {
    const html = renderToStaticMarkup(<Sparkline caption="Enrolments this week" points={[1, 3, 2, 5]} />);
    expect(html).toContain("<polyline");
    expect(html).toContain('<circle class="sc-sparkline__dot"');
    expect(html).toContain("<figcaption");
    expect(html).toContain("<th scope=\"row\">4</th><td>5</td>");
  });
});

describe("StatTile", () => {
  it("shows the delta with an arrow glyph and words, never colour alone", () => {
    const up = renderToStaticMarkup(<StatTile label="Average" value="7.8 / 10" delta={12} />);
    expect(up).toContain("sc-stat-tile__delta--up");
    expect(up).toContain("▲");
    expect(up).toContain('<span class="sc-visually-hidden">up </span>12%');
    const down = renderToStaticMarkup(<StatTile label="Late" value={3} delta="-4%" />);
    expect(down).toContain("▼");
    expect(down).toContain("down ");
  });
});
