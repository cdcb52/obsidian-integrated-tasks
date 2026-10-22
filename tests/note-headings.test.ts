import { describe, expect, it } from "vitest";
import { addSection, moveSection } from "../src/note-headings";
import { scanSections } from "../src/structure";

const heading = (content: string, name: string, level = 2) => scanSections(content, level).find(item => item.name === name)!;

describe("adding a heading at the end of a note", () => {
  it("adds it after the last line, a blank line apart, keeping the note's last newline", () => {
    expect(addSection("---\ntags: [project]\n---\n- [ ] Intro\n", "Launch", 2)).toBe("---\ntags: [project]\n---\n- [ ] Intro\n\n## Launch\n");
    expect(addSection("## Plan\n- [ ] A", "Launch", 1)).toBe("## Plan\n- [ ] A\n\n# Launch");
    // Blank lines at the end are not doubled.
    expect(addSection("- [ ] A\n\n\n", "Launch", 2)).toBe("- [ ] A\n\n## Launch\n");
    expect(addSection("", "Launch", 2)).toBe("## Launch\n");
  });

  it("goes above the completed tasks section when that ends the note, so it stays last", () => {
    const note = "## Plan\n- [ ] A\n\n## Task Log\n- [x] Done\n";
    expect(addSection(note, "Launch", 2, "Task Log")).toBe("## Plan\n- [ ] A\n\n## Launch\n\n## Task Log\n- [x] Done\n");
    expect(addSection(note, "Launch", 2, "task log")).toBe("## Plan\n- [ ] A\n\n## Launch\n\n## Task Log\n- [x] Done\n");
    // Not last: the end of the note.
    expect(addSection("## Task Log\n- [x] Done\n\n## Plan\n", "Launch", 2, "Task Log")).toBe("## Task Log\n- [x] Done\n\n## Plan\n\n## Launch\n");
  });
});

describe("moving a heading's section", () => {
  const note = "---\ntags: [project]\n---\nIntro\n\n## A\n- [ ] a\n  notes\n\n## B\n- [ ] b\n\n## C\n- [ ] c\n";

  it("moves the heading with its tasks and text before another heading, or after the last", () => {
    expect(moveSection(note, 2, heading(note, "C"), heading(note, "A"))).toBe("---\ntags: [project]\n---\nIntro\n\n## C\n- [ ] c\n\n## A\n- [ ] a\n  notes\n\n## B\n- [ ] b\n");
    expect(moveSection(note, 2, heading(note, "A"))).toBe("---\ntags: [project]\n---\nIntro\n\n## B\n- [ ] b\n\n## C\n- [ ] c\n\n## A\n- [ ] a\n  notes\n");
    expect(moveSection(note, 2, heading(note, "A"), heading(note, "C"))).toBe("---\ntags: [project]\n---\nIntro\n\n## B\n- [ ] b\n\n## A\n- [ ] a\n  notes\n\n## C\n- [ ] c\n");
  });

  it("leaves the note alone dropped where it is", () => {
    expect(moveSection(note, 2, heading(note, "B"), heading(note, "B"))).toBe(note);
    expect(moveSection(note, 2, heading(note, "B"), heading(note, "C"))).toBe(note);
    expect(moveSection(note, 2, heading(note, "C"))).toBe(note);
  });

  it("takes its subheadings along and stops at a higher heading", () => {
    const nested = "# Top\n## A\n### A1\n- [ ] a\n## B\n- [ ] b\n# Other\n## C\n- [ ] c";
    expect(moveSection(nested, 2, heading(nested, "A"), heading(nested, "C"))).toBe("# Top\n## B\n- [ ] b\n# Other\n\n## A\n### A1\n- [ ] a\n\n## C\n- [ ] c");
    expect(moveSection(nested, 2, heading(nested, "C"), heading(nested, "B"))).toBe("# Top\n## A\n### A1\n- [ ] a\n\n## C\n- [ ] c\n\n## B\n- [ ] b\n# Other");
  });

  it("keeps Windows line endings", () => {
    const windows = note.replace(/\n/g, "\r\n");
    expect(moveSection(windows, 2, heading(windows, "C"), heading(windows, "A"))).toBe("---\ntags: [project]\n---\nIntro\n\n## C\n- [ ] c\n\n## A\n- [ ] a\n  notes\n\n## B\n- [ ] b\n".replace(/\n/g, "\r\n"));
  });

  it("refuses a heading that no longer reads as it was shown", () => {
    expect(() => moveSection(note, 2, { line: 5, name: "Renamed" }, heading(note, "C"))).toThrow("The note changed since it was shown. Try again.");
    expect(() => moveSection(note, 2, heading(note, "A"), { line: 3, name: "Intro" })).toThrow();
  });
});
