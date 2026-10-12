import { Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindNoteTaskEdit, handleTaskEditClick, handleRecurringTaskClick } from "../src/note-task-edit";
import { scanTasks } from "../src/parser";

function click(metaKey: boolean, isCheckbox = true) {
  return {
    metaKey, ctrlKey: false, button: 0,
    target: { closest: () => isCheckbox ? {} : null },
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn()
  };
}

const task = scanTasks("Note.md", "# Tasks\n- [ ] Parent\n  - [x] Child p1")[1];

describe("Mod-click task editing in notes", () => {
  afterEach(() => { Object.assign(Platform, { isMacOS: true }); });

  it.each([
    [true, true, false, true],
    [true, false, true, false],
    [false, false, true, true],
    [false, true, false, false]
  ])("uses the platform modifier (Mac: %s, Command: %s, Control: %s)", (isMacOS, metaKey, ctrlKey, shouldOpen) => {
    Object.assign(Platform, { isMacOS });
    const event = { ...click(metaKey), ctrlKey };
    const open = vi.fn();
    handleTaskEditClick(event as unknown as MouseEvent, () => task, open);
    expect(open).toHaveBeenCalledTimes(shouldOpen ? 1 : 0);
    expect(event.preventDefault).toHaveBeenCalledTimes(shouldOpen ? 1 : 0);
  });
  it("opens the resolved task and blocks the native completion toggle", () => {
    const event = click(true);
    const open = vi.fn();
    handleTaskEditClick(event as unknown as MouseEvent, () => task, open);
    expect(open).toHaveBeenCalledExactlyOnceWith(task);
    expect(task.completed).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it.each([[false, true, task], [true, false, task], [true, true, undefined]] as const)(
    "leaves ordinary clicks, non-checkboxes, and unrecognized tasks alone (%s, %s)",
    (metaKey, isCheckbox, resolved) => {
      const event = click(metaKey, isCheckbox);
      const open = vi.fn();
      handleTaskEditClick(event as unknown as MouseEvent, () => resolved, open);
      expect(open).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    }
  );
});


describe("checkbox presses in notes", () => {
  it("leaves a long press to Obsidian, opening nothing", () => {
    vi.useFakeTimers();
    const document = new EventTarget();
    const root = Object.assign(new EventTarget(), { ownerDocument: document, win: { setTimeout, clearTimeout } });
    const checkbox = { isConnected: true, closest: () => checkbox };
    const open = vi.fn();
    const dispose = bindNoteTaskEdit(root as unknown as HTMLElement, () => task, open);
    const event = Object.defineProperties(new Event("touchstart", { cancelable: true }), { target: { value: checkbox }, touches: { value: [{ identifier: 0, clientX: 0, clientY: 0 }] } });
    root.dispatchEvent(event);
    vi.advanceTimersByTime(1000);
    expect(open).not.toHaveBeenCalled();
    dispose();
    vi.useRealTimers();
  });
});


describe("recurring checkbox completion in notes", () => {
  const recurring = scanTasks("Project.md", "- [ ] [[Habit]] 2026-09-19")[0];
  it("claims an ordinary checkbox click before the native toggle", () => {
    const event = click(false);
    const complete = vi.fn(() => true);
    handleRecurringTaskClick(event as unknown as MouseEvent, () => recurring, complete);
    expect(complete).toHaveBeenCalledExactlyOnceWith(recurring);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });
  it("leaves non-recurring tasks to Obsidian", () => {
    const event = click(false);
    handleRecurringTaskClick(event as unknown as MouseEvent, () => recurring, () => false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it("does not complete an already checked task or a modifier-click", () => {
    const complete = vi.fn(() => true);
    handleRecurringTaskClick(click(false) as unknown as MouseEvent, () => ({ ...recurring, completed: true }), complete);
    handleRecurringTaskClick(click(true) as unknown as MouseEvent, () => recurring, complete);
    expect(complete).not.toHaveBeenCalled();
  });
});
