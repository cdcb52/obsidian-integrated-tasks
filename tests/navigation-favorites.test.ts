// @vitest-environment happy-dom
import { beforeAll, expect, it, vi } from "vitest";
import { installObsidianDom } from "./helpers/obsidian-dom";

const menus: Array<{ titles: string[]; click(title: string): void }> = [];
vi.mock("obsidian", async importOriginal => {
  class Menu {
    items: Array<{ title: string; click?: () => void }> = [];
    constructor() { menus.push({ titles: [], click: title => this.items.find(item => item.title === title)?.click?.() }); }
    addItem(build: (item: Record<string, (value: unknown) => unknown>) => void): this {
      const entry: { title: string; click?: () => void } = { title: "" };
      const item: Record<string, (value: unknown) => unknown> = {};
      for (const name of ["setSection", "setIcon", "setWarning", "setChecked"]) item[name] = () => item;
      item.setTitle = title => { entry.title = String(title); menus[menus.length - 1].titles.push(entry.title); return item; };
      item.onClick = click => { entry.click = click as () => void; return item; };
      build(item);
      this.items.push(entry);
      return this;
    }
    showAtMouseEvent(): void {}
  }
  return { ...await importOriginal<typeof import("./obsidian-mock")>(), Menu, Keymap: { isModEvent: (event: MouseEvent) => event.metaKey }, Notice: class {}, setIcon: vi.fn() };
});

import { TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { TaskNavigationView } from "../src/navigation-view";
import { DEFAULT_SETTINGS, type Project } from "../src/types";
import type TaskManagerPlugin from "../src/main";

beforeAll(() => installObsidianDom());

const project = (name: string, parent?: string): Project => ({ path: `${name}.md`, name, openTasks: 1, completedTasks: 0, ...parent ? { parentPath: `${parent}.md` } : {} });

function setup(favorites: string[] = []) {
  const byPath = new Map<string, TFile | TFolder>();
  const folder = (path: string, parent: TFolder | null): TFolder => {
    const made = Object.assign(new TFolder(), { path, name: path.split("/").pop() ?? "", parent, children: [] as Array<TFile | TFolder>, isRoot: () => path === "/" });
    parent?.children.push(made);
    byPath.set(path, made);
    return made;
  };
  const file = (path: string, parent: TFolder): TFile => {
    const name = path.split("/").pop()!;
    const made = Object.assign(new TFile(), { path, name, basename: name.replace(/\.[^.]+$/, ""), extension: name.split(".").pop()!, parent });
    parent.children.push(made);
    byPath.set(path, made);
    return made;
  };
  const root = folder("/", null);
  const work = folder("Work", root);
  file("Work/Plan.md", work);
  file("Notes.md", root);
  const openFile = vi.fn(async () => {});
  const app = {
    vault: { getRoot: () => root, getAbstractFileByPath: (path: string) => byPath.get(path) ?? null, on: () => ({}) },
    workspace: { getActiveFile: () => null, getLeaf: vi.fn(() => ({ openFile })), on: () => ({}), trigger: vi.fn(), requestSaveLayout: vi.fn() },
    fileManager: { renameFile: vi.fn(), promptForDeletion: vi.fn() },
    // Records what each row hands Obsidian's drag manager to drop.
    dragManager: {
      drops: new Map<HTMLElement, (event: DragEvent, draggable: unknown, hovering: boolean) => unknown>(),
      handleDrag: () => {},
      handleDrop(element: HTMLElement, drop: (event: DragEvent, draggable: unknown, hovering: boolean) => unknown) { this.drops.set(element, drop); },
      dragFile: () => ({}), dragFolder: () => ({})
    }
  };
  const settings = {
    ...DEFAULT_SETTINGS, showFiles: true, favorites, navOrder: { projects: [], tags: [], files: {} },
    smartLists: [{ id: "calls", name: "Calls", filters: [], sort: "date", descending: false, grouping: "default" }, { id: "errands", name: "Errands", filters: [], sort: "date", descending: false, grouping: "default" }]
  } as typeof DEFAULT_SETTINGS;
  const projects = [project("Home"), project("Work"), project("Ads", "Work"), project("Site", "Work")];
  const tags = [{ name: "errand", openTasks: 1, completedTasks: 0 }, { name: "home", openTasks: 2, completedTasks: 0 }];
  let view: TaskNavigationView;
  const plugin = {
    settings, saveSettings: vi.fn(async () => {}),
    index: { projects: () => projects, tagSummaries: () => tags, query: () => [] },
    isFavorite: (key: string) => settings.favorites.includes(key),
    toggleFavorite: vi.fn(async (key: string) => {
      settings.favorites = settings.favorites.includes(key) ? settings.favorites.filter(item => item !== key) : [...settings.favorites, key];
      view.refresh();
    }),
    openTaskView: vi.fn(async () => {}), openProject: vi.fn(async () => {}), openTag: vi.fn(async () => {}), openProjectMenu: vi.fn(),
    // Moves the project under its new parent, as the index then reads it.
    updateProject: vi.fn(async (path: string, change: (draft: { parent: string }) => { parent: string }) => {
      const parent = change({ parent: "" }).parent;
      const index = projects.findIndex(item => item.path === path);
      projects[index] = { ...projects[index], parentPath: parent || undefined };
      return path;
    })
  };
  view = new TaskNavigationView({ app } as unknown as WorkspaceLeaf, plugin as unknown as TaskManagerPlugin);
  // Tags start folded; open them.
  (view as unknown as { expanded: Set<string> }).expanded.add("tags");
  view.refresh();
  const container = view.containerEl.children[1] as HTMLElement;
  const row = (key: string) => container.querySelector(`[data-tm-nav-key="${CSS.escape(key)}"]`)?.closest<HTMLElement>(".tm-nav-item") ?? null;
  const favoriteLabels = () => Array.from(container.querySelectorAll(".tm-nav-favorites .tm-nav-children .tm-nav-label")).map(label => label.textContent);
  const sectionLabels = (index: number) => Array.from(container.querySelectorAll(".tm-nav-list > .tm-nav-section"))[index]
    .querySelectorAll(".tm-nav-children .tm-nav-label");
  return { view, settings, plugin, container, row, favoriteLabels, sectionLabels, openFile, app, byPath };
}

const rightClick = (row: HTMLElement) => {
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }));
  return menus[menus.length - 1];
};

/**
 * Drags `source` onto `target`, in its top half (`before`) or its bottom half, `dx` px right (or left) of where the drag
 * began; returns whether `target` took it, and the depth its line showed.
 */
function dragTo(source: HTMLElement, target: HTMLElement, before: boolean, dx = 0): { taken: boolean; depth: string } {
  const dataTransfer = { setData: vi.fn(), types: [] as string[], effectAllowed: "", dropEffect: "" };
  const event = (type: string, x = 100) => {
    const made = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(made, { dataTransfer: { value: dataTransfer }, clientY: { value: before ? 2 : 18 }, clientX: { value: x } });
    return made;
  };
  target.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
  source.dispatchEvent(event("dragstart"));
  expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-task-manager-nav-item", expect.any(String));
  const over = event("dragover", 100 + dx);
  target.dispatchEvent(over);
  // The line shows on the row it is over, or (over a project's own rows) on the project where it is.
  const marked = target.closest(".tm-navigation")?.querySelector<HTMLElement>(".tm-nav-drop-before, .tm-nav-drop-after");
  if (over.defaultPrevented && marked === target) expect(marked.classList.contains(before ? "tm-nav-drop-before" : "tm-nav-drop-after")).toBe(true);
  const depth = marked?.style.getPropertyValue("--tm-nav-drop-depth") ?? "";
  target.dispatchEvent(event("drop", 100 + dx));
  source.dispatchEvent(event("dragend"));
  return { taken: over.defaultPrevented, depth };
}
const drag = (source: HTMLElement, target: HTMLElement, before: boolean): boolean => dragTo(source, target, before).taken;

it("puts Favorites at the top, filled from any item's right-click menu", async () => {
  const { container, row, favoriteLabels, plugin, settings } = setup();
  const first = container.querySelector(".tm-nav-list > .tm-nav-group")!;
  expect(first.classList.contains("tm-nav-favorites")).toBe(true);
  expect(first.querySelector(".tm-nav-label")!.textContent).toBe("Favorites");
  expect(first.querySelector(".tm-nav-empty")!.textContent).toBe("Drag an item here, or right-click it");
  // A list, the Projects view, a smart list, a tag, a folder and a file.
  for (const key of ["mode:today", "mode:projects", "list:calls", "tag:home", "folder:Work", "file:Notes.md"]) {
    const menu = rightClick(row(key)!);
    expect(menu.titles).toContain("Add to favorites");
    menu.click("Add to favorites");
  }
  await vi.waitFor(() => expect(settings.favorites).toHaveLength(6));
  expect(plugin.toggleFavorite.mock.calls.map(call => call[0])).toEqual(["mode:today", "mode:projects", "list:calls", "tag:home", "folder:Work", "file:Notes.md"]);
  expect(favoriteLabels()).toEqual(["Today", "Projects", "Calls", "home", "Work", "Notes"]);
  expect(container.querySelector(".tm-nav-favorites .tm-nav-empty")).toBeNull();
  // In Favorites an item offers to come out again.
  const menu = rightClick(row("favorite:mode:today")!);
  expect(menu.titles).toEqual(["Remove from favorites"]);
  menu.click("Remove from favorites");
  await vi.waitFor(() => expect(favoriteLabels()).toEqual(["Projects", "Calls", "home", "Work", "Notes"]));
});

it("shows favourites as their own sections do, leaving out what is gone", async () => {
  const { row, favoriteLabels, plugin, openFile } = setup(["project:Site.md", "tag:gone", "project:Gone.md", "mode:inbox", "folder:Work", "file:Notes.md", "list:missing"]);
  expect(favoriteLabels()).toEqual(["Site", "Inbox", "Work", "Notes"]);
  // Each works as it does in its own section.
  expect(row("favorite:project:Site.md")!.querySelector(".tm-nav-progress")).not.toBeNull();
  row("favorite:project:Site.md")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  expect(plugin.openProject).toHaveBeenCalledWith("Site.md", { keepTaskMode: true, newLeaf: false });
  row("favorite:mode:inbox")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  expect(plugin.openTaskView).toHaveBeenCalledWith({ mode: "inbox" });
  row("favorite:file:Notes.md")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
  // A folder opens in place, listing what is in it.
  row("favorite:folder:Work")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  expect(favoriteLabels()).toEqual(["Site", "Inbox", "Work", "Plan", "Notes"]);
  // A project's right-click is its actions menu.
  rightClick(row("favorite:project:Site.md")!);
  expect(plugin.openProjectMenu).toHaveBeenCalledWith("Site.md", expect.any(HTMLElement), { x: 12, y: 34 });
});

it("reorders favourites, smart lists, a parent's subprojects and tags by dragging, each among its own", () => {
  const { row, favoriteLabels, sectionLabels, settings, plugin, container } = setup(["mode:today", "mode:inbox", "tag:errand"]);
  expect(drag(row("favorite:tag:errand")!, row("favorite:mode:today")!, true)).toBe(true);
  expect(settings.favorites).toEqual(["tag:errand", "mode:today", "mode:inbox"]);
  expect(favoriteLabels()).toEqual(["errand", "Today", "Inbox"]);
  expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  // A favourite stays among the favourites.
  expect(drag(row("favorite:mode:inbox")!, row("tag:home")!, true)).toBe(false);

  expect(drag(row("list:errands")!, row("list:calls")!, true)).toBe(true);
  expect(settings.smartLists.map(list => list.id)).toEqual(["errands", "calls"]);

  const projects = () => Array.from(sectionLabels(1)).map(label => label.textContent);
  expect(projects()).toEqual(["Home", "Work", "Ads", "Site"]);
  expect(drag(row("project:Site.md")!, row("project:Ads.md")!, true)).toBe(true);
  expect(projects()).toEqual(["Home", "Work", "Site", "Ads"]);
  // A parent takes its subprojects along.
  expect(drag(row("project:Work.md")!, row("project:Home.md")!, true)).toBe(true);
  expect(projects()).toEqual(["Work", "Site", "Ads", "Home"]);
  expect(settings.navOrder.projects).toEqual(["Work.md", "Site.md", "Ads.md", "Home.md"]);
  expect(plugin.updateProject).not.toHaveBeenCalled();

  const tags = () => Array.from(sectionLabels(2)).map(label => label.textContent);
  expect(drag(row("tag:errand")!, row("tag:home")!, false)).toBe(true);
  expect(tags()).toEqual(["home", "errand"]);
  expect(settings.navOrder.tags).toEqual(["home", "errand"]);
  expect(container.querySelector(".tm-nav-drop-before, .tm-nav-drop-after, .is-being-dragged")).toBeNull();
});

it("nests a project under the one above when dragged right, and takes it out when dragged left, as tasks do", async () => {
  const { row, sectionLabels, settings, plugin } = setup();
  const tree = () => Array.from(sectionLabels(1)).map(label => `${"-".repeat(Number(label.closest<HTMLElement>(".tm-nav-item")!.style.getPropertyValue("--tm-nav-depth")))}${label.textContent}`);
  expect(tree()).toEqual(["Home", "Work", "-Ads", "-Site"]);
  // Right, where it is: under the project above it.
  expect(dragTo(row("project:Site.md")!, row("project:Site.md")!, true, 30)).toEqual({ taken: true, depth: "2" });
  await vi.waitFor(() => expect(tree()).toEqual(["Home", "Work", "-Ads", "--Site"]));
  expect(plugin.updateProject).toHaveBeenLastCalledWith("Site.md", expect.any(Function));
  // Left, where it is: out from under its parent, a level per step, after the project it was under.
  expect(dragTo(row("project:Site.md")!, row("project:Site.md")!, true, -20).depth).toBe("1");
  await vi.waitFor(() => expect(tree()).toEqual(["Home", "Work", "-Ads", "-Site"]));
  expect(dragTo(row("project:Ads.md")!, row("project:Ads.md")!, true, -40).depth).toBe("0");
  await vi.waitFor(() => expect(tree()).toEqual(["Home", "Work", "-Site", "Ads"]));
  // Below a nested project it goes beside it; dragged right, under it; a top project can't nest with nothing above it.
  expect(dragTo(row("project:Home.md")!, row("project:Site.md")!, false).depth).toBe("1");
  await vi.waitFor(() => expect(tree()).toEqual(["Work", "-Site", "-Home", "Ads"]));
  expect(dragTo(row("project:Work.md")!, row("project:Work.md")!, true, 50).depth).toBe("0");
  expect(tree()).toEqual(["Work", "-Site", "-Home", "Ads"]);
  // Not into its own subprojects: over them it stays where it is.
  expect(dragTo(row("project:Work.md")!, row("project:Home.md")!, false, 30)).toEqual({ taken: true, depth: "0" });
  expect(tree()).toEqual(["Work", "-Site", "-Home", "Ads"]);
  expect(settings.navOrder.projects).toEqual(["Work.md", "Site.md", "Home.md", "Ads.md"]);
  expect(plugin.updateProject).toHaveBeenCalledTimes(4);
});

it("adds what is dropped into Favorites: on its heading at the end, beside a favourite, or on the empty list", async () => {
  const { row, container, favoriteLabels, settings, app, byPath } = setup();
  const hint = container.querySelector<HTMLElement>(".tm-nav-favorites .tm-nav-empty")!;
  // A list keeps its place in the lists, but drops into Favorites.
  expect(dragTo(row("mode:today")!, hint, false).taken).toBe(true);
  expect(settings.favorites).toEqual(["mode:today"]);
  expect(favoriteLabels()).toEqual(["Today"]);
  expect(drag(row("tag:home")!, row("favorites")!, false)).toBe(true);
  expect(settings.favorites).toEqual(["mode:today", "tag:home"]);
  // Beside a favourite, before or after it.
  expect(drag(row("project:Site.md")!, row("favorite:tag:home")!, true)).toBe(true);
  expect(drag(row("list:errands")!, row("favorite:mode:today")!, false)).toBe(true);
  expect(favoriteLabels()).toEqual(["Today", "Errands", "Site", "home"]);
  // A favourite dropped on the heading moves to the end.
  expect(drag(row("favorite:mode:today")!, row("favorites")!, false)).toBe(true);
  expect(settings.favorites).toEqual(["list:errands", "project:Site.md", "tag:home", "mode:today"]);
  expect(container.querySelector(".is-drop-target, .tm-nav-drop-before, .tm-nav-drop-after")).toBeNull();
  // Files and folders, from the file tree or the file explorer, drop in through Obsidian's drag manager.
  const drops = app.dragManager.drops;
  const heading = row("favorites")!;
  expect(drops.get(heading)!({} as DragEvent, { type: "folder", file: byPath.get("Work") }, true)).toMatchObject({ action: "Add to favorites", hoverClass: "is-drop-target" });
  expect(heading.classList.contains("is-drop-target")).toBe(true);
  drops.get(heading)!({} as DragEvent, { type: "folder", file: byPath.get("Work") }, false);
  const beside = row("favorite:list:errands")!;
  beside.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
  drops.get(beside)!({ clientY: 2 } as DragEvent, { type: "file", file: byPath.get("Notes.md") }, false);
  await vi.waitFor(() => expect(settings.favorites).toEqual(["file:Notes.md", "list:errands", "project:Site.md", "tag:home", "mode:today", "folder:Work"]));
  // What is not a file (a task, say) is left to other targets.
  expect(drops.get(row("favorites")!)!({} as DragEvent, null, true)).toBeUndefined();
});

it("folds the tags from the Tags heading, which no longer opens a list of tags", () => {
  const { row, plugin, sectionLabels } = setup();
  const heading = row("tags")!;
  const label = heading.querySelector<HTMLElement>(".tm-nav-label")!;
  expect(label.textContent).toBe("Tags");
  expect(label.getAttribute("aria-expanded")).toBe("true");
  expect(sectionLabels(2)).toHaveLength(2);
  label.click();
  expect(plugin.openTaskView).not.toHaveBeenCalled();
  expect(row("tags")!.querySelector(".tm-nav-label")!.getAttribute("aria-expanded")).toBe("false");
  expect(row("tag:home")).toBeNull();
  row("tags")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  expect(row("tag:home")).not.toBeNull();
});

it("opens a project's actions from a right-click on its row", () => {
  const { row, plugin } = setup();
  const work = row("project:Work.md")!;
  rightClick(work);
  expect(plugin.openProjectMenu).toHaveBeenCalledWith("Work.md", work.querySelector(".tm-nav-label"), { x: 12, y: 34 });
});
