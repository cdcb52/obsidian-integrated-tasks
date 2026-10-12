import { expect, it, vi } from "vitest";
import type { App } from "obsidian";
vi.mock("obsidian", async importOriginal => ({
  ...await importOriginal<typeof import("./obsidian-mock")>(), Plugin: class {}, ItemView: class {},
  MarkdownView: class {}, Modal: class {}, PluginSettingTab: class {}, Notice: class {}, Setting: class {}, setIcon: vi.fn()
}));
vi.mock("../src/note-token-editor", () => ({ noteTokenEditor: vi.fn() }));
import { TFile, TFolder } from "obsidian";
import TaskManagerPlugin from "../src/main";
import { forgetSidebarPaths, inOrder, moveKey, navOrderFrom, renameSidebarPaths } from "../src/sidebar-order";
import { projectHierarchy } from "../src/project-hierarchy";
import type { Project } from "../src/types";

it("moves a key before or after another, and leaves the rest in order", () => {
  expect(moveKey(["a", "b", "c", "d"], "d", "b", false)).toEqual(["a", "d", "b", "c"]);
  expect(moveKey(["a", "b", "c", "d"], "a", "c", true)).toEqual(["b", "c", "a", "d"]);
  expect(moveKey(["a", "b", "c", "d"], "d", "a", true)).toEqual(["a", "d", "b", "c"]);
  expect(moveKey(["a", "b"], "a", "missing", false)).toEqual(["a", "b"]);
  expect(moveKey(["a", "b"], "a", "a", false)).toEqual(["a", "b"]);
  // Items follow a saved order; what it does not list follows, as it was.
  expect(inOrder(["x", "b", "a", "y"], ["a", "b"], key => key)).toEqual(["a", "b", "x", "y"]);
});

it("orders subprojects among their parent's as dragged, parents first", () => {
  const project = (name: string, parent?: string): Project => ({ path: `${name}.md`, name, openTasks: 0, completedTasks: 0, ...parent ? { parentPath: `${parent}.md` } : {} });
  const projects = [project("Work"), project("Home"), project("Site", "Work"), project("Ads", "Work")];
  const names = (order?: string[]) => projectHierarchy(projects, order).map(({ project, depth }) => `${"-".repeat(depth)}${project.name}`);
  expect(names()).toEqual(["Home", "Work", "-Ads", "-Site"]);
  expect(names(["Work.md", "Site.md"])).toEqual(["Work", "-Site", "-Ads", "Home"]);
});

it("keeps only what a saved sidebar order can hold", () => {
  expect(navOrderFrom(undefined)).toEqual({ projects: [], tags: [], files: {} });
  expect(navOrderFrom({ projects: ["A.md", 3, "A.md"], tags: "x", files: { "/": ["a", null], Work: [], Bad: "x" } }))
    .toEqual({ projects: ["A.md"], tags: [], files: { "/": ["a"] } });
});

const settings = () => ({
  favorites: ["mode:today", "file:Work/Plan.md", "folder:Work", "project:Work/Site.md", "tag:work", "file:Notes.md"],
  navOrder: { projects: ["Work/Site.md", "Home.md"], tags: ["work"], files: { "/": ["Work", "Notes.md"], Work: ["Site.md", "Plan.md"], "Work/Old": ["a.md"] } }
});

it("lets favourites and orders follow a renamed or moved note or folder", () => {
  // A note renamed in place keeps its place in its folder.
  expect(renameSidebarPaths(settings(), "Work/Plan.md", "Work/Roadmap.md", false, () => true)).toEqual({
    favorites: ["mode:today", "file:Work/Roadmap.md", "folder:Work", "project:Work/Site.md", "tag:work", "file:Notes.md"],
    navOrder: { ...settings().navOrder, files: { ...settings().navOrder.files, Work: ["Site.md", "Roadmap.md"] } }
  });
  // Moved elsewhere, it leaves its old folder's order.
  expect(renameSidebarPaths(settings(), "Work/Site.md", "Site.md", false, () => true)?.navOrder).toEqual({
    projects: ["Site.md", "Home.md"], tags: ["work"], files: { "/": ["Work", "Notes.md"], Work: ["Plan.md"], "Work/Old": ["a.md"] }
  });
  // A renamed folder takes what is in it along.
  const renamed = renameSidebarPaths(settings(), "Work", "Jobs", true, () => false)!;
  expect(renamed.favorites).toEqual(["mode:today", "file:Jobs/Plan.md", "folder:Jobs", "project:Jobs/Site.md", "tag:work", "file:Notes.md"]);
  expect(renamed.navOrder).toEqual({ projects: ["Jobs/Site.md", "Home.md"], tags: ["work"], files: { "/": ["Jobs", "Notes.md"], Jobs: ["Site.md", "Plan.md"], "Jobs/Old": ["a.md"] } });
  // A file in a renamed folder (reported after it) stays in that folder's order.
  expect(renameSidebarPaths(renamed, "Work/Plan.md", "Jobs/Plan.md", false, () => false)).toBeUndefined();
  expect(renameSidebarPaths(settings(), "Other.md", "Elsewhere.md", false, () => true)).toBeUndefined();
});

it("lets go of a deleted note or folder, and what was in it", () => {
  expect(forgetSidebarPaths(settings(), "Notes.md", false)).toEqual({
    favorites: ["mode:today", "file:Work/Plan.md", "folder:Work", "project:Work/Site.md", "tag:work"],
    navOrder: { ...settings().navOrder, files: { ...settings().navOrder.files, "/": ["Work"] } }
  });
  expect(forgetSidebarPaths(settings(), "Work", true)).toEqual({
    favorites: ["mode:today", "tag:work", "file:Notes.md"],
    navOrder: { projects: ["Home.md"], tags: ["work"], files: { "/": ["Notes.md"] } }
  });
  expect(forgetSidebarPaths(settings(), "Other.md", false)).toBeUndefined();
});

function plugin() {
  const made = new TaskManagerPlugin({} as App, {} as never);
  const refresh = vi.fn();
  made.app = { workspace: { getLeavesOfType: () => [] }, vault: { getAbstractFileByPath: () => null } } as unknown as App;
  let saved: unknown;
  made.saveData = vi.fn(async data => { saved = JSON.parse(JSON.stringify(data)); });
  made.loadData = vi.fn(async () => saved);
  made.refreshNavigation = refresh;
  return { plugin: made, refresh, saved: () => saved as Record<string, unknown> };
}

it("adds favourites, takes them out, and keeps them with a deleted smart list's own", async () => {
  const { plugin: made, refresh, saved } = plugin();
  await made.loadSettings();
  expect(made.settings.favorites).toEqual([]);
  expect(made.settings.navOrder).toEqual({ projects: [], tags: [], files: {} });
  await made.toggleFavorite("mode:today");
  await made.toggleFavorite("tag:work");
  expect(made.isFavorite("tag:work")).toBe(true);
  await made.toggleFavorite("mode:today");
  expect(made.settings.favorites).toEqual(["tag:work"]);
  expect(saved().favorites).toEqual(["tag:work"]);
  expect(refresh).toHaveBeenCalledTimes(3);
  const list = await made.saveSmartList({ name: "Calls", filters: [], sort: "date", descending: false, grouping: "default" });
  await made.toggleFavorite(`list:${list.id}`);
  await made.deleteSmartList(list.id);
  expect(made.settings.favorites).toEqual(["tag:work"]);
  // Saved settings come back cleaned.
  made.loadData = vi.fn(async () => ({ favorites: ["tag:work", "tag:work", 4, "nonsense", "file:A.md"], navOrder: { tags: ["b", "a"] }, customFileOrder: "yes" }));
  await made.loadSettings();
  expect(made.settings.favorites).toEqual(["tag:work", "file:A.md"]);
  expect(made.settings.navOrder).toEqual({ projects: [], tags: ["b", "a"], files: {} });
  expect(made.settings.customFileOrder).toBe(false);
});

it("follows renamed and deleted notes and folders in the favourites", async () => {
  const { plugin: made, refresh } = plugin();
  await made.loadSettings();
  made.settings.favorites = ["file:Notes.md", "folder:Work", "project:Work/Site.md"];
  const internal = made as unknown as { followSidebarPaths(file: unknown, oldPath?: string): void };
  internal.followSidebarPaths(Object.assign(new TFile(), { path: "Ideas.md" }), "Notes.md");
  expect(made.settings.favorites).toEqual(["file:Ideas.md", "folder:Work", "project:Work/Site.md"]);
  internal.followSidebarPaths(Object.assign(new TFolder(), { path: "Work" }));
  expect(made.settings.favorites).toEqual(["file:Ideas.md"]);
  expect(refresh).toHaveBeenCalledTimes(2);
  internal.followSidebarPaths(Object.assign(new TFile(), { path: "Other.md" }));
  expect(refresh).toHaveBeenCalledTimes(2);
});
