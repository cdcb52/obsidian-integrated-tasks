// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installObsidianDom } from "./helpers/obsidian-dom";

vi.mock("obsidian", async importOriginal => {
  const original = await importOriginal<typeof import("./obsidian-mock")>();
  return { ...original, Menu: class {}, Notice: class {}, setIcon: vi.fn() };
});

import { Platform, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { TaskIndex } from "../src/task-index";
import { TaskMainView } from "../src/task-view";
import { parseTaskQuery } from "../src/task-query";
import { type ViewPeriod, DEFAULT_SETTINGS, type SavedViewOptions, type SmartList, type ViewLayout } from "../src/types";
import { todayIso } from "../src/date";
import type TaskManagerPlugin from "../src/main";

beforeAll(() => installObsidianDom());
afterEach(() => { document.body.innerHTML = ""; });

async function setup(notes: Array<[string, string]>, frontmatter: Record<string, Record<string, unknown>> = {}) {
  const files = new Map(notes.map(([path]) => [path, Object.assign(new TFile(), { path, extension: "md", basename: path.replace(/\.md$/, "") })]));
  const contents = new Map(notes);
  const app = {
    vault: { getMarkdownFiles: () => [...files.values()], getAbstractFileByPath: (path: string) => files.get(path) ?? null, cachedRead: async (file: TFile) => contents.get(file.path) ?? "", on: () => ({}), offref: () => {} },
    metadataCache: { getFileCache: (file: TFile) => frontmatter[file.path] ? { frontmatter: frontmatter[file.path] } : {}, on: () => ({}), offref: () => {}, getFirstLinkpathDest: () => null },
    workspace: { getLeaf: () => ({ openFile: vi.fn() }), requestSaveLayout: vi.fn() }
  } as unknown as App;
  const index = new TaskIndex(app, () => DEFAULT_SETTINGS, () => "YYYY-MM-DD");
  await index.initialize();
  const settings = { ...DEFAULT_SETTINGS, viewOptions: {} as Record<string, SavedViewOptions>, viewLayouts: {} as Record<string, ViewLayout>, viewPeriods: {} as Record<string, ViewPeriod>, smartLists: [] as SmartList[] };
  const plugin = {
    settings, index, store: {}, dateFormat: () => "YYYY-MM-DD", openEditor: vi.fn(), openTaskView: vi.fn().mockResolvedValue(undefined),
    projectDraft: vi.fn(() => ({ tags: "" })),
    updateProject: vi.fn().mockResolvedValue(""), setProjectDescription: vi.fn().mockResolvedValue(undefined), openProjectCreator: vi.fn(),
    saveViewOptions: vi.fn((key: string, options?: SavedViewOptions) => { if (options) settings.viewOptions[key] = options; else delete settings.viewOptions[key]; }),
    saveViewLayout: vi.fn((key: string, layout?: ViewLayout) => { if (layout && layout !== "list") settings.viewLayouts[key] = layout; else delete settings.viewLayouts[key]; }),
    saveViewPeriod: vi.fn((key: string, period?: ViewPeriod) => { if (period && Object.keys(period).length) settings.viewPeriods[key] = period; else delete settings.viewPeriods[key]; }),
    saveSmartList: vi.fn(async (draft: Omit<SmartList, "id">, id?: string) => {
      const list = { ...draft, id: id ?? "new" };
      settings.smartLists = [...settings.smartLists.filter(item => item.id !== list.id), list];
      return list;
    })
  };
  const view = new TaskMainView({ app } as unknown as WorkspaceLeaf, plugin as unknown as TaskManagerPlugin);
  const content = () => view.containerEl.children[1] as HTMLElement;
  return { view, plugin, settings, content };
}

const titles = (container: HTMLElement) => Array.from(container.querySelectorAll(".tm-task-item .tm-task-title")).map(title => title.textContent);
/** Picks P1 in View options › Priority. */
function filterP1(content: HTMLElement): void {
  content.querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
  content.querySelector<HTMLButtonElement>("[data-tm-focus-key='option-priority']")!.click();
  content.querySelector<HTMLElement>(".tm-options-dropdown [data-value='1']")!.click();
}

describe("View options kept for each view", () => {
  it("keeps each view's options between visits, by list, project and tag, and forgets them once cleared", async () => {
    const today = todayIso();
    const { view, plugin, settings, content } = await setup([["A.md", `- [ ] Urgent ${today} p1\n- [ ] Later ${today}`], ["Site.md", "- [ ] Page p2\n- [ ] Copy"]], { "Site.md": { tags: ["project"] } });
    await view.setState({ mode: "today" });
    filterP1(content());
    expect(titles(content())).toEqual(["Urgent"]);
    expect(plugin.saveViewOptions).toHaveBeenLastCalledWith("today", expect.objectContaining({ filters: [{ property: "priority", operator: "is", values: ["1"] }] }));

    // Another view starts from its own options (none kept: the defaults).
    await view.setState({ mode: "all" });
    expect(titles(content())).toEqual(["Urgent", "Later", "Page", "Copy"]);
    await view.setState({ mode: "all", pagePath: "Site.md" });
    content().querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
    content().querySelector<HTMLButtonElement>("[data-tm-focus-key='option-sort']")!.click();
    content().querySelector<HTMLElement>(".tm-options-dropdown [data-value='title']")!.click();
    expect(Object.keys(settings.viewOptions).sort()).toEqual(["project:Site.md", "today"]);

    // Back on Today, its filter is there again.
    await view.setState({ mode: "today" });
    expect(titles(content())).toEqual(["Urgent"]);
    expect(content().querySelector(".tm-options-badge")!.textContent).toBe("1");
    content().querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
    content().querySelector<HTMLButtonElement>(".tm-options-clear")!.click();
    expect(settings.viewOptions.today).toBeUndefined();
    await view.setState({ mode: "all", pagePath: "Site.md" });
    expect(titles(content())).toEqual(["Copy", "Page"]);
  });

  it("opens a new tab of a view with its kept options", async () => {
    const today = todayIso();
    const first = await setup([["A.md", `- [ ] Urgent ${today} p1\n- [ ] Later ${today}`]]);
    first.settings.viewOptions.today = { filters: [{ property: "priority", operator: "is", values: ["1"] }], sort: "date", descending: false, grouping: "default", showProjects: false };
    await first.view.setState({ mode: "today" });
    expect(titles(first.content())).toEqual(["Urgent"]);
    expect(first.view.getState().showProjects).toBe(false);
  });
});

describe("Layouts kept for each view", () => {
  it("opens each view in the layout it was left in, a list until then, and keeps the Projects list's and a smart list's too", async () => {
    const today = todayIso();
    const { view, plugin, settings, content } = await setup([["A.md", `- [ ] Call ${today}`], ["Site.md", "- [ ] Page"]], { "Site.md": { tags: ["project"] } });
    settings.smartLists.push({ id: "p1", name: "P1", filters: [], sort: "date", descending: false, grouping: "default" });
    const layoutButton = (name: string) => content().querySelector<HTMLButtonElement>(`[data-tm-focus-key="${name}"]`)!;
    await view.setState({ mode: "today" });
    layoutButton("layout-calendar").click();
    expect(plugin.saveViewLayout).toHaveBeenLastCalledWith("today", "calendar");
    await view.setState({ mode: "upcoming" });
    expect(view.getState().layout).toBe("list");
    layoutButton("layout-kanban").click();
    await view.setState({ mode: "projects" });
    layoutButton("layout-gantt").click();
    await view.setState({ mode: "smartLists", smartListId: "p1" });
    layoutButton("layout-calendar").click();
    expect(settings.viewLayouts).toEqual({ today: "calendar", upcoming: "kanban", projects: "gantt", "smartList:p1": "calendar" });

    await view.setState({ mode: "today" });
    expect(view.getState().layout).toBe("calendar");
    await view.setState({ mode: "projects" });
    expect(view.getState().projectLayout).toBe("gantt");
    // A layout the state names (a restored tab, or Back) holds; switching to it by command keeps it for the view.
    await view.setState({ mode: "upcoming", layout: "list" });
    expect(view.getState().layout).toBe("list");
    await view.setState({ ...view.getState(), layout: "calendar" });
    expect(settings.viewLayouts.upcoming).toBe("calendar");
    // Back to a list, nothing is kept.
    layoutButton("layout-list").click();
    expect(settings.viewLayouts.upcoming).toBeUndefined();
  });
});

describe("The Projects view", () => {
  const projects = (): Array<[string, string]> => [["Site.md", "- [ ] Page"], ["Home.md", "- [ ] Paint"], ["Garden.md", "- [x] Dig"], ["Old.md", "- [ ] Box"]];
  const frontmatter = {
    "Site.md": { tags: ["project"], status: "In progress", priority: 1 },
    "Home.md": { tags: ["project"], status: "on hold" },
    "Garden.md": { tags: ["project"] },
    "Old.md": { tags: ["project", "archived"], status: "Cancelled" }
  };
  const sections = (content: HTMLElement) => Array.from(content.querySelectorAll(".tm-section, .tm-kanban-column")).map(section => [
    (section.querySelector("h2 > span") ?? section.querySelector("h2"))!.textContent, Array.from(section.querySelectorAll(".tm-task-title")).map(title => title.textContent)
  ]);

  it("lists and boards projects by their status, every status a group, and has no calendar", async () => {
    const { view, plugin, settings, content } = await setup(projects(), frontmatter);
    await view.setState({ mode: "projects" });
    // A status property says a project's status; without one, its tasks say whether it is done.
    const byStatus = [["To do", []], ["In progress", ["Site"]], ["Waiting", ["Home"]], ["Done", ["Garden"]], ["Cancelled", ["Old"]]];
    expect(sections(content())).toEqual(byStatus);
    expect(Array.from(content().querySelectorAll(".tm-project-status")).map(status => status.textContent)).toEqual(["In progress", "Waiting", "Cancelled"]);
    const button = (key: string) => content().querySelector<HTMLButtonElement>(`[data-tm-focus-key="${key}"]`);
    expect(["layout-list", "layout-kanban", "layout-gantt"].every(key => button(key))).toBe(true);
    expect(button("layout-calendar")).toBeNull();
    button("layout-kanban")!.click();
    expect(settings.viewLayouts.projects).toBe("kanban");
    expect(sections(content())).toEqual(byStatus);
    // Dropped in a column, a project takes its status.
    const internal = view as unknown as { dropListTask(task: unknown, group: unknown): Promise<void> };
    await internal.dropListTask({ id: "project:Home.md" }, { property: "status", value: "Done" });
    expect(plugin.updateProject).toHaveBeenCalledOnce();
    const [path, change] = plugin.updateProject.mock.calls[0] as [string, (draft: Record<string, unknown>) => Record<string, unknown>];
    expect(path).toBe("Home.md");
    expect(change({ name: "Home" })).toEqual({ name: "Home", status: "done" });
    button("layout-gantt")!.click();
    expect(settings.viewLayouts.projects).toBe("gantt");
    expect(content().querySelectorAll(".tm-gantt-project")).toHaveLength(4);
  });

  it("filters projects with View options limited to a project's properties, kept for the view", async () => {
    const { view, settings, content } = await setup(projects(), frontmatter);
    await view.setState({ mode: "projects" });
    content().querySelector<HTMLButtonElement>(".tm-filter-toggle")!.click();
    expect(content().querySelector("[data-tm-focus-key='option-status']")).not.toBeNull();
    expect(content().querySelector("[data-tm-focus-key='option-repeat']")).toBeNull();
    expect(content().querySelector("[data-tm-focus-key='option-convert']")).toBeNull();
    content().querySelector<HTMLButtonElement>("[data-tm-focus-key='option-priority']")!.click();
    content().querySelector<HTMLElement>(".tm-options-dropdown [data-value='1']")!.click();
    expect(sections(content())).toEqual([["To do", []], ["In progress", ["Site"]], ["Waiting", []], ["Done", []], ["Cancelled", []]]);
    expect(settings.viewOptions.projects?.filters).toEqual([{ property: "priority", operator: "is", values: ["1"] }]);
  });

  it("shows a project's description in a card on its page, edited in place", async () => {
    const { view, plugin, content } = await setup(projects(), { ...frontmatter, "Site.md": { ...frontmatter["Site.md"], description: "The new website.\nLaunch in spring." } });
    await view.setState({ mode: "all", pagePath: "Site.md" });
    const card = () => content().querySelector<HTMLElement>(".tm-project-description")!;
    expect(card().hidden).toBe(false);
    // Under the whole header: the title, its properties, the layouts and the buttons.
    expect(card().previousElementSibling?.classList.contains("tm-view-header")).toBe(true);
    // The header sits closer to the card while it shows.
    expect(card().previousElementSibling?.classList.contains("has-description")).toBe(true);
    expect(card().textContent).toBe("The new website.\nLaunch in spring.");
    card().click();
    const field = card().querySelector("textarea")!;
    expect(field.value).toBe("The new website.\nLaunch in spring.");
    field.value = "The new website.";
    field.dispatchEvent(new FocusEvent("blur"));
    expect(plugin.setProjectDescription).toHaveBeenCalledExactlyOnceWith("Site.md", "The new website.");
    expect(card().textContent).toBe("The new website.");
    // Without one, there is no card.
    await view.setState({ mode: "all", pagePath: "Home.md" });
    expect(card().hidden).toBe(true);
    expect(card().previousElementSibling?.classList.contains("has-description")).toBe(false);
  });
});

describe("Calendar scope and Gantt range kept for each view", () => {
  it("opens a calendar on four days on a phone", async () => {
    const platform = Platform as { isPhone?: boolean };
    platform.isPhone = true;
    try {
      const { view, settings } = await setup([["A.md", "- [ ] Call"]]);
      await view.setState({ mode: "today", layout: "calendar" } as never);
      expect((view.getState() as { calendarScope?: string }).calendarScope).toBe("four-day");
      expect(settings.viewPeriods.today).toBeUndefined();
    } finally { platform.isPhone = false; }
  });

  it("opens each view's calendar at the scope it was left at, and the Projects Gantt at its range", async () => {
    const today = todayIso();
    const { view, settings, content } = await setup([["A.md", `- [ ] Call ${today}`], ["Site.md", "- [ ] Page"]], { "Site.md": { tags: ["project"], start: today, end: today } });
    const scope = (label: string) => content().querySelector<HTMLButtonElement>(`.tm-calendar-scopes button[aria-label="${label}"]`)!;
    await view.setState({ mode: "today", layout: "calendar" });
    scope("Week").click();
    expect(settings.viewPeriods.today).toEqual({ calendarScope: "week" });
    // Another view keeps its own (a month until changed); back again, the week holds.
    await view.setState({ mode: "upcoming", layout: "calendar" });
    expect(view.getState().calendarScope).toBe("month");
    await view.setState({ mode: "today", layout: "calendar" });
    expect(view.getState().calendarScope).toBe("week");
    // Back to a month, nothing is kept.
    scope("Month").click();
    expect(settings.viewPeriods.today).toBeUndefined();

    await view.setState({ mode: "projects" });
    content().querySelector<HTMLButtonElement>('[data-tm-focus-key="layout-gantt"]')!.click();
    content().querySelector<HTMLButtonElement>('.tm-gantt-zoom button[aria-label="Zoom in"]')!.click();
    const range = settings.viewPeriods.projects;
    expect(range?.ganttScale ?? range?.ganttZoom).toBeDefined();
    await view.setState({ mode: "today" });
    await view.setState({ mode: "projects" });
    expect([view.getState().ganttZoom, view.getState().ganttScale]).toEqual([range!.ganttZoom, range!.ganttScale]);
  });
});

describe("Convert to smart list", () => {
  it("makes a smart list of the view's options that filters the view's own tasks, and opens it", async () => {
    const today = todayIso();
    const { view, plugin, settings, content } = await setup([["A.md", `- [ ] Urgent today ${today} p1\n- [ ] Urgent later 2999-01-01 p1\n- [ ] Plain today ${today}`]]);
    await view.setState({ mode: "today" });
    filterP1(content());
    content().querySelector<HTMLButtonElement>(".tm-options-convert")!.click();
    // The panel closes for a popover naming the list.
    expect(content().querySelector<HTMLElement>(".tm-options-panel")!.hidden).toBe(true);
    const input = document.querySelector<HTMLInputElement>(".tm-choice-popover input")!;
    input.value = "Urgent today";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(plugin.openTaskView).toHaveBeenCalledWith({ mode: "smartLists", smartListId: "new" }));
    expect(plugin.saveSmartList).toHaveBeenCalledWith({ name: "Urgent today", filters: [{ property: "priority", operator: "is", values: ["1"] }],
      sort: "date", descending: false, grouping: "default", scope: { mode: "today" } });

    // The list shows Today's P1 tasks, grouped as Today groups them; a smart list offers no conversion of its own.
    await view.setState({ mode: "smartLists", smartListId: "new" });
    expect(titles(content())).toEqual(["Urgent today"]);
    expect(Array.from(content().querySelectorAll(".tm-section > h2")).map(heading => heading.textContent)).toContain("Today");
    expect(content().querySelector(".tm-options-convert")).toBeNull();
    // So does a task-query block that names it.
    const parsed = parseTaskQuery("smart list: Urgent today", { sourcePath: "Note.md", dateFormat: "YYYY-MM-DD", smartLists: settings.smartLists, resolveNote: () => undefined });
    expect(parsed.query).toMatchObject({ mode: "today", filters: [{ property: "priority", operator: "is", values: ["1"] }] });
  });

  it("offers Update smart list in a smart list's View options once its options change, and saves them into it", async () => {
    const today = todayIso();
    const { view, plugin, settings, content } = await setup([["A.md", `- [ ] Urgent ${today} p1\n- [ ] Plain ${today}`]]);
    settings.smartLists = [{ id: "focus", name: "Focus", filters: [], sort: "date", descending: false, grouping: "default", scope: { mode: "today" } }];
    await view.setState({ mode: "smartLists", smartListId: "focus" });
    const update = () => content().querySelector<HTMLButtonElement>(".tm-options-update")!;
    expect(update().textContent).toBe("Update smart list");
    // Nothing to save until the view's options differ from the list's.
    expect(update().disabled).toBe(true);
    filterP1(content());
    expect(titles(content())).toEqual(["Urgent"]);
    expect(update().disabled).toBe(false);
    update().click();
    expect(content().querySelector<HTMLElement>(".tm-options-panel")!.hidden).toBe(true);
    expect(plugin.saveSmartList).toHaveBeenCalledWith({ name: "Focus", filters: [{ property: "priority", operator: "is", values: ["1"] }],
      sort: "date", descending: false, grouping: "default", scope: { mode: "today" } }, "focus");
    await vi.waitFor(() => expect(settings.smartLists[0].filters).toHaveLength(1));
    view.render();
    expect(titles(content())).toEqual(["Urgent"]);
    expect(update().disabled).toBe(true);
  });
});
