import { expect, it, vi } from "vitest";
vi.mock("obsidian", async importOriginal => ({ ...await importOriginal<typeof import("./obsidian-mock")>(), Modal: class {} }));
import { applyProjectDraft, projectEditDraft } from "../src/project-editor";
import type { Project } from "../src/types";
const project: Project = { name: "Launch", path: "Projects/Launch.md", parentPath: "Projects/Studio.md", priority: 2, openTasks: 1, completedTasks: 0 };

it("loads aliased fields and link lists, then updates properties without replacing custom metadata", () => {
  const frontmatter = { tags: ["project", "work", "archived"], start_date: ["[[2026-09-18|Friday]]"], EndDate: "2026-09-20", Deadline: "2026-09-21", Priority: "medium", Parent: ["[[Studio]]"], custom: { retained: true } };
  const draft = projectEditDraft(project, frontmatter);
  expect(draft).toEqual({ name: "Launch", date: "[[2026-09-18|Friday]]", endDate: "2026-09-20", deadline: "2026-09-21", priority: "2", parent: "Projects/Studio.md", tags: "project, work, archived", color: "" });
  applyProjectDraft(frontmatter, { ...draft, endDate: "", priority: "1" }, "YYYY-MM-DD", true);
  expect(frontmatter).toEqual({ tags: ["project", "work", "archived"], start_date: "[[2026-09-18]]", EndDate: null, Deadline: "[[2026-09-21]]", Priority: 1, Parent: "[[Projects/Studio]]", custom: { retained: true } });
});

it("rejects invalid edits without partially modifying frontmatter", () => {
  const frontmatter = { tags: ["project"], date: "2026-09-18", custom: "keep" };
  const draft = projectEditDraft(project, frontmatter);
  expect(() => applyProjectDraft(frontmatter, { ...draft, deadline: "garbage" }, "YYYY-MM-DD", false)).toThrow();
  expect(frontmatter).toEqual({ tags: ["project"], date: "2026-09-18", custom: "keep" });
});

it("writes a chosen status by its name, keeping the property's spelling, removes it for No status, and leaves it alone otherwise", () => {
  const frontmatter: Record<string, unknown> = { tags: ["project"], Status: "on hold" };
  const draft = projectEditDraft(project, frontmatter);
  expect(draft.status).toBeUndefined();
  applyProjectDraft(frontmatter, { ...draft, priority: "1" }, "YYYY-MM-DD", false);
  expect(frontmatter.Status).toBe("on hold");
  applyProjectDraft(frontmatter, { ...draft, status: "doing" }, "YYYY-MM-DD", false);
  expect(frontmatter.Status).toBe("In progress");
  expect(() => applyProjectDraft(frontmatter, { ...draft, status: "someday" }, "YYYY-MM-DD", false)).toThrow("valid status");
  applyProjectDraft(frontmatter, { ...draft, status: "" }, "YYYY-MM-DD", false);
  expect("Status" in frontmatter).toBe(false);
});
