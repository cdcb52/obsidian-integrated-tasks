// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { installObsidianDom } from "./helpers/obsidian-dom";
import { gap, gapPlace, grab, layOutSidebar, middleOf } from "./helpers/nav-drag";

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
beforeEach(() => layOutSidebar());
afterEach(() => { vi.restoreAllMocks(); document.body.empty(); });

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
  expect(plugin.openTaskView).toHaveBeenCalledWith({ mode: "inbox" }, { newLeaf: false });
  row("favorite:file:Notes.md")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledOnce());
  // A folder opens in place, listing what is in it.
  row("favorite:folder:Work")!.querySelector<HTMLElement>(".tm-nav-label")!.click();
  expect(favoriteLabels()).toEqual(["Site", "Inbox", "Work", "Plan", "Notes"]);
  // A project's right-click is its actions menu.
  rightClick(row("favorite:project:Site.md")!);
  expect(plugin.openProjectMenu).toHaveBeenCalledWith("Site.md", expect.any(HTMLElement), { x: 12, y: 34 });
});

it("reorders favourites, smart lists, a parent's subprojects and tags by dragging, each among its own", async () => {
  const { row, favoriteLabels, sectionLabels, settings, plugin, container } = setup(["mode:today", "mode:inbox", "tag:errand"]);
  // Lifted, the row folds away and the gap takes its place; over the top half of Today, the gap opens above it.
  const errand = grab(row("favorite:tag:errand")!);
  expect(row("favorite:tag:errand")!.classList.contains("tm-drag-source")).toBe(true);
  expect(gapPlace()).toEqual({ above: "Inbox", depth: "0" });
  errand.to(row("favorite:mode:today")!, 4);
  expect(gapPlace()).toEqual({ above: null, depth: "0" });
  errand.drop();
  await vi.waitFor(() => expect(settings.favorites).toEqual(["tag:errand", "mode:today", "mode:inbox"]));
  expect(favoriteLabels()).toEqual(["errand", "Today", "Inbox"]);
  expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  // A favourite stays among the favourites: over another section its gap goes back to its own place.
  const inbox = grab(row("favorite:mode:inbox")!).to(row("tag:home")!, 4);
  expect(gapPlace()).toEqual({ above: "Today", depth: "0" });
  inbox.drop();
  await vi.waitFor(() => expect(gap()).toBeNull());
  expect(settings.favorites).toEqual(["tag:errand", "mode:today", "mode:inbox"]);
  expect(plugin.saveSettings).toHaveBeenCalledTimes(1);

  grab(row("list:errands")!).to(row("list:calls")!, 4).drop();
  await vi.waitFor(() => expect(settings.smartLists.map(list => list.id)).toEqual(["errands", "calls"]));

  const projects = () => Array.from(sectionLabels(1)).map(label => label.textContent);
  expect(projects()).toEqual(["Home", "Work", "Ads", "Site"]);
  grab(row("project:Site.md")!).to(row("project:Ads.md")!, 4).drop();
  await vi.waitFor(() => expect(projects()).toEqual(["Home", "Work", "Site", "Ads"]));
  // A parent takes its subprojects along: they fold away with it.
  const work = grab(row("project:Work.md")!);
  expect(["Work.md", "Site.md", "Ads.md"].map(path => row(`project:${path}`)!.classList.contains("tm-drag-source"))).toEqual([true, true, true]);
  work.to(row("project:Home.md")!, 4).drop();
  await vi.waitFor(() => expect(projects()).toEqual(["Work", "Site", "Ads", "Home"]));
  expect(settings.navOrder.projects).toEqual(["Work.md", "Site.md", "Ads.md", "Home.md"]);
  expect(plugin.updateProject).not.toHaveBeenCalled();

  const tags = () => Array.from(sectionLabels(2)).map(label => label.textContent);
  grab(row("tag:errand")!).to(row("tag:home")!, 16).drop();
  await vi.waitFor(() => expect(tags()).toEqual(["home", "errand"]));
  expect(settings.navOrder.tags).toEqual(["home", "errand"]);
  expect(container.querySelector(".tm-drop-gap, .tm-drag-source, .is-being-dragged, .is-drop-target")).toBeNull();
  expect(document.querySelector(".tm-drag-preview")).toBeNull();
});

it("lifts the row and lets the rows around it make room, and Escape puts it back", async () => {
  const { row, settings } = setup(["mode:today", "mode:inbox", "tag:errand"]);
  const inbox = row("favorite:mode:inbox")!;
  const today = row("favorite:mode:today")!;
  const top = today.getBoundingClientRect().top;
  const drag = grab(row("favorite:tag:errand")!);
  // A copy follows the pointer; its row's slot is the gap, so nothing moves yet.
  const copy = document.querySelector<HTMLElement>(".tm-nav-drag-layer .tm-drag-preview")!;
  expect(copy.textContent).toContain("errand");
  expect(document.body.classList.contains("tm-list-dragging")).toBe(true);
  expect(inbox.getBoundingClientRect().top).toBe(top + 20);
  // Above Today, the gap opens there: Today and Inbox move down a row to make room.
  drag.to(today, 4);
  expect([today.getBoundingClientRect().top, inbox.getBoundingClientRect().top]).toEqual([top + 20, top + 40]);
  expect(gap()!.style.getPropertyValue("--tm-gap-height")).toBe("20px");
  drag.escape();
  await vi.waitFor(() => expect(gap()).toBeNull());
  expect(document.querySelector(".tm-drag-preview")).toBeNull();
  expect(document.body.classList.contains("tm-list-dragging")).toBe(false);
  expect(row("favorite:tag:errand")!.classList.contains("tm-drag-source")).toBe(false);
  expect(row("favorite:tag:errand")!.style.height).toBe("");
  expect(settings.favorites).toEqual(["mode:today", "mode:inbox", "tag:errand"]);
});

it("nests a project under the one above when dragged right, and takes it out when dragged left, as tasks do", async () => {
  const { row, sectionLabels, settings, plugin } = setup();
  const tree = () => Array.from(sectionLabels(1)).map(label => `${"-".repeat(Number(label.closest<HTMLElement>(".tm-nav-item")!.style.getPropertyValue("--tm-nav-depth")))}${label.textContent}`);
  expect(tree()).toEqual(["Home", "Work", "-Ads", "-Site"]);
  // Right, where it is: under the project above it; the gap slides in a level.
  let drag = grab(row("project:Site.md")!).to(gap()!, 10, 30);
  expect(gapPlace()).toEqual({ above: "Ads", depth: "2" });
  drag.drop();
  await vi.waitFor(() => expect(tree()).toEqual(["Home", "Work", "-Ads", "--Site"]));
  expect(plugin.updateProject).toHaveBeenLastCalledWith("Site.md", expect.any(Function));
  // Left, where it is: out from under its parent, a level per step, after the project it was under.
  drag = grab(row("project:Site.md")!).to(gap()!, 10, -20);
  expect(gapPlace()!.depth).toBe("1");
  drag.drop();
  await vi.waitFor(() => expect(tree()).toEqual(["Home", "Work", "-Ads", "-Site"]));
  drag = grab(row("project:Ads.md")!).to(gap()!, 10, -40);
  expect(gapPlace()!.depth).toBe("0");
  drag.drop();
  await vi.waitFor(() => expect(tree()).toEqual(["Home", "Work", "-Site", "Ads"]));
  // Below a nested project it goes beside it; a top project can't nest with nothing above it.
  drag = grab(row("project:Home.md")!).to(row("project:Site.md")!, 16);
  expect(gapPlace()).toEqual({ above: "Site", depth: "1" });
  drag.drop();
  await vi.waitFor(() => expect(tree()).toEqual(["Work", "-Site", "-Home", "Ads"]));
  drag = grab(row("project:Work.md")!).to(gap()!, 10, 50);
  expect(gapPlace()!.depth).toBe("0");
  drag.drop();
  await vi.waitFor(() => expect(gap()).toBeNull());
  expect(tree()).toEqual(["Work", "-Site", "-Home", "Ads"]);
  expect(settings.navOrder.projects).toEqual(["Work.md", "Site.md", "Home.md", "Ads.md"]);
  expect(plugin.updateProject).toHaveBeenCalledTimes(4);
});

it("adds what is dropped into Favorites: on its heading at the end, beside a favourite, or on the empty list", async () => {
  const { row, container, favoriteLabels, settings, app, byPath } = setup();
  const hint = container.querySelector<HTMLElement>(".tm-nav-favorites .tm-nav-empty")!;
  // A list keeps its place in the lists, faded while it is dragged, and drops into Favorites.
  const today = row("mode:today")!;
  const drag = grab(today);
  expect(today.classList.contains("is-being-dragged")).toBe(true);
  expect(today.classList.contains("tm-drag-source")).toBe(false);
  expect(gap()).toBeNull();
  drag.to(hint).drop();
  await vi.waitFor(() => expect(settings.favorites).toEqual(["mode:today"]));
  expect(favoriteLabels()).toEqual(["Today"]);
  expect(row("mode:today")).not.toBeNull();
  // On the heading, at the end, the heading lit up.
  const home = grab(row("tag:home")!).to(row("favorites")!);
  expect(row("favorites")!.classList.contains("is-drop-target")).toBe(true);
  expect(gapPlace()).toEqual({ above: "Today", depth: "0" });
  home.drop();
  await vi.waitFor(() => expect(settings.favorites).toEqual(["mode:today", "tag:home"]));
  // Beside a favourite, before or after it.
  grab(row("project:Site.md")!).to(row("favorite:tag:home")!, 4).drop();
  await vi.waitFor(() => expect(settings.favorites).toEqual(["mode:today", "project:Site.md", "tag:home"]));
  grab(row("list:errands")!).to(row("favorite:mode:today")!, 16).drop();
  await vi.waitFor(() => expect(favoriteLabels()).toEqual(["Today", "Errands", "Site", "home"]));
  // A favourite dropped on the heading moves to the end.
  grab(row("favorite:mode:today")!).to(row("favorites")!).drop();
  await vi.waitFor(() => expect(settings.favorites).toEqual(["list:errands", "project:Site.md", "tag:home", "mode:today"]));
  expect(container.querySelector(".is-drop-target, .tm-drop-gap, .is-being-dragged")).toBeNull();
  // Files and folders from the file explorer drop in through Obsidian's drag manager, anywhere in the list: the gap
  // opens where they go, as for the sidebar's own rows.
  const list = () => container.querySelector<HTMLElement>(".tm-nav-list")!;
  const over = (target: HTMLElement, at: number) => ({ clientX: 100, clientY: target.getBoundingClientRect().top + at }) as DragEvent;
  const drop = () => app.dragManager.drops.get(list())!;
  expect(drop()(over(row("favorites")!, 10), { type: "folder", file: byPath.get("Work") }, true)).toMatchObject({ action: "Add to favorites", dropEffect: "move" });
  expect(row("favorites")!.classList.contains("is-drop-target")).toBe(true);
  expect(gapPlace()).toEqual({ above: "Today", depth: "0" });
  drop()(over(row("favorites")!, 10), { type: "folder", file: byPath.get("Work") }, false);
  await vi.waitFor(() => expect(settings.favorites).toEqual(["list:errands", "project:Site.md", "tag:home", "mode:today", "folder:Work"]));
  drop()(over(row("favorite:list:errands")!, 4), { type: "file", file: byPath.get("Notes.md") }, true);
  expect(gapPlace()).toEqual({ above: null, depth: "0" });
  drop()(over(row("favorite:list:errands")!, 4), { type: "file", file: byPath.get("Notes.md") }, false);
  await vi.waitFor(() => expect(settings.favorites).toEqual(["file:Notes.md", "list:errands", "project:Site.md", "tag:home", "mode:today", "folder:Work"]));
  expect(gap()).toBeNull();
  // What is not a file (a task, say) is left to other targets.
  expect(drop()(over(row("favorites")!, 10), null, true)).toBeUndefined();
  expect(middleOf(row("favorites")!)).toBeGreaterThan(0);
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
