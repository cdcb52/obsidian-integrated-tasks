import { EditorView } from "@codemirror/view";
import { ItemView, Keymap, Menu, Notice, setIcon, TFile, TFolder, type TAbstractFile, type WorkspaceLeaf } from "obsidian";
import type TaskManagerPlugin from "./main";
import type { FileSortOrder, Project, TaskManagerSettings, TaskViewMode } from "./types";
import { activeProjects, renderProjectProgress } from "./project-progress";
import { projectHierarchy } from "./project-hierarchy";
import { activeTaskDrag, highlightDropTarget, markDropTarget, TASK_DRAG_TYPE, type SidebarDrop } from "./sidebar-drop";
import { inOrder, moveKey } from "./sidebar-order";
import { leafFor } from "./leaves";
import { NavDragController, SIDE_HYSTERESIS_PX, type NavDrag, type NavGap, type NavIntent, type Point } from "./navigation-drag";

export const TASK_NAV_VIEW = "task-manager-navigation";

/** A list in the sidebar, as Things shows its lists: a coloured icon, the name, and (for some) how many tasks are open. */
interface NavEntry { mode: TaskViewMode; label: string; icon: string; color: string; count?: boolean; griplyIcon?: string }

/** The lists, in groups set apart as Things sets its lists apart. */
const NAV_GROUPS: NavEntry[][] = [
  [{ mode: "inbox", label: "Inbox", icon: "inbox", color: "blue", count: true }],
  [
    { mode: "today", label: "Today", icon: "star", griplyIcon: "calendar-x", color: "yellow", count: true },
    { mode: "upcoming", label: "Upcoming", icon: "calendar-days", color: "red" },
    { mode: "all", label: "All Tasks", icon: "layers", color: "cyan" }
  ]
];
/** The icon and colour a smart list and a tag show, here and wherever else the sidebar's lists are named. */
export const SMART_LIST_GLYPH = { icon: "list-filter", color: "orange" } as const;
export const TAG_GLYPH = { icon: "hash", color: "muted" } as const;

/** A list's icon and colour as the sidebar draws it: Today's icon follows the style, a star in Things and a calendar in Griply. */
export function listGlyph(mode: TaskViewMode, style: TaskManagerSettings["style"]): { icon: string; color: string } | undefined {
  const entry = NAV_GROUPS.flat().find(item => item.mode === mode);
  return entry && { icon: (style === "griply" && entry.griplyIcon) || entry.icon, color: entry.color };
}

/** What folds away from a chevron: Favorites, smart lists under All Tasks, and the sections below the lists (each a
 * heading over its items). */
type NavSection = "favorites" | "smartLists" | "projects" | "tags" | "files";
/** The sections below the lists. The Projects heading opens the Projects view; the Tags heading only folds its tags. */
const NAV_SECTIONS: Array<{ section: "projects" | "tags"; label: string; icon: string; open?: TaskViewMode }> = [
  { section: "projects", label: "Projects", icon: "square-chart-gantt", open: "projects" },
  { section: "tags", label: "Tags", icon: "tag" }
];
/** The icon a file shows by its kind, as the file explorer would name them. */
const FILE_ICONS: Record<string, string> = {
  md: "file-text", canvas: "layout-dashboard", base: "table", pdf: "file-text",
  png: "file-image", jpg: "file-image", jpeg: "file-image", gif: "file-image", svg: "file-image", webp: "file-image", bmp: "file-image", avif: "file-image",
  mp3: "file-audio", wav: "file-audio", m4a: "file-audio", ogg: "file-audio", flac: "file-audio", webm: "file-video", mp4: "file-video", mov: "file-video", mkv: "file-video"
};
/** Whether `file` can move into `folder`: not where it already is, and a folder not into itself or a folder inside it. */
export function canMoveInto(file: TAbstractFile, folder: TFolder): boolean {
  if (file.parent === folder) return false;
  return !(file instanceof TFolder && (file === folder || folder.path.startsWith(`${file.path}/`)));
}

/** The file tree's orders, with the names and groups the file explorer gives them. */
const FILE_SORT_ORDERS: Array<[FileSortOrder, string, string]> = [
  ["alphabetical", "File name (A to Z)", "name"], ["alphabeticalReverse", "File name (Z to A)", "name"],
  ["byModifiedTime", "Modified time (new to old)", "modified"], ["byModifiedTimeReverse", "Modified time (old to new)", "modified"],
  ["byCreatedTime", "Created time (new to old)", "created"], ["byCreatedTimeReverse", "Created time (old to new)", "created"]
];

/** `files` in `order`, folders first. Folders have no times, so they go by name, backwards only in Z to A. */
export function sortFiles(files: TAbstractFile[], order: FileSortOrder, custom: string[] = []): TAbstractFile[] {
  const byName = (a: TAbstractFile, b: TAbstractFile): number => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const time = (file: TAbstractFile): number => file instanceof TFile ? order.startsWith("byCreated") ? file.stat.ctime : file.stat.mtime : 0;
  const sorted = [...files].sort((a, b) => {
    const folders = Number(b instanceof TFolder) - Number(a instanceof TFolder);
    if (folders) return folders;
    if (order === "alphabetical") return byName(a, b);
    if (order === "alphabeticalReverse") return byName(b, a);
    if (a instanceof TFolder) return byName(a, b);
    return (order.endsWith("Reverse") ? time(a) - time(b) : time(b) - time(a)) || byName(a, b);
  });
  // Dragged into place (`custom`, by name), folders and files mix; what was not dragged follows in `order`.
  return inOrder(sorted, custom, file => file.name);
}
/** What Obsidian's drag manager carries: a file or folder, or several from the file explorer. */
interface Draggable { type: string; file?: TAbstractFile; files?: TAbstractFile[] }
interface DropResult { action: string; dropEffect: "move" | "none"; hoverEl?: HTMLElement; hoverClass?: string }
/** Obsidian's drag manager, which its file explorer drags files with, so a file dragged from here links in a note, opens
 * in a tab, or moves in the file explorer. It is not in the plugin API, so files drag only while it is there. */
interface DragManager {
  handleDrag(element: HTMLElement, start: (event: DragEvent) => Draggable | null): void;
  handleDrop(element: HTMLElement, drop: (event: DragEvent, draggable: Draggable | null, hovering: boolean) => DropResult | undefined): void;
  dragFile(event: DragEvent, file: TFile, source?: string): Draggable;
  dragFolder(event: DragEvent, folder: TFolder, source?: string): Draggable;
}
const NAV_MODES = new Set<TaskViewMode>([...NAV_GROUPS.flat().map(entry => entry.mode), "projects", "tags"]);

/** A row's icon, its colour, its count of open tasks, and whether what it folds is open (for a row whose click folds). */
interface NavItemOptions { icon?: string; color?: string; count?: number; expanded?: boolean }
/** A project's row in the sidebar's tree, as drawn: how deep it is, and the project it shows under ("" for none). */
interface NavProjectRow { path: string; depth: number; parent: string; row: HTMLElement }
/** Where a dragged project goes: as deep as it will be, its parent, and the project it follows. */
interface ProjectDrop { depth: number; parent: string; after?: string }
/** Dragging a project or file this far right (a level per this much) puts it under the one above; left, out a level. */
const NEST_PX = 24;
const OUTDENT_PX = 16;
/** Where in the sidebar a file row is: the Files tree, or Favorites (a favourite folder's files). Renaming happens in one. */
type FileScope = "files" | "favorites";
/** After a drop's file moves, the index and vault events they cause (each note whose links Obsidian rewrites) redraw
 * the list once they pause this long, or at the latest after BURST_MAX_MS. */
const SETTLE_MS = 100;
const BURST_QUIET_MS = 300;
const BURST_MAX_MS = 2000;

/**
 * What a row in the sidebar is, as a drag reads it: where something dropped beside it goes, and what it carries when
 * it is dragged. Favorites' heading (and its empty hint) is the end of Favorites; the Files heading, the vault's top.
 */
type NavItem =
  | { kind: "favorite"; key: string }
  | { kind: "list"; mode: TaskViewMode }
  | { kind: "smartList"; id: string }
  | { kind: "tag"; name: string }
  | { kind: "project"; drawn: NavProjectRow; rows: NavProjectRow[]; place: (dragged: NavProjectRow, drop: ProjectDrop) => Promise<void> }
  | { kind: "file"; file: TFile | TFolder; depth: number; scope: FileScope }
  | { kind: "favorites" }
  | { kind: "root" };
/** What is dragged: a row (with what it is as a favourite, to drop into Favorites), or files from the file explorer. */
interface NavDragItem { item?: NavItem; favorite?: string; files?: Array<TFile | TFolder>; label: string }

/** Lucide icons, drawn once each and copied for every row after that. */
const ICONS = new Map<string, Node>();
/** Draws icon `name` into `parent`: drawing an icon parses its SVG, so after the first time it is copied instead. */
export function navIcon(parent: HTMLElement, name: string): void {
  parent.setAttribute("data-icon", name);
  const drawn = ICONS.get(name);
  if (!drawn) {
    parent.empty();
    setIcon(parent, name);
    // An icon that did not draw (none by that name yet) is drawn again next time.
    if (parent.firstChild) ICONS.set(name, parent.cloneNode(true));
    return;
  }
  parent.empty();
  for (const child of Array.from(drawn.childNodes)) parent.appendChild(child.cloneNode(true));
}

/** A row's depth in its tree (projects, files), as drawn. */
function depthOf(row: Element): number {
  return Number.parseInt((row as HTMLElement).style?.getPropertyValue("--tm-nav-depth") || "0", 10) || 0;
}

/** The files and folders Obsidian's drag manager carries, if any. */
function draggedFiles(draggable: Draggable | null): Array<TFile | TFolder> {
  const files = draggable?.type === "files" ? draggable.files ?? [] : draggable?.type === "file" || draggable?.type === "folder" ? [draggable.file] : [];
  return files.filter((file): file is TFile | TFolder => file instanceof TFile || file instanceof TFolder);
}

export class TaskNavigationView extends ItemView {
  private activeMode: TaskViewMode = "today";
  private activeTag?: string;
  private activeSmartList?: string;
  private activeProject?: string;
  /** Sections shown open; Things lists its projects, so Favorites, smart lists and projects start open. */
  private expanded = new Set<NavSection>(["favorites", "smartLists", "projects", "files"]);
  /** Parent projects whose subprojects are folded away. */
  private foldedProjects = new Set<string>();
  /** Folders shown open in the file tree; kept with the sidebar's layout. */
  private openFolders = new Set<string>();
  /** The file or folder being renamed in place (in the file tree or in Favorites), and the name typed so far. */
  private renaming?: { path: string; value: string; selected: boolean; scope: FileScope };
  /** True while the list is rebuilt, when a rename field losing focus is not the user leaving it. */
  private rebuilding = false;
  private fileEvents = false;
  private unsubscribe?: () => void;
  private frame?: number;
  private settleTimer?: number;
  /**
   * A press on the list in progress: rebuilding it now would take the pressed row away before its click (on phones,
   * the first tap would only make the sidebar active), so the list waits until the press ends.
   */
  private pressed = false;
  /** A redraw waiting for a press, a drag or a drop's file moves to end. */
  private pendingRender = false;
  private releaseTimer?: number;
  private closed = false;
  /** Until then, after a drop's file moves, redraws wait for the burst of index and vault events to pause. */
  private burstUntil = 0;
  /** A file row dragged natively (with Option held), as from the file explorer: the list waits for the drop. */
  private nativeDrag = false;
  /** Something dragged over the list (a file from the file explorer, say): the rows under it stay until it leaves or drops. */
  private dragOver = false;
  /** A drop's file moves under way: the list redraws once they are done (see whileMoving). */
  private moving = 0;
  /** The open file's path, for the file rows. */
  private activeFile?: string;
  /** Each row's label and key, so marking what is open changes two rows rather than redrawing the list. */
  private labels: Array<{ row: HTMLElement; label: HTMLElement; key: string }> = [];
  /** What each row is, for a drag (see NavItem), and the lists drops go into. */
  private rowItems = new WeakMap<HTMLElement, { item: NavItem; favorite?: string }>();
  private listEl?: HTMLElement;
  private favoritesHeading?: HTMLElement;
  private favoritesChildren?: HTMLElement;
  private filesChildren?: HTMLElement;
  /** What the index says, read once until it changes: the open task counts (by day), and the projects. */
  private counts = new Map<string, number>();
  private countsDay = "";
  private projectList?: Project[];
  /** Drags the rows, as the task lists drag theirs. */
  private readonly drag = new NavDragController<NavDragItem>({
    list: () => this.listEl,
    scroller: () => this.containerEl.children[1] as HTMLElement | undefined,
    layerClasses: () => [...this.settings.density === "compact" ? ["tm-density-compact"] : [], ...this.settings.style === "things" ? ["tm-style-things"] : []],
    resolve: (element, point, drag) => this.resolveDrop(element, point, drag),
    source: row => this.dragSource(row),
    home: (row, item, depth, x) => this.dragHome(row, item, depth, x),
    label: item => item.label,
    dropOutside: (point, item) => this.dropOutside(point, item),
    onIdle: () => this.resumeRender()
  });
  // The toolbar is one tab stop; arrow keys move between its buttons.
  private toolbarFocus = 0;
  constructor(leaf: WorkspaceLeaf, private readonly plugin: TaskManagerPlugin) { super(leaf); }
  getViewType(): string { return TASK_NAV_VIEW; }
  getDisplayText(): string { return "Tasks"; }
  getIcon(): string { return "circle-check-big"; }
  getState(): Record<string, unknown> { return { ...super.getState(), openFolders: [...this.openFolders] }; }
  async setState(state: unknown, result: Parameters<ItemView["setState"]>[1]): Promise<void> {
    const folders = (state as { openFolders?: unknown } | null)?.openFolders;
    if (Array.isArray(folders)) this.openFolders = new Set(folders.filter((path): path is string => typeof path === "string"));
    await super.setState(state, result);
    this.render();
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.unsubscribe = this.plugin.index.subscribe(() => {
      // Counts and projects are read again on the next redraw.
      this.forgetIndex();
      this.scheduleSettledRender();
    });
    const syncActive = (): void => {
      if (this.plugin.settings.showFiles || this.labels.some(entry => entry.key.startsWith("file:"))) this.markActiveFile();
      this.followActiveView();
    };
    // Only a tab in the main area changes what is open; the sidebar itself (or another) becoming active changes nothing.
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => {
      if (leaf && leaf.getRoot?.() !== this.app.workspace.rootSplit) return;
      syncActive();
    }));
    const release = (): void => {
      if (!this.pressed) return;
      this.pressed = false;
      // After the click the press makes, which opens what it is on (and redraws the list itself).
      if (this.releaseTimer !== undefined) this.containerEl.win.clearTimeout(this.releaseTimer);
      this.releaseTimer = this.containerEl.win.setTimeout(() => {
        this.releaseTimer = undefined;
        if (!this.pendingRender) return;
        this.pendingRender = false;
        this.scheduleRender();
      }, 400);
    };
    this.registerDomEvent(this.containerEl, "pointerdown", () => {
      this.pressed = true;
      // No native drag goes on during a press: one whose end never came here is over.
      this.nativeDrag = false;
      this.dragOver = false;
    });
    this.registerDomEvent(this.containerEl.win, "pointerup", release, true);
    this.registerDomEvent(this.containerEl.win, "pointercancel", release, true);
    // While something is dragged over the list natively (a file from the file explorer), it stays as it is (see render).
    const over = (): void => { this.dragOver = true; };
    this.registerDomEvent(this.containerEl, "dragenter", over, true);
    this.registerDomEvent(this.containerEl, "dragover", over, true);
    this.registerDomEvent(this.containerEl, "dragleave", event => {
      if (this.containerEl.contains(event.relatedTarget as Node | null)) return;
      this.dragOver = false;
      this.drag.leaveExternal();
      this.resumeRender();
    }, true);
    // A native drag that ends anywhere (dropped elsewhere, or let go) takes its gap with it.
    this.registerDomEvent(this.containerEl.win, "dragend", () => this.endNativeDrag(), true);
    this.registerDomEvent(this.containerEl.win, "drop", () => {
      this.dragOver = false;
      this.resumeRender();
    }, true);
    syncActive();
    this.render();
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.cancelRender();
    this.drag.dispose();
    if (this.settleTimer !== undefined) this.containerEl.win.clearTimeout(this.settleTimer);
    this.settleTimer = undefined;
    if (this.releaseTimer !== undefined) this.containerEl.win.clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
  }
  setActive(mode: TaskViewMode, tag?: string, project?: string, smartListId?: string): void {
    this.activeSmartList = smartListId;
    this.activeMode = mode; this.activeTag = tag; this.activeProject = project;
    // The section holding the open item unfolds, so it shows; then the list is drawn again. Otherwise only the
    // rows that were and are now open change.
    const section: NavSection | undefined = smartListId ? "smartLists" : tag ? "tags" : project ? "projects" : undefined;
    const unfolds = section !== undefined && !this.expanded.has(section);
    if (section) this.expanded.add(section);
    if (unfolds || this.hidesActiveProject() || !this.labels.length) this.render();
    else this.markActive();
  }

  /** Whether a parent of the open project is folded, so drawing the list again unfolds it. */
  private hidesActiveProject(): boolean {
    if (!this.activeProject || !this.foldedProjects.size) return false;
    const byPath = new Map(this.projects().map(project => [project.path, project]));
    for (let path = byPath.get(this.activeProject)?.parentPath; path; path = byPath.get(path)?.parentPath) if (this.foldedProjects.has(path)) return true;
    return false;
  }

  /** Marks the rows of what is open (a list, smart list, project, tag or file), and unmarks the rest, in place. */
  private markActive(): void {
    for (const { row, label, key } of this.labels) {
      const active = this.isActiveKey(key);
      if (row.classList.contains("is-active") === active) continue;
      row.toggleClass("is-active", active);
      label.setAttribute("aria-current", active ? "page" : "false");
    }
  }

  /** The open file changed: its rows are marked, without drawing the list again. */
  private markActiveFile(): void {
    const path = this.app.workspace.getActiveFile?.()?.path;
    if (path === this.activeFile) return;
    this.activeFile = path;
    this.markActive();
  }

  /** Whether the row with `key` (as data-tm-nav-key has it, in Favorites too) shows what is open. */
  private isActiveKey(key: string): boolean {
    const bare = key.startsWith("favorite:") ? key.slice("favorite:".length) : key;
    const colon = bare.indexOf(":");
    if (colon < 0) return false;
    const [kind, value] = [bare.slice(0, colon), bare.slice(colon + 1)];
    if (kind === "mode") return this.listActive(value as TaskViewMode);
    if (kind === "list") return this.activeSmartList === value;
    if (kind === "project") return this.activeProject === value;
    if (kind === "tag") return this.activeTag === value;
    if (kind === "file") return this.activeFile === value;
    return false;
  }

  /** Marks what the task tab in front lists, when another tab comes to the front or Back and Forward change what it lists. */
  followActiveView(): void {
    const view = this.app.workspace.getActiveViewOfType(ItemView);
    if (view?.getViewType() !== "task-manager-main") return;
    const state = view.getState();
    const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
    const mode = NAV_MODES.has(state.mode as TaskViewMode) ? state.mode as TaskViewMode : state.mode === "smartLists" ? "smartLists" : undefined;
    if (!mode) return;
    const [tag, project, smartList] = mode === "smartLists" ? [undefined, undefined, text(state.smartListId)]
      : [text(state.tag), mode === "tags" ? undefined : text(state.pagePath) ?? text(state.projectPath), undefined];
    // Already marked (a list opened from here is marked as it opens): nothing to redraw.
    if (mode === this.activeMode && tag === this.activeTag && project === this.activeProject && smartList === this.activeSmartList) return;
    if (mode === "smartLists") this.setActive(mode, undefined, undefined, smartList);
    else this.setActive(mode, tag, project);
  }

  /** Redraws the list now, or (`soon`) in the next frame, along with anything else that changed by then. */
  refresh(soon = false): void {
    // Something outside changed (a setting, the smart lists): what the index says is read again too.
    this.forgetIndex();
    if (soon) this.scheduleRender(); else this.render();
  }

  /** Changes arrive in bursts, so render at most once per frame (after a drop's moves, once they pause). */
  private scheduleRender(): void {
    if (this.closed || this.frame !== undefined) return;
    if (Date.now() < this.burstUntil) { this.scheduleSettledRender(); return; }
    this.renderNextFrame();
  }

  private renderNextFrame(): void {
    if (this.closed || this.frame !== undefined) return;
    this.frame = this.containerEl.win.requestAnimationFrame(() => {
      this.frame = undefined;
      // A name being typed keeps its field; the list catches up when the rename ends.
      if (!this.renaming) this.render();
    });
  }

  /**
   * Index and vault events come in bursts (a moved note changes every note that links to it, each one indexed again),
   * so the list redraws once they pause; after a drop's moves, once they pause a little longer.
   */
  private scheduleSettledRender(): void {
    if (this.closed) return;
    const win = this.containerEl.win;
    if (this.settleTimer !== undefined) win.clearTimeout(this.settleTimer);
    const now = Date.now();
    const delay = now < this.burstUntil ? Math.min(BURST_QUIET_MS, this.burstUntil - now) : SETTLE_MS;
    this.settleTimer = win.setTimeout(() => {
      this.settleTimer = undefined;
      this.burstUntil = 0;
      this.renderNextFrame();
    }, delay);
  }

  /** A redraw that waited (for a press, a drag or a drop's moves) happens, once nothing holds it any more. */
  private resumeRender(): void {
    if (this.pendingRender) this.scheduleRender();
  }

  private cancelRender(): void {
    if (this.frame === undefined) return;
    this.containerEl.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
  }

  /** What the index said is read again when next needed. */
  private forgetIndex(): void {
    this.counts.clear();
    this.projectList = undefined;
  }

  /** The projects, read from the index once until it changes. */
  private projects(): Project[] {
    return this.projectList ??= this.plugin.index.projects();
  }

  /** How many open tasks a list has, counted once until the index (or the day) changes. */
  private openCount(mode: TaskViewMode): number {
    const day = new Date().toDateString();
    if (day !== this.countsDay) { this.counts.clear(); this.countsDay = day; }
    let count = this.counts.get(mode);
    if (count === undefined) {
      count = this.plugin.index.query({ mode, showCompleted: false }).length;
      this.counts.set(mode, count);
    }
    return count;
  }

  private get settings(): TaskManagerSettings { return this.plugin.settings; }

  private render(): void {
    this.cancelRender();
    if (this.closed) return;
    // Rebuilding the list mid-press, or mid-drag, would take away the row being pressed or dragged (or the rows under it);
    // mid-drop, the files being moved would redraw it again and again.
    if (this.pressed || this.drag.dragging || this.nativeDrag || this.dragOver || this.moving) { this.pendingRender = true; return; }
    this.pendingRender = false;
    // The rows are drawn anew: what they were is forgotten.
    this.drag.dispose();
    this.labels = [];
    this.rowItems = new WeakMap();
    this.favoritesHeading = this.favoritesChildren = this.filesChildren = undefined;
    const container = this.containerEl.children[1] as HTMLElement;
    // Rebuilding the list would drop keyboard focus and scroll position; restore both afterwards.
    const focused = container.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = focused && container.contains(focused) ? focused.getAttribute("data-tm-nav-key") : null;
    const scrollTop = container.scrollTop;
    this.rebuilding = true;
    container.empty();
    container.addClass("tm-navigation");
    container.classList.toggle("tm-density-compact", this.settings.density === "compact");
    container.classList.toggle("tm-style-things", this.settings.style === "things");
    const header = container.createDiv({ cls: "nav-header tm-nav-header" });
    const toolbar = header.createDiv({ cls: "nav-buttons-container", attr: { role: "toolbar", "aria-label": "Task actions" } });
    const buttons: HTMLButtonElement[] = [];
    const rove = (index: number): void => {
      this.toolbarFocus = index;
      buttons.forEach((button, position) => button.setAttribute("tabindex", position === index ? "0" : "-1"));
    };
    const action = (label: string, icon: string, run: () => void | Promise<void>): HTMLButtonElement => {
      const button = toolbar.createEl("button", { cls: "clickable-icon nav-action-button", attr: { "aria-label": label, title: label, "data-tm-nav-key": `action:${label}` } });
      navIcon(button, icon);
      const index = buttons.push(button) - 1;
      button.addEventListener("focus", () => rove(index));
      button.addEventListener("click", () => { void Promise.resolve().then(run).catch(error => new Notice(String(error))); });
      return button;
    };
    toolbar.addEventListener("keydown", event => {
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const last = buttons.length - 1;
      const next = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
        : event.key === "Home" ? 0 : event.key === "End" ? last : undefined;
      if (next === undefined) return;
      event.preventDefault();
      rove(next);
      buttons[next].focus();
    });
    action("New task", "circle-plus", () => this.plugin.newTask());
    action("New note", "square-pen", () => this.newNote());
    const toggle = action("Task mode", "list-checks", async () => {
      toggle.disabled = true;
      try { await this.plugin.setTaskMode(!this.settings.taskMode); }
      finally { this.render(); }
    });
    toggle.setAttribute("aria-pressed", String(this.settings.taskMode));
    toggle.setAttribute("title", `Task mode: ${this.settings.taskMode ? "On" : "Off"}`);
    toggle.classList.toggle("is-active", this.settings.taskMode);
    // Folders and their order belong to the file tree, so they show with it.
    if (this.settings.showFiles) {
      action("New folder", "folder-plus", () => this.newFolder(this.app.vault.getRoot()));
      const sort = action("Change sort order", "arrow-up-narrow-wide", () => this.openSortMenu(sort));
    }
    rove(Math.min(this.toolbarFocus, buttons.length - 1));

    const nav = container.createDiv({ cls: "nav-files-container tm-nav-list", attr: { "aria-label": "Task navigation" } });
    this.listEl = nav;
    if (this.settings.showFiles || this.settings.favorites?.some(key => /^(file|folder):/.test(key))) {
      this.watchFiles();
      this.activeFile = this.app.workspace.getActiveFile()?.path;
    }
    // Files and folders dragged in from the file explorer drop anywhere in the list, through Obsidian's drag manager.
    this.externalDrop(nav);
    this.renderFavorites(nav);
    for (const group of NAV_GROUPS) {
      const lists = nav.createDiv({ cls: "tm-nav-group" });
      for (const entry of group) {
        const row = this.listRow(lists, entry.mode, `mode:${entry.mode}`);
        // The lists keep their places; they drag only into Favorites.
        this.draggable(row, { kind: "list", mode: entry.mode }, `mode:${entry.mode}`);
        // Smart lists, being saved views of all tasks, sit under All Tasks.
        if (entry.mode !== "all" || !this.folder(row, "smartLists", "smart lists")) continue;
        const children = lists.createDiv({ cls: "tree-item-children nav-folder-children tm-nav-children" });
        const smartLists = this.settings.smartLists;
        // Indented a step under All Tasks, as a subproject is under its parent.
        for (const list of smartLists) {
          const item = this.smartListRow(children, list.id, `list:${list.id}`);
          item?.setCssProps({ "--tm-nav-depth": "1" });
          if (item) this.draggable(item, { kind: "smartList", id: list.id }, `list:${list.id}`);
        }
        if (!smartLists.length) children.createDiv({ cls: "tm-nav-empty", text: "No smart lists yet" });
      }
    }

    for (const { section, label, icon, open } of NAV_SECTIONS) {
      const group = nav.createDiv({ cls: "tree-item nav-folder tm-nav-group tm-nav-section" });
      const heading = open
        ? this.item(group, `mode:${open}`, label, this.listActive(open), event => this.plugin.openTaskView({ mode: open }, { newLeaf: Keymap.isModEvent(event) }), { icon, color: "section" })
        : this.item(group, section, label, false, () => this.toggleSection(section), { icon, color: "section", expanded: this.expanded.has(section) });
      if (open) heading.addEventListener("contextmenu", event => this.openItemMenu(event, `mode:${open}`));
      if (!this.folder(heading, section, label)) { group.addClass("is-folded"); continue; }
      const children = group.createDiv({ cls: "tree-item-children nav-folder-children tm-nav-children" });
      if (section === "projects") {
        const projects = activeProjects(this.projects());
        // The open project's parents stay unfolded, so it shows.
        const byPath = new Map(projects.map(project => [project.path, project]));
        for (let path = byPath.get(this.activeProject ?? "")?.parentPath; path; path = byPath.get(path)?.parentPath) this.foldedProjects.delete(path);
        const tree = projectHierarchy(projects, this.settings.navOrder?.projects);
        // Subprojects sit under their parent, indented a step per level; a parent folds them away from its chevron.
        let hiddenBelow: number | undefined;
        // The project each level is under, and the rows as drawn, which projects drag among.
        const parents: string[] = [];
        const rows: NavProjectRow[] = [];
        tree.forEach(({ project, depth }, index) => {
          parents[depth] = project.path;
          if (hiddenBelow !== undefined && depth > hiddenBelow) return;
          hiddenBelow = undefined;
          const row = this.projectRow(children, project, `project:${project.path}`);
          row.style.setProperty("--tm-nav-depth", String(depth));
          const drawn: NavProjectRow = { path: project.path, depth, parent: depth ? parents[depth - 1] : "", row };
          rows.push(drawn);
          this.draggable(row, { kind: "project", drawn, rows, place: (dragged, drop) => this.placeProject(projects, tree.map(entry => entry.project.path), dragged, drop) }, `project:${project.path}`);
          if ((tree[index + 1]?.depth ?? 0) <= depth) return;
          const folded = this.foldedProjects.has(project.path);
          this.chevron(row, !folded, project.name, `collapse:project:${project.path}`, () => {
            if (folded) this.foldedProjects.delete(project.path); else this.foldedProjects.add(project.path);
          });
          if (folded) hiddenBelow = depth;
        });
        if (!projects.length) children.createDiv({ cls: "tm-nav-empty", text: "No projects yet" });
      } else {
        const tags = inOrder(this.plugin.index.tagSummaries(), this.settings.navOrder?.tags ?? [], tag => tag.name);
        for (const tag of tags) {
          const row = this.tagRow(children, tag, `tag:${tag.name}`);
          this.draggable(row, { kind: "tag", name: tag.name }, `tag:${tag.name}`);
        }
        if (!tags.length) children.createDiv({ cls: "tm-nav-empty", text: "No tags yet" });
      }
    }
    // The vault's files and folders, below everything else, as the file explorer lists them.
    if (this.settings.showFiles) {
      const group = nav.createDiv({ cls: "tree-item nav-folder tm-nav-group tm-nav-section tm-nav-files" });
      const root = this.app.vault.getRoot();
      const heading = this.item(group, "files", "Files", false, () => this.toggleSection("files"), { icon: "folder-tree", color: "section", expanded: this.expanded.has("files") });
      heading.addEventListener("contextmenu", event => this.openFileMenu(event, root));
      this.dropZone(heading, { kind: "root" });
      if (this.folder(heading, "files", "files")) {
        const children = group.createDiv({ cls: "tree-item-children nav-folder-children tm-nav-children" });
        this.filesChildren = children;
        this.renderFolder(children, root, 0, "files");
        if (!root.children.length) children.createDiv({ cls: "tm-nav-empty", text: "No files yet" });
      } else group.addClass("is-folded");
    }
    container.scrollTop = scrollTop;
    this.rebuilding = false;
    const rename = this.renaming ? container.querySelector<HTMLInputElement>("input.tm-nav-rename") : null;
    if (rename) {
      rename.focus({ preventScroll: true });
      if (!this.renaming?.selected) { rename.select(); if (this.renaming) this.renaming.selected = true; }
    } else {
      // A rename whose row is gone (folded away, or the file deleted) is over.
      this.renaming = undefined;
      if (focusKey) {
        const target = Array.from(container.querySelectorAll<HTMLElement>("[data-tm-nav-key]")).find(element => element.getAttribute("data-tm-nav-key") === focusKey);
        target?.focus({ preventScroll: true });
      }
    }
  }

  /** A row: an icon (its colour set by `color`), the name, and on the right an optional count. */
  private item(parent: HTMLElement, key: string, label: string, active: boolean, open: (event: MouseEvent) => unknown, options: NavItemOptions = {}): HTMLElement {
    const { icon, color, count, expanded } = options;
    const row = parent.createDiv({ cls: `tree-item-self nav-file-title tm-nav-item${active ? " is-active" : ""}${color ? ` is-${color}` : ""}` });
    if (icon) {
      const glyph = row.createDiv({ cls: "tm-nav-icon", attr: { "aria-hidden": "true" } });
      navIcon(glyph, icon);
    }
    const button = row.createEl("button", { cls: "tm-nav-label", text: label, attr: {
      "aria-current": active ? "page" : "false", title: label, "data-tm-nav-key": key, ...expanded === undefined ? {} : { "aria-expanded": String(expanded) }
    } });
    this.labels.push({ row, label: button, key });
    button.addEventListener("click", event => { void Promise.resolve(open(event)).catch(error => new Notice(String(error))); });
    if (count) row.createDiv({ cls: "tm-nav-count", text: String(count), attr: { "aria-label": `${count} open` } });
    return row;
  }

  private listActive(mode: TaskViewMode): boolean {
    return mode === this.activeMode && !this.activeTag && !this.activeProject && !this.activeSmartList;
  }

  /** A chevron on `row` that folds `section` away; true while it is open. */
  private folder(row: HTMLElement, section: NavSection, label: string): boolean {
    const expanded = this.expanded.has(section);
    this.chevron(row, expanded, label, `collapse:${section}`, () => {
      if (expanded) this.expanded.delete(section); else this.expanded.add(section);
    });
    return expanded;
  }

  /** Folds or unfolds a section from its heading. */
  private toggleSection(section: NavSection): void {
    if (this.expanded.has(section)) this.expanded.delete(section); else this.expanded.add(section);
    this.render();
  }

  /** A list's row (Inbox, Today, Upcoming, All Tasks, or Projects in Favorites), which tasks dragged to Inbox and Today drop on. */
  private listRow(parent: HTMLElement, mode: TaskViewMode, key: string): HTMLElement {
    const projects = mode === "projects";
    const entry = NAV_GROUPS.flat().find(item => item.mode === mode);
    const glyph = projects ? { icon: NAV_SECTIONS[0].icon, color: "muted" } : listGlyph(mode, this.settings.style)!;
    const count = entry?.count ? this.openCount(mode) : undefined;
    const row = this.item(parent, key, projects ? NAV_SECTIONS[0].label : entry?.label ?? mode, this.listActive(mode),
      event => this.plugin.openTaskView({ mode }, { newLeaf: Keymap.isModEvent(event) }), { ...glyph, count });
    if (mode === "inbox" || mode === "today") this.dropTarget(row, { kind: mode });
    row.addEventListener("contextmenu", event => this.openItemMenu(event, `mode:${mode}`));
    return row;
  }

  private smartListRow(parent: HTMLElement, id: string, key: string): HTMLElement | undefined {
    const list = this.settings.smartLists.find(item => item.id === id);
    if (!list) return undefined;
    const row = this.item(parent, key, list.name, this.activeSmartList === list.id,
      event => this.plugin.openTaskView({ mode: "smartLists", smartListId: list.id }, { newLeaf: Keymap.isModEvent(event) }), SMART_LIST_GLYPH);
    row.addEventListener("contextmenu", event => this.openItemMenu(event, `list:${list.id}`));
    return row;
  }

  /** A project's row: its progress pie where a list's icon is, tasks dropping on it, and its actions on a right-click. */
  private projectRow(parent: HTMLElement, project: Project, key: string): HTMLElement {
    const row = this.item(parent, key, project.name, this.activeProject === project.path,
      event => this.plugin.openProject(project.path, { keepTaskMode: true, newLeaf: Keymap.isModEvent(event) }));
    this.dropTarget(row, { kind: "project", path: project.path });
    // Its progress, as a pie in its colour, stands where a list's icon does.
    const icon = row.createDiv({ cls: "tm-nav-icon tm-nav-progress", attr: { "aria-hidden": "true" } });
    renderProjectProgress(icon, project, false);
    row.prepend(icon);
    row.addEventListener("contextmenu", event => {
      event.preventDefault();
      const label = row.querySelector<HTMLElement>(".tm-nav-label") ?? row;
      this.plugin.openProjectMenu(project.path, label, { x: event.clientX, y: event.clientY });
    });
    return row;
  }

  private tagRow(parent: HTMLElement, tag: { name: string; openTasks: number }, key: string): HTMLElement {
    const row = this.item(parent, key, tag.name, this.activeTag === tag.name,
      event => this.plugin.openTag(tag.name, { keepTaskMode: true, newLeaf: Keymap.isModEvent(event) }), { ...TAG_GLYPH, count: tag.openTasks });
    this.dropTarget(row, { kind: "tag", tag: tag.name });
    row.addEventListener("contextmenu", event => this.openItemMenu(event, `tag:${tag.name}`));
    return row;
  }

  /**
   * Favorites, at the top: any of the sidebar's lists, smart lists, projects, tags, files and folders, added from its
   * right-click menu or dragged in, in the order they were added or dragged into. Each works as it does in its own
   * section; a folder opens in place.
   */
  private renderFavorites(nav: HTMLElement): void {
    const group = nav.createDiv({ cls: "tree-item nav-folder tm-nav-group tm-nav-section tm-nav-favorites" });
    const heading = this.item(group, "favorites", "Favorites", false, () => this.toggleSection("favorites"), { icon: "star", color: "section", expanded: this.expanded.has("favorites") });
    // Anything dropped on the heading joins the end of Favorites.
    this.favoritesHeading = heading;
    this.dropZone(heading, { kind: "favorites" });
    if (!this.folder(heading, "favorites", "favorites")) { group.addClass("is-folded"); return; }
    const children = group.createDiv({ cls: "tree-item-children nav-folder-children tm-nav-children" });
    this.favoritesChildren = children;
    let shown = 0;
    // Looked up once, and only when a favourite needs them.
    let projects: Map<string, Project> | undefined;
    let tags: Map<string, { name: string; openTasks: number }> | undefined;
    const lookup = {
      project: (path: string) => (projects ??= new Map(this.projects().map(project => [project.path, project]))).get(path),
      tag: (name: string) => (tags ??= new Map(this.plugin.index.tagSummaries().map(tag => [tag.name, tag]))).get(name)
    };
    for (const key of this.settings.favorites ?? []) {
      const row = this.favoriteRow(children, key, lookup);
      if (!row) continue;
      shown++;
      this.draggable(row, { kind: "favorite", key }, key);
      // A favourite folder lists what is in it, as in the file tree.
      const folder = this.favoriteFolder(key);
      if (folder && this.openFolders.has(folder.path)) this.renderFolder(children, folder, 1, "favorites");
    }
    if (!shown) this.dropZone(children.createDiv({ cls: "tm-nav-empty", text: "Drag an item here, or right-click it" }), { kind: "favorites" });
  }

  /** Puts `keys` in Favorites, beside `target` (else at the end), taking them from where they were if already there. */
  private async addFavorites(keys: string[], target: string | undefined, after: boolean): Promise<void> {
    const favorites = this.settings.favorites.filter(key => !keys.includes(key));
    const at = target === undefined ? -1 : favorites.indexOf(target);
    favorites.splice(at < 0 ? favorites.length : at + (after ? 1 : 0), 0, ...keys);
    // So what was added shows.
    this.expanded.add("favorites");
    await this.saveOrder(() => { this.settings.favorites = favorites; });
  }

  private favoriteFolder(key: string): TFolder | undefined {
    if (!key.startsWith("folder:")) return undefined;
    const folder = this.app.vault.getAbstractFileByPath(key.slice("folder:".length));
    return folder instanceof TFolder ? folder : undefined;
  }

  /** A favourite's row, drawn as in its own section; none when what it names is gone (a tag no task has any more). */
  private favoriteRow(parent: HTMLElement, key: string, lookup: { project(path: string): Project | undefined; tag(name: string): { name: string; openTasks: number } | undefined }): HTMLElement | undefined {
    const colon = key.indexOf(":");
    const [kind, value] = [key.slice(0, colon), key.slice(colon + 1)];
    const navKey = `favorite:${key}`;
    if (kind === "mode") return NAV_MODES.has(value as TaskViewMode) && value !== "tags" ? this.listRow(parent, value as TaskViewMode, navKey) : undefined;
    if (kind === "list") return this.smartListRow(parent, value, navKey);
    if (kind === "tag") {
      const tag = lookup.tag(value);
      return tag && this.tagRow(parent, tag, navKey);
    }
    if (kind === "project") {
      const project = lookup.project(value);
      return project && this.projectRow(parent, project, navKey);
    }
    const file = this.app.vault.getAbstractFileByPath(value);
    if (kind === "file" && file instanceof TFile) return this.fileRow(parent, file, 0, "favorites", navKey);
    if (kind === "folder" && file instanceof TFolder && !file.isRoot()) return this.fileRow(parent, file, 0, "favorites", navKey);
    return undefined;
  }

  /** A list's, smart list's or tag's menu: adding it to Favorites, or taking it out. */
  private openItemMenu(event: MouseEvent, key: string): void {
    event.preventDefault();
    const menu = new Menu();
    this.favoriteMenuItem(menu, key);
    menu.showAtMouseEvent(event);
  }

  private favoriteMenuItem(menu: Menu, key: string): void {
    const favorite = this.plugin.isFavorite(key);
    menu.addItem(entry => entry.setSection("action").setTitle(favorite ? "Remove from favorites" : "Add to favorites").setIcon(favorite ? "star-off" : "star")
      .onClick(() => { void this.plugin.toggleFavorite(key).catch(error => new Notice(String(error))); }));
  }

  /** Saves an order changed by a drag (`change` writes it into the settings), and redraws the list in it. */
  private async saveOrder(change: () => void): Promise<void> {
    change();
    this.render();
    await this.plugin.saveSettings();
  }

  /** Lets `row` (which is `item`, and `favorite` in Favorites) be dragged; `native` rows are files (see fileDrag). */
  private draggable(row: HTMLElement, item: NavItem, favorite?: string, native = false): void {
    this.rowItems.set(row, { item, favorite });
    this.drag.bind(row, native);
  }

  /** Lets things dropped on `element` (a heading, an empty list's hint) go where `item` says. */
  private dropZone(element: HTMLElement, item: NavItem): void {
    this.rowItems.set(element, { item });
  }

  /** What a drag of `row` carries: what it is, the rows that go with it, and whether it can move from where it is. */
  private dragSource(row: HTMLElement): { item: NavDragItem; rows: HTMLElement[]; movable: boolean } | undefined {
    const info = this.rowItems.get(row);
    if (!info || info.item.kind === "favorites" || info.item.kind === "root") return undefined;
    if (info.item.kind === "file" && this.renaming?.path === info.item.file.path) return undefined;
    const label = row.querySelector(".tm-nav-label")?.textContent ?? "";
    const files = info.item.kind === "file" ? [info.item.file] : undefined;
    return { item: { item: info.item, favorite: info.favorite, files, label }, rows: this.blockOf(row), movable: info.item.kind !== "list" };
  }

  /**
   * A dragged project's or file's own place, where moving sideways still nests or outdents it: a project right under
   * the project above, or left out from under its parent; the last file of a folder left, out of the folder.
   */
  private dragHome(row: HTMLElement, source: NavDragItem, depth: number, x: number): NavIntent | undefined {
    const item = source.item;
    const own: NavIntent = { gap: { element: row, where: "before", depth }, moves: true };
    if (item?.kind === "project") {
      const block = this.projectBlock(item.rows, item.drawn);
      const others = item.rows.filter(entry => !block.includes(entry));
      const slot = item.rows.indexOf(item.drawn);
      const at = (to: number): NavIntent => this.projectSlot(others, item.drawn, slot, item.drawn.depth, to - x, item.place);
      return { ...own, sideways: to => ({ ...at(to), sideways: at }) };
    }
    if (item?.kind === "file") {
      const file = item.file;
      const next = this.rowAfter(row);
      const least = item.scope === "favorites" ? 1 : 0;
      const shallowest = Math.max(least, next ? Math.min(depthOf(next), depth) : least);
      const at = (to: number): NavIntent => {
        const dx = to - x;
        const target = Math.max(shallowest, depth - (dx <= -OUTDENT_PX ? Math.max(1, Math.floor(-dx / NEST_PX)) : 0));
        if (target === depth || !file.parent) return { ...own, sideways: at };
        // Out of its folder: after the folder (or the one it is in), in the folder that holds it.
        let anchor: TAbstractFile = file.parent;
        for (let level = depth - 1; level > target && anchor.parent; level--) anchor = anchor.parent;
        const placed = this.fileBeside(row, anchor, [file], true, target, { home: own } as NavDrag<NavDragItem>);
        return { ...placed, gap: { element: row, where: "after", depth: target }, sideways: at };
      };
      return { ...own, sideways: at };
    }
    return undefined;
  }

  /** `row` and the rows that go with it: those after it drawn deeper (subprojects, a folder's open contents). */
  private blockOf(row: HTMLElement): HTMLElement[] {
    const depth = depthOf(row);
    const rows = [row];
    for (let next = row.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.classList.contains("tm-drop-gap")) continue;
      if (!next.classList.contains("tm-nav-item") || depthOf(next) <= depth) break;
      rows.push(next as HTMLElement);
    }
    return rows;
  }

  /** The next row drawn after `row`'s block, if any, in the same list. */
  private rowAfter(row: HTMLElement): HTMLElement | undefined {
    const block = this.blockOf(row);
    for (let next = block[block.length - 1].nextElementSibling; next; next = next.nextElementSibling) {
      if (next.classList.contains("tm-drop-gap") || next.classList.contains("tm-drag-source")) continue;
      return next.classList.contains("tm-nav-item") ? next as HTMLElement : undefined;
    }
    return undefined;
  }

  /**
   * Whether a drop over `row` at `point` goes after it, by which half of it the pointer is in; once a side is
   * chosen, the other needs the pointer a little past the middle.
   */
  private afterHalf(row: HTMLElement, point: Point): boolean {
    const rect = this.drag.rect(row);
    const side = this.drag.current?.side;
    const shift = side?.row === row ? side.after ? -SIDE_HYSTERESIS_PX : SIDE_HYSTERESIS_PX : 0;
    return point.clientY >= rect.top + rect.height / 2 + shift;
  }

  /** A drop before or after `row` (after its block), at its depth, doing `commit(after)`. */
  private beside(row: HTMLElement, point: Point, moves: boolean, commit: (after: boolean) => Promise<void>, action?: string): NavIntent {
    const after = this.afterHalf(row, point);
    const block = this.blockOf(row);
    const gap: NavGap = after ? { element: block[block.length - 1], where: "after", depth: depthOf(row) } : { element: row, where: "before", depth: depthOf(row) };
    return { gap, moves, side: { row, after }, action, commit: () => commit(after) };
  }

  /**
   * What dropping what is dragged over `element` (a row, or Favorites' empty hint) at `point` does. Favourites move
   * among themselves; anything else with a place in Favorites is added to them; smart lists, tags and projects move
   * among their own; files and folders move in the file tree. Elsewhere it goes nowhere: back to its own place.
   */
  private resolveDrop(element: HTMLElement, point: Point, drag: NavDrag<NavDragItem>): NavIntent | undefined {
    const target = this.rowItems.get(element)?.item;
    const source = drag.item;
    const dragged = source.item;
    if (!target) return drag.home;
    const favorites = source.favorite ? [source.favorite]
      : (source.files ?? []).filter(file => !(file instanceof TFolder && file.isRoot())).map(file => `${file instanceof TFolder ? "folder" : "file"}:${file.path}`);
    switch (target.kind) {
      case "favorites": {
        if (!favorites.length) return drag.home;
        const end = this.favoritesChildren;
        const heading = element === this.favoritesHeading ? element : undefined;
        return {
          gap: end ? { element: end, where: "end", depth: 0 } : undefined, highlight: heading, moves: dragged?.kind === "favorite",
          action: "Add to favorites", commit: () => this.addFavorites(favorites, undefined, true)
        };
      }
      case "favorite":
        if (!favorites.length) return drag.home;
        return this.beside(element, point, dragged?.kind === "favorite", after => this.addFavorites(favorites, target.key, after), "Add to favorites");
      case "smartList":
        if (dragged?.kind !== "smartList") return drag.home;
        return this.beside(element, point, true, after => this.saveOrder(() => {
          const ids = moveKey(this.settings.smartLists.map(list => list.id), dragged.id, target.id, after);
          this.settings.smartLists = inOrder(this.settings.smartLists, ids, list => list.id);
        }));
      case "tag":
        if (dragged?.kind !== "tag") return drag.home;
        return this.beside(element, point, true, after => this.saveOrder(() => {
          const names = inOrder(this.plugin.index.tagSummaries(), this.settings.navOrder?.tags ?? [], tag => tag.name).map(tag => tag.name);
          this.settings.navOrder = { ...this.settings.navOrder, tags: moveKey(names, dragged.name, target.name, after) };
        }));
      case "project":
        if (dragged?.kind !== "project" || dragged.rows !== target.rows) return drag.home;
        return this.projectIntent(target.drawn, target.rows, dragged.drawn, point, drag.x, target.place);
      case "file":
        // A favourite dragged over a favourite folder's files stays where it was going.
        if (!source.files?.length) return dragged?.kind === "favorite" && target.scope === "favorites" ? undefined : drag.home;
        return this.fileIntent(element, target, source.files, point, drag);
      case "root": {
        const root = this.app.vault.getRoot();
        const moving = (source.files ?? []).filter(file => canMoveInto(file, root));
        if (!moving.length) return drag.home;
        return {
          gap: this.filesChildren ? { element: this.filesChildren, where: "start", depth: 0 } : undefined, highlight: element, moves: true,
          land: this.filesChildren ? "gap" : "hide", action: "Move into the vault", commit: () => this.whileMoving(() => this.moveInto(moving, root))
        };
      }
      default:
        return drag.home;
    }
  }

  /**
   * Where a dragged project goes over `target`, as a task does in a list: above or below it by the pointer's height,
   * at the depth of the projects there; moving right of where the drag began goes a level deeper per 24px, under the
   * project above, and moving left comes out a level per 24px (from 16px), as far as the top. Its subprojects go
   * with it, and not into themselves.
   */
  private projectIntent(target: NavProjectRow, rows: NavProjectRow[], dragged: NavProjectRow, point: Point, startX: number, place: (dragged: NavProjectRow, drop: ProjectDrop) => Promise<void>): NavIntent {
    const block = this.projectBlock(rows, dragged);
    const others = rows.filter(item => !block.includes(item));
    const after = this.afterHalf(target.row, point);
    const index = others.indexOf(target);
    const slot = after ? index + 1 : index;
    const below = others[slot];
    // Below a project with its subprojects open, it goes first among them.
    const natural = !after ? target.depth : below && below.depth > target.depth ? below.depth : target.depth;
    const at = (x: number): NavIntent => ({ ...this.projectSlot(others, dragged, slot, natural, x - startX, place), side: { row: target.row, after } });
    return { ...at(point.clientX), sideways: at };
  }

  /** `dragged` at `slot` among the `others` (after the one before it), `natural` levels deep but for moving `dx` sideways. */
  private projectSlot(others: NavProjectRow[], dragged: NavProjectRow, slot: number, natural: number, dx: number, place: (dragged: NavProjectRow, drop: ProjectDrop) => Promise<void>): NavIntent {
    const above = others[slot - 1];
    const shift = dx >= NEST_PX ? Math.floor(dx / NEST_PX) : dx <= -OUTDENT_PX ? -Math.max(1, Math.floor(-dx / NEST_PX)) : 0;
    const depth = Math.max(0, Math.min(natural + shift, above ? above.depth + 1 : 0));
    let drop: ProjectDrop;
    if (!above) drop = { depth: 0, parent: "" };
    else if (depth === above.depth + 1) drop = { depth, parent: above.path, after: above.path };
    else {
      // The project above, or the one it is under, at that depth: it follows that one, beside it.
      let index = slot - 1;
      while (index > 0 && others[index].depth > depth) index--;
      const beside = others[index];
      drop = { depth, parent: beside.parent, after: beside.path };
    }
    const gap: NavGap = above ? { element: above.row, where: "after", depth } : { element: others[0]?.row ?? dragged.row, where: "before", depth };
    return { gap, moves: true, commit: () => place(dragged, drop) };
  }

  /** `project`'s row and the rows of its subprojects below it, which drag along with it. */
  private projectBlock(rows: NavProjectRow[], project: NavProjectRow): NavProjectRow[] {
    const start = rows.indexOf(project);
    let end = start + 1;
    while (end < rows.length && rows[end].depth > project.depth) end++;
    return rows.slice(start, end);
  }

  /**
   * Puts a dragged project (with its subprojects) where `drop` says: after `drop.after` in the sidebar's order (first
   * when none), and under `drop.parent`, writing its parent when that changed.
   */
  private async placeProject(projects: Project[], order: string[], dragged: NavProjectRow, drop: ProjectDrop): Promise<void> {
    const paths = order.filter(path => path !== dragged.path);
    paths.splice(drop.after ? paths.indexOf(drop.after) + 1 : 0, 0, dragged.path);
    const reparented = drop.parent === dragged.parent ? projects
      : projects.map(project => project.path === dragged.path ? { ...project, parentPath: drop.parent || undefined } : project);
    // Kept as the tree then reads, parents before their subprojects.
    const next = projectHierarchy(reparented, paths).map(entry => entry.project.path);
    const previous = this.settings.navOrder;
    if (drop.parent === dragged.parent && next.join("\n") === order.join("\n")) return;
    this.settings.navOrder = { ...previous, projects: next };
    if (drop.parent !== dragged.parent) {
      try {
        await this.plugin.updateProject(dragged.path, draft => ({ ...draft, parent: drop.parent }));
        // Its new parent is read from the index again.
        this.forgetIndex();
      }
      catch (cause) {
        this.settings.navOrder = previous;
        this.render();
        new Notice(cause instanceof Error ? cause.message : "Could not move the project.");
        return;
      }
    }
    this.render();
    await this.plugin.saveSettings();
  }

  /** A native drag (a file dragged with Option, or from the file explorer) is over: its gap goes, and a waiting redraw happens. */
  private endNativeDrag(): void {
    this.nativeDrag = false;
    this.dragOver = false;
    this.drag.leaveExternal();
    this.resumeRender();
  }

  /**
   * Lets tasks dragged in a task view drop on `row`. A list's drag follows the pointer and finds the row by its mark;
   * a calendar card drags natively, and the row takes that drop here.
   */
  private dropTarget(row: HTMLElement, drop: SidebarDrop): void {
    markDropTarget(row, drop);
    const dragging = (event: DragEvent): boolean => Boolean(activeTaskDrag() && event.dataTransfer?.types.includes(TASK_DRAG_TYPE));
    row.addEventListener("dragover", event => {
      if (!dragging(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      highlightDropTarget(row, true);
    });
    row.addEventListener("dragleave", event => { if (!row.contains(event.relatedTarget as Node | null)) highlightDropTarget(row, false); });
    row.addEventListener("drop", event => {
      highlightDropTarget(row, false);
      const drag = activeTaskDrag();
      if (!drag || !dragging(event)) return;
      event.preventDefault();
      void drag.drop(drop);
    });
  }

  /** A chevron at the end of `row` that folds what is under it; `toggle` flips it, and the list is redrawn. */
  private chevron(row: HTMLElement, open: boolean, label: string, key: string, toggle: () => void): void {
    const collapse = row.createEl("button", { cls: "clickable-icon tm-nav-collapse", attr: {
      "aria-label": `${open ? "Collapse" : "Expand"} ${label}`, "aria-expanded": String(open), "data-tm-nav-key": key
    } });
    navIcon(collapse, open ? "chevron-down" : "chevron-right");
    collapse.addEventListener("click", () => { toggle(); this.render(); });
  }

  /** Redraws the file tree as files come and go, and as another file opens. */
  private watchFiles(): void {
    if (this.fileEvents) return;
    this.fileEvents = true;
    const changed = (): void => this.scheduleSettledRender();
    this.registerEvent(this.app.vault.on("create", changed));
    this.registerEvent(this.app.vault.on("delete", changed));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      // An open folder stays open under its new name, as do the folders inside it.
      if (file instanceof TFolder) {
        for (const path of [...this.openFolders]) {
          if (path !== oldPath && !path.startsWith(`${oldPath}/`)) continue;
          this.openFolders.delete(path);
          this.openFolders.add(file.path + path.slice(oldPath.length));
        }
        this.app.workspace.requestSaveLayout();
      }
      changed();
    }));
    // The open file is marked where its row is, without drawing the list again.
    this.registerEvent(this.app.workspace.on("file-open", () => this.markActiveFile()));
  }

  /** `folder`'s children in the file tree's order: dragged into place, when they were, else by the chosen order. */
  private folderChildren(folder: TFolder): TAbstractFile[] {
    const custom = this.settings.customFileOrder ? this.settings.navOrder?.files[folder.path] ?? [] : [];
    return sortFiles(folder.children, this.settings.fileSortOrder, custom);
  }

  /** Lists `folder`'s children in the file tree's order, and the children of those left open, a step further in. */
  private renderFolder(parent: HTMLElement, folder: TFolder, depth: number, scope: FileScope): void {
    for (const child of this.folderChildren(folder)) {
      if (!(child instanceof TFolder) && !(child instanceof TFile)) continue;
      this.fileRow(parent, child, depth, scope, `${child instanceof TFolder ? "folder" : "file"}:${child.path}`);
      if (child instanceof TFolder && this.openFolders.has(child.path)) this.renderFolder(parent, child, depth + 1, scope);
    }
  }

  /**
   * A file's or folder's row, as the file explorer draws it: a folder opens in place from its name or chevron, a file
   * opens (in a new tab with the modifier). In the file tree it drags as the file explorer's do, and files dropped on
   * it go into the folder or beside it; in Favorites it drags among the favourites.
   */
  private fileRow(parent: HTMLElement, file: TFile | TFolder, depth: number, scope: FileScope, key: string): HTMLElement {
    const isFolder = file instanceof TFolder;
    const open = isFolder && this.openFolders.has(file.path);
    const toggle = (): void => {
      if (open) this.openFolders.delete(file.path); else this.openFolders.add(file.path);
      this.app.workspace.requestSaveLayout();
    };
    const row = file instanceof TFolder
      ? this.item(parent, key, file.name, false, () => { toggle(); this.render(); }, { icon: open ? "folder-open" : "folder", color: "muted", expanded: open })
      : this.item(parent, key, file.basename, file.path === this.activeFile,
        event => leafFor(this.app, Keymap.isModEvent(event)).openFile(file), { icon: FILE_ICONS[file.extension.toLowerCase()] ?? "file", color: "muted" });
    row.addClass(isFolder ? "tm-nav-folder" : "tm-nav-file");
    row.style.setProperty("--tm-nav-depth", String(depth));
    row.addEventListener("contextmenu", event => this.openFileMenu(event, file, scope));
    // A favourite itself drags among the favourites (see renderFavorites); what is in a favourite folder drags as in the
    // file tree, and with Option held, natively, as the file explorer's files do.
    if (!key.startsWith("favorite:")) {
      this.draggable(row, { kind: "file", file, depth, scope }, `${isFolder ? "folder" : "file"}:${file.path}`, Boolean(this.dragManager));
      this.fileDrag(row, file);
    }
    if (file instanceof TFile && file.extension === "md") this.dropTarget(row, { kind: "note", path: file.path });
    // Notes show their name alone; other files add their kind, as the file explorer does.
    if (file instanceof TFile && file.extension !== "md") row.createDiv({ cls: "nav-file-tag tm-nav-file-tag", text: file.extension });
    if (this.renaming?.path === file.path && this.renaming.scope === scope) this.renameField(row, file);
    if (file instanceof TFolder && file.children.length) this.chevron(row, open, file.name, `collapse:${key}`, toggle);
    return row;
  }

  /** The file explorer's menu for `file`: opening it, adding it to Favorites, making notes and folders in a folder,
   * renaming and deleting, and what Obsidian and other plugins add to a file's menu. */
  private openFileMenu(event: MouseEvent, file: TAbstractFile, scope: FileScope = "files"): void {
    event.preventDefault();
    const menu = new Menu();
    const run = (action: () => unknown): void => { void Promise.resolve().then(action).catch(error => new Notice(String(error))); };
    if (file instanceof TFile) {
      menu.addItem(entry => entry.setSection("open").setTitle("Open in new tab").setIcon("file-plus").onClick(() => run(() => this.app.workspace.getLeaf("tab").openFile(file))));
      menu.addItem(entry => entry.setSection("open").setTitle("Open to the right").setIcon("separator-vertical").onClick(() => run(() => this.app.workspace.getLeaf("split").openFile(file))));
    } else if (file instanceof TFolder) {
      menu.addItem(entry => entry.setSection("action-primary").setTitle("New note").setIcon("square-pen").onClick(() => run(() => this.newNote(file))));
      menu.addItem(entry => entry.setSection("action-primary").setTitle("New folder").setIcon("folder-plus").onClick(() => run(() => this.newFolder(file))));
    }
    if (!(file instanceof TFolder && file.isRoot())) {
      this.favoriteMenuItem(menu, `${file instanceof TFolder ? "folder" : "file"}:${file.path}`);
      menu.addItem(entry => entry.setSection("action").setTitle("Rename…").setIcon("pencil").onClick(() => {
        this.renaming = { path: file.path, value: file instanceof TFile ? file.basename : file.name, selected: false, scope };
        this.render();
      }));
      menu.addItem(entry => entry.setSection("danger").setTitle("Delete").setIcon("trash-2").setWarning(true)
        .onClick(() => run(() => this.app.fileManager.promptForDeletion(file))));
    }
    this.app.workspace.trigger("file-menu", menu, file, "file-explorer-context-menu", this.leaf);
    menu.showAtMouseEvent(event);
  }

  /** Makes an untitled note, in `folder` or where Obsidian puts new notes, and opens it with its title ready to type. */
  private async newNote(folder?: TFolder): Promise<void> {
    const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
    const note = await this.app.vault.create(this.availablePath(parent, "Untitled", ".md"), "");
    if (this.settings.showFiles) this.showFolder(parent);
    await leafFor(this.app, false).openFile(note, { active: true, state: { mode: "source" }, eState: { rename: "all" } });
  }

  /** Makes an untitled folder in `folder` and names it in place. */
  private async newFolder(folder: TFolder): Promise<void> {
    const created = await this.app.vault.createFolder(this.availablePath(folder, "Untitled", ""));
    this.showFolder(folder);
    this.renaming = { path: created.path, value: created.name, selected: false, scope: "files" };
    this.render();
  }

  /** The file tree's orders, as the file explorer offers them, and the order its files were dragged into; the one in use checked. */
  private openSortMenu(button: HTMLElement): void {
    const menu = new Menu();
    const choose = async (change: () => void): Promise<void> => {
      change();
      await this.plugin.saveSettings();
      this.render();
    };
    for (const [order, title, section] of FILE_SORT_ORDERS) {
      menu.addItem(entry => entry.setSection(section).setTitle(title).setChecked(!this.settings.customFileOrder && this.settings.fileSortOrder === order)
        .onClick(() => choose(() => { this.settings.fileSortOrder = order; this.settings.customFileOrder = false; })));
    }
    menu.addItem(entry => entry.setSection("custom").setTitle("Custom order").setChecked(this.settings.customFileOrder)
      .onClick(() => choose(() => { this.settings.customFileOrder = true; })));
    const rect = button.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  private get dragManager(): DragManager | undefined {
    const manager = (this.app as unknown as { dragManager?: Partial<DragManager> } | undefined)?.dragManager;
    return manager && typeof manager.handleDrag === "function" && typeof manager.handleDrop === "function" ? manager as DragManager : undefined;
  }

  /**
   * Lets `file` be dragged natively, as the file explorer's files are, while Option (Alt) is held: into a note as a
   * link, onto a tab to open it, into Canvas or into a folder. Without it, the row drags as the sidebar's others do.
   */
  private fileDrag(row: HTMLElement, file: TAbstractFile): void {
    const manager = this.dragManager;
    if (!manager || this.renaming?.path === file.path) return;
    manager.handleDrag(row, event => file instanceof TFile ? manager.dragFile(event, file, "tm-files")
      : file instanceof TFolder ? manager.dragFolder(event, file, "tm-files") : null);
    // The list stays as it is until the drag ends, wherever it goes: redrawn, the row dragged would be gone.
    row.addEventListener("dragstart", () => {
      this.pressed = false;
      this.nativeDrag = true;
    });
  }

  /**
   * Lets files and folders dragged natively (from the file explorer, or from here with Option held) drop anywhere in
   * the list: the gap opens where they would land, as for the sidebar's own rows, and the rows already here move there.
   */
  private externalDrop(nav: HTMLElement): void {
    this.dragManager?.handleDrop(nav, (event, draggable, hovering) => {
      const files = draggedFiles(draggable);
      if (!files.length) return undefined;
      const point = { clientX: event.clientX, clientY: event.clientY };
      const item: NavDragItem = { files, label: files.length > 1 ? `${files.length} files` : files[0].name };
      if (hovering) {
        const intent = this.drag.hoverExternal(point, item, this.rowHeight());
        return intent ? { action: intent.action ?? "", dropEffect: "move", hoverEl: nav, hoverClass: "tm-nav-external-drop" } : { action: "", dropEffect: "none" };
      }
      const intent = this.drag.dropExternal(files.map(file => this.treeRows(file)).filter(rows => rows.length));
      if (!intent?.commit) return { action: "", dropEffect: "none" };
      void intent.commit();
      return { action: intent.action ?? "", dropEffect: "move" };
    });
  }

  /** How tall a row is, for the gap a drag from elsewhere opens. */
  private rowHeight(): number {
    const row = this.listEl?.querySelector<HTMLElement>(".tm-nav-item");
    return row?.getBoundingClientRect().height || 28;
  }

  /** `file`'s row in the file tree, and the rows of what is open in it; none when it is not drawn. */
  private treeRows(file: TAbstractFile): HTMLElement[] {
    const key = `${file instanceof TFolder ? "folder" : "file"}:${file.path}`;
    const label = this.filesChildren?.querySelector<HTMLElement>(`[data-tm-nav-key="${CSS.escape(key)}"]`);
    const row = label?.closest<HTMLElement>(".tm-nav-item");
    return row ? this.blockOf(row) : [];
  }

  /**
   * Where files dragged over `element`, a file's or folder's row (`target`), go. Over a folder's middle, into it (the
   * gap opening under it, a level in, and a closed folder opening after a moment); over a row's top or bottom, before
   * or after it in its folder. After the last row of an open folder, moving left takes them out a level at a time.
   */
  private fileIntent(element: HTMLElement, target: Extract<NavItem, { kind: "file" }>, files: Array<TFile | TFolder>, point: Point, drag: NavDrag<NavDragItem>): NavIntent {
    const file = target.file;
    const folder = file instanceof TFolder ? file : undefined;
    const open = Boolean(folder && this.openFolders.has(folder.path));
    const rect = this.drag.rect(element);
    const y = point.clientY - rect.top;
    const into = folder && rect.height > 0 && y >= rect.height / 4 && (open || y <= rect.height * 3 / 4);
    if (folder && into) {
      const moving = files.filter(item => canMoveInto(item, folder));
      if (!moving.length) return drag.home;
      return {
        gap: { element, where: "after", depth: target.depth + 1 }, highlight: element, moves: true, land: open ? "gap" : "hide",
        action: `Move into ${folder.name}`, spring: open ? undefined : () => this.springOpen(element, folder, target.depth, target.scope),
        commit: () => this.whileMoving(() => this.moveInto(moving, folder))
      };
    }
    const after = folder ? y > rect.height / 2 : this.afterHalf(element, point);
    if (!after) return this.fileBeside(element, file, files, false, target.depth, drag);
    // After it, as deep as it is, or (after the last of a folder's rows) as far out as the row below, moving left.
    const next = this.rowAfter(element);
    const least = target.scope === "favorites" ? 1 : 0;
    const shallowest = Math.max(least, next ? Math.min(depthOf(next), target.depth) : least);
    const at = (x: number): NavIntent => {
      const dx = x - drag.x;
      const depth = Math.max(shallowest, target.depth - (dx <= -OUTDENT_PX ? Math.max(1, Math.floor(-dx / NEST_PX)) : 0));
      let anchor: TAbstractFile = file;
      for (let level = target.depth; level > depth && anchor.parent; level--) anchor = anchor.parent;
      return { ...this.fileBeside(element, anchor, files, true, depth, drag), side: { row: element, after: true } };
    };
    return { ...at(point.clientX), sideways: at };
  }

  /** Files placed just before or after `anchor` in its folder, the gap beside `row` at `depth`. */
  private fileBeside(row: HTMLElement, anchor: TAbstractFile, files: Array<TFile | TFolder>, after: boolean, depth: number, drag: NavDrag<NavDragItem>): NavIntent {
    const destination = anchor.parent;
    const moving = destination ? files.filter(item => item !== anchor && (item.parent === destination || canMoveInto(item, destination))) : [];
    if (!destination || !moving.length) return drag.home;
    const into = `Move into ${destination.isRoot() ? "the vault" : destination.name}`;
    return {
      gap: after ? { element: row, where: "after", depth } : { element: row, where: "before", depth }, moves: true, side: { row, after },
      action: moving.every(item => item.parent === destination) ? "Move here" : into,
      commit: () => this.whileMoving(() => this.placeFiles(moving, anchor, after))
    };
  }

  /**
   * Opens `folder` (its row `row`, `depth` deep) mid-drag, as the file explorer does when a file rests on it: its rows
   * are drawn under it (after the gap, which stays where it is), and the list is drawn again once the drag ends.
   */
  private springOpen(row: HTMLElement, folder: TFolder, depth: number, scope: FileScope): void {
    if (this.openFolders.has(folder.path)) return;
    this.openFolders.add(folder.path);
    this.app.workspace.requestSaveLayout();
    const holder = createDiv();
    this.renderFolder(holder, folder, depth + 1, scope);
    const gap = row.nextElementSibling?.classList.contains("tm-drop-gap") ? row.nextElementSibling : row;
    gap.after(...Array.from(holder.children));
    const glyph = row.querySelector<HTMLElement>(".tm-nav-icon");
    if (glyph) navIcon(glyph, "folder-open");
    row.querySelector(".tm-nav-label")?.setAttribute("aria-expanded", "true");
    const chevron = row.querySelector<HTMLElement>(".tm-nav-collapse");
    if (chevron) {
      navIcon(chevron, "chevron-down");
      chevron.setAttribute("aria-expanded", "true");
      chevron.setAttribute("aria-label", `Collapse ${folder.name}`);
    }
    this.pendingRender = true;
  }

  /**
   * Files let go outside the sidebar: onto a note, a link to each where they are let go (an embed for other files), as
   * the file explorer drops them; onto a folder in the file explorer (or a file in it), into that folder.
   */
  private dropOutside(point: Point, item: NavDragItem): boolean {
    const files = item.files ?? [];
    if (!files.length) return false;
    const element = this.containerEl.ownerDocument.elementFromPoint(point.clientX, point.clientY);
    if (!element) return false;
    const editor = element.closest<HTMLElement>(".cm-editor");
    if (editor) {
      const view = EditorView.findFromDOM(editor);
      const notes = files.filter((file): file is TFile => file instanceof TFile);
      if (!view || !notes.length) return false;
      const host = this.app.workspace.getLeavesOfType("markdown").map(leaf => leaf.view as unknown as { containerEl?: HTMLElement; file?: TFile | null })
        .find(markdown => markdown.containerEl?.contains(editor));
      const source = host?.file?.path ?? "";
      const text = notes.map(file => `${file.extension === "md" ? "" : "!"}${this.app.fileManager.generateMarkdownLink(file, source)}`).join(" ");
      const at = view.posAtCoords({ x: point.clientX, y: point.clientY }) ?? view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length } });
      view.focus();
      return true;
    }
    const entry = element.closest<HTMLElement>(".nav-folder-title[data-path], .nav-file-title[data-path]");
    if (!entry || this.containerEl.contains(entry)) return false;
    const found = this.app.vault.getAbstractFileByPath(entry.getAttribute("data-path") ?? "");
    const folder = found instanceof TFolder ? found : found?.parent;
    const moving = folder ? files.filter(file => canMoveInto(file, folder)) : [];
    if (!folder || !moving.length) return false;
    void this.whileMoving(() => this.moveInto(moving, folder));
    return true;
  }

  /**
   * Runs a drop's file moves with the list held as it is, then redraws it once. Each move, the orders and favourites
   * that follow it, and each note whose links Obsidian then updates would otherwise redraw it, over and over.
   */
  private async whileMoving(moves: () => Promise<unknown>): Promise<void> {
    this.moving++;
    try { await moves(); }
    catch (error) { new Notice(String(error)); }
    finally {
      this.moving--;
      this.pendingRender = true;
      // The rows already show where the files went; the list is drawn again once the index and the vault, busy
      // with the notes whose links Obsidian rewrites, have paused.
      if (!this.moving) {
        this.burstUntil = Date.now() + BURST_MAX_MS;
        this.scheduleSettledRender();
      }
    }
  }

  /** Moves files and folders into `folder`, keeping their names; a name already taken there stays put. Returns those moved. */
  private async moveInto(files: TAbstractFile[], folder: TFolder): Promise<TAbstractFile[]> {
    const moved: TAbstractFile[] = [];
    for (const file of files) {
      const path = `${folder.isRoot() ? "" : `${folder.path}/`}${file.name}`;
      if (this.app.vault.getAbstractFileByPath(path)) { new Notice(`“${file.name}” already exists in ${folder.isRoot() ? "the vault" : folder.name}`); continue; }
      try { await this.app.fileManager.renameFile(file, path); moved.push(file); }
      catch (error) { new Notice(String(error)); }
    }
    this.showFolder(folder);
    return moved;
  }

  /**
   * Puts files just before or after `target`, moving those from elsewhere into its folder first; the folder keeps that
   * order (and the tree follows the dragged order from then on).
   */
  private async placeFiles(files: TAbstractFile[], target: TAbstractFile, after: boolean): Promise<void> {
    const folder = target.parent;
    if (!folder) return;
    const here = files.filter(file => file.parent === folder);
    const moved = await this.moveInto(files.filter(file => file.parent !== folder), folder);
    const placed = [...here, ...moved].map(file => file.name);
    if (!placed.length) return;
    const names = this.folderChildren(folder).map(file => file.name).filter(name => !placed.includes(name));
    const at = names.indexOf(target.name);
    names.splice(at < 0 ? names.length : at + (after ? 1 : 0), 0, ...placed);
    const order = this.settings.navOrder ?? { projects: [], tags: [], files: {} };
    await this.saveOrder(() => {
      this.settings.navOrder = { ...order, files: { ...order.files, [folder.path]: names } };
      this.settings.customFileOrder = true;
    });
  }

  /** Opens `folder` and the folders around it, so what was just made in it shows. */
  private showFolder(folder: TFolder | null): void {
    for (; folder && !folder.isRoot(); folder = folder.parent) this.openFolders.add(folder.path);
    this.expanded.add("files");
    this.app.workspace.requestSaveLayout();
  }

  /** `name` in `folder`, numbered as the file explorer numbers new files when the name is taken. */
  private availablePath(folder: TFolder, name: string, extension: string): string {
    const base = folder.isRoot() ? "" : `${folder.path}/`;
    for (let n = 0; ; n++) {
      const path = `${base}${name}${n ? ` ${n}` : ""}${extension}`;
      if (!this.app.vault.getAbstractFileByPath(path)) return path;
    }
  }

  /** Puts a field for the new name in place of `file`'s name: Enter or leaving it renames, Escape keeps the name. */
  private renameField(row: HTMLElement, file: TAbstractFile): void {
    const state = this.renaming;
    const label = row.querySelector(".tm-nav-label");
    if (!state || !label) return;
    const input = createEl("input", { cls: "tm-nav-rename", attr: { type: "text", "aria-label": `Rename ${file.name}`, spellcheck: "false" } });
    input.value = state.value;
    label.replaceWith(input);
    let done = false;
    const finish = (save: boolean): void => {
      if (done) return;
      done = true;
      this.renaming = undefined;
      const name = input.value.trim();
      const current = file instanceof TFile ? file.basename : file.name;
      if (save && name && name !== current) {
        const parent = file.parent;
        const path = `${parent && !parent.isRoot() ? `${parent.path}/` : ""}${name}${file instanceof TFile ? `.${file.extension}` : ""}`;
        if (/[\\/:]/.test(name)) new Notice("File names can't contain \\, / or :");
        else if (this.app.vault.getAbstractFileByPath(path)) new Notice(`“${name}” already exists`);
        else void this.app.fileManager.renameFile(file, path).catch(error => new Notice(String(error)));
      }
      this.render();
    };
    input.addEventListener("input", () => { state.value = input.value; });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => { if (!this.rebuilding) finish(true); });
  }
}
