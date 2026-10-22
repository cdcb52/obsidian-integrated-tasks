import { describe, expect, it } from "vitest";
import { placeChangedTasks, type PlacementOptions } from "../src/completed-placement";
import { completedSectionName } from "../src/structure";

const place = (content: string[], changes: Array<[number, boolean]>, placement: PlacementOptions["placement"], section = "Task Logs", sectionHeadingLevel = 1) =>
  placeChangedTasks("Note.md", content.join("\n"), changes.map(([line, closed]) => ({ line, closed })), { placement, section, sectionHeadingLevel }).split("\n");

describe("completed tasks kept in place", () => {
  it("leaves the note as it is", () => {
    const note = ["# A", "- [x] One", "- [ ] Two"];
    expect(place(note, [[1, true]], "keep")).toEqual(note);
  });
});

describe("completed tasks moved to the bottom of their list", () => {
  it("moves a completed task, with its notes and subtasks, below the rest of its list, in its own section", () => {
    const note = ["# A", "- [x] One", "    notes", "    - [ ] Step", "- [ ] Two", "- [x] Done before", "", "# B", "- [ ] Three"];
    expect(place(note, [[1, true]], "bottom")).toEqual(["# A", "- [ ] Two", "- [x] Done before", "- [x] One", "    notes", "    - [ ] Step", "", "# B", "- [ ] Three"]);
  });

  it("keeps to the list the task is in, under a heading below the section level too", () => {
    const note = ["# A", "## Errands", "- [x] Milk", "- [ ] Eggs", "## Calls", "- [ ] Sam"];
    expect(place(note, [[2, true]], "bottom")).toEqual(["# A", "## Errands", "- [ ] Eggs", "- [x] Milk", "## Calls", "- [ ] Sam"]);
  });

  it("moves a completed subtask below its siblings, under its task", () => {
    const note = ["- [ ] Parent", "    - [x] One", "    - [ ] Two", "- [ ] Next"];
    expect(place(note, [[1, true]], "bottom")).toEqual(["- [ ] Parent", "    - [ ] Two", "    - [x] One", "- [ ] Next"]);
  });

  it("moves a reopened task to the top of its list", () => {
    const note = ["# A", "Some text", "", "- [ ] One", "- [ ] Two", "- [ ] Reopened", "    - [ ] Its step"];
    expect(place(note, [[5, false]], "bottom")).toEqual(["# A", "Some text", "", "- [ ] Reopened", "    - [ ] Its step", "- [ ] One", "- [ ] Two"]);
  });

  it("keeps several tasks completed or reopened together in their order", () => {
    const note = ["- [x] A", "- [ ] B", "- [x] C", "- [ ] D"];
    expect(place(note, [[0, true], [2, true]], "bottom")).toEqual(["- [ ] B", "- [ ] D", "- [x] A", "- [x] C"]);
    expect(place(["- [ ] A", "- [ ] B", "- [ ] C"], [[1, false], [2, false]], "bottom")).toEqual(["- [ ] B", "- [ ] C", "- [ ] A"]);
  });

  it("keeps the note's last line break", () => {
    expect(place(["- [x] A", "- [ ] B", ""], [[0, true]], "bottom")).toEqual(["- [ ] B", "- [x] A", ""]);
  });
});

describe("completed tasks moved to a section", () => {
  it("adds the section at the end of the note, with a heading for the section the task came from", () => {
    const note = ["---", "status: Active", "---", "# Heading 1", "- [x] Done", "- [ ] Open", "", "# Heading 2", "- [ ] Later", ""];
    expect(place(note, [[4, true]], "section")).toEqual(["---", "status: Active", "---", "# Heading 1", "- [ ] Open", "", "# Heading 2", "- [ ] Later",
      "", "# Task Logs", "", "## Heading 1", "- [x] Done", ""]);
  });

  it("puts a task with no section right under the section's heading, before the headings for sections", () => {
    const note = ["- [x] Loose", "# A", "- [x] Sectioned", "- [ ] Open"];
    expect(place(note, [[0, true], [2, true]], "section")).toEqual(["# A", "- [ ] Open", "", "# Task Logs", "- [x] Loose", "", "## A", "- [x] Sectioned"]);
  });

  it("adds to the existing section and headings, below what they hold", () => {
    const note = ["# A", "- [x] New", "- [ ] Open", "# Task Logs", "", "## A", "- [x] Old", "", "## B", "- [x] Other"];
    expect(place(note, [[1, true]], "section")).toEqual(["# A", "- [ ] Open", "# Task Logs", "", "## A", "- [x] Old", "- [x] New", "", "## B", "- [x] Other"]);
  });

  it("adds a heading for a section the section does not have yet, at its end", () => {
    const note = ["# B", "- [x] New", "# Task Logs", "## A", "- [x] Old", "", "# After", "Text"];
    expect(place(note, [[1, true]], "section")).toEqual(["# B", "# Task Logs", "## A", "- [x] Old", "", "## B", "- [x] New", "", "# After", "Text"]);
  });

  it("takes the section's name from settings, at the section heading level, case aside", () => {
    expect(place(["## A", "- [x] Done", "## done", "### A", "- [x] Old"], [[1, true]], "section", "## Done", 2))
      .toEqual(["## A", "## done", "### A", "- [x] Old", "- [x] Done"]);
    expect(completedSectionName("  # Archive ")).toBe("Archive");
    expect(completedSectionName("")).toBe("Task Logs");
  });

  it("reopens a task back at the top of the section it came from, dropping a heading it leaves empty", () => {
    const note = ["# A", "Intro", "- [ ] Open", "", "# Task Logs", "", "## A", "- [ ] Reopened", "    - [x] Step", "", "## B", "- [x] Other"];
    expect(place(note, [[7, false]], "section")).toEqual(["# A", "Intro", "- [ ] Reopened", "    - [x] Step", "- [ ] Open", "", "# Task Logs", "", "## B", "- [x] Other"]);
    const last = ["# A", "- [ ] Open", "", "# Task Logs", "", "## A", "- [ ] Reopened", ""];
    expect(place(last, [[6, false]], "section")).toEqual(["# A", "- [ ] Reopened", "- [ ] Open", "", "# Task Logs", ""]);
  });

  it("reopens a task with no section at the note's top, and leaves one whose section is gone where it is", () => {
    const note = ["---", "a: 1", "---", "- [ ] Top", "# Task Logs", "- [ ] Loose", "## Gone", "- [ ] Orphan"];
    expect(place(note, [[5, false], [7, false]], "section")).toEqual(["---", "a: 1", "---", "- [ ] Loose", "- [ ] Top", "# Task Logs", "## Gone", "- [ ] Orphan"]);
  });

  it("moves completed subtasks below their siblings, and reopened tasks outside it to the top of their list", () => {
    const note = ["# A", "- [ ] Parent", "    - [x] One", "    - [ ] Two", "- [ ] First", "- [ ] Reopened"];
    expect(place(note, [[2, true], [5, false]], "section")).toEqual(["# A", "- [ ] Reopened", "- [ ] Parent", "    - [ ] Two", "    - [x] One", "- [ ] First"]);
  });

  it("moves a task that was indented under a plain bullet to the left margin", () => {
    const note = ["# A", "- Groceries", "    - [x] Milk", "    - [ ] Eggs"];
    expect(place(note, [[2, true]], "section")).toEqual(["# A", "- Groceries", "    - [ ] Eggs", "", "# Task Logs", "", "## A", "- [x] Milk"]);
  });
});
