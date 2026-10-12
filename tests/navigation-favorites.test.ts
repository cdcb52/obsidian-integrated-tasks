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
    fileManager: { renameFile: vi.fn(), promptForDeletion: vi.fn() }
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
    openTaskView: vi.fn(async () => {}), openProject: vi.fn(async () => {}), openTag: vi.fn(async () => {}), openProjectMenu: vi.fn()
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
  return { view, settings, plugin, container, row, favoriteLabels, sectionLabels, openFile };
}

const rightClick = (row: HTMLElement) => {
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 12, clientY: 34 }));
  return menus[menus.length - 1];
};

/** Drags `source` onto `target`, in its top half (`before`) or its bottom half; returns whether `target` took it. */
function drag(source: HTMLElement, target: HTMLElement, before: boolean): boolean {
  const dataTransfer = { setData: vi.fn(), types: [] as string[], effectAllowed: "", dropEffect: "" };
  const event = (type: string) => {
    const made = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(made, { dataTransfer: { value: dataTransfer }, clientY: { value: before ? 2 : 18 } });
    return made;
  };
  target.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
  source.dispatchEvent(event("dragstart"));
  expect(dataTransfer.setData).toHaveBeenCalledWith("application/x-task-manager-nav-item", expect.any(String));
  const over = event("dragover");
  target.dispatchEvent(over);
  if (over.defaultPrevented) expect(target.classList.contains(before ? "tm-nav-drop-before" : "tm-nav-drop-after")).toBe(true);
  target.dispatchEvent(event("drop"));
  source.dispatchEvent(event("dragend"));
  return over.defaultPrevented;
}

it("puts Favorites at the top, filled from any item's right-click menu", async () => {
  const { container, row, favoriteLabels, plugin, settings } = setup();
  const first = container.querySelector(".tm-nav-list > .tm-nav-group")!;
  expect(first.classList.contains("tm-nav-favorites")).toBe(true);
  expect(first.querySelector(".tm-nav-label")!.textContent).toBe("Favorites");
  expect(first.querySelector(".tm-nav-empty")!.textContent).toBe("Right-click an item to add it here");
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
  expect(drag(row("project:Work.md")!, row("project:Home.md")!, true)).toBe(true);
  expect(projects()).toEqual(["Work", "Site", "Ads", "Home"]);
  expect(settings.navOrder.projects).toEqual(["Work.md", "Site.md", "Ads.md", "Home.md"]);
  // A subproject stays under its parent: it does not drop among the top projects.
  expect(drag(row("project:Ads.md")!, row("project:Home.md")!, false)).toBe(false);

  const tags = () => Array.from(sectionLabels(2)).map(label => label.textContent);
  expect(drag(row("tag:errand")!, row("tag:home")!, false)).toBe(true);
  expect(tags()).toEqual(["home", "errand"]);
  expect(settings.navOrder.tags).toEqual(["home", "errand"]);
  expect(container.querySelector(".tm-nav-drop-before, .tm-nav-drop-after, .is-being-dragged")).toBeNull();
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
