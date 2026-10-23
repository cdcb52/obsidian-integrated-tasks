import { ItemView, Notice, Platform, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import type TaskManagerPlugin from "./main";
import { NEW_TASK_ID, TaskMainView, tasksOpenInSidebar } from "./task-view";
import { noteGroupName, splitDestination } from "./structure";
import { renderCalendar } from "./calendar-view";
import { ListDragController } from "./list-drag-view";
import { activeTaskDrag, markDropZone, onTaskDrag, startTaskDrag, TASK_DRAG_TYPE, type SidebarDrop, type TaskDrag } from "./sidebar-drop";
import { NEW_TASK_TITLE } from "./task-title";
import { renderThingsTaskDetails, thingsDeadlineLabel } from "./things-row-details";
import { calendarDate, rescheduledDraft } from "./calendar";
import { actionDate, formatDate, todayIso } from "./date";
import { parseTaskInput, repeatLabel } from "./parser";
import { groupTasks, sortTasks } from "./query";
import { isRepeatingTask } from "./recurring-task";
import { draftFromTask, draftFromTitle, draftMatchesTask } from "./task-draft";
import type { TaskEditorProperty } from "./task-editor";
import { taskInputRanges } from "./task-input";
import { deadlineIsDistant, deadlineIsOverdue, editable, renderTaskDetails, taskDeadlineCountdown, taskTimeDurationLabel, taskTimeLabel } from "./task-row-details";
import { STATUS_ICONS, STATUS_LABELS, TASK_STATUSES, checkboxLabel, statusClass } from "./task-status";
import { PRIORITY_NAMES, cardNotes, longDate, paintTokens, repeatIcon, type TaskCardDraft } from "./things-task-card";
import { NoteTaskHost } from "./note-task-host";
import { createTaskRow, dropEmptyRowParts } from "./task-row";
import type { OpenEditorState } from "./main";
import { groupingLabel, ViewOptionsPanel, type ViewOptionsState } from "./view-options";
import { dismissPopovers, openChoicePopover } from "./choice-popover";
import { cloneTaskFilters, UNDATED_FILTERS } from "./task-filters";
import { listGlyph, navIcon, SMART_LIST_GLYPH, TAG_GLYPH } from "./navigation-view";
import { activeProjects, renderProjectProgress } from "./project-progress";
import { openProjectDraftProperty } from "./project-menu";
import { projectColorValue } from "./project-properties";
import type { ProjectDraft } from "./project-creator";
import type { Project, SavedViewOptions, Task, TaskEditorPreset, TaskFilter, TaskGrouping, TaskQuery, TaskSort, TaskStatus } from "./types";

export const TASK_SIDEBAR_VIEW = "task-manager-sidebar";

/** What the details edit through: the task view in front, or beside a note, the note's (see NoteTaskHost). */
/** A task's line and title, as last seen. */
type TaskSource = { raw: string; title: string };
type DetailsHost = Pick<TaskMainView, "editTaskProperty" | "setTaskStatus" | "changeTask" | "newTaskInSidebar" | "typeNewTask" | "finishNewTask" | "getSelectedTasks" | "clearSelection" | "sidebarSelection">;
/** A property the sidebar edits through the task view showing the task (see TaskMainView.editTaskProperty). */
type SidebarProperty = TaskEditorProperty | "status" | "project";

const noteName = (path: string): string => path.replace(/\.md$/i, "").split("/").pop() ?? path;
const isTextField = (element: Element | null): element is HTMLInputElement | HTMLTextAreaElement =>
  element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && element.type === "text");

function autosize(area: HTMLTextAreaElement): void {
  area.setCssStyles({ height: "auto" });
  area.setCssStyles({ height: `${area.scrollHeight}px` });
}

/**
 * A project being created here (three panes; see TaskSidebarView.startNewProject): its properties so far; `version`
 * counts the choices that redraw it (not typing), and `error` is why it could not be created.
 */
interface NewProject { draft: ProjectDraft; version: number; error: string; creating: boolean }
const NEW_PROJECT_ID = "new-project";

/** One part of the sidebar, redrawn only when what it shows changes, so typing in one is not disturbed by the other. */
interface Section { element: HTMLElement; drawn?: string }

/** A list's tasks show in pages, so a large vault does not build every row at once. */
const LIST_PAGE = 100;

/**
 * What the sidebar lists while no task is shown (see TaskManagerSettings.sidebarIdleView): a view's tasks or a smart
 * list's, grouped by default as the view groups them ("today": overdue, then today). `filters`: its View options' own
 * until changed there; `pinned` ones stay whatever they say (Smart Context's note). `calendar` shows today's calendar
 * instead, `undated` takes the dates off tasks dropped on it, and `empty` is its icon and heading while it has no tasks.
 */
interface IdleView {
  key: string; label: string; query: TaskQuery; sort: TaskSort; descending: boolean; group: Exclude<TaskGrouping, "default"> | "today";
  filters?: readonly TaskFilter[]; pinned?: readonly TaskFilter[]; calendar?: boolean; undated?: boolean; empty?: readonly [string, string];
}
const IDLE_VIEWS = [["inbox", "Inbox"], ["today", "Today"], ["upcoming", "Upcoming"], ["all", "All Tasks"]] as const;
/** Smart Context (see TaskSidebarView.contextView): All Tasks, its View options set for the view or note in front. */
export const SMART_CONTEXT = "context";
const sameFilter = (a: TaskFilter, b: TaskFilter): boolean =>
  a.property === b.property && a.operator === b.operator && JSON.stringify(a.values) === JSON.stringify(b.values);

/**
 * The Task Details sidebar (in the right sidebar by default). While no task is shown it lists what its name picks (see
 * idleView): Smart Context by default, which follows the view or note in front (Today's calendar beside Today, All Tasks
 * without a date beside Upcoming…). A task selected there or in the view takes its place with its details, editable in
 * place. Tasks drag between it and the view: onto an hour to schedule them then, from the tasks without a date onto a day.
 */
export class TaskSidebarView extends ItemView {
  /** The list shown (and the note Smart Context follows), to start afresh when it changes. */
  private context?: string;
  /** The shown task's title and notes as typed (and a subtask being typed); `dirty` until they are saved. */
  /** `source`: the task's line and title when the draft began (or was last saved), to find it by if its line moves. */
  private draft?: { id: string; dirty: boolean; source?: TaskSource } & TaskCardDraft;
  /** Saves and writes, one after another, so each sees the task as the last one left it. */
  private saving: Promise<void> = Promise.resolve();
  /** The layout drawn (list, style, density) and its parts: the list (or today's calendar), then the details in its place. */
  private skeleton = "";
  private planner?: Section;
  private details?: Section;
  /** Above the list, staying put as it redraws: its name (a button that picks it) and its View options. */
  private plannerHead?: HTMLElement;
  private idlePanel?: ViewOptionsPanel;
  private idleOptionsOpen = false;
  /**
   * A task selected here (in the day or the list), or shown here by the view (one it does not list), shown in the
   * details until the view's selection changes.
   */
  private localId?: string;
  /** The view's selection as last seen, to tell when it changes. */
  private viewSelection = "";
  /** The task the details show, or "selection" for several tasks, if any (Escape, or the close button, takes them away). */
  private shownId?: string;
  /** A project being created, which has the sidebar to itself until it is created or dropped. */
  private newProject?: NewProject;
  /** A drag of tasks in progress somewhere: Today's hours or the tasks without a date come back for it. */
  private dragging = false;
  private stopDragWatch?: () => void;
  private listRows = LIST_PAGE;
  private listDrag?: ListDragController;
  private indexVersion = 0;
  private renderFrame?: number;
  private closed = false;
  private unsubscribe?: () => void;
  /** Beside a note: its tasks, the ones its caret is on, and a new task started there. */
  private readonly note: NoteTaskHost;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: TaskManagerPlugin) {
    super(leaf);
    this.navigation = false;
    this.note = new NoteTaskHost(plugin, this.app, () => this.scheduleRender(), task => { this.localId = task.id; this.render(); });
  }

  getViewType(): string { return TASK_SIDEBAR_VIEW; }
  getDisplayText(): string { return "Task details"; }
  getIcon(): string { return "circle-check-big"; }

  async onOpen(): Promise<void> {
    this.unsubscribe = this.plugin.index.subscribe(() => { this.indexVersion++; this.scheduleRender(); });
    // A drag shows the list (or today's hours) at once, to drop on; it gives way to the task shown again once it ends,
    // after the drop has read it.
    this.stopDragWatch = onTaskDrag(drag => {
      this.dragging = Boolean(drag);
      if (drag) this.render(); else this.scheduleRender();
    });
    // A click where nothing takes focus (between the properties, say) focuses the sidebar, so its keys still work there.
    this.content.tabIndex = -1;
    // Escape takes the task shown away (see closeDetails).
    this.registerDomEvent(this.content, "keydown", event => {
      if (event.key !== "Escape" || !this.shownId) return;
      event.preventDefault();
      this.closeDetails();
    });
    // A click outside the list's View options closes them.
    this.registerDomEvent(this.content.ownerDocument, "pointerdown", event => this.idlePanel?.handleOutside(event));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRender()));
    this.render();
  }

  async onClose(): Promise<void> {
    // A popover opened from here goes with it, as a task view's do, rather than saving later through a closed sidebar.
    dismissPopovers(this.containerEl);
    this.closed = true;
    this.unsubscribe?.();
    this.stopDragWatch?.();
    this.listDrag?.dispose();
    this.listDrag = undefined;
    if (this.renderFrame !== undefined) this.containerEl.win.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = undefined;
    await this.saveDraft();
  }

  private get content(): HTMLElement { return this.containerEl.children[1] as HTMLElement; }

  /** Bursts of changes (index updates, a new selection, another tab) redraw once, on the next frame. */
  scheduleRender(): void {
    if (this.renderFrame !== undefined || this.closed) return;
    this.renderFrame = this.containerEl.win.requestAnimationFrame(() => {
      this.renderFrame = undefined;
      if (!this.closed) this.render();
    });
  }

  /** The task view the sidebar follows: the active one, or with a sidebar in front, the main area's last one. */
  private taskView(): TaskMainView | undefined {
    const workspace = this.app.workspace;
    const view = workspace.getActiveViewOfType(TaskMainView) ?? workspace.getMostRecentLeaf()?.view;
    return view instanceof TaskMainView ? view : undefined;
  }

  /**
   * What the details edit through: the task view in front, else beside a note (or with a new task started there), the
   * note's. The Projects view lists projects, so a new task started over it (Create new task) is the note's too.
   */
  private host(): DetailsHost | undefined {
    const view = this.taskView();
    if (view && !(view.isProjectsView && this.note.newTaskInSidebar())) return view;
    return this.note.noteView() || this.note.newTaskInSidebar() ? this.note : undefined;
  }

  /** `force`: redraw both parts, even unchanged. */
  render(force = false): void {
    const view = this.taskView();
    // A task picked from the list with nothing else in front is edited as beside a note.
    const host = this.host() ?? (this.localId ? this.note : undefined);
    const idle = this.idleView();
    const selected = host?.sidebarSelection() ?? [];
    // A task selected in the view takes over from one selected here.
    const viewSelection = selected.map(task => task.id).join("\n");
    if (viewSelection !== this.viewSelection) {
      this.viewSelection = viewSelection;
      // As it does from a project being created.
      if (selected.length) { this.localId = undefined; this.newProject = undefined; }
    }
    // Another list (or Smart Context's for another note) starts afresh.
    const context = JSON.stringify([idle.key, idle.pinned]);
    if (context !== this.context) { this.localId = undefined; this.listRows = LIST_PAGE; }
    this.context = context;
    const local = this.localId ? this.plugin.index.taskById(this.localId) : undefined;
    if (!local) this.localId = undefined;
    // A project being created comes first, then a new task the view started here (three panes), until each is written or dropped.
    const creating = this.newProject;
    const entry = creating ? undefined : host?.newTaskInSidebar();
    const task = creating ? undefined : entry?.task ?? local ?? (selected.length === 1 ? selected[0] : undefined);
    this.followTask(task, entry);
    const settings = this.plugin.settings;
    const skeleton = [idle.key, settings.style, settings.density].join("|");
    if (skeleton !== this.skeleton || !this.details?.element.isConnected) this.build(idle, skeleton);
    const planner = this.planner!;
    this.draw(planner, JSON.stringify([todayIso(), this.indexVersion, this.listRows, idle, this.idleOptions(idle), settings.calendarProjectColors, settings.calendarPriorityColors]), force,
      () => idle.calendar ? this.renderToday(planner.element) : this.renderIdleList(planner.element, idle));
    for (const element of Array.from(planner.element.querySelectorAll<HTMLElement>("[data-task-id]"))) element.toggleClass("is-selected", element.getAttribute("data-task-id") === this.localId);
    const details = this.details!;
    // One at a time: a task shown (or several selected) has the sidebar to itself; without one (or after Escape), the
    // list shows, as a drag of tasks also brings it back meanwhile, to drop on.
    const several = !creating && !task && selected.length > 1;
    this.shownId = creating ? NEW_PROJECT_ID : task?.id ?? (several ? "selection" : undefined);
    const alone = Boolean(this.shownId) && !this.dragging;
    this.content.toggleClass("is-showing-task", alone);
    planner.element.hidden = alone;
    if (this.plannerHead) this.plannerHead.hidden = alone;
    if (alone && this.idlePanel?.isOpen) this.idlePanel.setOpen(false);
    else this.idlePanel?.sync();
    details.element.hidden = !alone;
    // A new task redraws as its properties change (not as it is typed).
    if (creating) this.draw(details, JSON.stringify([alone, NEW_PROJECT_ID, creating.version]), force, () => { if (alone) this.renderProjectCreator(details.element, creating); });
    else this.draw(details, JSON.stringify([alone, Boolean(view), Boolean(host), local ? "local" : selected.length, task?.id, entry && [entry.task, entry.destination], task?.raw, task?.description, task && this.children(task).map(child => child.raw), several && selected.map(item => item.raw)]), force,
      () => { if (alone) this.renderDetails(details.element, host, entry ? [] : local ? [local] : selected, task, entry?.destination); });
  }

  /** Lays the sidebar out for a list: its name and View options over its tasks (or today's calendar), then the details. */
  private build(idle: IdleView, skeleton: string): void {
    const container = this.content;
    const settings = this.plugin.settings;
    this.listDrag?.dispose();
    this.listDrag = undefined;
    container.empty();
    // It shares the task views' styles (checkboxes, rows, the calendar), which hang off .tm-main-view.
    container.addClass("tm-main-view", "tm-task-sidebar");
    container.toggleClass("tm-style-things", settings.style === "things");
    container.toggleClass("tm-style-griply", settings.style === "griply");
    container.toggleClass("tm-density-compact", settings.density === "compact");
    container.toggleClass("is-calendar", Boolean(idle.calendar));
    this.buildToolbar(container);
    this.plannerHead = this.buildIdleHead(container, idle);
    this.planner = { element: container.createDiv({ cls: "tm-sidebar-planner tm-sidebar-idle", attr: { "data-tm-scroll-key": "sidebar-planner" } }) };
    if (idle.undated) this.takeUndatedDrops(this.planner.element);
    this.details = { element: container.createDiv({ cls: "tm-sidebar-pane", attr: { "data-tm-scroll-key": "sidebar-details" } }) };
    this.skeleton = skeleton;
  }

  /** A toolbar at the top, as the task navigation's: New task and New project, which with three panes open here. */
  private buildToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "nav-header tm-nav-header tm-sidebar-toolbar" })
      .createDiv({ cls: "nav-buttons-container", attr: { role: "toolbar", "aria-label": "Task details actions" } });
    for (const [label, icon, run] of [
      ["New task", "circle-plus", () => this.plugin.newTask()],
      ["New project", "square-chart-gantt", () => this.plugin.openProjectCreator()]
    ] as const) {
      const button = toolbar.createEl("button", { cls: "clickable-icon nav-action-button", attr: { type: "button", "aria-label": label, title: label, "data-tm-focus-key": `sidebar-${label.toLowerCase().replace(" ", "-")}` } });
      navIcon(button, icon);
      button.addEventListener("click", () => run());
    }
  }

  private draw(section: Section, drawn: string, force: boolean, render: () => void): void {
    if (!force && section.drawn === drawn) return;
    const first = section.drawn === undefined;
    section.drawn = drawn;
    this.preserveView(section.element, !first, () => { section.element.empty(); render(); });
  }

  /** Re-rendering replaces every element; focus (with its caret) and scroll positions go back where they were. */
  private preserveView(root: HTMLElement, scroll: boolean, update: () => void): void {
    const active = root.ownerDocument.activeElement;
    const key = active && root.contains(active) ? active.closest("[data-tm-focus-key]")?.getAttribute("data-tm-focus-key") : undefined;
    const range = isTextField(active) ? [active.selectionStart ?? 0, active.selectionEnd ?? 0] as const : undefined;
    const scrolled = [root, ...Array.from(root.querySelectorAll<HTMLElement>("[data-tm-scroll-key]"))]
      .map(element => ({ key: element === root ? "" : element.getAttribute("data-tm-scroll-key") ?? "", top: element.scrollTop }));
    update();
    if (scroll) for (const { key, top } of scrolled) {
      const element = key ? root.querySelector<HTMLElement>(`[data-tm-scroll-key="${CSS.escape(key)}"]`) : root;
      if (element) element.scrollTop = top;
    }
    const target = key ? root.querySelector<HTMLElement>(`[data-tm-focus-key="${CSS.escape(key)}"]`) : null;
    if (!target) return;
    target.focus({ preventScroll: true });
    if (range && isTextField(target)) target.setSelectionRange(range[0], range[1]);
  }

  /**
   * Escape, or the close button: the task shown goes, and the sidebar shows its list again. What was typed in it is not saved; a new task is dropped.
   */
  private closeDetails(): void {
    if (this.newProject) { this.newProject = undefined; this.render(); return; }
    const host = this.host();
    this.draft = undefined;
    this.localId = undefined;
    if (host?.newTaskInSidebar()) { void host.finishNewTask(false); return; }
    if (host?.sidebarSelection().length) host.clearSelection();
    this.render();
  }

  /** Shows a task of the list (or the day) in the details, until another is selected here or in the view. */
  private select(task: Task): void {
    this.newProject = undefined;
    this.localId = task.id;
    this.render();
  }

  /**
   * Shows a task the view opened, or its new task (three panes; see TaskMainView.revealInSidebar): `focus` puts the
   * caret in its title.
   */
  showTask(id: string, options: { focus?: boolean } = {}): void {
    // Settle on the view in front first (a redraw may be pending), so the task is not taken for the last view's.
    this.render();
    this.newProject = undefined;
    if (id !== NEW_TASK_ID) this.localId = id;
    this.render();
    if (options.focus) this.content.querySelector<HTMLTextAreaElement>(".tm-sidebar-title-field")?.focus();
  }

  /**
   * Starts a new task here beside a note, with three panes (Create new task with no task view in front), its title
   * empty to type; Enter writes it once titled, as a task view's.
   */
  async startNewTask(state: OpenEditorState): Promise<void> {
    this.newProject = undefined;
    await this.note.startNewTask(state);
    this.render();
    this.content.querySelector<HTMLTextAreaElement>(".tm-sidebar-title-field")?.focus();
  }

  /**
   * Starts a new project here, with three panes, in place of the Create project window: its name empty to type, its
   * properties below as a task's. Enter in the name (or Create project) writes its note and opens its page; Escape
   * drops it.
   */
  async startNewProject(): Promise<void> {
    await this.saveDraft();
    this.newProject = {
      draft: { name: "", date: "", endDate: "", deadline: "", priority: "", parent: "", tags: "project", status: "", color: "", description: "" },
      version: 0, error: "", creating: false
    };
    this.render();
    this.content.querySelector<HTMLTextAreaElement>(".tm-sidebar-title-field")?.focus();
  }

  /**
   * After a new task is written, the next one: drawn afresh (it reads as the last did, so would not redraw), its title
   * focused.
   */
  private focusNewTask(): void {
    if (this.closed || !this.host()?.newTaskInSidebar()) return;
    this.render(true);
    this.content.querySelector<HTMLTextAreaElement>(".tm-sidebar-title-field")?.focus();
  }

  /** A time clicked in Today's hours adds a task then: with three panes, here, as the view adds one; else in the task editor. */
  private addTask(preset: TaskEditorPreset): void {
    const view = this.taskView();
    if (view && tasksOpenInSidebar(this.plugin.settings)) view.newTask(preset);
    else this.plugin.openEditor({ mode: "all", preset });
  }

  /** Starts a drag of tasks here, which a sidebar list, another pane, or a view's own drop zones can take. */
  private startDrag(tasks: Task[]): Task[] {
    startTaskDrag(this.content.ownerDocument, { tasks, drop: target => this.dropTasks(tasks, target) });
    return tasks;
  }

  /** What dropping tasks dragged here does is the view's to decide, as for its own (so its selection is kept). */
  private async dropTasks(tasks: Task[], target: SidebarDrop): Promise<void> {
    await this.taskView()?.dropTasks(tasks, target);
  }

  // The list, or Smart Context's today: the day's calendar.

  private renderToday(element: HTMLElement): void {
    const tasks = sortTasks(this.plugin.index.query({ mode: "all", showCompleted: false }).filter(task => calendarDate(task)));
    renderCalendar(element.createDiv({ cls: "tm-sidebar-calendar" }), {
      // Today's calendar, as Today's own: its all-day row and hours, no toolbar, and the period never changes.
      anchor: todayIso(), scope: "day", toolbar: false, tasks, dateFormat: this.plugin.dateFormat(), navigate: () => {},
      color: task => this.plugin.settings.calendarProjectColors ? this.plugin.index.projectColor(task.path) : undefined,
      priorityColors: this.plugin.settings.calendarPriorityColors,
      create: preset => this.addTask(preset),
      // A click shows the task in the details below.
      bind: (card, task) => {
        card.setAttribute("data-task-id", task.id);
        card.addEventListener("click", event => { event.stopPropagation(); this.select(task); });
      },
      edit: task => this.select(task),
      dragStart: task => { this.startDrag([task]); },
      toggle: (task, completed) => this.plugin.store.toggle(task, completed),
      move: (task, date, time) => this.dropTasks([task], { kind: "schedule", date, time }),
      resize: async (task, date, time, duration) => {
        await this.plugin.store.update(task, { ...rescheduledDraft(task, date, time), durationMinutes: duration });
        await this.plugin.index.refreshPath(task.path);
      }
    });
  }

  /**
   * What the sidebar lists while no task is shown: Smart Context unless a view, a smart list, a project or a tag is
   * chosen (one since removed goes back to Smart Context).
   */
  private idleView(): IdleView {
    const chosen = this.plugin.settings.sidebarIdleView;
    // A project's open tasks, by heading as its page groups them.
    const project = chosen?.startsWith("project:") ? this.plugin.index.projects().find(item => `project:${item.path}` === chosen) : undefined;
    if (project) return { key: chosen, label: project.name, query: { mode: "project", projectPath: project.path, showCompleted: false }, sort: "date", descending: false, group: "section" };
    // A tag's, as its page lists them: through its note when it links to one, so a tag's other spellings count too.
    if (chosen?.startsWith("tag:")) {
      const tag = chosen.slice("tag:".length);
      const file = this.plugin.index.tagFile(tag);
      return { key: chosen, label: tag, query: { mode: "tags", showCompleted: false, ...file ? { tagPath: file.path } : { tag } }, sort: "date", descending: false, group: "none" };
    }
    const list = chosen?.startsWith("smartList:") ? this.plugin.settings.smartLists.find(item => `smartList:${item.id}` === chosen) : undefined;
    if (list) {
      // A list made from a view filters that view's tasks, and groups them as it does by default.
      const scope = list.scope;
      const query: TaskQuery = {
        mode: scope?.mode === "project" ? "project" : scope?.mode === "tag" ? "tags" : scope?.mode ?? "all", showCompleted: false, filters: cloneTaskFilters(list.filters),
        ...(scope?.mode === "project" ? { projectPath: scope.path } : {}), ...(scope?.mode === "tag" ? { tag: scope.tag, tagPath: scope.path } : {})
      };
      const group = list.grouping !== "default" ? list.grouping : scope?.mode === "today" ? "today" : scope?.mode === "upcoming" ? "date" : "none";
      return { key: `smartList:${list.id}`, label: list.name, query, sort: list.sort, descending: list.descending, group };
    }
    const view = IDLE_VIEWS.find(([value]) => value === chosen);
    if (!view) return this.contextView();
    const [mode, label] = view;
    return { key: mode, label, query: { mode, showCompleted: false }, sort: "date", descending: false, group: mode === "today" ? "today" : mode === "upcoming" ? "date" : mode === "all" ? "source" : "none" };
  }

  /**
   * Smart Context: All Tasks (by note, as its view groups them), its View options set for what is in front. Beside
   * Today, Today's calendar (or, beside Today's calendar, Today's list); beside Upcoming, both dates No date (tasks dropped there lose theirs); beside a note (task
   * mode off), its Note that note; beside a note's task view (task mode on), by action date. Beside a calendar (but
   * Upcoming's) only the dates it shows, by their action date.
   */
  private contextView(): IdleView {
    const base = { label: "Smart Context", query: { mode: "all", showCompleted: false } as TaskQuery, sort: "date" as const, descending: false, group: "source" as const };
    const view = this.taskView();
    const mode = view?.getState().mode;
    const range = view?.calendarRange;
    const shown: TaskFilter[] | undefined = range && [{ property: "date", operator: "between", values: [...range] }];
    if (view && !view.pagePath && mode === "today") {
      return view.hasCalendar ? { ...base, key: "context:today-list", query: { mode: "today", showCompleted: false }, group: "today", pinned: shown } : { ...base, key: "context:today", calendar: true };
    }
    if (view && !view.pagePath && mode === "upcoming") return { ...base, key: "context:upcoming", filters: UNDATED_FILTERS, undated: true, empty: ["calendar-check", "Every task has a date"] };
    if (view?.pagePath) return { ...base, key: "context:page", group: "date", pinned: shown };
    const note = view ? undefined : this.note.noteView()?.file?.path;
    if (note) return { ...base, key: "context:note", pinned: [{ property: "source", operator: "is", values: [note] }], empty: ["file-text", "No tasks in this note"] };
    return { ...base, key: "context:all", pinned: shown };
  }

  /** The list's own View options, kept with the views' options for each list it can show (and each Smart Context). */
  private idleOptions(idle: IdleView): SavedViewOptions | undefined {
    return this.plugin.settings.viewOptions?.[`sidebar:${idle.key}`];
  }

  /** The list's filters, as its View options show them: pinned ones, then its own (or its defaults, until changed). */
  private idleFilters(idle: IdleView): TaskFilter[] {
    return cloneTaskFilters([...idle.pinned ?? [], ...this.idleOptions(idle)?.filters ?? idle.filters ?? []]);
  }

  private idleState(): ViewOptionsState {
    const idle = this.idleView();
    const own = this.idleOptions(idle);
    // Completed tasks are left out unless a status filter asks for them.
    return {
      sort: own?.sort ?? idle.sort, descending: own ? own.descending : idle.descending, grouping: own?.grouping ?? "default", filters: this.idleFilters(idle), openOnly: true,
      defaultGroup: idle.group === "today" ? "Overdue and today" : groupingLabel(idle.group)
    };
  }

  /**
   * Above the list: its name, a button that picks what the sidebar lists (Smart Context, a view, a smart list, a project
   * or a tag), beside its View options (none for today's calendar).
   */
  private buildIdleHead(container: HTMLElement, idle: IdleView): HTMLElement {
    const head = container.createDiv({ cls: "tm-sidebar-planner-head" });
    const label = `${idle.label}: choose what shows here when no task is selected`;
    const title = head.createEl("button", { cls: "tm-sidebar-planner-title tm-sidebar-idle-title", attr: { type: "button", "aria-haspopup": "listbox", "aria-label": label, title: label, "data-tm-focus-key": "sidebar-idle-view" } });
    title.createSpan({ text: idle.label });
    setIcon(title.createSpan({ cls: "tm-sidebar-idle-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
    title.addEventListener("click", () => this.chooseIdleView(title));
    this.idlePanel = undefined;
    if (idle.calendar) return head;
    const toggle = head.createEl("button", { cls: "tm-filter-toggle clickable-icon", attr: { type: "button", "data-tm-focus-key": "idle-view-options" } });
    this.idlePanel = new ViewOptionsPanel(head, toggle, {
      state: () => this.idleState(),
      update: change => {
        const idle = this.idleView();
        const state = this.idleState();
        // Pinned filters are not the list's own to keep: they follow what is in front.
        const filters = (change.filters ?? state.filters).filter(filter => !idle.pinned?.some(pin => sameFilter(pin, filter)));
        this.plugin.saveViewOptions?.(`sidebar:${idle.key}`, {
          filters, sort: change.sort ?? state.sort, descending: change.descending ?? state.descending, grouping: change.grouping ?? state.grouping
        });
        this.render();
      },
      clear: () => { this.plugin.saveViewOptions?.(`sidebar:${this.idleView().key}`, undefined); this.render(); },
      // Read lazily: the panel outlives task changes, so choices must reflect the current tasks.
      tasks: () => this.plugin.index.allTasks(),
      expanded: () => this.idleOptionsOpen,
      setExpanded: open => { this.idleOptionsOpen = open; }
    });
    return head;
  }

  /**
   * The list's name opens a list of what it can show, with a search on top: Smart Context, Inbox, Today, Upcoming, All
   * Tasks, a smart list, a project or a tag, each with the icon the task sidebar gives it.
   */
  private chooseIdleView(anchor: HTMLElement): void {
    const style = this.plugin.settings.style;
    const projects = activeProjects(this.plugin.index.projects()).sort((a, b) => a.name.localeCompare(b.name));
    const byPath = new Map(projects.map(project => [project.path, project]));
    const glyph = (color: string): string => `tm-choice-color-${color}`;
    const chosen = this.idleView().key;
    openChoicePopover({
      anchor, label: "Show when no task is selected", selected: chosen.startsWith("context:") ? SMART_CONTEXT : chosen,
      input: { placeholder: "Find a list, project or tag", filter: true },
      choices: [
        { value: SMART_CONTEXT, label: "Smart Context", icon: "sparkles", cls: glyph("blue") },
        ...IDLE_VIEWS.map(([value, label]) => {
          const { icon, color } = listGlyph(value, style)!;
          // Things fills Today's star, as the task sidebar does.
          return { value, label, icon, cls: `${glyph(color)}${style === "things" && value === "today" ? " is-filled" : ""}` };
        }),
        ...this.plugin.settings.smartLists.map((list, index) => ({ value: `smartList:${list.id}`, label: list.name, icon: SMART_LIST_GLYPH.icon, cls: glyph(SMART_LIST_GLYPH.color), separated: index === 0 })),
        // A project's progress, in its colour, as the task sidebar draws it.
        ...projects.map((project, index) => ({
          value: `project:${project.path}`, label: project.name, separated: index === 0, cls: "is-project",
          detail: project.parentPath ? byPath.get(project.parentPath)?.name ?? noteName(project.parentPath) : undefined,
          drawIcon: (icon: HTMLElement) => renderProjectProgress(icon, project, false)
        })),
        ...this.plugin.index.tagSummaries().map((tag, index) => ({ value: `tag:${tag.name}`, label: tag.name, icon: TAG_GLYPH.icon, cls: glyph(TAG_GLYPH.color), separated: index === 0 }))
      ],
      choose: value => {
        if (value === this.plugin.settings.sidebarIdleView) return;
        this.plugin.settings.sidebarIdleView = value;
        this.listRows = LIST_PAGE;
        void this.plugin.saveSettings().catch((cause: unknown) => { new Notice(cause instanceof Error ? cause.message : "Could not save the setting."); });
        this.render();
      }
    });
  }

  /** The list's tasks, through its View options, grouped as its view groups them unless they say otherwise. */
  private renderIdleList(element: HTMLElement, idle: IdleView): void {
    const own = this.idleOptions(idle);
    const sort = own?.sort ?? idle.sort;
    const descending = own ? own.descending : idle.descending;
    const grouping = own && own.grouping !== "default" ? own.grouping : idle.group;
    const all = sortTasks(this.plugin.index.query({ ...idle.query, filters: [...idle.query.filters ?? [], ...this.idleFilters(idle)] }), sort, descending);
    const ids = new Set(all.map(task => task.id));
    // Subtasks go with their task.
    const tasks = all.filter(task => !task.parentId || !ids.has(task.parentId));
    if (!tasks.length) {
      // Filters chosen in its View options may be what leaves it empty.
      const filtered = own !== undefined && JSON.stringify(own.filters) !== JSON.stringify(idle.filters ?? []);
      const [icon, title] = idle.empty ?? ["list-checks", `No tasks in ${idle.label}`];
      const empty = element.createDiv({ cls: "tm-empty tm-sidebar-empty" });
      setIcon(empty.createDiv({ cls: "tm-empty-icon" }), icon);
      empty.createEl("h3", { text: title });
      empty.createEl("p", { text: filtered ? "No tasks match the filters." : "Select a task here or in a task view, or put the cursor on a checklist in a note, to see its details here." });
      return;
    }
    // Its rows drag to a task view or a sidebar list, as a view's do.
    this.listDrag?.dispose();
    this.listDrag = new ListDragController(id => this.plugin.index.taskById(id), async () => {}, false, task => this.startDrag([task]), false);
    const shown = tasks.slice(0, this.listRows);
    const today = todayIso();
    const overdue = (task: Task): boolean => (actionDate(task) ?? today) < today;
    // Today's tasks are headed Today only below overdue ones.
    const groups: Array<readonly [string, Task[]]> = grouping === "today"
      ? shown.some(overdue) ? ([["Overdue", shown.filter(overdue)], ["Today", shown.filter(task => !overdue(task))]] as const).filter(([, group]) => group.length) : [["", shown]]
      : grouping === "none" ? [["", shown]] : [...groupTasks(shown, grouping, descending && sort === grouping)];
    // A project's headings in the order its note has them, as its page shows them.
    if (grouping === "section" && idle.query.projectPath) {
      const first = (group: Task[]): number => Math.min(...group.map(task => task.line));
      groups.sort(([, a], [, b]) => first(a) - first(b));
    }
    for (const [key, group] of groups) {
      const parent = key ? element.createEl("section", { cls: "tm-section" }) : element;
      const title = /^\d{4}-\d{2}-\d{2}$/.test(key) ? formatDate(key, this.plugin.dateFormat()) : grouping === "source" ? noteGroupName(key, this.plugin.settings.noteGroupLabel) : key;
      if (key) parent.createEl("h2", { text: title });
      const list = parent.createDiv({ cls: "tm-task-list", attr: { role: "list", "aria-label": title || idle.label } });
      for (const task of group) this.renderRow(list, task);
    }
    const hidden = tasks.length - this.listRows;
    if (hidden > 0) {
      const more = element.createEl("button", { cls: "tm-show-more-tasks", text: `Show ${Math.min(LIST_PAGE, hidden)} more (${hidden} hidden)`, attr: { type: "button", "data-tm-focus-key": "sidebar-show-more" } });
      more.addEventListener("click", () => { this.listRows += LIST_PAGE; this.render(); });
    }
  }

  /**
   * Tasks dragged here from the view (its list's rows, or its calendar's cards) take their dates off; a slot opens at the
   * top of the list meanwhile.
   */
  private takeUndatedDrops(element: HTMLElement): void {
    let gap: HTMLElement | undefined;
    const show = (drag: TaskDrag): void => {
      gap ??= createDiv({ cls: "tm-drop-gap" });
      gap.style.setProperty("--tm-gap-height", `${drag.height ?? 32}px`);
      const host = element.querySelector(".tm-task-list") ?? element;
      if (host.firstElementChild !== gap) host.prepend(gap);
    };
    const leave = (): void => { gap?.remove(); gap = undefined; };
    markDropZone(element, {
      hover: (_point, drag) => show(drag),
      leave,
      drop: async (_point, drag) => { leave(); await drag.drop({ kind: "schedule" }); }
    });
    // A calendar card drags natively; tasks without a date (this list's own) have nothing to take off.
    const native = (event: DragEvent): TaskDrag | undefined => {
      const drag = event.dataTransfer?.types.includes(TASK_DRAG_TYPE) ? activeTaskDrag() : undefined;
      return drag?.tasks.some(task => task.scheduledDate || task.deadline) ? drag : undefined;
    };
    element.addEventListener("dragover", event => {
      const drag = native(event);
      if (!drag) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      show(drag);
    });
    element.addEventListener("dragleave", event => { if (!element.contains(event.relatedTarget as Node | null)) leave(); });
    element.addEventListener("drop", event => {
      const drag = native(event);
      leave();
      if (!drag) return;
      event.preventDefault();
      void drag.drop({ kind: "schedule" });
    });
  }

  /** A task's row, as a list shows it in the chosen style: its checkbox, title and properties; a click shows its details. */
  private renderRow(list: HTMLElement, task: Task, depth = 0): void {
    const things = this.plugin.settings.style === "things";
    const parts = createTaskRow(list, task, {
      cls: "tm-task-item", depth, repeatCheckbox: things && isRepeatingTask(this.app, task), things, lead: things,
      color: this.plugin.index.projectColor(task.path), markColor: true, attr: { tabindex: "0", "data-task-id": task.id }, focusKeys: { title: `sidebar-row:${task.id}` }
    });
    const { row, checkbox, primary, lead, metadata } = parts;
    checkbox.addEventListener("change", () => this.toggle(task, checkbox.checked, task.id === this.draft?.id));
    this.listDrag?.row(row, primary, task);
    const host = this.host() ?? this.note;
    const details = {
      grouping: "none" as const, dateFormat: this.plugin.dateFormat(), source: task.path, tags: task.tags ?? [],
      edit: (property: TaskEditorProperty) => { if (host) void this.edit(host, [task], property); },
      openSource: () => void this.openSource(task)
    };
    if (lead) renderThingsTaskDetails({ lead, inline: primary, secondary: metadata }, task, { ...details, todayMarker: true, subtaskMark: true, datesBelow: Platform.isPhone });
    else renderTaskDetails(primary, metadata, task, details);
    dropEmptyRowParts(parts);
    // The title selects as the rest of the row does; the checkbox and properties keep their own actions.
    row.addEventListener("click", event => {
      const control = (event.target as HTMLElement).closest("input, label, a, [role=button]:not(.tm-task-item)");
      if (!control) this.select(task);
    });
    row.addEventListener("keydown", event => {
      if (event.target === row && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); this.select(task); }
    });
  }

  // The selected task.

  private children(task: Task): Task[] {
    return task.childIds.map(id => this.plugin.index.taskById(id)).filter((child): child is Task => Boolean(child));
  }

  /**
   * Another task shown saves the last one's typing first; an untouched draft takes the task's current text (a new
   * task, what is typed for it, which the view keeps).
   */
  private followTask(task: Task | undefined, entry?: { title: string; notes: string }): void {
    if (this.draft && this.draft.id !== task?.id) {
      void this.saveDraft();
      this.draft = undefined;
    }
    if (task && !this.draft?.dirty) this.draft = { id: task.id, dirty: false, source: { raw: task.raw, title: task.title }, title: entry?.title ?? task.title, notes: entry?.notes ?? cardNotes(task.description), subtask: this.draft?.subtask };
  }

  private typed(task: Task, next: TaskCardDraft): void {
    if (this.draft?.id !== task.id) return;
    // A new task's typing is the view's to keep until it is written.
    if (task.id === NEW_TASK_ID) { this.draft = { ...next, id: task.id, dirty: false }; this.host()?.typeNewTask(next.title, next.notes); return; }
    const dirty = this.draft.dirty || next.title !== this.draft.title || next.notes !== this.draft.notes;
    this.draft = { ...next, id: task.id, source: this.draft.source, dirty };
  }

  /**
   * The task with `id` as it now reads: that line while it is still the task (the same text, or the same title, as
   * `source`), else the one line in its note that reads as `source` did. Ids are line numbers, so a line added above it
   * (by sync or another plugin) moves the task off its id, and another task can take it.
   */
  private liveTask(id: string, source?: TaskSource): Task | undefined {
    const index = this.plugin.index;
    const byId = index.taskById(id);
    if (!source || (byId && (byId.raw === source.raw || byId.title === source.title))) return byId;
    const tasks = index.tasksForPath(byId?.path ?? id.slice(0, id.lastIndexOf(":")));
    for (const same of [(task: Task) => task.raw === source.raw, (task: Task) => task.title === source.title]) {
      const matches = tasks.filter(same);
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  }

  /** A task shown here as it now reads (see liveTask), after any typing for it was saved. */
  private current(task: Task): Task | undefined {
    const source = this.draft?.id === task.id ? this.draft.source : undefined;
    return this.liveTask(task.id, source ?? { raw: task.raw, title: task.title });
  }

  /**
   * Writes the typed title and notes when they changed (tokens in the title set properties, as in a card), keeping the
   * task selected in its view; then redraws, so the title shows what was read from it.
   */
  private saveDraft(): Promise<void> {
    const draft = this.draft;
    if (!draft?.dirty) return this.saving;
    const typed = { ...draft };
    this.saving = this.saving.then(async () => {
      const task = this.liveTask(typed.id, typed.source);
      if (!task) { new Notice("The task changed in its note, so what you typed wasn't saved."); return; }
      // A title cleared keeps the task's own.
      const next = draftFromTitle(task, typed.title.trim() ? typed.title : task.title, new Date(), this.plugin.dateFormat());
      const notes = typed.notes.trim() === cardNotes(task.description).trim() ? undefined : typed.notes;
      try {
        let moveTo: string | undefined;
        if (!draftMatchesTask(task, next) || notes !== undefined) {
          moveTo = next.destination !== draftFromTask(task).destination ? next.destination.split("#")[0] : undefined;
          // Saving puts the line's properties in order, as a card does.
          await this.change(task, async () => {
            await this.plugin.store.update(task, { ...next, description: notes, sortProperties: true });
            return moveTo ? [task.path, moveTo] : [task.path];
          }, moveTo);
        }
        const current = this.draft;
        // What was saved is the task's line now, for the next save (or toggle) to find it by.
        const saved = moveTo ? undefined : this.plugin.index.taskById(task.id);
        if (current?.id === typed.id && saved) current.source = { raw: saved.raw, title: saved.title };
        // Anything typed while saving is still to save.
        if (current?.id === typed.id && current.title === typed.title && current.notes === typed.notes) {
          current.dirty = false;
          if (!this.closed) this.render(true);
        }
      } catch (cause) {
        new Notice(cause instanceof Error ? cause.message : "Could not save the task.");
      }
    });
    return this.saving;
  }

  /** Writes a change to the shown task through its view, which keeps it selected (and so shown here). */
  private async change(task: Task, write: () => Promise<string[]>, moveTo?: string): Promise<void> {
    const host = this.host();
    if (host) await host.changeTask(task, write, moveTo);
    else for (const path of await write()) await this.plugin.index.refreshPath(path);
  }

  /** The property just clicked or focused, for a popover to open beside. */
  private popoverAnchor(): HTMLElement | undefined {
    const active = this.content.ownerDocument.activeElement as HTMLElement | null;
    return active && this.content.contains(active) ? active : undefined;
  }

  /**
   * Edits a property in its popover, as the task's row would (for several tasks, as their menu would); the typing is
   * saved first, so it edits the task as it now reads.
   */
  private async edit(host: DetailsHost, tasks: Task[], property: SidebarProperty, anchor = this.popoverAnchor()): Promise<void> {
    const key = anchor?.getAttribute("data-tm-focus-key");
    await this.saveDraft();
    // Saving redraws: open beside the same control in the new drawing.
    const target = anchor?.isConnected ? anchor : (key ? this.content.querySelector<HTMLElement>(`[data-tm-focus-key="${CSS.escape(key)}"]`) : null) ?? this.content;
    // Several are the view's selection as it now reads; one, as saved.
    const current = tasks.length > 1 ? host.getSelectedTasks() : tasks.map(task => this.current(task) ?? task);
    host.editTaskProperty(current, property, target);
  }

  /** The shown task's checkbox keeps it selected (completing a recurring task moves its dates); a subtask's just toggles. */
  private toggle(task: Task, completed: boolean, shown: boolean): void {
    const failed = (cause: unknown): void => { new Notice(cause instanceof Error ? cause.message : "Could not update the task."); };
    if (!shown) { void this.plugin.store.toggle(task, completed).catch(failed); return; }
    void this.saveDraft();
    // As the task reads once any typing is saved.
    this.saving = this.saving.then(() => {
      // Not found as it was, the task as last drawn: the store finds its line by its text, or refuses.
      const current = this.current(task) ?? task;
      // Completed tasks may move in their note (Settings › Completed tasks): it is found again by its title there.
      const moves = this.plugin.settings.completedPlacement !== "keep" && current.completed !== completed;
      return this.change(current, async () => { await this.plugin.store.toggle(current, completed); return [current.path]; }, moves ? current.path : undefined);
    }).catch(failed);
  }

  private renameChild(child: Task, title: string): void {
    // A subtask stays under its task: its title's tokens set properties but do not move it.
    const draft = draftFromTitle(child, title, new Date(), this.plugin.dateFormat(), false);
    if (draftMatchesTask(child, draft)) return;
    void this.plugin.store.update(child, { ...draft, sortProperties: true })
      .then(() => this.plugin.index.refreshPath(child.path))
      .catch((cause: unknown) => { new Notice(cause instanceof Error ? cause.message : "Could not rename the subtask."); });
  }

  /** Writes a typed subtask after `after` (the last one); its field stays focused for the next. */
  private async addSubtask(parentId: string, title: string, after: Task | undefined): Promise<void> {
    const parent = this.plugin.index.taskById(parentId);
    if (!parent) return;
    try {
      // Everything in a new subtask was just typed, so its natural-language dates count too.
      const parsed = parseTaskInput(title, new Date(), this.plugin.dateFormat());
      await this.plugin.store.addSubtask(parent, parsed?.title.trim() ? parsed : { title }, after);
      await this.plugin.index.refreshPath(parent.path);
    } catch (cause) {
      new Notice(cause instanceof Error ? cause.message : "Could not add the subtask.");
    }
  }

  /**
   * The task's note in a new tab, at the task's line. `showTask` (Open in note): task mode would open a project's or
   * tag's note as its task view, so it is turned off first, for the task to show in the note.
   */
  private async openSource(task: Task, showTask = false): Promise<void> {
    await this.saveDraft();
    const file = this.app.vault.getAbstractFileByPath(task.path);
    if (!(file instanceof TFile)) return;
    const index = this.plugin.index;
    if (showTask && this.plugin.settings.taskMode && (index.isProject(file.path) || index.tagForPath(file.path))) await this.plugin.setTaskMode(false);
    await this.app.workspace.getLeaf("tab").openFile(file, { eState: { line: task.line } });
  }

  /** `destination`: for a new task, the note it will go to. */
  private renderDetails(container: HTMLElement, host: DetailsHost | undefined, selected: Task[], task: Task | undefined, destination?: string): void {
    if (host && !task && selected.length > 1) { this.renderSelectionDetails(container, host, selected); return; }
    if (!host || !task) return;
    this.renderTaskDetails(container, host, task, destination);
    // A new task is in no note yet.
    if (task.id === NEW_TASK_ID) return;
    const footer = container.createDiv({ cls: "tm-sidebar-footer" });
    const open = footer.createEl("button", { cls: "tm-sidebar-open-note", attr: { type: "button", title: task.path, "data-tm-focus-key": "sidebar-open-note" } });
    setIcon(open.createSpan({ cls: "tm-sidebar-open-note-icon", attr: { "aria-hidden": "true" } }), "file-text");
    open.createSpan({ text: "Open in note" });
    open.addEventListener("click", () => void this.openSource(task, true).catch((cause: unknown) => { new Notice(cause instanceof Error ? cause.message : "Could not open the note."); }));
  }

  /** Typing is saved once focus leaves the title and notes (moving between the two keeps it). */
  private saveOnLeave(root: HTMLElement, fields: string): void {
    root.addEventListener("focusout", event => {
      if (!(event.target as HTMLElement | null)?.matches?.(fields)) return;
      if ((event.relatedTarget as HTMLElement | null)?.matches?.(fields)) return;
      void this.saveDraft();
    });
  }

  /**
   * The title over a list of the task's properties, each a row that opens its editor, then its notes and subtasks; in
   * either style, drawn in its colours and checkboxes.
   */
  private renderTaskDetails(container: HTMLElement, host: DetailsHost, task: Task, destination?: string): void {
    const draft = this.draft!;
    // A new task, not yet written: Enter writes it (once titled), Escape drops it.
    const isNew = task.id === NEW_TASK_ID;
    const now = new Date();
    const dateFormat = this.plugin.dateFormat();
    const panel = container.createDiv({ cls: "tm-sidebar-details" });

    const head = panel.createDiv({ cls: "tm-sidebar-head" });
    // As in its row: in the Things style a recurring task's checkbox is its repeat icon.
    const repeating = this.plugin.settings.style === "things" && isRepeatingTask(this.app, task);
    const box = head.createEl("label", { cls: `tm-checkbox-target${repeating ? ` tm-repeat-target${task.priority ? ` is-p${task.priority}` : ""}` : ""}` });
    const checkbox = box.createEl("input", { type: "checkbox", cls: `tm-task-checkbox${task.priority ? ` is-p${task.priority}` : ""}${statusClass(task.status)}`, attr: { "aria-label": checkboxLabel(task), "data-tm-focus-key": "sidebar-checkbox" } });
    checkbox.checked = task.completed;
    if (isNew) checkbox.disabled = true;
    else checkbox.addEventListener("change", () => this.toggle(task, checkbox.checked, true));
    if (repeating) repeatIcon(box);
    // As in a card: the title is one wrapping line, and what saving reads as a property is marked behind it.
    const titleBox = head.createDiv({ cls: "tm-things-card-title-box" });
    const backdrop = titleBox.createDiv({ cls: "tm-things-card-title-backdrop", attr: { "aria-hidden": "true" } });
    const title = titleBox.createEl("textarea", { cls: "tm-things-card-title tm-sidebar-title-field", attr: { "aria-label": "Title", placeholder: isNew ? NEW_TASK_TITLE : "Title", rows: "1", "data-tm-focus-key": "sidebar-title" } });
    title.value = draft.title;
    // Back to what the sidebar shows without a task, as Escape goes (where there is no Escape key, on phones, too).
    const close = head.createEl("button", { cls: "clickable-icon tm-sidebar-close", attr: { type: "button", "aria-label": "Close", title: "Close (Escape)", "data-tm-focus-key": "sidebar-close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeDetails());
    const paint = (): void => paintTokens(backdrop, title.value, taskInputRanges(title.value, task.title, now, dateFormat));
    paint();

    let properties = this.renderProperties(panel, host, [task], destination);
    // As in a card, the properties read what the title sets as it is typed (dates, p1, #tags, a project…), before it is saved.
    const preview = (): void => {
      const next = draftFromTitle(task, title.value, new Date(), dateFormat);
      const moved = next.destination !== draftFromTask(task).destination;
      checkbox.className = `tm-task-checkbox${next.priority ? ` is-p${next.priority}` : ""}${statusClass(task.status)}`;
      const shown = this.renderProperties(panel, host, [task], moved ? next.destination : destination, { ...task, ...next, path: task.path });
      properties.replaceWith(shown);
      properties = shown;
    };
    if (title.value !== task.title) preview();

    const notes = panel.createEl("textarea", { cls: "tm-sidebar-notes", attr: { "aria-label": "Notes", placeholder: "Add notes", rows: "2", "data-tm-focus-key": "sidebar-notes" } });
    notes.value = draft.notes;
    const change = (): void => this.typed(task, { title: title.value, notes: notes.value, subtask: this.draft?.subtask });
    title.addEventListener("input", () => {
      if (/[\r\n]/.test(title.value)) title.value = title.value.replace(/[\r\n]+/g, " ");
      autosize(title); paint(); preview(); change();
    });
    notes.addEventListener("input", () => { autosize(notes); change(); });
    // Enter in the title or notes confirms what was typed (Shift+Enter goes on from the title to the notes, and starts a
    // line in them): it is saved as the field is left, and a new task is written once titled, the next new task taking
    // its place. Escape (see closeDetails) cancels it and closes the task.
    panel.addEventListener("keydown", event => {
      const target = event.target as HTMLElement;
      if (target !== title && target !== notes) return;
      if (target === title && event.key === "Enter" && event.shiftKey && !event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        notes.focus();
        notes.setSelectionRange(notes.value.length, notes.value.length);
      } else if (event.key === "Enter" && !event.isComposing && (!event.shiftKey || event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!isNew) target.blur();
        else create();
      }
    });
    /** Writes the new task once titled, and the next one takes its place; untitled, the caret goes back to its title. */
    const create = (): void => {
      if (title.value.trim()) void host.finishNewTask(true, true).then(() => this.focusNewTask());
      else title.focus();
    };
    const fit = (): void => { autosize(title); autosize(notes); };
    if (panel.isConnected) fit();
    // The frame of the window it's in: a pop-out's, not the main window's, which may be in the background.
    (panel.ownerDocument.defaultView ?? window).requestAnimationFrame(fit);
    this.saveOnLeave(panel, ".tm-sidebar-title-field, .tm-sidebar-notes");

    // A new task's subtasks wait until it is written; Create task writes it, as Enter does (and as a new project's button).
    if (!isNew) this.renderSubtasks(panel, task);
    else panel.createDiv({ cls: "tm-sidebar-footer tm-sidebar-create" })
      .createEl("button", { cls: "mod-cta", text: "Create task", attr: { type: "button", "data-tm-focus-key": "sidebar-task-create" } })
      .addEventListener("click", create);
  }

  /**
   * The property rows, each a name and a value that opens its editor: one task's values, or for several the value they
   * share (else Mixed), set for all of them at once. `destination`: a new task's note to be (or the note typed in its
   * title). `shown`: the one task as its title, typed but not yet saved, would make it.
   */
  private renderProperties(panel: HTMLElement, host: DetailsHost, tasks: Task[], destination?: string, shown?: Task): HTMLElement {
    const [first] = tasks;
    const task = shown ?? first;
    const now = new Date();
    const today = todayIso(now);
    const properties = panel.createDiv({ cls: "tm-sidebar-properties", attr: { role: "group", "aria-label": "Properties" } });
    // The Things style reads like an open Things card: each property a line of its icon and its value, an unset one its
    // name (see styles.css).
    const things = this.plugin.settings.style === "things";
    const shares = (key: (item: Task) => unknown): boolean => tasks.every(item => JSON.stringify(key(item)) === JSON.stringify(key(first)));
    const row = (icon: string, name: string, property: SidebarProperty, key: (item: Task) => unknown, fill: (value: HTMLElement) => void, cls = ""): void => {
      const shared = shares(key);
      const element = properties.createDiv({ cls: `tm-sidebar-property${shared && cls ? ` ${cls}` : ""}` });
      const label = element.createSpan({ cls: "tm-sidebar-property-name" });
      setIcon(label.createSpan({ cls: "tm-sidebar-property-icon", attr: { "aria-hidden": "true" } }), icon);
      label.createSpan({ text: name });
      const value = element.createSpan({ cls: "tm-sidebar-property-value" });
      if (shared) fill(value);
      else { value.addClass("is-mixed"); value.setText("Mixed"); }
      if (!value.childElementCount && !value.textContent) { value.addClass("is-empty"); value.setText(things ? name : "None"); }
      editable(element, `${name}: ${value.textContent}`, `sidebar-${property}`, () => void this.edit(host, tasks, property, element));
    };
    const status = (item: Task) => item.status;
    row(shares(status) ? STATUS_ICONS[task.status] : "circle-dashed", "Status", "status", status, value => { value.setText(STATUS_LABELS[task.status]); }, `is-status${statusClass(task.status)}`);
    // In the Things style, as on a card: Today's star, a date's red calendar.
    const isToday = task.scheduledDate === today;
    row(things && isToday ? "star" : "calendar", "Date", "scheduledDate", item => [item.scheduledDate, item.scheduledTime, item.durationMinutes], value => {
      const time = taskTimeDurationLabel(task.scheduledTime, task.durationMinutes);
      const day = task.scheduledDate ? isToday ? "Today" : longDate(task.scheduledDate, now) : "";
      value.setText([day, time].filter(Boolean).join(", "));
      value.toggleClass("is-overdue", !things && Boolean(task.scheduledDate && task.scheduledDate < today && !task.completed));
    }, things && task.scheduledDate ? isToday ? "is-today" : "is-dated" : "");
    const urgent = Boolean(task.deadline && !task.completed && (deadlineIsOverdue(task.deadline, task.deadlineTime, now) || task.deadline === today));
    row("flag", "Deadline", "deadline", item => [item.deadline, item.deadlineTime], value => {
      if (!task.deadline) return;
      if (things) {
        value.createSpan({ text: `${longDate(task.deadline, now)}${task.deadlineTime ? `, ${taskTimeLabel(task.deadlineTime)}` : ""}` });
        value.createSpan({ cls: "tm-sidebar-property-extra", text: thingsDeadlineLabel(task.deadline, now) });
        return;
      }
      const pill = value.createSpan({ cls: `tm-task-due${deadlineIsDistant(task.deadline, now) ? " is-distant" : ""}${!task.completed && deadlineIsOverdue(task.deadline, task.deadlineTime, now) ? " is-overdue" : ""}` });
      setIcon(pill.createSpan({ cls: "tm-task-detail-icon", attr: { "aria-hidden": "true" } }), "flag");
      pill.createSpan({ text: taskDeadlineCountdown(task.deadline, now) });
      value.createSpan({ cls: "tm-sidebar-property-extra", text: `${longDate(task.deadline, now)}${task.deadlineTime ? `, ${taskTimeLabel(task.deadlineTime)}` : ""}` });
    }, things && task.deadline ? `is-deadline${urgent ? " is-urgent" : ""}` : "");
    row("signal", "Priority", "priority", item => item.priority, value => {
      if (!task.priority) return;
      if (!things) { value.setText(`P${task.priority} · ${PRIORITY_NAMES[task.priority]}`); return; }
      value.createSpan({ text: `${PRIORITY_NAMES[task.priority]} priority` });
      value.createSpan({ cls: "tm-sidebar-property-extra", text: `P${task.priority}` });
    }, task.priority ? `is-p${task.priority}` : "");
    row("folder", "Project", "project", item => item.path, value => {
      const path = destination ? splitDestination(destination).path : task.path;
      const source = value.createSpan({ cls: "tm-task-source", text: path === this.plugin.settings.inboxPath ? "Inbox" : noteName(path) });
      const color = this.plugin.index.projectColor(path);
      if (color) source.style.setProperty("--tm-project-color", color);
    });
    row("tag", "Tags", "tags", item => item.tags ?? [], value => {
      // The Things style's tags are the card's pills.
      if (things) { for (const tag of task.tags ?? []) value.createSpan({ cls: "tm-things-card-tag", text: tag }); return; }
      for (const tag of task.tags ?? []) {
        const pill = value.createSpan({ cls: "tm-task-tag" });
        setIcon(pill.createSpan({ cls: "tm-task-detail-icon", attr: { "aria-hidden": "true" } }), "tag");
        pill.createSpan({ text: tag });
      }
    });
    // Without a name beside them, the Things style's lines say what they are, as a card's do.
    row("repeat", "Repeat", "repeat", item => item.repeat, value => {
      if (task.repeat) value.setText(things ? `Repeats ${repeatLabel(task.repeat).toLowerCase()}` : repeatLabel(task.repeat));
    });
    return properties;
  }

  /**
   * A project to create, laid out as a task's details: its name over its properties, each opening the popover a
   * project's page opens, then its description and the Create project button.
   */
  private renderProjectCreator(container: HTMLElement, entry: NewProject): void {
    const { draft } = entry;
    const now = new Date();
    const things = this.plugin.settings.style === "things";
    const panel = container.createDiv({ cls: "tm-sidebar-details is-new-project" });

    const head = panel.createDiv({ cls: "tm-sidebar-head" });
    // In the checkbox's place, an empty progress ring in its colour, as the task sidebar draws a project.
    const ring = head.createDiv({ cls: "tm-sidebar-project-ring" });
    renderProjectProgress(ring, { name: draft.name.trim() || "New project", path: "", openTasks: 0, completedTasks: 0, color: projectColorValue(draft.color) } as Project, false);
    const titleBox = head.createDiv({ cls: "tm-things-card-title-box" });
    const backdrop = titleBox.createDiv({ cls: "tm-things-card-title-backdrop", attr: { "aria-hidden": "true" } });
    const title = titleBox.createEl("textarea", { cls: "tm-things-card-title tm-sidebar-title-field", attr: { "aria-label": "Project name", placeholder: "New project", rows: "1", "data-tm-focus-key": "sidebar-project-name" } });
    title.value = draft.name;
    backdrop.setText(draft.name);
    const close = head.createEl("button", { cls: "clickable-icon tm-sidebar-close", attr: { type: "button", "aria-label": "Close", title: "Close (Escape)", "data-tm-focus-key": "sidebar-close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeDetails());

    const properties = panel.createDiv({ cls: "tm-sidebar-properties", attr: { role: "group", "aria-label": "Properties" } });
    const row = (icon: string, name: string, property: keyof ProjectDraft, fill: (value: HTMLElement) => void, cls = ""): void => {
      const element = properties.createDiv({ cls: `tm-sidebar-property${cls ? ` ${cls}` : ""}` });
      const label = element.createSpan({ cls: "tm-sidebar-property-name" });
      setIcon(label.createSpan({ cls: "tm-sidebar-property-icon", attr: { "aria-hidden": "true" } }), icon);
      label.createSpan({ text: name });
      const value = element.createSpan({ cls: "tm-sidebar-property-value" });
      fill(value);
      if (!value.childElementCount && !value.textContent) { value.addClass("is-empty"); value.setText(things ? name : "None"); }
      editable(element, `${name}: ${value.textContent}`, `sidebar-project-${property}`, () => this.editNewProject(entry, property, element));
    };
    const status = (TASK_STATUSES as readonly string[]).includes(draft.status ?? "") ? draft.status as TaskStatus : undefined;
    row(status ? STATUS_ICONS[status] : "circle-dashed", "Status", "status", value => { if (status) value.setText(STATUS_LABELS[status]); }, status ? `is-status${statusClass(status)}` : "");
    const date = (iso: string) => (value: HTMLElement): void => { if (iso) value.setText(longDate(iso, now)); };
    row("calendar", "Start date", "date", date(draft.date));
    row("calendar-check", "End date", "endDate", date(draft.endDate));
    row("flag", "Deadline", "deadline", value => {
      if (!draft.deadline) return;
      value.createSpan({ text: longDate(draft.deadline, now) });
      value.createSpan({ cls: "tm-sidebar-property-extra", text: things ? thingsDeadlineLabel(draft.deadline, now) : taskDeadlineCountdown(draft.deadline, now) });
    });
    const priority = /^[123]$/.test(draft.priority) ? Number(draft.priority) as 1 | 2 | 3 : undefined;
    row("signal", "Priority", "priority", value => {
      if (!priority) return;
      if (!things) { value.setText(`P${priority} · ${PRIORITY_NAMES[priority]}`); return; }
      value.createSpan({ text: `${PRIORITY_NAMES[priority]} priority` });
      value.createSpan({ cls: "tm-sidebar-property-extra", text: `P${priority}` });
    }, priority ? `is-p${priority}` : "");
    row("folder-tree", "Parent project", "parent", value => {
      if (!draft.parent) return;
      const source = value.createSpan({ cls: "tm-task-source", text: noteName(draft.parent) });
      const color = this.plugin.index.projectColor(draft.parent);
      if (color) source.style.setProperty("--tm-project-color", color);
    });
    row("tag", "Tags", "tags", value => {
      for (const tag of draft.tags.split(/[,\s]+/).map(tag => tag.replace(/^#/, "")).filter(Boolean)) {
        if (things) { value.createSpan({ cls: "tm-things-card-tag", text: tag }); continue; }
        const pill = value.createSpan({ cls: "tm-task-tag" });
        setIcon(pill.createSpan({ cls: "tm-task-detail-icon", attr: { "aria-hidden": "true" } }), "tag");
        pill.createSpan({ text: tag });
      }
    });
    row("palette", "Color", "color", value => {
      const color = projectColorValue(draft.color);
      if (!color || !draft.color) return;
      value.createSpan({ cls: "tm-sidebar-project-swatch", attr: { "aria-hidden": "true" } }).style.setProperty("--tm-project-color", color);
      value.createSpan({ text: draft.color.startsWith("#") ? draft.color : draft.color[0].toUpperCase() + draft.color.slice(1) });
    });

    const description = panel.createEl("textarea", { cls: "tm-sidebar-notes", attr: { "aria-label": "Description", placeholder: "Add description", rows: "2", "data-tm-focus-key": "sidebar-project-description" } });
    description.value = draft.description ?? "";
    panel.createDiv({ cls: "tm-editor-error tm-sidebar-error", text: entry.error, attr: { role: "alert" } });
    const footer = panel.createDiv({ cls: "tm-sidebar-footer tm-sidebar-create" });
    const create = footer.createEl("button", { cls: "mod-cta", text: "Create project", attr: { type: "button", "data-tm-focus-key": "sidebar-project-create" } });
    create.addEventListener("click", () => void this.createNewProject(entry));

    // Typing is kept as it goes, without a redraw.
    title.addEventListener("input", () => {
      if (/[\r\n]/.test(title.value)) title.value = title.value.replace(/[\r\n]+/g, " ");
      autosize(title);
      backdrop.setText(title.value);
      entry.draft = { ...entry.draft, name: title.value };
    });
    description.addEventListener("input", () => { autosize(description); entry.draft = { ...entry.draft, description: description.value }; });
    // Enter in the name creates the project once named (Shift+Enter goes on to the description, where Enter starts a
    // line); Cmd/Ctrl+Enter creates it from either, as in the Create project window.
    panel.addEventListener("keydown", event => {
      const target = event.target as HTMLElement;
      if ((target !== title && target !== description) || event.key !== "Enter" || event.isComposing || event.altKey) return;
      if (event.metaKey || event.ctrlKey) { event.preventDefault(); if (!event.repeat) void this.createNewProject(entry); }
      else if (target === title && event.shiftKey) { event.preventDefault(); description.focus(); description.setSelectionRange(description.value.length, description.value.length); }
      else if (target === title) { event.preventDefault(); if (title.value.trim() && !event.repeat) void this.createNewProject(entry); }
    });
    const fit = (): void => { autosize(title); autosize(description); };
    if (panel.isConnected) fit();
    (panel.ownerDocument.defaultView ?? window).requestAnimationFrame(fit);
  }

  /** A new project's property in the popover a project's page opens for it; a choice redraws the new project. */
  private editNewProject(entry: NewProject, property: keyof ProjectDraft, anchor: HTMLElement): void {
    const { draft } = entry;
    openProjectDraftProperty(this.plugin, draft, property, anchor, {
      status: draft.status ?? "",
      // Chosen dates are kept as ISO dates, which the note is written from in the vault's format.
      dates: { date: draft.date || undefined, endDate: draft.endDate || undefined, deadline: draft.deadline || undefined },
      save: change => {
        if (this.newProject !== entry) return;
        entry.draft = change(entry.draft);
        entry.error = "";
        entry.version++;
        this.render();
      }
    });
  }

  /** Writes the new project's note and opens its page, as the Create project window does; a problem shows above the button. */
  private async createNewProject(entry: NewProject): Promise<void> {
    if (entry.creating || this.newProject !== entry) return;
    entry.creating = true;
    try {
      const path = await this.plugin.createProjectNote(entry.draft);
      if (this.newProject === entry) this.newProject = undefined;
      this.render();
      await this.plugin.openProject(path);
    } catch (cause) {
      entry.error = cause instanceof Error ? cause.message : String(cause);
      entry.version++;
      if (this.newProject === entry) this.render();
    } finally {
      entry.creating = false;
    }
  }

  /**
   * Several tasks selected: Multiple tasks in place of a title, a checkbox that completes (or reopens) them all, and
   * their properties, set for all of them at once; no notes or subtasks, which are each task's own.
   */
  private renderSelectionDetails(container: HTMLElement, host: DetailsHost, tasks: Task[]): void {
    const panel = container.createDiv({ cls: "tm-sidebar-details is-selection" });
    const head = panel.createDiv({ cls: "tm-sidebar-head" });
    const done = tasks.every(task => task.completed);
    const box = head.createEl("label", { cls: "tm-checkbox-target" });
    const checkbox = box.createEl("input", { type: "checkbox", cls: "tm-task-checkbox", attr: { "aria-label": done ? `Reopen ${tasks.length} tasks` : `Complete ${tasks.length} tasks`, "data-tm-focus-key": "sidebar-checkbox" } });
    checkbox.checked = done;
    checkbox.indeterminate = !done && tasks.some(task => task.completed);
    checkbox.addEventListener("change", () => host.setTaskStatus(host.getSelectedTasks(), checkbox.checked ? "done" : "todo"));
    head.createDiv({ cls: "tm-sidebar-selection-name", text: "Multiple tasks" });
    const close = head.createEl("button", { cls: "clickable-icon tm-sidebar-close", attr: { type: "button", "aria-label": "Close", title: "Close (Escape)", "data-tm-focus-key": "sidebar-close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => this.closeDetails());
    this.renderProperties(panel, host, tasks);
  }

  /** The subtasks: each checks off and renames in place; the last line adds one, and Enter starts the next. */
  private renderSubtasks(panel: HTMLElement, task: Task): void {
    const children = this.children(task);
    const list = panel.createDiv({ cls: "tm-sidebar-subtasks", attr: { role: "list", "aria-label": "Subtasks" } });
    for (const child of children) {
      const item = list.createDiv({ cls: `tm-sidebar-subtask${child.completed ? " is-completed" : ""}`, attr: { role: "listitem" } });
      // The Things style's subtasks are a card's checklist: round boxes in the accent colour.
      const cls = this.plugin.settings.style === "things" ? "tm-things-card-check-box" : `tm-task-checkbox${child.priority ? ` is-p${child.priority}` : ""}${statusClass(child.status)}`;
      const box = item.createEl("input", { type: "checkbox", cls, attr: { "aria-label": checkboxLabel(child) } });
      box.checked = child.completed;
      box.addEventListener("change", () => this.toggle(child, box.checked, false));
      const name = item.createEl("input", { type: "text", cls: "tm-sidebar-subtask-title", attr: { "aria-label": `Subtask: ${child.title}`, "data-tm-focus-key": `sidebar-subtask:${child.id}` } });
      name.value = child.title;
      const commit = (): void => {
        const value = name.value.trim();
        if (!value) { name.value = child.title; return; }
        if (value !== child.title) this.renameChild(child, value);
      };
      name.addEventListener("blur", commit);
      name.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); name.blur(); }
        // Escape puts the name back, and goes on to close the task.
        else if (event.key === "Escape") { name.value = child.title; name.blur(); }
      });
    }
    const adding = list.createDiv({ cls: "tm-sidebar-subtask is-new" });
    // A dashed checkbox stands where the new subtask's checkbox will be.
    adding.createSpan({ cls: "tm-sidebar-subtask-add", attr: { "aria-hidden": "true" } });
    const input = adding.createEl("input", { type: "text", cls: "tm-sidebar-subtask-title", attr: { "aria-label": "New subtask", placeholder: "Add subtask", "data-tm-focus-key": "sidebar-subtask-new" } });
    input.value = this.draft?.subtask?.text ?? "";
    const keep = (text: string): void => { if (this.draft) this.draft = { ...this.draft, subtask: text ? { text } : undefined }; };
    input.addEventListener("input", () => keep(input.value));
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      input.value = "";
      keep("");
      void this.addSubtask(task.id, value, children[children.length - 1]);
    });
  }
}
