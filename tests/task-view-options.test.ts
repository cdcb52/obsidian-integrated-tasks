import { expect, it, vi } from "vitest";
import type { WorkspaceLeaf } from "obsidian";
import type TaskManagerPlugin from "../src/main";
vi.mock("obsidian", async original => ({ ...await original<typeof import("./obsidian-mock")>(), ItemView: class {}, Menu: class {}, Notice: class {}, setIcon: vi.fn() }));
import { TaskMainView } from "../src/task-view";

class Element extends EventTarget {
  children: Element[] = [];
  attrs: Record<string, string> = {};
  tag = ""; text = ""; value = ""; hidden = false;
  validity = { valid: true };
  focus = vi.fn();
  createEl(tag: string, options: { attr?: Record<string, string>; text?: string; value?: string } = {}): Element {
    const el = new Element(); el.tag = tag; el.attrs = options.attr ?? {}; el.text = options.text ?? ""; el.value = options.value ?? "";
    this.children.push(el); return el;
  }
  createDiv(options = {}) { return this.createEl("div", options); }
  createSpan(options = {}) { return this.createEl("span", options); }
  setText(text: string) { this.text = text; }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  toggleClass() {}
  prepend(child: Element) { this.children = [child, ...this.children.filter(el => el !== child)]; }
  empty() { this.children = []; }
  all(): Element[] { return this.children.flatMap(el => [el, ...el.all()]); }
}

// The view options panel itself is covered in view-options.test.ts.

it.each([true, false])("lists archived projects in a group of their own in the Projects list (active projects: %s)", hasActive => {
  const archived = { path: "Archive.md", name: "Archive", archived: true, openTasks: 0, completedTasks: 1 };
  const active = { ...archived, path: "Active.md", name: "Active", archived: false, openTasks: 1 };
  const openProjectCreator = vi.fn();
  const projects = hasActive ? [active, archived] : [archived];
  const view = new TaskMainView({} as WorkspaceLeaf, { openProjectCreator, index: { projects: () => projects } } as unknown as TaskManagerPlugin);
  const internal = view as unknown as {
    state: { mode: string }; shownProjects: Map<string, unknown>;
    renderProjectGroups(root: HTMLElement, items: unknown[]): void; renderProjectGroup(root: HTMLElement, title: string, projects: unknown[]): void;
  };
  internal.state = { mode: "projects" };
  for (const project of projects) internal.shownProjects.set(`project:${project.path}`, project);
  const groups = vi.spyOn(internal, "renderProjectGroup").mockImplementation(() => {});
  const root = new Element();
  internal.renderProjectGroups(root as never, projects.map(project => ({ id: `project:${project.path}` })));
  expect(groups).toHaveBeenCalledWith(root, "Archived", [archived], undefined);
  expect(groups).toHaveBeenCalledWith(root, "Active", hasActive ? [active] : [], undefined);
  // Its add button makes a project.
  view.newTask();
  expect(openProjectCreator).toHaveBeenCalledOnce();
});

it("starts a sectioned project at its first heading, with only a drop-only list above it", () => {
  const view = new TaskMainView({} as WorkspaceLeaf, { settings: {}, index: { headingsForPath: () => [{ name: "Ready", line: 0 }] } } as unknown as TaskManagerPlugin);
  const internal = view as unknown as { renderProjectSections(root: HTMLElement, path: string, tasks: unknown[]): void; renderTaskList(root: HTMLElement, tasks: unknown[], target: unknown): void };
  const renderList = vi.spyOn(internal, "renderTaskList").mockImplementation(() => {});
  const root = new Element();
  internal.renderProjectSections(root as never, "Project.md", [{ sectionLine: 0 }]);
  expect(root.children[0].tag).toBe("section");
  expect(root.children[0].children[0].text).toBe("Ready");
  // The list above the headings is empty and only takes drops; the section's own list follows.
  expect(renderList).toHaveBeenCalledTimes(2);
  expect(renderList.mock.calls[0]).toEqual([root, [], { destination: "Project.md" }, true]);
  expect(renderList.mock.calls[1][0]).toBe(root.children[0]);
});
