import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ClassDetailsCard, { classDetailsPayload, initialClassDetails, NEW_MODULE } from "./ClassDetailsCard";

const session = {
  id: 251,
  title: "OSINT Batch IV · Friday 27 Nov",
  status: "scheduled",
  lecture_title: "Google dorking",
  description: "Operators",
  target_module: { id: 9, title: "OSINT BEGINNER - GOOGLE DORKING" },
};

describe("class details name the recorded lecture", () => {
  it("starts from the saved topic, description and module", () => {
    expect(initialClassDetails(session)).toEqual({
      topic: "Google dorking",
      description: "Operators",
      module: "9",
      newModule: "",
    });
    expect(initialClassDetails({ id: 1 })).toEqual({ topic: "", description: "", module: "", newModule: "" });
  });

  it("sends an existing module by id, or a new module by name", () => {
    expect(classDetailsPayload({ topic: " Tor ", description: " ", module: "9", newModule: "" })).toEqual({
      topic: "Tor",
      description: "",
      module_id: 9,
    });
    expect(classDetailsPayload({ topic: "Tor", description: "", module: NEW_MODULE, newModule: " DARK WEB " })).toEqual({
      topic: "Tor",
      description: "",
      new_module_title: "DARK WEB",
    });
    expect(classDetailsPayload({ topic: "Tor", description: "", module: "", newModule: "" })).toEqual({
      topic: "Tor",
      description: "",
    });
  });

  it("renders the topic, module and description fields with the current module listed", () => {
    const html = renderToStaticMarkup(<ClassDetailsCard session={session} moduleOptions={[{ id: 3, title: "Recon" }]} />);
    expect(html).toContain("Class details");
    expect(html).toContain("Topic (lecture title)");
    expect(html).toContain("OSINT BEGINNER - GOOGLE DORKING");
    expect(html).toContain("Recon");
    expect(html).toContain("New module…");
    expect(html).toContain("Save details");
  });

  it("tells the host an ended class's recording is renamed", () => {
    const html = renderToStaticMarkup(<ClassDetailsCard session={{ ...session, status: "ended" }} />);
    expect(html).toContain("renames and moves the recording already published");
  });
});
