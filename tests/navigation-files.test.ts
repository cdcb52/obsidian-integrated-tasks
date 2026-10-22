// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { installObsidianDom } from "./helpers/obsidian-dom";
import { firePointer, gap, gapPlace, grab, layOutSidebar } from "./helpers/nav-drag";

const menus: Array<{ titles: string[]; checked: string[]; click(title: string): void }> = [];
vi.mock("obsidian", async importOriginal => {
  class Menu {
    items: Array<{ title: string; click?: () => void }> = [];
    constructor() { menus.push({ titles: [], checked: [], click: title => this.items.find(item => item.title === title)?.click?.() }); }
    addItem(build: (item: Record<string, (value: unknown) => unknown>) => void): this {
      const entry: { title: string; click?: () => void } = { title: "" };
      const item: Record<string, (value: unknown) => unknown> = {};
      for (const name of ["setSection", "setIcon", "setWarning"]) item[name] = () => item;
      item.setTitle = title => { entry.title = String(title); menus[menus.length - 1].titles.push(entry.title); return item; };
      item.onClick = click => { entry.click = click as () => void; return item; };
      item.setChecked = checked => { if (checked) menus[menus.length - 1].checked.push(entry.title); return item; };
      build(item);
      this.items.push(entry);
      return this;
    }
    showAtMouseEvent(): void {}
    showAtPosition(): void {}
  }
  return { ...await importOriginal<typeof import("./obsidian-mock")>(), Menu, Keymap: { isModEvent: (event: MouseEvent) => event.metaKey }, Notice: class {}, setIcon: vi.fn() };
});

import { EditorView } from "@codemirror/view";
import { TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { sortFiles, TaskNavigationView } from "../src/navigation-view";
import { dropTargetOf } from "../src/sidebar-drop";
import { DEFAULT_SETTINGS } from "../src/types";
import type TaskManagerPlugin from "../src/main";

beforeAll(() => installObsidianDom());
beforeEach(() => layOutSidebar());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.empty(); });

function setup() {
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
  file("Work/diagram.png", work);
  const note = file("Notes 10.md", root);
  file("Notes 2.md", root);
  const openFile = vi.fn(async () => {});
  const getLeaf = vi.fn(() => ({ openFile }));
  const renameFile = vi.fn(async () => {});
  const create = vi.fn(async (path: string) => file(path, root));
  const app = {
    vault: { getRoot: () => root, getAbstractFileByPath: (path: string) => byPath.get(path) ?? null, on: () => ({}), create, createFolder: vi.fn() },
    workspace: {
      getActiveFile: vi.fn(() => note as TFile | null), getLeaf, on: vi.fn((name: string, callback: (...args: unknown[]) => void) => { workspaceEvents.set(name, callback); return {}; }),
      trigger: vi.fn(), requestSaveLayout: vi.fn(), getActiveViewOfType: () => null, getLeavesOfType: () => [] as unknown[], rootSplit: {}
    },
    fileManager: { renameFile, promptForDeletion: vi.fn(), generateMarkdownLink: (file: TFile) => `[[${file.basename}]]` },
    // Records what the tree hands Obsidian's drag manager: what each row drags, and what each drops.
    dragManager: {
      drags: new Map<HTMLElement, (event: DragEvent) => unknown>(),
      drops: new Map<HTMLElement, (event: DragEvent, draggable: unknown, hovering: boolean) => unknown>(),
      // As Obsidian does, the element becomes draggable.
      handleDrag(element: HTMLElement, start: (event: DragEvent) => unknown) { element.draggable = true; this.drags.set(element, start); },
      handleDrop(element: HTMLElement, drop: (event: DragEvent, draggable: unknown, hovering: boolean) => unknown) { this.drops.set(element, drop); },
      dragFile: (_event: DragEvent, file: TFile) => ({ type: "file", file }),
      dragFolder: (_event: DragEvent, folder: TFolder) => ({ type: "folder", file: folder })
    }
  };
  const settings = { ...DEFAULT_SETTINGS, showFiles: false };
  const saveSettings = vi.fn(async () => {});
  let emit = (): void => {};
  const query = vi.fn(() => []);
  const plugin = {
    settings, saveSettings, index: { projects: () => [], tagSummaries: () => [], query, subscribe: (listener: () => void) => { emit = listener; return () => {}; } },
    isFavorite: (key: string) => settings.favorites.includes(key), toggleFavorite: vi.fn(async (key: string) => { settings.favorites = [...settings.favorites, key]; })
  } as unknown as TaskManagerPlugin;
  const view = new TaskNavigationView({ app } as unknown as WorkspaceLeaf, plugin);
  const container = view.containerEl.children[1] as HTMLElement;
  const labels = () => Array.from(container.querySelectorAll(".tm-nav-files .tm-nav-children .tm-nav-label, .tm-nav-files input")).map(label => label.textContent || (label as HTMLInputElement).value);
  const row = (key: string) => container.querySelector(`[data-tm-nav-key="${key}"]`)!.closest(".tm-nav-item") as HTMLElement;
  /** Moves `file` into `folder` as Obsidian would, for a rename that is let through. */
  const move = (file: TFile | TFolder, folder: TFolder) => {
    const from = file.parent!;
    from.children.splice(from.children.indexOf(file), 1);
    folder.children.push(file);
    byPath.delete(file.path);
    Object.assign(file, { parent: folder, path: folder.path === "/" ? file.name : `${folder.path}/${file.name}` });
    byPath.set(file.path, file);
  };
  return { view, settings, container, labels, row, app, getLeaf, openFile, renameFile, create, root, work, plugin, saveSettings, move, query, emit: () => emit(), workspaceEvents };
}
const workspaceEvents = new Map<string, (...args: unknown[]) => void>();

it("indents smart lists a step under All Tasks, as subprojects are under their parent", () => {
  const { view, settings, row } = setup();
  settings.smartLists = [{ id: "work", name: "Work", filters: [], sort: "date", descending: false, grouping: "default" }];
  view.setActive("smartLists", undefined, undefined, "work");
  view.refresh();
  expect(row("mode:all").style.getPropertyValue("--tm-nav-depth")).toBe("");
  expect(row("list:work").style.getPropertyValue("--tm-nav-depth")).toBe("1");
});

it("lists the vault's files below everything else only when the setting is on", () => {
  const { view, settings, container, labels } = setup();
  view.refresh();
  expect(container.querySelector(".tm-nav-files")).toBeNull();
  settings.showFiles = true;
  view.refresh();
  const sections = Array.from(container.querySelectorAll(".tm-nav-section"));
  expect(sections[sections.length - 1].classList.contains("tm-nav-files")).toBe(true);
  // A folded section says so, for the spacing after it.
  for (const section of sections) expect(section.classList.contains("is-folded")).toBe(!Array.from(section.children).some(child => child.classList.contains("tm-nav-children")));
  expect(sections.some(section => section.classList.contains("is-folded"))).toBe(true);
  // Folders first, then files by name, numbers in number order; notes without “.md”.
  expect(labels()).toEqual(["Work", "Notes 2", "Notes 10"]);
});

it("opens folders in place, remembers them, and opens files (in a new tab with the modifier)", async () => {
  const { view, settings, labels, row, getLeaf, openFile, app, work } = setup();
  settings.showFiles = true;
  view.refresh();
  expect(row("file:Notes 10.md").classList.contains("is-active")).toBe(true);
  (row("folder:Work").querySelector(".tm-nav-label") as HTMLElement).click();
  expect(labels()).toEqual(["Work", "diagram", "Plan", "Notes 2", "Notes 10"]);
  expect(row("file:Work/diagram.png").querySelector(".tm-nav-file-tag")?.textContent).toBe("png");
  expect(row("file:Work/Plan.md").style.getPropertyValue("--tm-nav-depth")).toBe("1");
  expect(view.getState()).toMatchObject({ openFolders: ["Work"] });
  (row("file:Work/Plan.md").querySelector(".tm-nav-label") as HTMLElement).dispatchEvent(new MouseEvent("click", { metaKey: true }));
  await Promise.resolve();
  expect(getLeaf).toHaveBeenLastCalledWith(true);
  expect(openFile).toHaveBeenCalledOnce();
  // Without it, a file opens in the tab in front, even one listing tasks (Obsidian would open a new tab beside it).
  const front = { getViewState: () => ({ type: "task-manager-main" }), openFile: vi.fn(async () => {}) };
  Object.assign(app.workspace, { getMostRecentLeaf: () => front, rootSplit: {} });
  (row("file:Work/Plan.md").querySelector(".tm-nav-label") as HTMLElement).click();
  await Promise.resolve();
  // Its tab becomes the active one, with focus in it, so the sidebar hands over to it.
  expect(front.openFile).toHaveBeenCalledExactlyOnceWith(work.children[0], { active: true });
  expect(getLeaf).toHaveBeenCalledOnce();
  // The open folders come back with the sidebar.
  const next = setup();
  next.settings.showFiles = true;
  await next.view.setState({ openFolders: ["Work"] }, { history: false });
  expect(next.labels()).toContain("Plan");
});

it("renames in place from the menu, and makes new notes in a folder", async () => {
  const { view, settings, container, row, renameFile, create } = setup();
  settings.showFiles = true;
  view.refresh();
  row("file:Notes 2.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  const menu = menus[menus.length - 1];
  expect(menu.titles).toEqual(["Open in new tab", "Open to the right", "Add to favorites", "Rename…", "Delete"]);
  menu.click("Rename…");
  const input = container.querySelector("input.tm-nav-rename") as HTMLInputElement;
  expect(input.value).toBe("Notes 2");
  input.value = "Ideas";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(renameFile).toHaveBeenCalledWith(expect.objectContaining({ path: "Notes 2.md" }), "Ideas.md");
  expect(container.querySelector("input.tm-nav-rename")).toBeNull();
  // A taken name is refused.
  row("file:Notes 10.md").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  menus[menus.length - 1].click("Rename…");
  const again = container.querySelector("input.tm-nav-rename") as HTMLInputElement;
  again.value = "Notes 2";
  again.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(renameFile).toHaveBeenCalledOnce();
  row("folder:Work").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  expect(menus[menus.length - 1].titles.slice(0, 2)).toEqual(["New note", "New folder"]);
  menus[menus.length - 1].click("New note");
  await vi.waitFor(() => expect(create).toHaveBeenCalledWith("Work/Untitled.md", ""));
});

it("adds folder and sort buttons to the toolbar with the files, and sorts files as the file explorer does", () => {
  const { view, settings, container, root } = setup();
  const actions = () => Array.from(container.querySelectorAll(".nav-action-button")).map(button => button.getAttribute("aria-label"));
  view.refresh();
  expect(actions()).toEqual(["New task", "New note", "Task mode"]);
  settings.showFiles = true;
  view.refresh();
  expect(actions()).toEqual(["New task", "New note", "Task mode", "New folder", "Change sort order"]);
  const [work, notes10, notes2] = [root.children[0], root.children[1], root.children[2]] as [TFolder, TFile, TFile];
  Object.assign(notes10, { stat: { mtime: 1, ctime: 3 } });
  Object.assign(notes2, { stat: { mtime: 2, ctime: 1 } });
  const names = (order: Parameters<typeof sortFiles>[1]) => sortFiles(root.children, order).map(file => file.name);
  expect(work).toBeInstanceOf(TFolder);
  expect(names("alphabetical")).toEqual(["Work", "Notes 2.md", "Notes 10.md"]);
  expect(names("alphabeticalReverse")).toEqual(["Work", "Notes 10.md", "Notes 2.md"]);
  expect(names("byModifiedTime")).toEqual(["Work", "Notes 2.md", "Notes 10.md"]);
  expect(names("byModifiedTimeReverse")).toEqual(["Work", "Notes 10.md", "Notes 2.md"]);
  expect(names("byCreatedTime")).toEqual(["Work", "Notes 10.md", "Notes 2.md"]);
  expect(names("byCreatedTimeReverse")).toEqual(["Work", "Notes 2.md", "Notes 10.md"]);
});

it("drags files natively with Option held, as the file explorer does; without it, they lift and move into a folder", async () => {
  const { view, settings, row, app, renameFile, root, work } = setup();
  settings.showFiles = true;
  view.refresh();
  const { drags } = app.dragManager;
  const notes = row("file:Notes 2.md");
  const folder = row("folder:Work");
  expect(drags.get(notes)!({} as DragEvent)).toEqual({ type: "file", file: root.children[2] });
  expect(drags.get(folder)!({} as DragEvent)).toEqual({ type: "folder", file: work });
  // A note takes tasks too.
  expect(dropTargetOf(notes)?.drop).toEqual({ kind: "note", path: "Notes 2.md" });
  expect(dropTargetOf(folder)).toBeUndefined();
  // With Option, the press is the native drag's: nothing lifts.
  firePointer(notes.querySelector(".tm-nav-label")!, "pointerdown", { altKey: true, clientY: 50 });
  firePointer(notes, "pointermove", { clientY: 80 });
  expect(document.querySelector(".tm-drag-preview")).toBeNull();
  expect(notes.draggable).toBe(true);
  firePointer(notes, "pointerup", { clientY: 80 });
  // Without it, the note lifts; over a folder's middle the folder lights up and the gap opens inside it.
  const note = root.children[2];
  const drag = grab(notes).to(folder, 10);
  expect(folder.classList.contains("is-drop-target")).toBe(true);
  expect(gapPlace()).toEqual({ above: "Work", depth: "1" });
  expect(renameFile).not.toHaveBeenCalled();
  drag.drop();
  await vi.waitFor(() => expect(renameFile).toHaveBeenCalledWith(note, "Work/Notes 2.md"));
  // Into a closed folder, it goes out of sight at once.
  expect(notes.style.height).toBe("0px");
  expect(gap()).toBeNull();
  // A folder doesn't go into itself, and nothing goes where it already is.
  const back = grab(row("folder:Work")).to(row("file:Notes 10.md"), 10);
  expect(gapPlace()!.above).toBe("Notes 10");
  back.to(gap()!, 10).drop();
  await vi.waitFor(() => expect(gap()).toBeNull());
  expect(renameFile).toHaveBeenCalledOnce();
});

it("puts files dragged beside a file or folder at that place, and keeps that order as the tree's custom order", async () => {
  const { view, settings, row, labels, renameFile, root, work, saveSettings, move } = setup();
  settings.showFiles = true;
  view.refresh();
  expect(labels()).toEqual(["Work", "Notes 2", "Notes 10"]);
  // Over the top of Notes 2, the gap opens above it, and the rows make room.
  const drag = grab(row("file:Notes 10.md")).to(row("file:Notes 2.md"), 4);
  expect(gapPlace()).toEqual({ above: "Work", depth: "0" });
  drag.drop();
  await vi.waitFor(() => expect(labels()).toEqual(["Work", "Notes 10", "Notes 2"]));
  expect(settings.customFileOrder).toBe(true);
  expect(settings.navOrder.files["/"]).toEqual(["Work", "Notes 10.md", "Notes 2.md"]);
  expect(saveSettings).toHaveBeenCalled();
  // Files and folders mix: a note goes above a folder from the top of its row, and into it from the middle.
  grab(row("file:Notes 2.md")).to(row("folder:Work"), 2).drop();
  await vi.waitFor(() => expect(labels()).toEqual(["Notes 2", "Work", "Notes 10"]));
  expect(renameFile).not.toHaveBeenCalled();
  // From another folder, it moves here first.
  (row("folder:Work").querySelector(".tm-nav-label") as HTMLElement).click();
  const plan = work.children[0] as TFile;
  renameFile.mockImplementationOnce(async () => move(plan, root));
  const out = grab(row("file:Work/Plan.md")).to(row("file:Notes 10.md"), 16);
  expect(gapPlace()).toEqual({ above: "Notes 10", depth: "0" });
  out.drop();
  await vi.waitFor(() => expect(renameFile).toHaveBeenCalledWith(plan, "Plan.md"));
  await vi.waitFor(() => expect(settings.navOrder.files["/"]).toEqual(["Notes 2.md", "Work", "Notes 10.md", "Plan.md"]));
  await vi.waitFor(() => expect(labels()).toEqual(["Notes 2", "Work", "diagram", "Notes 10", "Plan"]));
  // The sort menu says the order is custom; another order sorts again, keeping the custom one for later.
  (view.containerEl.querySelector('[aria-label="Change sort order"]') as HTMLElement).click();
  await vi.waitFor(() => expect(menus[menus.length - 1].titles).toContain("Custom order"));
  expect(menus[menus.length - 1].checked).toEqual(["Custom order"]);
  menus[menus.length - 1].click("File name (A to Z)");
  await vi.waitFor(() => expect(labels()).toEqual(["Work", "diagram", "Notes 2", "Notes 10", "Plan"]));
  expect(settings.customFileOrder).toBe(false);
  (view.containerEl.querySelector('[aria-label="Change sort order"]') as HTMLElement).click();
  await vi.waitFor(() => expect(menus[menus.length - 1].checked).toEqual(["File name (A to Z)"]));
  menus[menus.length - 1].click("Custom order");
  await vi.waitFor(() => expect(labels()).toEqual(["Notes 2", "Work", "diagram", "Notes 10", "Plan"]));
});

it("opens a closed folder a file rests on, and takes the last file of an open folder out of it, moving left", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { view, settings, row, labels, renameFile, root, work } = setup();
  settings.showFiles = true;
  view.refresh();
  const drag = grab(row("file:Notes 2.md")).to(row("folder:Work"), 10);
  expect(labels()).toEqual(["Work", "Notes 2", "Notes 10"]);
  // Resting on it, Work opens: its files show under the gap, where the note would go.
  vi.advanceTimersByTime(600);
  expect(labels()).toEqual(["Work", "diagram", "Plan", "Notes 2", "Notes 10"]);
  expect(gapPlace()).toEqual({ above: "Work", depth: "1" });
  expect(row("folder:Work").querySelector(".tm-nav-label")!.getAttribute("aria-expanded")).toBe("true");
  // After Plan, the last of Work's files, it goes into Work; moving left, out of it, after Work.
  drag.to(row("file:Work/Plan.md"), 16);
  expect(gapPlace()).toEqual({ above: "Plan", depth: "1" });
  drag.to(gap()!, 10, -30);
  expect(gapPlace()).toEqual({ above: "Plan", depth: "0" });
  drag.drop();
  await vi.advanceTimersByTimeAsync(0);
  expect(renameFile).not.toHaveBeenCalled();
  expect(settings.navOrder.files["/"]).toEqual(["Work", "Notes 2.md", "Notes 10.md"]);
  // The last file of an open folder, at its own place, comes out of it moving left.
  const plan = work.children[0] as TFile;
  await vi.advanceTimersByTimeAsync(2000);
  const out = grab(row("file:Work/Plan.md")).to(gap()!, 10, -30);
  expect(gapPlace()).toEqual({ above: "diagram", depth: "0" });
  out.drop();
  await vi.advanceTimersByTimeAsync(0);
  expect(renameFile).toHaveBeenCalledWith(plan, "Plan.md");
  expect(root.children).toContain(work);
});

it("lands a file let go on a folder that opened under it among that folder's files, without waiting for the move", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const { view, settings, row, labels, renameFile } = setup();
  settings.showFiles = true;
  view.refresh();
  renameFile.mockImplementationOnce(() => new Promise<void>(() => {}));
  const dragged = row("file:Notes 2.md");
  const drag = grab(dragged).to(row("folder:Work"), 10);
  vi.advanceTimersByTime(600);
  // Let go without moving again: the note shows at once where the gap was, first in Work.
  drag.drop();
  await vi.advanceTimersByTimeAsync(0);
  expect(renameFile).toHaveBeenCalledOnce();
  expect(dragged.style.height).toBe("");
  expect(dragged.style.getPropertyValue("--tm-nav-depth")).toBe("1");
  expect(labels()).toEqual(["Work", "Notes 2", "diagram", "Plan", "Notes 10"]);
});

it("keeps the file tree as it is through a file drag and the drop's moves, then redraws it once they pause", async () => {
  const { view, settings, row, labels, app, renameFile, root, work, move, emit, query } = setup();
  settings.showFiles = true;
  await view.onOpen();
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
  const notes2 = root.children[2] as TFile;
  const dragged = row("file:Notes 2.md");
  const drag = grab(dragged);
  // Redrawn mid-drag, the row dragged would be gone, and the rows under the pointer would jump.
  view.refresh();
  await frame();
  expect(row("file:Notes 2.md")).toBe(dragged);
  // Dropped into Work, the note goes out of sight at once; the tree waits for the move (and the links Obsidian
  // updates with it), however long it takes.
  let moved!: () => void;
  renameFile.mockImplementationOnce(() => new Promise<void>(resolve => { moved = resolve; }));
  drag.to(row("folder:Work"), 10).drop();
  await vi.waitFor(() => expect(renameFile).toHaveBeenCalledOnce());
  expect(dragged.style.height).toBe("0px");
  emit();
  view.refresh(true);
  await frame();
  expect(row("file:Notes 2.md")).toBe(dragged);
  move(notes2, work);
  moved();
  // Then the burst of index updates the move sets off: one redraw once they pause.
  const counted = query.mock.calls.length;
  emit(); emit();
  await vi.waitFor(() => expect(labels()).toEqual(["Work", "diagram", "Notes 2", "Plan", "Notes 10"]));
  expect(query.mock.calls.length - counted).toBeLessThanOrEqual(2);
  // Something dragged in from elsewhere (the file explorer) holds the tree too, until it leaves.
  const over = row("file:Notes 10.md");
  over.dispatchEvent(new Event("dragenter", { bubbles: true }));
  view.refresh();
  expect(row("file:Notes 10.md")).toBe(over);
  over.dispatchEvent(new MouseEvent("dragleave", { bubbles: true, relatedTarget: document.body }));
  await vi.waitFor(() => expect(row("file:Notes 10.md")).not.toBe(over));
  // A file from the file explorer opens the gap where it would go; let go, the row already here moves there at once.
  const list = container(view).querySelector<HTMLElement>(".tm-nav-list")!;
  const point = (target: HTMLElement, at: number) => ({ clientX: 100, clientY: target.getBoundingClientRect().top + at }) as DragEvent;
  const notes10 = root.children.find(file => file.name === "Notes 10.md")!;
  const target = row("folder:Work");
  expect(app.dragManager.drops.get(list)!(point(target, 2), { type: "file", file: notes10 }, true)).toMatchObject({ action: "Move here", dropEffect: "move" });
  expect(gapPlace()).toEqual({ above: null, depth: "0" });
  const row10 = row("file:Notes 10.md");
  app.dragManager.drops.get(list)!(point(target, 2), { type: "file", file: notes10 }, false);
  expect(row10.nextElementSibling).toBe(target);
  expect(gap()).toBeNull();
  window.dispatchEvent(new Event("dragend"));
  await view.onClose();
});

it("drops files let go outside the sidebar onto a folder in the file explorer, or into a note as a link", async () => {
  const { view, settings, row, renameFile, root } = setup();
  settings.showFiles = true;
  view.refresh();
  const notes2 = root.children[2] as TFile;
  // The file explorer, beside the sidebar.
  const explorer = document.body.createDiv({ cls: "nav-files-container" });
  const folder = explorer.createDiv({ cls: "nav-folder-title", attr: { "data-path": "Work" } });
  document.elementFromPoint = () => folder;
  const outside = 2000;
  let drag = grab(row("file:Notes 2.md")).to(outside);
  // Outside, the rows close back up and a label with its name follows the pointer.
  expect(document.querySelector(".tm-drag-chip")!.textContent).toBe("Notes 2");
  expect(gapPlace()).toEqual({ above: "Work", depth: "0" });
  drag.drop();
  await vi.waitFor(() => expect(renameFile).toHaveBeenCalledWith(notes2, "Work/Notes 2.md"));
  expect(document.querySelector(".tm-drag-chip, .tm-drag-preview")).toBeNull();
  // A note: a link where it is let go.
  const editor = document.body.createDiv({ cls: "cm-editor" });
  document.elementFromPoint = () => editor;
  const editorView = { posAtCoords: vi.fn(() => 5), state: { selection: { main: { head: 0 } } }, dispatch: vi.fn(), focus: vi.fn() };
  vi.spyOn(EditorView, "findFromDOM").mockReturnValue(editorView as unknown as EditorView);
  drag = grab(row("file:Notes 10.md")).to(outside);
  drag.drop();
  await vi.waitFor(() => expect(editorView.dispatch).toHaveBeenCalledWith({ changes: { from: 5, insert: "[[Notes 10]]" }, selection: { anchor: 17 } }));
  expect(renameFile).toHaveBeenCalledOnce();
  // Anywhere else, it flies back.
  document.elementFromPoint = () => document.body;
  drag = grab(row("file:Notes 10.md")).to(outside);
  drag.drop();
  await vi.waitFor(() => expect(document.querySelector(".tm-drag-preview")).toBeNull());
  expect(row("file:Notes 10.md").classList.contains("tm-drag-source")).toBe(false);
  expect(editorView.dispatch).toHaveBeenCalledOnce();
});

it("marks the open file in place, and counts open tasks and draws icons once until something changes", async () => {
  const { view, settings, row, app, query, emit, workspaceEvents } = setup();
  settings.showFiles = true;
  await view.onOpen();
  const notes10 = row("file:Notes 10.md");
  const notes2 = row("file:Notes 2.md");
  expect(notes10.classList.contains("is-active")).toBe(true);
  // Another file opening marks its row, and unmarks the other, without drawing the list again.
  app.workspace.getActiveFile.mockReturnValue(app.vault.getAbstractFileByPath("Notes 2.md") as TFile);
  workspaceEvents.get("file-open")!();
  workspaceEvents.get("active-leaf-change")!(null);
  expect(row("file:Notes 2.md")).toBe(notes2);
  expect([notes2.classList.contains("is-active"), notes10.classList.contains("is-active")]).toEqual([true, false]);
  expect(notes2.querySelector(".tm-nav-label")!.getAttribute("aria-current")).toBe("page");
  // A list opening marks it in place too.
  const inbox = row("mode:inbox");
  view.setActive("inbox");
  expect(row("mode:inbox")).toBe(inbox);
  expect(inbox.classList.contains("is-active")).toBe(true);
  // Inbox and Today are counted once; folding a folder draws the list again without counting again.
  const counted = query.mock.calls.length;
  (row("folder:Work").querySelector(".tm-nav-label") as HTMLElement).click();
  expect(query.mock.calls.length).toBe(counted);
  emit();
  await vi.waitFor(() => expect(query.mock.calls.length).toBe(counted + 2));
  // An icon is drawn once, and copied after that.
  const { setIcon } = await import("obsidian");
  vi.mocked(setIcon).mockImplementation((element: HTMLElement, name: string) => { element.createSpan({ cls: `svg-${name}` }); });
  vi.mocked(setIcon).mockClear();
  view.refresh();
  view.refresh();
  const drawn = vi.mocked(setIcon).mock.calls.map(call => call[1]);
  expect(new Set(drawn).size).toBe(drawn.length);
  expect(row("file:Notes 2.md").querySelector(".svg-file-text")).not.toBeNull();
  await view.onClose();
});

it("marks only what the tab in front shows: a note unmarks the list, and a task page marks its note's file too", async () => {
  const { view, settings, row, app, plugin, workspaceEvents } = setup();
  settings.showFiles = true;
  Object.assign(plugin.index, { isProject: (path: string) => path === "Work/Plan.md", tagForPath: (path: string) => path === "Notes 10.md" ? "reading" : undefined });
  let active: unknown = { getViewType: () => "task-manager-main", getState: () => ({ mode: "today" }) };
  Object.assign(app.workspace, { getActiveViewOfType: () => active });
  const front = (): void => workspaceEvents.get("active-leaf-change")!(null);
  await view.onOpen();
  expect(row("mode:today").classList.contains("is-active")).toBe(true);
  // A note in front: its file is marked, and no list is.
  active = { getViewType: () => "markdown", getState: () => ({}) };
  app.workspace.getActiveFile.mockReturnValue(app.vault.getAbstractFileByPath("Notes 2.md") as TFile);
  front();
  expect(row("mode:today").classList.contains("is-active")).toBe(false);
  expect(row("file:Notes 2.md").classList.contains("is-active")).toBe(true);
  // A project's or a tag's note marks the project or tag.
  const setActive = vi.spyOn(view, "setActive");
  app.workspace.getActiveFile.mockReturnValue(app.vault.getAbstractFileByPath("Work/Plan.md") as TFile);
  front();
  expect(setActive).toHaveBeenLastCalledWith("projects", undefined, "Work/Plan.md");
  app.workspace.getActiveFile.mockReturnValue(app.vault.getAbstractFileByPath("Notes 10.md") as TFile);
  front();
  expect(setActive).toHaveBeenLastCalledWith("tags", "reading", undefined);
  // A task page in front (a note in task mode), for which Obsidian has no active file, marks its note's row.
  const page = { getViewType: () => "task-manager-main", getState: () => ({ mode: "all", pagePath: "Notes 2.md" }) };
  active = page;
  Object.assign(app.workspace, { getMostRecentLeaf: () => ({ view: page }) });
  app.workspace.getActiveFile.mockReturnValue(null);
  front();
  expect([row("file:Notes 2.md").classList.contains("is-active"), row("file:Notes 10.md").classList.contains("is-active")]).toEqual([true, false]);
  await view.onClose();
});

it("leaves out the sections settings hide, and a group of lists left with none", () => {
  const { view, settings, container } = setup();
  settings.showFiles = true;
  const headings = () => Array.from(container.querySelectorAll(".tm-nav-label")).map(label => label.getAttribute("data-tm-nav-key")!)
    .filter(key => !key.includes(":") || key.startsWith("mode:"));
  view.refresh();
  expect(headings()).toEqual(["favorites", "mode:inbox", "mode:today", "mode:upcoming", "mode:all", "mode:projects", "tags", "files"]);
  settings.hiddenSidebarSections = ["favorites", "inbox", "upcoming", "tags"];
  view.refresh();
  expect(headings()).toEqual(["mode:today", "mode:all", "mode:projects", "files"]);
  settings.hiddenSidebarSections = ["today", "upcoming", "all", "projects"];
  settings.showFiles = false;
  view.refresh();
  expect(headings()).toEqual(["favorites", "mode:inbox", "tags"]);
  expect(container.querySelectorAll(".tm-nav-group:not(.tm-nav-section)")).toHaveLength(1);
});

const container = (view: TaskNavigationView) => view.containerEl.children[1] as HTMLElement;

it("sorts a folder's files in its custom order, with files not yet placed after them in the chosen order", () => {
  const { root } = setup();
  expect(sortFiles(root.children, "alphabetical", ["Notes 10.md"]).map(file => file.name)).toEqual(["Notes 10.md", "Work", "Notes 2.md"]);
  expect(sortFiles(root.children, "alphabeticalReverse", ["Gone.md", "Notes 2.md"]).map(file => file.name)).toEqual(["Notes 2.md", "Work", "Notes 10.md"]);
});
