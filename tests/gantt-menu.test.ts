// @vitest-environment happy-dom
import { afterEach, beforeAll, expect, it, vi } from "vitest";
vi.mock("obsidian", async importOriginal => ({ ...await importOriginal<typeof import("./obsidian-mock")>(), Notice: class {}, setIcon: vi.fn() }));
import { installObsidianDom } from "./helpers/obsidian-dom";
import { renderGantt } from "../src/gantt-view";
import type { Project } from "../src/types";

beforeAll(() => installObsidianDom());
afterEach(() => { document.body.innerHTML = ""; });

function gantt() {
  const project: Project = { path: "Site.md", name: "Site", openTasks: 1, completedTasks: 0, archived: false, scheduledDate: "2026-10-01", endDate: "2026-10-20" };
  const menu = vi.fn();
  const container = document.body.createDiv();
  renderGantt(container, { projects: [project], anchor: "2026-10-01", zoom: "month", dateFormat: "YYYY-MM-DD", navigate: vi.fn(), open: vi.fn(), update: vi.fn(), menu });
  const scroll = container.querySelector<HTMLElement>(".tm-gantt-scroll")!;
  Object.assign(scroll, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  const title = container.querySelector<HTMLElement>(".tm-gantt-project .tm-task-title")!;
  const pointer = (target: HTMLElement, type: string, x: number, y: number) =>
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 2, pointerId: 1, clientX: x, clientY: y }));
  return { project, menu, scroll, title, pointer };
}

it("opens a project's actions on a right-click that stays put, and pans on a right-drag", () => {
  const { project, menu, scroll, title, pointer } = gantt();
  pointer(title, "pointerdown", 100, 50);
  pointer(scroll, "pointerup", 101, 50);
  expect(menu).toHaveBeenCalledExactlyOnceWith(project, { x: 101, y: 50 }, title);
  // The right button's own menu event, after it, opens nothing more.
  title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 101, clientY: 50 }));
  expect(menu).toHaveBeenCalledOnce();
  pointer(title, "pointerdown", 100, 50);
  pointer(scroll, "pointermove", 160, 50);
  pointer(scroll, "pointerup", 160, 50);
  expect(menu).toHaveBeenCalledOnce();
});

it("opens a project's actions on Ctrl-click, but not over the timeline's header", () => {
  const { project, menu, scroll, title } = gantt();
  title.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 0, ctrlKey: true, clientX: 20, clientY: 30 }));
  expect(menu).toHaveBeenCalledExactlyOnceWith(project, { x: 20, y: 30 }, title);
  scroll.querySelector<HTMLElement>(".tm-gantt-header")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 0, clientX: 20, clientY: 5 }));
  expect(menu).toHaveBeenCalledOnce();
});
