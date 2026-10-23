// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installObsidianDom } from "./helpers/obsidian-dom";

const menus: Array<{ items: Array<{ title: string; click: () => void }>; separators: number }> = [];
vi.mock("obsidian", async importOriginal => {
  const original = await importOriginal<typeof import("./obsidian-mock")>();
  class Menu {
    items: Array<{ title: string; click: () => void }> = [];
    separators = 0;
    constructor() { menus.push(this); }
    addItem(build: (item: Record<string, (value: unknown) => unknown>) => void): this {
      const entry = { title: "", click: () => {} };
      const item: Record<string, (value: unknown) => unknown> = {
        setTitle: value => { entry.title = String(value); return item; },
        setIcon: () => item,
        onClick: value => { entry.click = value as () => void; return item; }
      };
      build(item);
      this.items.push(entry);
      return this;
    }
    addSeparator(): this { this.separators++; return this; }
    showAtPosition(): void {}
  }
  return { ...original, Menu, Notice: class {}, setIcon: vi.fn() };
});

// Asking before deleting opens an Obsidian modal; the tests check what it asks.
vi.mock("../src/confirm-modal", () => ({ openConfirm: vi.fn() }));

import { Platform, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { openConfirm } from "../src/confirm-modal";
import { TaskIndex } from "../src/task-index";
import { activeTaskDrag } from "../src/sidebar-drop";
import { TaskMainView } from "../src/task-view";
import { DEFAULT_SETTINGS, type Project } from "../src/types";
import { todayIso } from "../src/date";
import { addDays } from "../src/calendar";
import type TaskManagerPlugin from "../src/main";

beforeAll(() => {
  installObsidianDom();
  // happy-dom has no pointer capture; row drags and swipes call it.
  HTMLElement.prototype.setPointerCapture ??= () => {};
  HTMLElement.prototype.releasePointerCapture ??= () => {};
});
afterEach(() => { document.body.innerHTML = ""; menus.length = 0; vi.unstubAllGlobals(); });

function note(path: string, count: number, line: (i: number) => string = i => `- [ ] ${path} task ${i}`): [string, string] {
  return [path, Array.from({ length: count }, (_, i) => line(i)).join("\n")];
}

async function setup(notes: Array<[string, string]>, frontmatter: Record<string, Record<string, unknown>> = {}) {
  const files = new Map(notes.map(([path]) => [path, Object.assign(new TFile(), { path, extension: "md", basename: path.replace(/\.md$/, "") })]));
  const contents = new Map(notes);
  let emitModify: (file: TFile) => void = () => {};
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()],
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
      on: (event: string, callback: (file: TFile) => void) => { if (event === "modify") emitModify = callback; return {}; },
      offref: () => {}
    },
    metadataCache: { getFileCache: (file: TFile) => frontmatter[file.path] ? { frontmatter: frontmatter[file.path] } : {}, on: () => ({}), offref: () => {}, getFirstLinkpathDest: (link: string) => files.get(link.endsWith(".md") ? link : `${link}.md`) ?? null },
    workspace: { getLeaf: () => ({ openFile: vi.fn() }) }
  } as unknown as App;
  const index = new TaskIndex(app, () => DEFAULT_SETTINGS, () => "YYYY-MM-DD");
  await index.initialize();
  const store = { toggle: vi.fn().mockResolvedValue(undefined), bulkDrop: vi.fn().mockResolvedValue([]), bulkChange: vi.fn().mockResolvedValue([]), setStatus: vi.fn().mockResolvedValue([]) };
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, taskDetails: "view" }, index, store, dateFormat: () => "YYYY-MM-DD",
    openEditor: vi.fn(), openTaskView: vi.fn(), undoTaskChange: vi.fn(), redoTaskChange: vi.fn(), openQuickSwitcher: vi.fn(), saveSettings: vi.fn(),
    showInTaskSidebar: vi.fn().mockResolvedValue(undefined),
    projectDraft: vi.fn(() => ({ name: "Site", date: "", endDate: "", deadline: "", priority: "", parent: "", tags: "work", color: "" })),
    updateProject: vi.fn().mockResolvedValue("Site.md"), deleteProject: vi.fn().mockResolvedValue(undefined),
    isFavorite: vi.fn(() => false), toggleFavorite: vi.fn().mockResolvedValue(undefined), app
  };
  const view = new TaskMainView({ app } as unknown as WorkspaceLeaf, plugin as unknown as TaskManagerPlugin);
  const internals = view as unknown as { refresh(): void; content: HTMLElement };
  const edit = async (path: string, content: string) => { contents.set(path, content); emitModify(files.get(path)!); await new Promise(resolve => setTimeout(resolve, 0)); };
  return { view, internals, index, store, plugin, edit, files, read: (path: string) => contents.get(path) ?? "", content: () => internals.content };
}

const rows = (container: HTMLElement, section?: HTMLElement) => Array.from((section ?? container).querySelectorAll<HTMLElement>(".tm-task-item"));
const sections = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("section.tm-section"));
const key = (target: HTMLElement, key: string, options: KeyboardEventInit = {}) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options }));
/** Row actions (S, M, Alt+arrows) need the task selected: click it first. */
const act = (row: HTMLElement, name: string, options: KeyboardEventInit = {}) => { row.click(); return key(row, name, options); };

describe("groups named by note", () => {
  it("name a note by its name alone, or by its path in the vault, as Settings › Note group names say", async () => {
    const { view, content, plugin } = await setup([note("Work/Clients/Acme.md", 1), note("Home.md", 1)]);
    const groups = () => Array.from(content().querySelectorAll(".tm-section > h2 > span, .tm-kanban-column-header h2")).map(title => title.textContent?.trim());
    // All Tasks groups by note.
    await view.setState({ mode: "all" });
    expect(groups()).toEqual(["Home", "Acme"]);
    plugin.settings.noteGroupLabel = "path";
    await view.setState({ mode: "today" });
    await view.setState({ mode: "all" });
    expect(groups()).toEqual(["Home", "Work/Clients/Acme"]);
    await view.setState({ mode: "all", layout: "kanban" } as never);
    expect(groups()).toEqual(["Home", "Work/Clients/Acme"]);
  });
});

describe("paged task lists", () => {
  it("keeps rows the user loaded in a later section across re-renders, with a minimum per section", async () => {
    const { view, internals, content } = await setup([note("A.md", 500), note("B.md", 300)]);
    await view.setState({ mode: "all" });
    let [a, b] = sections(content());
    expect(rows(content(), a)).toHaveLength(200);
    expect(rows(content(), b)).toHaveLength(20);
    b.querySelector<HTMLButtonElement>(".tm-show-more-tasks")!.click();
    expect(rows(content(), b)).toHaveLength(220);
    internals.refresh();
    [a, b] = sections(content());
    expect(rows(content(), a)).toHaveLength(200);
    expect(rows(content(), b)).toHaveLength(220);
    expect(b.querySelector(".tm-show-more-tasks")!.textContent).toBe("Show 80 more (80 hidden)");
  });

  it("keeps a selected task shown and selected when other tasks push it past the page", async () => {
    const { view, internals, content, edit } = await setup([["A.md", ""], note("B.md", 30)]);
    await view.setState({ mode: "all" });
    rows(content())[25].click();
    await edit("A.md", note("A.md", 300)[1]);
    internals.refresh();
    const [a, b] = sections(content());
    expect(rows(content(), a)).toHaveLength(200);
    expect(rows(content(), b)).toHaveLength(26);
    expect(rows(content(), b)[25].classList.contains("is-selected")).toBe(true);
    expect(view.getSelectedTasks().map(task => task.title)).toEqual(["B.md task 25"]);
  });

  it("shows today's tasks even when overdue tasks fill the page", async () => {
    // Local date: an ISO (UTC) date is yesterday or tomorrow for part of the day in many time zones.
    const { view, content } = await setup([note("Late.md", 300, i => `- [ ] Late ${i} 2020-01-01`), note("Now.md", 5, i => `- [ ] Now ${i} ${todayIso()}`)]);
    await view.setState({ mode: "today" });
    const [overdue, today] = sections(content());
    expect(rows(content(), overdue)).toHaveLength(200);
    expect(rows(content(), today)).toHaveLength(5);
  });

  it("moves focus to the first new row when Show more is used from the keyboard, and observes the pane", async () => {
    const observed: IntersectionObserverInit[] = [];
    vi.stubGlobal("IntersectionObserver", class { constructor(_: unknown, options: IntersectionObserverInit) { observed.push(options); } observe(): void {} disconnect(): void {} });
    const { view, internals, content } = await setup([note("A.md", 250)]);
    await view.setState({ mode: "all" });
    expect(observed[0].root).toBe(internals.content);
    const more = content().querySelector<HTMLButtonElement>(".tm-show-more-tasks")!;
    more.focus();
    more.click();
    expect(document.activeElement).toBe(rows(content())[200]);
    expect(content().querySelector(".tm-show-more-tasks")).toBeNull();
    expect(content().querySelector("[aria-live]")!.textContent).toBe("Showing 50 more tasks");
  });
});

describe("focus", () => {
  it("takes focus into the list when its tab comes to the front with focus, keeping focus already in it", async () => {
    const { view, content } = await setup([note("A.md", 3)]);
    await view.setState({ mode: "all" });
    const outside = document.body.createEl("button");
    outside.focus();
    // As Obsidian does for the tab it makes active (a list opened from the task sidebar, say).
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(rows(content())[0]);
    // Focus already in the view stays where it is.
    const checkbox = rows(content())[2].querySelector<HTMLInputElement>("[data-tm-focus-key=checkbox]")!;
    checkbox.focus();
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(checkbox);
    // Coming back, it goes to the row last in the tab order; without focus asked for, nothing moves.
    outside.focus();
    view.setEphemeralState({});
    expect(document.activeElement).toBe(outside);
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(rows(content())[2]);
    // A view with no rows takes focus itself.
    await view.setState({ mode: "inbox" });
    expect(rows(content())).toHaveLength(0);
    outside.focus();
    view.setEphemeralState({ focus: true });
    expect(document.activeElement).toBe(content());
  });
});

describe("re-rendering", () => {
  it("restores focus to the same control and keeps scroll position", async () => {
    const { view, internals, content } = await setup([note("A.md", 30)]);
    await view.setState({ mode: "all" });
    const checkbox = rows(content())[5].querySelector<HTMLInputElement>("[data-tm-focus-key=checkbox]")!;
    checkbox.focus();
    content().scrollTop = 120;
    internals.refresh();
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("data-tm-focus-key")).toBe("checkbox");
    expect(focused.closest(".tm-task-item")!.getAttribute("data-task-id")).toBe("A.md:5");
    expect(content().scrollTop).toBe(120);
  });

  it("restores the scroll position of elements that are recreated, such as the board", async () => {
    const { view, internals, content } = await setup([note("A.md", 3), note("B.md", 3)]);
    await view.setState({ mode: "all", layout: "kanban" });
    const board = content().querySelector<HTMLElement>("[data-tm-scroll-key=kanban]")!;
    board.scrollLeft = 300;
    internals.refresh();
    const next = content().querySelector<HTMLElement>("[data-tm-scroll-key=kanban]")!;
    expect(next).not.toBe(board);
    expect(next.scrollLeft).toBe(300);
  });

  it("focuses the row now at the same position when the focused task disappears", async () => {
    const { view, content, edit } = await setup([note("A.md", 5)]);
    await view.setState({ mode: "all" });
    rows(content())[2].focus();
    await edit("A.md", "- [ ] A.md task 0\n- [ ] A.md task 1\n- [x] A.md task 2\n- [ ] A.md task 3\n- [ ] A.md task 4");
    (view as unknown as { refresh(): void }).refresh();
    expect((document.activeElement as HTMLElement).getAttribute("data-task-id")).toBe("A.md:3");
  });

  it("shows done and cancelled tasks when grouped by status, and every status checked in View options", async () => {
    const { view, content } = await setup([["A.md", "- [ ] Open\n- [x] Shipped\n- [-] Dropped"]]);
    await view.setState({ mode: "all" });
    const checked = () => {
      content().querySelector<HTMLButtonElement>('[data-tm-focus-key="option-status"]')!.click();
      const options = Array.from(content().querySelectorAll(".tm-options-dropdown [aria-selected=true]")).map(option => option.textContent);
      content().querySelector<HTMLButtonElement>('[data-tm-focus-key="option-status"]')!.click();
      return options;
    };
    view.containerEl.querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
    expect(checked()).toEqual(["View default", "To do", "In progress", "Waiting"]);
    (view as unknown as { grouping: string }).grouping = "status";
    view.render();
    expect(Array.from(content().querySelectorAll(".tm-task-item .tm-task-title")).map(title => title.textContent)).toEqual(["Open", "Shipped", "Dropped"]);
    view.containerEl.querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
    expect(checked()).toEqual(["View default", "To do", "In progress", "Waiting", "Done", "Cancelled"]);
  });

  it("keeps the options panel, an open dropdown and a half-built filter when tasks change", async () => {
    const { view, internals, content } = await setup([note("A.md", 3)]);
    await view.setState({ mode: "all" });
    view.containerEl.querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
    const panel = content().querySelector(".tm-options-panel")!;
    content().querySelector<HTMLButtonElement>('[data-tm-focus-key="option-title"]')!.click();
    content().querySelector<HTMLElement>(".tm-options-option.is-action")!.click();
    const condition = content().querySelector<HTMLSelectElement>(".tm-options-conditions select")!;
    condition.value = "contains";
    content().querySelector<HTMLButtonElement>('[data-tm-focus-key="option-status"]')!.click();
    internals.refresh();
    expect(content().querySelector(".tm-options-panel")).toBe(panel);
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(content().querySelector(".tm-options-dropdown [role=listbox]")!.getAttribute("aria-label")).toBe("Status");
    expect(content().querySelector<HTMLSelectElement>(".tm-options-conditions select")!.value).toBe("contains");
  });

  it("coalesces index updates into one refresh per frame and cancels it when the view closes", async () => {
    const frames: FrameRequestCallback[] = [];
    const { view, index, edit } = await setup([note("A.md", 3)]);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frames.push(callback); return frames.length; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    await view.onOpen();
    const refresh = vi.spyOn(view as unknown as { refresh(): void }, "refresh");
    await edit("A.md", "- [ ] one");
    await edit("A.md", "- [ ] one\n- [ ] two");
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(refresh).toHaveBeenCalledOnce();
    await edit("A.md", "- [ ] three");
    await view.onClose();
    expect(cancel).toHaveBeenCalledWith(2);
    expect(index.allTasks().map(task => task.title)).toEqual(["three"]);
  });
});

describe("keyboard", () => {
  it("keeps one row in the tab order and row controls out of it until the row is focused", async () => {
    const { view, content } = await setup([note("A.md", 4, i => `- [ ] Task ${i} 2026-10-0${i + 1} #[[tag]]`)]);
    await view.setState({ mode: "all" });
    expect(rows(content()).map(row => row.tabIndex)).toEqual([0, -1, -1, -1]);
    const controls = (row: HTMLElement) => Array.from(row.querySelectorAll<HTMLElement>("input, button, [role=button]")).map(control => control.tabIndex);
    expect(new Set(controls(rows(content())[1]))).toEqual(new Set([-1]));
    rows(content())[1].focus();
    expect(rows(content()).map(row => row.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(new Set(controls(rows(content())[1]))).toEqual(new Set([0]));
    expect(rows(content())[1].hasAttribute("aria-label")).toBe(false);
  });

  it("moves the selection with arrows and extends it with Shift; with nothing selected, arrows start at an end", async () => {
    const { view, content } = await setup([note("A.md", 4)]);
    await view.setState({ mode: "all" });
    const lines = () => view.getSelectedTasks().map(task => task.line);
    rows(content())[2].focus();
    // Nothing selected, so nothing is "active": Down starts at the first task.
    key(rows(content())[2], "ArrowDown");
    expect(lines()).toEqual([0]);
    expect(document.activeElement).toBe(rows(content())[0]);
    key(rows(content())[0], "ArrowDown");
    expect(lines()).toEqual([1]);
    expect(document.activeElement).toBe(rows(content())[1]);
    key(rows(content())[1], "ArrowDown", { shiftKey: true });
    expect(lines()).toEqual([1, 2]);
    expect(rows(content())[2].querySelector(".tm-selected-marker")!.textContent).toBe("Selected");
    key(rows(content())[2], "End");
    expect(lines()).toEqual([3]);
    expect(document.activeElement).toBe(rows(content())[3]);
    // Escape clears the selection; Up then starts at the last task.
    key(rows(content())[3], "Escape");
    expect(lines()).toEqual([]);
    key(rows(content())[3], "ArrowUp");
    expect(lines()).toEqual([3]);
  });

  it("selects a focused task on Enter instead of opening it while nothing is selected", async () => {
    const { view, content, plugin } = await setup([note("A.md", 2)]);
    await view.setState({ mode: "all" });
    rows(content())[1].focus();
    key(rows(content())[1], "Enter");
    expect(view.getSelectedTasks().map(task => task.line)).toEqual([1]);
    expect(plugin.openEditor).not.toHaveBeenCalled();
    expect(document.querySelector(".tm-task-menu")).toBeNull();
  });

  it("reorders, nests and outdents with Alt+arrows", async () => {
    const { view, content, store, index, plugin } = await setup([["A.md", "- [ ] One\n- [ ] Two\n  - [ ] Child\n- [ ] Three"]]);
    plugin.settings.showSubtasks = true;
    await view.setState({ mode: "all" });
    const byTitle = (title: string) => rows(content()).find(row => row.textContent!.includes(title))!;
    const task = (title: string) => index.allTasks().find(item => item.title === title)!;
    act(byTitle("Three"), "ArrowUp", { altKey: true });
    await Promise.resolve();
    expect(store.bulkDrop).toHaveBeenLastCalledWith([task("Three")], { destination: "A.md" }, task("Two"), "before");
    act(byTitle("Two"), "ArrowRight", { altKey: true });
    await Promise.resolve();
    expect(store.bulkDrop).toHaveBeenLastCalledWith([task("Two")], { destination: "A.md" }, task("One"), "child");
    act(byTitle("Child"), "ArrowLeft", { altKey: true });
    await Promise.resolve();
    expect(store.bulkDrop).toHaveBeenLastCalledWith([task("Child")], { destination: "A.md" }, task("Two"), "after");
    // A move from the keyboard is no pointer drag: the sidebar is not told to show where to drop.
    expect(activeTaskDrag()).toBeUndefined();
  });

  it("offers only the places to move to in the M menu", async () => {
    const { view, content, store, index } = await setup([note("A.md", 2), note("B.md", 2)]);
    await view.setState({ mode: "all" });
    act(rows(content())[0], "m");
    expect(menus[0].items.map(item => item.title)).toEqual(["Move to A", "Move to B"]);
    menus[0].items[1].click();
    await Promise.resolve();
    expect(store.bulkDrop).toHaveBeenLastCalledWith([index.allTasks()[0]], { destination: "B.md" }, undefined, undefined);
  });

  it("opens the status list on S, for the whole selection", async () => {
    const { view, content, store, index } = await setup([["A.md", "- [/] Draft\n- [ ] Review\n- [ ] Send"]]);
    await view.setState({ mode: "all" });
    act(rows(content())[0], "s");
    const popover = document.querySelector<HTMLElement>(".tm-choice-popover")!;
    expect(popover.getAttribute("aria-label")).toBe("Status");
    expect(popover.querySelector("[aria-selected=true]")!.getAttribute("data-value")).toBe("doing");
    // S again moves on through the statuses, round to the first after the last; Enter sets the one reached.
    key(document.activeElement as HTMLElement, "s");
    expect(document.activeElement!.getAttribute("data-value")).toBe("waiting");
    for (const next of ["done", "cancelled", "todo"]) {
      key(document.activeElement as HTMLElement, "S", { shiftKey: true });
      expect(document.activeElement!.getAttribute("data-value")).toBe(next);
    }
    key(document.activeElement as HTMLElement, "s");
    key(document.activeElement as HTMLElement, "s");
    expect(store.setStatus).not.toHaveBeenCalled();
    key(document.activeElement as HTMLElement, "Enter");
    expect(store.setStatus).toHaveBeenLastCalledWith([index.allTasks()[0]], "waiting");
    rows(content())[1].click();
    key(rows(content())[1], "ArrowDown", { shiftKey: true });
    key(rows(content())[2], "s");
    document.querySelector<HTMLElement>(".tm-choice-popover [data-value='cancelled']")!.click();
    expect(store.setStatus).toHaveBeenLastCalledWith(index.allTasks().slice(1), "cancelled");
  });

  it("completes the selection on C, or reopens it when all of it is complete, and does nothing once deselected", async () => {
    const { view, content, store, index } = await setup([["A.md", "- [ ] One\n- [x] Two"]]);
    view["showCompleted"] = true;
    await view.setState({ mode: "all" });
    expect(rows(content())[0].getAttribute("aria-keyshortcuts")).toMatch(/ M Shift\+T D Shift\+D P T G R S Shift\+S C$/);
    act(rows(content())[0], "c");
    expect(store.setStatus).toHaveBeenLastCalledWith([index.allTasks()[0]], "done");
    act(rows(content())[1], "c");
    expect(store.setStatus).toHaveBeenLastCalledWith([index.allTasks()[1]], "todo");
    // After Escape the row keeps focus but is no longer selected, so the letters do nothing.
    key(rows(content())[0], "Escape");
    key(rows(content())[0], "c");
    key(rows(content())[0], "s");
    expect(store.setStatus).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".tm-choice-popover")).toBeNull();
  });

  it("moves through the priorities on P in the priority list, setting one with Enter", async () => {
    const { view, content, store, index } = await setup([["A.md", "- [ ] Report p2"]]);
    const bulkUpdate = vi.fn().mockResolvedValue([]);
    (store as unknown as { bulkUpdate: typeof bulkUpdate }).bulkUpdate = bulkUpdate;
    await view.setState({ mode: "all" });
    act(rows(content())[0], "p");
    expect(document.activeElement!.getAttribute("data-value")).toBe("2");
    const values = ["3", "", "1", "2"].map(() => { key(document.activeElement as HTMLElement, "p"); return document.activeElement!.getAttribute("data-value"); });
    expect(values).toEqual(["3", "", "1", "2"]);
    key(document.activeElement as HTMLElement, "p");
    expect(bulkUpdate).not.toHaveBeenCalled();
    key(document.activeElement as HTMLElement, "Enter");
    expect(bulkUpdate).toHaveBeenLastCalledWith([index.allTasks()[0]], { priority: 3 });
  });

  it("opens the task's actions on E, for the selection", async () => {
    const { view, content } = await setup([note("A.md", 2)]);
    await view.setState({ mode: "all" });
    key(rows(content())[0], "e");
    expect(document.querySelector(".tm-task-menu")).toBeNull();
    act(rows(content())[0], "e");
    const menu = document.querySelector<HTMLElement>(".tm-task-menu")!;
    expect(menu.getAttribute("aria-label")).toBe("Task actions");
    expect(document.activeElement?.querySelector(".tm-task-menu-label")?.textContent).toBe("Complete");
    menu.remove();
  });

  it("schedules for today on Shift+T and opens each property's popover from its letter", async () => {
    const { view, content, store, index } = await setup([note("A.md", 2)]);
    const bulkUpdate = vi.fn().mockResolvedValue([]);
    (store as unknown as { bulkUpdate: typeof bulkUpdate }).bulkUpdate = bulkUpdate;
    await view.setState({ mode: "all" });
    act(rows(content())[0], "T", { shiftKey: true });
    expect(bulkUpdate).toHaveBeenLastCalledWith([index.allTasks()[0]], { scheduledDate: todayIso() });
    const opened = (letter: string, shiftKey = false) => {
      document.querySelectorAll(".tm-date-popover, .tm-choice-popover, .tm-tags-popover").forEach(element => element.remove());
      key(rows(content())[0], letter, { shiftKey });
      return document.querySelector<HTMLElement>(".tm-date-popover, .tm-choice-popover, .tm-tags-popover")?.getAttribute("aria-label");
    };
    expect([opened("d"), opened("D", true), opened("p"), opened("t"), opened("g"), opened("r"), opened("S", true)])
      .toEqual(["When", "Deadline", "Priority", "Tags", "Move to project", "Repeat", undefined]);
  });

  it("marks each status on the row and in the checkbox's name, and reopens a cancelled task from its checkbox", async () => {
    const { view, content, store, index } = await setup([["A.md", "- [ ] One p1\n- [/] Two p2\n- [?] Three\n- [x] Four\n- [-] Five"]]);
    view["showCompleted"] = true;
    await view.setState({ mode: "all" });
    const boxes = rows(content()).map(row => row.querySelector<HTMLInputElement>("input.tm-task-checkbox")!);
    expect(boxes.map(box => box.getAttribute("aria-label"))).toEqual([
      "Complete One (priority 1)", "Complete Two (in progress, priority 2)", "Complete Three (waiting)", "Complete Four", "Complete Five (cancelled)"]);
    expect(boxes.map(box => ["is-doing", "is-waiting", "is-cancelled"].filter(name => box.classList.contains(name)))).toEqual([[], ["is-doing"], ["is-waiting"], [], ["is-cancelled"]]);
    expect(boxes.map(box => box.checked)).toEqual([false, false, false, true, true]);
    expect(rows(content()).map(row => row.classList.contains("is-cancelled"))).toEqual([false, false, false, false, true]);
    expect(rows(content()).map(row => row.classList.contains("is-completed"))).toEqual([false, false, false, true, true]);
    boxes[4].click();
    expect(store.toggle).toHaveBeenLastCalledWith(index.allTasks()[4], false);
    boxes[1].click();
    expect(store.toggle).toHaveBeenLastCalledWith(index.allTasks()[1], true);
  });
});

describe("undo and select all", () => {
  it("undoes on Cmd+Z and redoes on Cmd+Shift+Z, but not while typing in a field", async () => {
    const { view, content, plugin } = await setup([note("A.md", 2)]);
    await view.onOpen();
    await view.setState({ mode: "all" });
    key(rows(content())[0], "z", { metaKey: true });
    expect(plugin.undoTaskChange).toHaveBeenCalledOnce();
    key(rows(content())[0], "z", { metaKey: true, shiftKey: true });
    expect(plugin.undoTaskChange).toHaveBeenCalledOnce();
    expect(plugin.redoTaskChange).toHaveBeenCalledOnce();
    const search = content().appendChild(document.createElement("input"));
    key(search, "z", { metaKey: true });
    key(search, "z", { metaKey: true, shiftKey: true });
    expect(plugin.undoTaskChange).toHaveBeenCalledOnce();
    expect(plugin.redoTaskChange).toHaveBeenCalledOnce();
  });

  it("selects every task on Cmd+A, but not while typing in a field", async () => {
    const { view, content } = await setup([note("A.md", 3)]);
    await view.onOpen();
    await view.setState({ mode: "all" });
    const search = content().appendChild(document.createElement("input"));
    key(search, "a", { metaKey: true });
    expect(view.getSelectedTasks()).toEqual([]);
    key(rows(content())[1], "a", { metaKey: true });
    expect(view.getSelectedTasks().map(task => task.line)).toEqual([0, 1, 2]);
    expect(rows(content()).every(row => row.classList.contains("is-selected"))).toBe(true);
    // Each selected row the next one's selection continues is marked, to square off where they meet.
    expect(rows(content()).map(row => row.classList.contains("is-selection-continues"))).toEqual([true, true, false]);
    rows(content())[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(rows(content()).map(row => row.classList.contains("is-selection-continues"))).toEqual([false, false, false]);
  });
});

describe("today header, density and gestures", () => {
  const pointer = (target: HTMLElement, type: string, x: number, y = 0, pointerType = "touch") =>
    target.dispatchEvent(new PointerEvent(type, { pointerType, pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const swipe = (row: HTMLElement, dx: number, dy = 0, pointerType = "touch") => {
    pointer(row, "pointerdown", 100, 100, pointerType);
    pointer(row, "pointermove", 100 + dx / 2, 100 + dy / 2, pointerType);
    pointer(row, "pointermove", 100 + dx, 100 + dy, pointerType);
    pointer(row, "pointerup", 100 + dx, 100 + dy, pointerType);
  };

  it("shows no summary under the Today title", async () => {
    const today = todayIso();
    const { view, content } = await setup([["A.md", `- [x] Done ${today}\n- [ ] Write ${today} 1h30m`]]);
    await view.setState({ mode: "today" });
    expect(content().querySelector(".tm-today-summary")).toBeNull();
    expect(content().querySelector<HTMLElement>(".tm-project-header-metadata")!.hidden).toBe(true);
  });

  it("colours the source label of tasks from coloured projects, except on the project's own page", async () => {
    const { view, content } = await setup([note("Site.md", 1), note("Loose.md", 1)], { "Site.md": { tags: ["project"], color: "blue" } });
    await view.setState({ mode: "all" });
    const [site, loose] = [rows(content()).find(row => row.textContent!.includes("Site"))!, rows(content()).find(row => row.textContent!.includes("Loose"))!];
    expect(site.style.getPropertyValue("--tm-project-color")).toBe("var(--color-blue)");
    expect(site.querySelector(".tm-project-dot")).toBeNull();
    expect(loose.style.getPropertyValue("--tm-project-color")).toBe("");
    await view.setState({ mode: "all", pagePath: "Site.md" });
    expect(rows(content())[0].style.getPropertyValue("--tm-project-color")).toBe("");
  });

  it("applies the compact density class", async () => {
    const { view, content, plugin } = await setup([note("A.md", 1)]);
    (plugin.settings as Record<string, unknown>).density = "compact";
    await view.setState({ mode: "all" });
    expect(content().classList.contains("tm-density-compact")).toBe(true);
  });

  it("toggles a task's selection on a right swipe and opens its actions on a left swipe, touch only", async () => {
    const { view, content, store } = await setup([note("A.md", 2)]);
    await view.setState({ mode: "all" });
    const lines = () => view.getSelectedTasks().map(task => task.line);
    swipe(rows(content())[1], 100);
    expect(lines()).toEqual([1]);
    swipe(rows(content())[0], 100);
    expect(lines()).toEqual([0, 1]);
    swipe(rows(content())[1], 100);
    expect(lines()).toEqual([0]);
    expect(document.querySelector(".tm-task-menu")).toBeNull();
    swipe(rows(content())[1], -100);
    expect(document.querySelector(".tm-task-menu")).not.toBeNull();
    // Short, mostly vertical, and mouse drags are no swipes.
    document.body.querySelectorAll(".tm-task-menu").forEach(menu => menu.remove());
    swipe(rows(content())[0], 40);
    swipe(rows(content())[0], -30, 120);
    swipe(rows(content())[0], -100, 0, "mouse");
    swipe(rows(content())[0], 100, 0, "mouse");
    expect(lines()).toEqual([0]);
    expect(document.querySelector(".tm-task-menu")).toBeNull();
    expect(store.toggle).not.toHaveBeenCalled();
  });

  it("adds to a Griply group from its heading's +, and always lists subtasks as rows", async () => {
    const { view, content, plugin } = await setup([["A.md", "- [ ] Parent\n  - [ ] Child"], note("B.md", 1)]);
    plugin.settings.style = "griply";
    plugin.settings.showSubtasks = false;
    await view.setState({ mode: "all" });
    expect(content().classList.contains("tm-style-griply")).toBe(true);
    expect(rows(content()).map(row => row.querySelector(".tm-task-title")?.textContent)).toEqual(["Parent", "Child", "B.md task 0"]);
    const [, second] = sections(content());
    second.querySelector<HTMLButtonElement>("h2 .tm-group-add-task")!.click();
    expect(plugin.openEditor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ preset: expect.objectContaining({ destination: "B.md" }) }));
    // The Things style still follows the setting: the subtask lives in its task's card.
    plugin.settings.style = "things";
    await view.setState({ mode: "all" });
    expect(rows(content()).map(row => row.querySelector(".tm-task-title")?.textContent)).toEqual(["Parent", "B.md task 0"]);
  });

  it("opens a task on a single tap on mobile, where a right swipe selects; on desktop a click selects", async () => {
    const platform = Platform as { isMobile?: boolean; isPhone?: boolean };
    platform.isMobile = platform.isPhone = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { view, content, plugin } = await setup([note("A.md", 2)]);
      plugin.settings.style = "griply";
      await view.setState({ mode: "all" });
      const tap = (row: HTMLElement) => { pointer(row, "pointerdown", 10, 10); pointer(row, "pointerup", 10, 10); row.click(); };
      // (In the Task Details sidebar: phones always use three panes.)
      tap(rows(content())[0]);
      expect(plugin.showInTaskSidebar).toHaveBeenCalledExactlyOnceWith(rows(content())[0].getAttribute("data-task-id"), { focus: false });
      // The dblclick a browser may send after two taps opens nothing more.
      tap(rows(content())[0]);
      rows(content())[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      expect(plugin.showInTaskSidebar).toHaveBeenCalledTimes(2);
      // A click that ends a swipe, or a long press let go without moving, opens nothing.
      plugin.showInTaskSidebar.mockClear();
      view.clearSelection();
      swipe(rows(content())[1], 100);
      rows(content())[1].click();
      expect(view.getSelectedTasks().map(task => task.line)).toEqual([1]);
      pointer(rows(content())[0], "pointerdown", 10, 10);
      vi.advanceTimersByTime(400);
      pointer(rows(content())[0], "pointerup", 10, 10);
      rows(content())[0].click();
      expect(plugin.showInTaskSidebar).not.toHaveBeenCalled();
      expect(plugin.openEditor).not.toHaveBeenCalled();
      expect(view.getSelectedTasks().map(task => task.line)).toEqual([1]);
    } finally { platform.isMobile = platform.isPhone = false; vi.useRealTimers(); }
    // On desktop a click selects; a double-click opens.
    const { view, content, plugin } = await setup([note("A.md", 2)]);
    plugin.settings.style = "griply";
    await view.setState({ mode: "all" });
    rows(content())[1].click();
    expect(plugin.openEditor).not.toHaveBeenCalled();
    expect(view.getSelectedTasks().map(task => task.line)).toEqual([1]);
    rows(content())[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(plugin.openEditor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ task: expect.objectContaining({ line: 1 }) }));
  });

  it("opens the quick switcher on Cmd+K", async () => {
    const { view, content, plugin } = await setup([note("A.md", 1)]);
    await view.onOpen();
    await view.setState({ mode: "all" });
    key(rows(content())[0], "k", { metaKey: true });
    expect(plugin.openQuickSwitcher).toHaveBeenCalledOnce();
  });
});

it("lays board cards out like an open task card in the Things style", async () => {
  const { view, content, plugin } = await setup([["A.md", "- [ ] Plan the day 2026-09-17 {2026-09-30} p1 #[[Errand]]\n    - Pack a map\n    - [ ] Step\n- [ ] Plain"]]);
  plugin.settings.style = "things";
  await view.setState({ mode: "all", layout: "kanban" });
  const card = Array.from(content().querySelectorAll<HTMLElement>(".tm-things-board-card")).find(row => row.textContent!.includes("Plan the day"))!;
  const parts = Array.from(card.querySelector(".tm-task-content")!.children).map(child => child.className);
  expect(parts).toEqual(["tm-task-primary", "tm-things-board-notes", "tm-things-card-properties"]);
  // The notes show as text, and a board card has no subtask mark.
  expect(card.querySelector(".tm-things-checklist")).toBeNull();
  expect(card.querySelector(".tm-things-board-notes")!.textContent).toBe("Pack a map");
  expect(Array.from(card.querySelectorAll(".tm-things-card-tag")).map(tag => tag.textContent)).toEqual(["Errand"]);
  expect(card.querySelectorAll(".tm-things-card-property").length).toBe(3);
  // No one-line row parts on a board card.
  expect(card.querySelector(".tm-things-lead, .tm-things-trailing")).toBeNull();
  const plain = Array.from(content().querySelectorAll<HTMLElement>(".tm-things-board-card")).find(row => row.textContent!.includes("Plain"))!;
  expect(Array.from(plain.querySelector(".tm-task-content")!.children).map(child => child.className)).toEqual(["tm-task-primary"]);
});

it("lists a subtask on its own row only with Show subtasks on, or when its task is not in the view", async () => {
  const { view, content, plugin } = await setup([["A.md", `- [ ] Parent 2099-10-20\n  - [ ] Child ${todayIso()}\n- [ ] Other`]]);
  plugin.settings.style = "things";
  const titles = () => Array.from(content().querySelectorAll<HTMLElement>(".tm-task-row .tm-task-title")).map(title => title.textContent);
  await view.setState({ mode: "all" });
  expect(titles()).toEqual(["Parent", "Other"]);
  // Nothing to fold without subtask rows; the parent still marks that it has subtasks.
  expect(content().querySelector(".tm-row-fold")).toBeNull();
  expect(content().querySelector(".tm-things-checklist")).not.toBeNull();
  // Today holds the child but not its task, so the child shows there.
  await view.setState({ mode: "today" });
  expect(titles()).toEqual(["Child"]);
  plugin.settings.showSubtasks = true;
  await view.setState({ mode: "all" });
  expect(titles()).toEqual(["Parent", "Child", "Other"]);
});

describe("folding", () => {
  const titles = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(".tm-task-row .tm-task-title")).map(title => title.textContent);

  it("folds a task's subtasks away from its chevron or with Left and Right", async () => {
    const { view, content, plugin } = await setup([["A.md", "- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild\n- [ ] Other"]]);
    plugin.settings.showSubtasks = true;
    await view.setState({ mode: "all" });
    expect(titles(content())).toEqual(["Parent", "Child", "Grandchild", "Other"]);
    // Only rows with subtasks get a chevron.
    expect(content().querySelectorAll(".tm-row-fold")).toHaveLength(2);
    const parent = () => rows(content()).find(row => row.textContent!.includes("Parent"))!;
    parent().querySelector<HTMLElement>(".tm-row-fold")!.click();
    expect(titles(content())).toEqual(["Parent", "Other"]);
    expect(parent().classList.contains("is-folded")).toBe(true);
    expect(parent().querySelector(".tm-row-fold")!.getAttribute("aria-expanded")).toBe("false");
    key(parent(), "ArrowRight");
    expect(titles(content())).toEqual(["Parent", "Child", "Grandchild", "Other"]);
    key(parent(), "ArrowLeft");
    expect(titles(content())).toEqual(["Parent", "Other"]);
  });

  it("folds a group's tasks away from its heading", async () => {
    const { view, content } = await setup([note("A.md", 2), note("B.md", 1)]);
    await view.setState({ mode: "all" });
    const section = (name: string) => Array.from(content().querySelectorAll<HTMLElement>(".tm-section")).find(item => item.querySelector("h2")!.textContent!.includes(name))!;
    section("A").querySelector<HTMLElement>(".tm-group-fold")!.click();
    expect(section("A").classList.contains("is-folded")).toBe(true);
    expect(section("A").querySelectorAll(".tm-task-row")).toHaveLength(0);
    expect(section("B").querySelectorAll(".tm-task-row")).toHaveLength(1);
    section("A").querySelector<HTMLElement>(".tm-group-fold")!.click();
    expect(section("A").querySelectorAll(".tm-task-row")).toHaveLength(2);
    // A click on the heading itself folds and unfolds it too.
    section("A").querySelector<HTMLElement>("h2 > span")!.click();
    expect(section("A").classList.contains("is-folded")).toBe(true);
    section("A").querySelector<HTMLElement>("h2")!.click();
    expect(section("A").classList.contains("is-folded")).toBe(false);
  });

  it("keeps focus on a heading's fold button across a redraw, whatever the heading says", async () => {
    const { view, content } = await setup([["A.md", '# Review "draft"\n- [ ] One']]);
    await view.setState({ mode: "all", pagePath: "A.md" });
    const fold = () => content().querySelector<HTMLElement>(".tm-group-fold")!;
    fold().focus();
    expect(() => view.render()).not.toThrow();
    expect(document.activeElement).toBe(fold());
  });

  it("keeps folds across a reload of the same page and drops them on another page", async () => {
    const { view, content, plugin } = await setup([["A.md", "- [ ] Parent\n  - [ ] Child"]]);
    plugin.settings.showSubtasks = true;
    await view.setState({ mode: "all" });
    content().querySelector<HTMLElement>(".tm-row-fold")!.click();
    const saved = view.getState();
    expect(saved.folded).toEqual(["task:A.md#Parent"]);
    await view.setState({ mode: "today" });
    await view.setState({ ...saved, folded: undefined, mode: "all" });
    expect(titles(content())).toEqual(["Parent", "Child"]);
    await view.setState(saved);
    expect(titles(content())).toEqual(["Parent"]);
  });
});

describe("project actions", () => {
  const blank = { name: "Site", date: "", endDate: "", deadline: "", priority: "", parent: "", tags: "work", color: "" };
  const menuButton = (label: string) => Array.from(document.querySelectorAll<HTMLElement>(".tm-task-menu button"))
    .find(button => button.getAttribute("aria-label") === label || button.querySelector(".tm-task-menu-label")?.textContent === label)!;
  /** Applies the last change sent to updateProject to a blank draft. */
  const lastChange = (plugin: { updateProject: ReturnType<typeof vi.fn> }) => (plugin.updateProject.mock.lastCall![1] as (draft: typeof blank) => typeof blank)(blank);

  it("shows the … button beside a project's title, opening its actions", async () => {
    const { view, content, plugin } = await setup([note("Site.md", 1)], { "Site.md": { tags: ["project", "work"] } });
    await view.setState({ mode: "all", pagePath: "Site.md" });
    const more = content().querySelector<HTMLElement>(".tm-title-row .tm-title-more")!;
    expect(more.getAttribute("aria-label")).toBe("Project actions");
    more.click();
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const labels = Array.from(document.querySelectorAll(".tm-task-menu button")).map(button => button.getAttribute("aria-label") ?? button.querySelector(".tm-task-menu-label")?.textContent);
    expect(labels).toEqual(["P1", "P2", "P3", "Status", "Start date", "End date", "Deadline", "Parent project", "Tags", "Color", "Rename", "Add description", "Add to favorites", "Open note", "Delete project"]);
    menuButton("P1").click();
    expect(plugin.updateProject.mock.lastCall![0]).toBe("Site.md");
    expect(lastChange(plugin).priority).toBe("1");
    expect(document.querySelector(".tm-task-menu")).toBeNull();
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("edits a project date in a date-only popover beside the menu", async () => {
    const { view, content, plugin } = await setup([note("Site.md", 1)], { "Site.md": { tags: ["project"] } });
    await view.setState({ mode: "all", pagePath: "Site.md" });
    content().querySelector<HTMLElement>(".tm-title-more")!.click();
    menuButton("Deadline").click();
    const popover = document.querySelector<HTMLElement>(".tm-date-popover")!;
    expect(popover.getAttribute("aria-label")).toBe("Deadline");
    const input = popover.querySelector<HTMLInputElement>("input")!;
    expect(input.placeholder).toBe("Type a date");
    input.value = "2026-10-05";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(lastChange(plugin).deadline).toBe("2026-10-05");
    // Choosing closes the menu too.
    expect(document.querySelector(".tm-task-menu")).toBeNull();
  });

  it("renames, recolours and re-parents a project, leaving out itself and its subprojects", async () => {
    const { view, content, plugin } = await setup([note("Site.md", 1), note("Sub.md", 1), note("Other.md", 1)],
      { "Site.md": { tags: ["project"] }, "Sub.md": { tags: ["project"], parent: "[[Site]]" }, "Other.md": { tags: ["project"] } });
    await view.setState({ mode: "all", pagePath: "Site.md" });
    const open = (label: string) => { content().querySelector<HTMLElement>(".tm-title-more")!.click(); menuButton(label).click(); return document.querySelector<HTMLElement>(".tm-choice-popover")!; };
    const enter = (popover: HTMLElement, text: string) => {
      const input = popover.querySelector<HTMLInputElement>("input")!;
      input.value = text; input.dispatchEvent(new Event("input"));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    };
    enter(open("Rename"), "Website");
    expect(lastChange(plugin).name).toBe("Website");
    enter(open("Color"), "#3B82F6");
    expect(lastChange(plugin).color).toBe("#3b82f6");
    const parent = open("Parent project");
    expect(Array.from(parent.querySelectorAll("[role=option]")).map(option => option.textContent)).toEqual(["Other", "No parent"]);
    parent.querySelector<HTMLElement>("[data-value='Other.md']")!.click();
    expect(lastChange(plugin).parent).toBe("Other.md");
  });

  it("asks before deleting a project, from the menu or a right-click on its row", async () => {
    const { view, content, plugin } = await setup([note("Site.md", 1)], { "Site.md": { tags: ["project"] } });
    const confirm = vi.mocked(openConfirm);
    confirm.mockClear();
    await view.setState({ mode: "projects" });
    const row = content().querySelector<HTMLElement>(".tm-project-row")!;
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }));
    menuButton("Delete project").click();
    expect(confirm).toHaveBeenCalledOnce();
    const options = confirm.mock.calls[0][1];
    expect(options.title).toBe("Delete “Site”?");
    options.run();
    expect(plugin.deleteProject).toHaveBeenCalledWith("Site.md");
  });
});

describe("the calendar in the Things style", () => {
  it("opens a double-clicked task in the task editor, since it has no room for a card", async () => {
    const { view, content, plugin } = await setup([["A.md", `- [ ] Dentist ${todayIso()}`]]);
    plugin.settings.style = "things";
    await view.setState({ mode: "all", layout: "calendar" } as never);
    const task = content().querySelector<HTMLElement>(".tm-calendar-task")!;
    task.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(plugin.openEditor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ task: expect.objectContaining({ title: "Dentist" }) }));
    expect(content().querySelector(".tm-things-card")).toBeNull();
  });
});

describe("a board's default grouping", () => {
  it("follows the view's, as a list does: one column, Overdue and Today, dates, notes", async () => {
    const plus = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return todayIso(date); };
    const { view, content, plugin } = await setup([
      [DEFAULT_SETTINGS.inboxPath, "- [ ] Loose"],
      ["A.md", `- [ ] Late ${plus(-2)}\n- [ ] Now ${plus(0)}\n- [ ] Soon ${plus(3)}`]
    ]);
    plugin.settings.showSubtasks = true;
    const columns = async (mode: string) => {
      await view.setState({ mode, layout: "kanban", showProjects: false } as never);
      return Array.from(content().querySelectorAll(".tm-kanban-column-header h2")).map(title => title.textContent);
    };
    expect(await columns("inbox")).toEqual(["Tasks"]);
    expect(await columns("today")).toEqual(["Overdue", "Today"]);
    expect((await columns("upcoming")).length).toBe(1);
    expect(await columns("all")).toEqual(expect.arrayContaining(["A"]));
  });
});

describe("Today's Overdue group", () => {
  it("shows only with something overdue, in a list and on a board", async () => {
    const plus = (days: number) => { const date = new Date(); date.setDate(date.getDate() + days); return todayIso(date); };
    const { view, content, plugin, edit } = await setup([["A.md", `- [ ] Now ${plus(0)}`]]);
    plugin.settings.showSubtasks = true;
    const groups = () => Array.from(content().querySelectorAll(".tm-section > h2, .tm-kanban-column-header h2")).map(title => title.textContent?.trim());
    // Nothing overdue: the list is today's tasks alone, with no heading over them; a board keeps its column.
    await view.setState({ mode: "today", showProjects: false } as never);
    expect(groups()).toEqual([]);
    expect(rows(content()).map(row => row.querySelector(".tm-task-title")?.textContent)).toEqual(["Now"]);
    await view.setState({ mode: "today", layout: "kanban", showProjects: false } as never);
    expect(groups()).toEqual(["Today"]);
    await edit("A.md", `- [ ] Now ${plus(0)}\n- [ ] Late ${plus(-2)}`);
    await view.setState({ mode: "today", layout: "list", showProjects: false } as never);
    expect(groups()).toEqual(["Overdue", "Today"]);
  });
});

describe("View options › Projects", () => {
  it("lists the projects a view matches among its tasks by default, with their progress, from a switch", async () => {
    const today = todayIso();
    const { view, content, plugin } = await setup(
      [["Loose.md", `- [ ] Call ${today}`], note("Launch.md", 1), note("Site.md", 1), note("Old.md", 1)],
      { "Launch.md": { tags: ["project"], deadline: today }, "Site.md": { tags: ["project"] }, "Old.md": { tags: ["project"], status: "Cancelled" } }
    );
    Object.assign(plugin, { projectDraft: () => ({ tags: "" }) });
    await view.setState({ mode: "all" });
    const projectRows = () => Array.from(content().querySelectorAll<HTMLElement>(".tm-project-row .tm-task-title")).map(title => title.textContent);
    // All Tasks lists every open project, each with its progress instead of a checkbox.
    expect(projectRows().sort()).toEqual(["Launch", "Site"]);
    expect(content().querySelector(".tm-project-row .tm-project-progress")).not.toBeNull();
    expect(content().querySelector(".tm-project-row input[type=checkbox]")).toBeNull();
    // A project with nothing under its name keeps its progress level with the name: said by a class, not by :has().
    for (const row of Array.from(content().querySelectorAll<HTMLElement>(".tm-project-row"))) {
      expect(row.classList.contains("is-single-line")).toBe(!row.querySelector(":scope > .tm-task-content > :is(.tm-task-metadata, .tm-things-secondary)"));
    }
    expect(content().querySelector(".tm-project-row.is-single-line")).not.toBeNull();
    // Today lists the project due today; Upcoming none of these.
    await view.setState({ mode: "today" });
    expect(projectRows()).toEqual(["Launch"]);
    await view.setState({ mode: "upcoming" });
    expect(projectRows()).toEqual([]);
    // The switch turns them off, and the tab keeps that.
    await view.setState({ mode: "all" });
    const toggle = content().querySelector<HTMLElement>("[data-tm-focus-key='option-projects']")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(projectRows()).toEqual([]);
    expect((view.getState() as { showProjects?: boolean }).showProjects).toBe(false);
  });
});

describe("a project page's subprojects", () => {
  it("are a Projects group above the note's tasks, or a Projects column first on a board", async () => {
    const { view, content, plugin } = await setup(
      [["Site.md", "- [ ] Loose\n## Build\n- [ ] Code"], note("Sub.md", 1)],
      { "Site.md": { tags: ["project"] }, "Sub.md": { tags: ["project"], parent: "[[Site]]" } }
    );
    Object.assign(plugin, { projectDraft: () => ({ tags: "" }) });
    await view.setState({ mode: "all", pagePath: "Site.md" });
    const first = content().querySelector<HTMLElement>(".tm-section")!;
    expect(first.querySelector("h2")!.textContent).toContain("Projects");
    expect(Array.from(first.querySelectorAll(".tm-task-title")).map(title => title.textContent)).toEqual(["Sub"]);
    // The note's own tasks follow, and none of them is in the Projects group.
    expect(Array.from(content().querySelectorAll(".tm-task-item .tm-task-title")).map(title => title.textContent)).toEqual(["Loose", "Code"]);
    await view.setState({ mode: "all", pagePath: "Site.md", layout: "kanban" } as never);
    expect(Array.from(content().querySelectorAll(".tm-kanban-column-header h2")).map(title => title.textContent)[0]).toBe("Projects");
  });
});

describe("groups without tasks", () => {
  it("shows every heading of a note, and every status and priority, in a list and on a board alike", async () => {
    const { view, content } = await setup([["Site.md", "- [ ] Loose\n# Build\n- [ ] Code p1\n# Ship"]], { "Site.md": { tags: ["project"] } });
    const titles = (selector: string) => Array.from(content().querySelectorAll(selector)).map(heading => heading.textContent);
    await view.setState({ mode: "all", pagePath: "Site.md", layout: "kanban" } as never);
    expect(titles(".tm-kanban-column-header h2")).toEqual(["No section", "Build", "Ship"]);
    const internal = view as unknown as { grouping: string };
    for (const [grouping, groups] of [["section", ["Build", "Ship"]], ["status", ["To do", "In progress", "Waiting", "Done", "Cancelled"]], ["priority", ["P1", "P2", "P3", "No priority"]]] as const) {
      internal.grouping = grouping;
      await view.setState({ mode: "all", pagePath: "Site.md", layout: "list" } as never);
      expect(titles(".tm-section h2")).toEqual(groups);
      await view.setState({ mode: "all", pagePath: "Site.md", layout: "kanban" } as never);
      expect(titles(".tm-kanban-column-header h2")).toEqual(grouping === "section" ? ["No section", ...groups] : groups);
    }
  });
});

describe("the Projects view's subprojects", () => {
  it("list under their parent, folding away from its chevron", async () => {
    const { view, content } = await setup([note("Site.md", 1), note("Sub.md", 1), note("Leaf.md", 1)], {
      "Site.md": { tags: ["project"] }, "Sub.md": { tags: ["project"], parent: "[[Site]]" }, "Leaf.md": { tags: ["project"], parent: "[[Sub]]" }
    });
    await view.setState({ mode: "projects" });
    const rows = () => Array.from(content().querySelectorAll<HTMLElement>(".tm-project-row")).map(row => [row.querySelector(".tm-task-title")!.textContent, row.style.getPropertyValue("--tm-depth")]);
    expect(rows()).toEqual([["Site", "0"], ["Sub", "1"], ["Leaf", "2"]]);
    content().querySelector<HTMLButtonElement>(".tm-project-row .tm-row-fold")!.click();
    expect(rows()).toEqual([["Site", "0"]]);
  });
});

describe("dragging in the Projects list", () => {
  it("gives a project its group's status, and the parent of the place it is dropped in", async () => {
    const { view, content, plugin } = await setup([note("Site.md", 1), note("Sub.md", 1), note("Home.md", 1)], {
      "Site.md": { tags: ["project"] }, "Sub.md": { tags: ["project"], parent: "[[Site]]" }, "Home.md": { tags: ["project"] }
    });
    await view.setState({ mode: "projects" });
    expect(content().querySelectorAll(".tm-project-row .tm-list-drag-handle")).toHaveLength(3);
    const internal = view as unknown as { dropListTask(task: unknown, group: unknown, anchor?: unknown, placement?: string): Promise<void> };
    const item = (name: string) => ({ id: `project:${name}.md` });
    const todo = { property: "status", value: "To do" };
    // Moved right, under Home: Home is its parent.
    await internal.dropListTask(item("Sub"), todo, item("Home"), "child");
    // Out from under Site, within its group: no parent.
    await internal.dropListTask(item("Sub"), todo, item("Site"), "after");
    // Beside a project with no parent, in its own group: where it was, so nothing changes.
    await internal.dropListTask(item("Home"), todo, item("Site"), "after");
    // To another group: its status, and its parent kept.
    await internal.dropListTask(item("Sub"), { property: "status", value: "Waiting" }, item("Home"), "after");
    // Under its own subproject: refused.
    await internal.dropListTask(item("Site"), todo, item("Sub"), "child");
    const changes = (plugin.updateProject.mock.calls as unknown as Array<[string, (draft: object) => object]>).map(([path, change]) => [path, change({})]);
    expect(changes).toEqual([["Sub.md", { parent: "Home.md" }], ["Sub.md", { parent: "" }], ["Sub.md", { status: "waiting" }]]);
  });
});

it("shows All Tasks in a tab left on the Tags list, which the task sidebar now lists instead", async () => {
  const { view, content } = await setup([["A.md", "- [ ] Call #[[work]]"]]);
  await view.setState({ mode: "tags" });
  expect(view.getState().mode).toBe("all");
  expect(content().querySelector(".tm-page-title, h1")?.textContent).toBe("All Tasks");
  expect(Array.from(content().querySelectorAll(".tm-task-title")).map(title => title.textContent)).toContain("Call");
  // A tag's own list stays.
  await view.setState({ mode: "tags", tag: "work" });
  expect(view.getState()).toMatchObject({ mode: "tags", tag: "work" });
});

describe("View options › Projects in the calendar", () => {
  it("shows dated projects on their day, with their progress, opening them as projects; the switch hides them", async () => {
    const today = todayIso();
    const { view, content, plugin } = await setup(
      [["Loose.md", `- [ ] Call ${today}`], note("Launch.md", 1), note("Site.md", 1)],
      { "Launch.md": { tags: ["project"], deadline: today }, "Site.md": { tags: ["project"] } }
    );
    const openProject = vi.fn(async () => {});
    Object.assign(plugin, { projectDraft: () => ({ tags: "" }), openProject });
    await view.setState({ mode: "all", layout: "calendar" } as never);
    const projects = () => Array.from(content().querySelectorAll<HTMLElement>(".tm-calendar-task.is-project"));
    // Launch shows on its deadline; Site has no date, so no day, and stays out of the unscheduled list too.
    expect(projects().map(card => card.querySelector(".tm-calendar-task-title")?.textContent)).toEqual(["Launch"]);
    const [launch] = projects();
    expect(launch.querySelector(".tm-project-progress")).not.toBeNull();
    expect(launch.querySelector("input[type=checkbox]")).toBeNull();
    // In this tab, as the file explorer opens a file; Cmd/Ctrl opens a new one.
    launch.querySelector<HTMLElement>(".tm-calendar-task-title")!.click();
    expect(openProject).toHaveBeenCalledExactlyOnceWith("Launch.md", { newLeaf: false });
    launch.querySelector<HTMLElement>(".tm-calendar-task-title")!.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(openProject).toHaveBeenLastCalledWith("Launch.md", { newLeaf: true });
    // The calendar has the switch too.
    const toggle = content().querySelector<HTMLElement>("[data-tm-focus-key='option-projects']")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(projects()).toEqual([]);
  });

  it("moves a project dragged to another day: its start, with its end the same distance after, or its deadline", async () => {
    const { view, plugin } = await setup([]);
    const writes: Array<Record<string, unknown>> = [];
    let note: Record<string, unknown> = {};
    Object.assign(plugin.store, { updateFrontmatter: vi.fn(async (_file: unknown, change: (frontmatter: Record<string, unknown>) => void) => {
      const frontmatter = { ...note };
      change(frontmatter);
      writes.push(frontmatter);
    }) });
    Object.assign(view.app.vault, { getAbstractFileByPath: (path: string) => Object.assign(new TFile(), { path }) });
    const move = (view as unknown as { moveProject(project: Project, date: string): Promise<void> }).moveProject.bind(view);
    const base = { path: "Launch.md", name: "Launch", openTasks: 1, completedTasks: 0 };
    note = { tags: ["project"], date: "2026-10-05", endDate: "2026-10-09" };
    await move({ ...base, scheduledDate: "2026-10-05", endDate: "2026-10-09" }, "2026-10-07");
    expect(writes.pop()).toMatchObject({ date: "2026-10-07", endDate: "2026-10-11" });
    note = { tags: ["project"], deadline: "2026-10-05" };
    await move({ ...base, deadline: "2026-10-05" }, "2026-10-02");
    expect(writes.pop()).toMatchObject({ deadline: "2026-10-02" });
    // Dropped on its own day, nothing is written.
    await move({ ...base, scheduledDate: "2026-10-05" }, "2026-10-05");
    expect(writes).toEqual([]);
  });
});

describe("projects on a board in the Things style", () => {
  it("put their dates below the name, which a narrow column would otherwise squeeze away", async () => {
    const today = todayIso();
    const { view, content, plugin } = await setup([note("Launch.md", 1)], { "Launch.md": { tags: ["project"], deadline: today } });
    Object.assign(plugin, { projectDraft: () => ({ tags: "" }) });
    plugin.settings.style = "things";
    await view.setState({ mode: "all", layout: "kanban" } as never);
    const row = content().querySelector<HTMLElement>(".tm-kanban .tm-project-row")!;
    expect(row.querySelector(".tm-task-primary .tm-things-trailing")).toBeNull();
    expect(row.querySelector(".tm-things-secondary .tm-things-trailing .tm-things-deadline")).not.toBeNull();
    await view.setState({ mode: "all", layout: "list" } as never);
    expect(content().querySelector(".tm-project-row .tm-task-primary .tm-things-trailing")).not.toBeNull();
  });
});

describe("smart list actions", () => {
  it("renames, updates with the view's options, and deletes after asking, from the … beside its title", async () => {
    const { view, content, plugin } = await setup([note("A.md", 2)]);
    const list = { id: "calls", name: "Calls", filters: [], sort: "date", descending: false, grouping: "default" };
    const saveSmartList = vi.fn().mockResolvedValue(list);
    Object.assign(plugin, { saveSmartList });
    Object.assign(plugin.settings, { smartLists: [list] });
    const confirm = vi.spyOn(view as unknown as { confirmDeleteSmartList(list: unknown): void }, "confirmDeleteSmartList").mockImplementation(() => {});
    await view.setState({ mode: "smartLists", smartListId: "calls" });
    const more = () => content().querySelector<HTMLElement>("[data-tm-focus-key='smart-list-actions']")!;
    const menuButton = (label: string) => Array.from(document.querySelectorAll<HTMLElement>(".tm-task-menu button"))
      .find(button => button.querySelector(".tm-task-menu-label")?.textContent === label)!;
    expect(more().getAttribute("aria-label")).toBe("Smart list actions");
    // Nothing changed yet: updating saves nothing.
    more().click();
    menuButton("Update view options").click();
    expect(saveSmartList).not.toHaveBeenCalled();
    // The view's sorting and grouping change, then go into the list.
    Object.assign(view, { sort: "priority", descending: true, grouping: "priority" });
    more().click();
    menuButton("Update view options").click();
    expect(saveSmartList).toHaveBeenLastCalledWith({ name: "Calls", filters: [], sort: "priority", descending: true, grouping: "priority" }, "calls");
    // Turning projects off goes in too (they show by default).
    Object.assign(view, { showProjects: false });
    more().click();
    menuButton("Update view options").click();
    expect(saveSmartList).toHaveBeenLastCalledWith(expect.objectContaining({ sort: "priority", showProjects: false }), "calls");
    more().click();
    menuButton("Rename").click();
    const input = document.querySelector<HTMLInputElement>(".tm-choice-popover input")!;
    input.value = "Phone calls"; input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(saveSmartList).toHaveBeenLastCalledWith(expect.objectContaining({ name: "Phone calls", sort: "date" }), "calls");
    more().click();
    menuButton("Delete smart list").click();
    expect(confirm).toHaveBeenCalledWith(list);
  });
});

describe("Things card subtasks", () => {
  it("leaves subtasks to their own rows when Show subtasks is on", async () => {
    const { view, content, index, plugin } = await setup([["A.md", "- [ ] Parent\n  - [ ] Child"]]);
    plugin.settings.style = "things";
    await view.setState({ mode: "all" });
    const parent = index.allTasks()[0];
    const open = (showSubtasks: boolean) => {
      plugin.settings.showSubtasks = showSubtasks;
      (view as unknown as { expanded?: object }).expanded = { id: parent.id, title: "Parent", notes: "" };
      (view as unknown as { renderTaskResults(): void }).renderTaskResults();
      return { checks: content().querySelectorAll(".tm-things-card .tm-things-card-check:not(.is-new)").length, childRow: rows(content()).some(row => row.textContent!.includes("Child")) };
    };
    expect(open(false)).toEqual({ checks: 1, childRow: false });
    expect(open(true)).toEqual({ checks: 0, childRow: true });
  });

  it("stays open after Enter adds a subtask, with the next one focused below it, even when the browser blurs the field as it is redrawn", async () => {
    // As Chromium does: removing the focused field (or what holds it) fires blur while it is still in the page.
    const blurFirst = (node: Node) => {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && node.contains(active) && node.isConnected) {
        active.dispatchEvent(new FocusEvent("blur"));
        active.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      }
    };
    const { removeChild } = Node.prototype, { remove } = Element.prototype;
    Node.prototype.removeChild = function <T extends Node>(this: Node, child: T): T { blurFirst(child); return removeChild.call(this, child) as T; };
    Element.prototype.remove = function (this: Element) { blurFirst(this); remove.call(this); };
    try {
      const { view, internals, plugin, store, content, edit, read } = await setup([["A.md", "- [ ] Parent"]]);
      plugin.settings.style = "things";
      // As the store does: the subtask goes below the one it follows (or last), and its line comes back.
      Object.assign(store, { update: vi.fn().mockResolvedValue(undefined), addSubtask: vi.fn(async (_parent: unknown, subtask: { title: string }, after?: { line: number }) => {
        const lines = read("A.md").split("\n");
        const line = after ? after.line + 1 : lines.length;
        lines.splice(line, 0, `    - [ ] ${subtask.title}`);
        await edit("A.md", lines.join("\n"));
        return line;
      }) });
      await view.setState({ mode: "all" });
      rows(content())[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(content().querySelector(".tm-things-card")).not.toBeNull());
      content().querySelector<HTMLElement>("[data-tm-focus-key='card-add-checklist']")!.click();
      const type = async (title: string) => {
        const input = content().querySelector<HTMLInputElement>(".is-new .tm-things-card-check-title")!;
        expect(document.activeElement).toBe(input);
        input.value = title;
        input.dispatchEvent(new Event("input"));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
        await new Promise(resolve => setTimeout(resolve, 20));
      };
      await type("First");
      // Something else redraws the list (Obsidian telling of the note's change again, say) with the next line focused.
      internals.refresh();
      await type("Second");
      expect(read("A.md")).toBe("- [ ] Parent\n    - [ ] First\n    - [ ] Second");
      const card = content().querySelector(".tm-things-card")!;
      expect(card).not.toBeNull();
      expect(Array.from(card.querySelectorAll<HTMLInputElement>(".tm-things-card-check-title")).map(input => input.value)).toEqual(["First", "Second", ""]);
      expect(document.activeElement).toBe(card.querySelector(".is-new .tm-things-card-check-title"));
    } finally {
      Node.prototype.removeChild = removeChild;
      Element.prototype.remove = remove;
    }
  });
});

describe("Create new task in the Things style", () => {
  async function inserted() {
    const inbox = DEFAULT_SETTINGS.inboxPath;
    const ctx = await setup([[inbox, "- [ ] Existing"]]);
    const { view, plugin, store, edit, read } = ctx;
    plugin.settings.style = "things";
    const extra = store as unknown as Record<string, ReturnType<typeof vi.fn>>;
    // Written at the top of the note, as with New task position › Top.
    extra.create = vi.fn(async (draft: { title: string; priority?: number }) => {
      await edit(inbox, `- [ ] ${draft.title}${draft.priority ? ` p${draft.priority}` : ""}\n${read(inbox)}`);
      return 0;
    });
    (plugin as unknown as { newTaskDraft: () => object }).newTaskDraft = () => ({ title: "", completed: false, indent: 0, destination: inbox });
    await view.setState({ mode: "inbox" });
    view.newTask();
    await vi.waitFor(() => expect(ctx.content().querySelector(".tm-things-card")).not.toBeNull());
    const card = () => ctx.content().querySelector<HTMLElement>(".tm-things-card");
    const title = () => card()!.querySelector<HTMLTextAreaElement>(".tm-things-card-title")!;
    const type = (text: string) => { title().value = text; title().dispatchEvent(new Event("input")); };
    const key = (target: HTMLElement, name: string) => target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    const listed = () => Array.from(ctx.content().querySelectorAll(".tm-task-list > *")).map(item => item.matches(".tm-things-card") ? "card" : item.querySelector(".tm-task-title")?.textContent);
    return { ...ctx, extra, card, title, type, key, listed };
  }

  it("opens a blank card where the task would go, writing nothing until its title is entered", async () => {
    const { extra, card, title, plugin, listed } = await inserted();
    expect(extra.create).not.toHaveBeenCalled();
    expect(listed()).toEqual(["card", "Existing"]);
    expect(title().value).toBe("");
    expect(title().placeholder).toBe("New to-do");
    // Nothing to complete, nor subtasks to add, until it is written.
    expect(card()!.querySelector<HTMLInputElement>(".tm-task-checkbox")!.disabled).toBe(true);
    expect(card()!.querySelector("[data-tm-focus-key='card-add-checklist']")).toBeNull();
    expect(plugin.openEditor).not.toHaveBeenCalled();
  });

  it("writes the task on Enter once titled, with what its title sets, and closes the card", async () => {
    const { extra, title, type, key, card, listed } = await inserted();
    key(title(), "Enter");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(extra.create).not.toHaveBeenCalled();
    expect(card()).not.toBeNull();
    type("Buy milk p1");
    key(title(), "Enter");
    await vi.waitFor(() => expect(card()).toBeNull());
    expect(extra.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Buy milk", priority: 1, destination: DEFAULT_SETTINGS.inboxPath }));
    await vi.waitFor(() => expect(listed()).toEqual(["Buy milk", "Existing"]));
  });

  it("drops the card closed untitled (Escape), writing nothing; closed titled, it writes the task", async () => {
    const { extra, view, type, key, card, listed } = await inserted();
    key(card()!, "Escape");
    await vi.waitFor(() => expect(card()).toBeNull());
    expect(extra.create).not.toHaveBeenCalled();
    expect(listed()).toEqual(["Existing"]);
    view.newTask();
    await vi.waitFor(() => expect(card()).not.toBeNull());
    type("Buy milk");
    await (view as unknown as { collapseCard(): Promise<void> }).collapseCard();
    expect(extra.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Buy milk" }));
  });

  it("drops a titled new task on Escape too", async () => {
    const { extra, type, key, card, title } = await inserted();
    type("Buy milk");
    key(title(), "Escape");
    await vi.waitFor(() => expect(card()).toBeNull());
    expect(extra.create).not.toHaveBeenCalled();
  });

  it("confirms an open task's card on Enter, saving what was typed, and cancels it on Escape, saving nothing", async () => {
    const { view, plugin, store, content } = await setup([note("A.md", 1)]);
    plugin.settings.style = "things";
    const update = vi.fn().mockResolvedValue(undefined);
    (store as unknown as { update: typeof update }).update = update;
    await view.setState({ mode: "all" });
    const title = () => content().querySelector<HTMLTextAreaElement>(".tm-things-card-title")!;
    const open = async () => {
      rows(content())[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(content().querySelector(".tm-things-card")).not.toBeNull());
    };
    await open();
    title().value = "Renamed";
    title().dispatchEvent(new Event("input"));
    title().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(content().querySelector(".tm-things-card")).toBeNull());
    expect(update).not.toHaveBeenCalled();
    await open();
    expect(title().value).toBe("A.md task 0");
    title().value = "Renamed";
    title().dispatchEvent(new Event("input"));
    title().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(content().querySelector(".tm-things-card")).toBeNull());
    expect(update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "A.md task 0" }), expect.objectContaining({ title: "Renamed" }));
  });

  it("keeps what is set in the card (its priority, from the toolbar) to write with the task", async () => {
    const { extra, card, title, type, key } = await inserted();
    type("Buy milk");
    card()!.querySelector<HTMLElement>("[data-tm-focus-key='card-add-priority']")!.click();
    await vi.waitFor(() => expect(document.querySelector(".tm-choice-popover [data-value='2']")).not.toBeNull());
    document.querySelector<HTMLElement>(".tm-choice-popover [data-value='2']")!.click();
    await vi.waitFor(() => expect(card()!.querySelector("[data-tm-focus-key='card-priority']")).not.toBeNull());
    expect(extra.create).not.toHaveBeenCalled();
    // The typing survives the redraw.
    expect(title().value).toBe("Buy milk");
    key(title(), "Enter");
    await vi.waitFor(() => expect(extra.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Buy milk", priority: 2 })));
  });

  it("starts a group's card with the group's value, as its heading's + button adds it", async () => {
    const { extra, view, plugin, content, type, key, title } = await inserted();
    const drafts: unknown[] = [];
    (plugin as unknown as { newTaskDraft: (state: { preset?: object }) => object }).newTaskDraft = state => {
      drafts.push(state.preset);
      return { title: "", completed: false, indent: 0, destination: DEFAULT_SETTINGS.inboxPath, ...state.preset };
    };
    await (view as unknown as { collapseCard(): Promise<void> }).collapseCard();
    view.newTask({ priority: 2 });
    await vi.waitFor(() => expect(content().querySelector(".tm-things-card [data-tm-focus-key='card-priority']")).not.toBeNull());
    expect(drafts).toEqual([{ priority: 2 }]);
    expect(extra.create).not.toHaveBeenCalled();
    type("Call Sam");
    key(title(), "Enter");
    await vi.waitFor(() => expect(extra.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: "Call Sam", priority: 2 })));
    expect(plugin.openEditor).not.toHaveBeenCalled();
  });

  it("opens the new card in its column on a board, too", async () => {
    const { extra, view, plugin, content } = await inserted();
    await (view as unknown as { collapseCard(): Promise<void> }).collapseCard();
    await view.setState({ mode: "inbox", layout: "kanban" } as never);
    view.newTask();
    await vi.waitFor(() => expect(content().querySelector(".tm-kanban .tm-things-card")).not.toBeNull());
    expect(extra.create).not.toHaveBeenCalled();
    expect(plugin.openEditor).not.toHaveBeenCalled();
  });

  it("opens the task editor in other styles", async () => {
    const { view, plugin } = await setup([note("A.md", 1)]);
    plugin.settings.style = "griply";
    await view.setState({ mode: "today" });
    view.newTask();
    expect(plugin.openEditor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ mode: "today" }));
  });
});

describe("Gantt navigation", () => {
  it("moves the arrows' period on from the dates in view, after scrolling the timeline either way", async () => {
    const { view, content } = await setup([note("Site.md", 1)], { "Site.md": { tags: ["project"], start: "2026-03-02", end: "2026-03-20" } });
    await view.setState({ mode: "projects", projectLayout: "gantt", ganttAnchor: "2026-03-01", ganttZoom: "month" });
    const scroll = () => content().querySelector<HTMLElement>(".tm-gantt-scroll")!;
    // The first day in view: the timeline's first date plus the days scrolled past.
    const shown = () => addDays(content().querySelector<HTMLElement>(".tm-gantt-date")!.title, Math.floor(scroll().scrollLeft / 32));
    expect(shown()).toBe("2026-03-01");
    for (const [days, next] of [[-36, "2026-02-24"], [-40, "2026-02-15"], [20, "2026-04-07"]] as const) {
      // Scrolled by hand, then on by a month: from the dates in view, wherever the timeline was scrolled.
      scroll().scrollLeft += days * 32;
      scroll().dispatchEvent(new Event("scroll"));
      content().querySelector<HTMLElement>("[aria-label='Next period']")!.click();
      expect(shown()).toBe(next);
    }
  });

  it("opens at the start of the year, in the Year view at first, and there again when opened anew", async () => {
    const { view, content } = await setup([note("Site.md", 1)], { "Site.md": { tags: ["project"], start: "2026-03-02", end: "2026-03-20" } });
    const yearStart = `${todayIso().slice(0, 4)}-01-01`;
    const shown = () => addDays(content().querySelector<HTMLElement>(".tm-gantt-date")!.title, Math.floor(content().querySelector<HTMLElement>(".tm-gantt-scroll")!.scrollLeft / 3));
    await view.setState({ mode: "projects", projectLayout: "gantt" });
    expect(shown()).toBe(yearStart);
    expect(content().querySelector("[aria-label='Year'][aria-pressed='true']")).not.toBeNull();
    content().querySelector<HTMLElement>("[aria-label='Next period']")!.click();
    expect(shown()).toBe(`${Number(yearStart.slice(0, 4)) + 1}-01-01`);
    // Another page and back: the start of the year again, in the scale it was left in.
    await view.setState({ mode: "today" });
    await view.setState({ mode: "projects", projectLayout: "gantt" });
    expect(shown()).toBe(yearStart);
    expect(view.getState().ganttAnchor).toBeUndefined();
  });
});

describe("Back and Forward", () => {
  it("records the page left when the view moves to another project, tag or list, not when it refreshes the same one", async () => {
    const { view } = await setup([note("A.md", 1)]);
    const result = () => ({ history: false });
    // Opening with its first page: the tab records the view it replaced itself.
    const first = result();
    await view.setState({ mode: "all", pagePath: "A.md" }, first);
    expect(first.history).toBe(false);
    const same = result();
    await view.setState({ mode: "all", pagePath: "A.md", layout: "kanban" }, same);
    expect(same.history).toBe(false);
    for (const next of [{ mode: "all", pagePath: "B.md" }, { mode: "today" }, { mode: "tags", tag: "home" }, { mode: "smartLists", smartListId: "calls" }]) {
      const moved = result();
      await view.setState(next, moved);
      expect(moved.history).toBe(true);
    }
  });
});

describe("tab title", () => {
  it("names the tab after its list once its state arrives, refreshing the view header, tab and window titles", async () => {
    const { view } = await setup([note("Project.md", 1)]);
    const updateHeader = vi.fn(), updateTitle = vi.fn();
    const internals = view as unknown as { leaf: object; app: { workspace: object }; titleEl: HTMLElement };
    internals.leaf = { updateHeader };
    internals.titleEl = document.createElement("div");
    internals.titleEl.setText("Tasks");
    Object.assign(internals.app.workspace, { updateTitle });
    // Obsidian reads the title while opening the view, before its state: not "Today".
    expect(view.getDisplayText()).toBe("Tasks");
    await view.setState({ mode: "all", pagePath: "Project.md" });
    expect(view.getDisplayText()).toBe("Project");
    // The view header's title (set once as the view loaded), the tab and the window follow.
    expect(internals.titleEl.textContent).toBe("Project");
    expect(updateHeader).toHaveBeenCalled();
    expect(updateTitle).toHaveBeenCalled();
    // Every list names its tab as its page does.
    for (const [state, title] of [[{ mode: "projects" }, "Projects"], [{ mode: "tags" }, "All Tasks"], [{ mode: "tags", tag: "home" }, "home"], [{ mode: "all" }, "All Tasks"],
      [{ mode: "inbox" }, "Inbox"], [{ mode: "today" }, "Today"], [{ mode: "upcoming" }, "Upcoming"]] as const) {
      await view.setState(state);
      expect(internals.titleEl.textContent).toBe(title);
    }
  });
});

describe("opening a card on the desktop", () => {
  it("scrolls the opened card just far enough to show it", async () => {
    const { view, content, plugin } = await setup([note("A.md", 3)]);
    plugin.settings.style = "things";
    await view.setState({ mode: "all" });
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      rows(content())[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
      await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" }));
      expect(scrollIntoView.mock.contexts[0]).toBe(content().querySelector(".tm-things-card"));
    } finally { HTMLElement.prototype.scrollIntoView = original; }
  });
});

describe("on phones", () => {
  it("opens tasks in the Task Details sidebar (three panes) whatever Task details says, new ones too, never as a card", async () => {
    const platform = Platform as { isMobile?: boolean; isPhone?: boolean };
    platform.isMobile = platform.isPhone = true;
    try {
      const { view, content, plugin } = await setup([note("A.md", 2)]);
      plugin.settings.style = "things";
      plugin.settings.taskDetails = "view";
      await view.setState({ mode: "all" });
      rows(content())[1].click();
      expect(plugin.showInTaskSidebar).toHaveBeenCalledExactlyOnceWith(rows(content())[1].getAttribute("data-task-id"), { focus: false });
      expect(view.getSelectedTasks().map(task => task.line)).toEqual([1]);
      (plugin as unknown as { newTaskDraft: () => object }).newTaskDraft = () => ({ title: "", completed: false, indent: 0, destination: "A.md" });
      view.newTask();
      await vi.waitFor(() => expect(plugin.showInTaskSidebar).toHaveBeenLastCalledWith("tm-new-task", { focus: true }));
      expect(content().querySelector(".tm-things-card")).toBeNull();
      expect(plugin.openEditor).not.toHaveBeenCalled();
    } finally {
      platform.isMobile = platform.isPhone = false;
    }
  });
});

describe("on tablets", () => {
  it("opens a tapped task as Task details says, as on desktop", async () => {
    const platform = Platform as { isMobile?: boolean; isPhone?: boolean };
    platform.isMobile = true;
    try {
      const { view, content, plugin } = await setup([note("A.md", 2)]);
      plugin.settings.style = "things";
      plugin.settings.taskDetails = "view";
      await view.setState({ mode: "all" });
      rows(content())[1].click();
      await vi.waitFor(() => expect(content().querySelector(".tm-things-card")).not.toBeNull());
      expect(plugin.showInTaskSidebar).not.toHaveBeenCalled();
    } finally {
      platform.isMobile = false;
    }
  });
});



describe("recurring tasks in the Things style", () => {
  it("shows the repeat icon as the checkbox, toggling the task, with no repeat mark in the line", async () => {
    const { view, content, plugin, store, index } = await setup([["A.md", "- [ ] Water every week p2\n- [ ] Call"]]);
    plugin.settings.style = "things";
    await view.setState({ mode: "all" });
    const [water, call] = rows(content());
    const target = water.querySelector<HTMLElement>(".tm-checkbox-target")!;
    expect(target.classList.contains("tm-repeat-target")).toBe(true);
    expect(target.classList.contains("is-p2")).toBe(true);
    expect(target.querySelector(".tm-repeat-icon")).not.toBeNull();
    expect(water.querySelector(".tm-things-repeat, .tm-task-recurring")).toBeNull();
    const checkbox = target.querySelector<HTMLInputElement>("input.tm-task-checkbox")!;
    checkbox.click();
    expect(store.toggle).toHaveBeenCalledWith(index.allTasks().find(task => task.title === "Water"), true);
    // Other tasks keep the checkbox; so does a recurring task in the Griply style.
    expect(call.querySelector(".tm-repeat-target")).toBeNull();
    plugin.settings.style = "griply";
    await view.setState({ mode: "all" });
    expect(rows(content())[0].querySelector(".tm-repeat-target")).toBeNull();
  });
});

describe("row marks", () => {
  it("marks subtasks, notes or both after the title (subtasks only while not listed as rows), never on a board", async () => {
    const { view, content, plugin } = await setup([["A.md", "- [ ] Plan\n  - [ ] Step\n  - Notes\n- [ ] Pack\n  - [ ] Bag\n- [ ] Read\n  - Chapter 3"]]);
    plugin.settings.style = "things";
    const marks = async (showSubtasks: boolean, layout: string) => {
      plugin.settings.showSubtasks = showSubtasks;
      await view.setState({ mode: "all", layout } as never);
      return ["Plan", "Pack", "Read"].map(title => rows(content()).find(item => item.querySelector(".tm-task-title")?.textContent === title)
        ?.querySelector(".tm-things-checklist")?.getAttribute("aria-label") ?? null);
    };
    expect(await marks(false, "list")).toEqual(["Has subtasks and notes", "Has subtasks", "Has notes"]);
    expect(await marks(true, "list")).toEqual(["Has notes", null, "Has notes"]);
    expect(await marks(false, "kanban")).toEqual([null, null, null]);
  });
});

describe("copy, paste, delete and duplicate on selected tasks", () => {
  async function selected() {
    const ctx = await setup([["A.md", "- [ ] One\n- [ ] Two\n- [ ] Three"]]);
    const extra = ctx.store as unknown as Record<string, ReturnType<typeof vi.fn>>;
    extra.copyTasks = vi.fn().mockResolvedValue("- [ ] Two");
    extra.pasteTasks = vi.fn().mockResolvedValue({ path: "A.md", from: 2, to: 3 });
    extra.bulkDelete = vi.fn().mockResolvedValue([]);
    extra.duplicate = vi.fn().mockResolvedValue([]);
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined), readText: vi.fn().mockResolvedValue("- [ ] Two") };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    (ctx.plugin as unknown as { newTaskDraft: () => object }).newTaskDraft = () => ({ destination: "Inbox.md" });
    await ctx.view.onOpen();
    await ctx.view.setState({ mode: "all" });
    rows(ctx.content())[1].click();
    return { ...ctx, extra, clipboard, row: rows(ctx.content())[1], two: ctx.index.allTasks()[1] };
  }

  it("copies the selection to the clipboard on Cmd+C", async () => {
    const { row, extra, clipboard, two } = await selected();
    key(row, "c", { metaKey: true });
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("- [ ] Two"));
    expect(extra.copyTasks).toHaveBeenCalledWith([two]);
  });

  it("pastes after the last selected task on Cmd+V, or where a new task goes with none selected", async () => {
    const { view, row, extra, two } = await selected();
    key(row, "v", { metaKey: true });
    await vi.waitFor(() => expect(extra.pasteTasks).toHaveBeenCalledWith("- [ ] Two", { after: two }));
    view.clearSelection();
    key(row, "v", { metaKey: true });
    await vi.waitFor(() => expect(extra.pasteTasks).toHaveBeenLastCalledWith("- [ ] Two", { destination: "Inbox.md" }));
  });

  it("deletes the selection on Delete or Backspace, and duplicates it on Cmd+D", async () => {
    const { view, row, extra, two } = await selected();
    key(row, "d", { metaKey: true });
    expect(extra.duplicate).toHaveBeenCalledWith([two]);
    key(row, "Backspace");
    await vi.waitFor(() => expect(extra.bulkDelete).toHaveBeenCalledWith([two]));
    expect(view.getSelectedTasks()).toEqual([]);
    extra.bulkDelete.mockClear();
    key(row, "Delete");
    expect(extra.bulkDelete).not.toHaveBeenCalled();
  });

  it("leaves Delete and Backspace to a button that has focus", async () => {
    const { content, extra } = await selected();
    const button = content().querySelector<HTMLElement>("button")!;
    key(button, "Backspace");
    key(button, "Delete");
    expect(extra.bulkDelete).not.toHaveBeenCalled();
  });

  it("leaves the keys to a field being typed in", async () => {
    const { content, extra } = await selected();
    const field = content().appendChild(document.createElement("textarea"));
    key(field, "Backspace");
    key(field, "c", { metaKey: true });
    expect(extra.bulkDelete).not.toHaveBeenCalled();
    expect(extra.copyTasks).not.toHaveBeenCalled();
  });
});
