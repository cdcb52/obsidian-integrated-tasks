import { Platform, editorInfoField, MarkdownRenderChild, type MarkdownPostProcessorContext } from "obsidian";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Text } from "@codemirror/state";
import { todayIso } from "./date";
import { scanTasks } from "./parser";
import type { Task } from "./types";

type OpenTask = (task: Task) => void;

/** Capture before Obsidian's checkbox handler can toggle the task. */
export function handleTaskEditClick(event: MouseEvent, resolve: (checkbox: HTMLElement) => Task | undefined, open: OpenTask): void {
  if (!(Platform.isMacOS ? event.metaKey : event.ctrlKey) || event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  const checkbox = target?.closest?.<HTMLElement>('input[type="checkbox"]');
  if (!checkbox) return;
  const task = resolve(checkbox);
  if (!task) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  open(task);
}

/** Claim ordinary checkbox clicks before the native checkbox write: `complete` for open tasks (repeats), `reopen` for checked ones. */
export function handleRecurringTaskClick(event: MouseEvent, resolve: (checkbox: HTMLElement) => Task | undefined, complete?: (task: Task) => boolean, reopen?: (task: Task) => boolean): void {
  if ((!complete && !reopen) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const checkbox = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('input[type="checkbox"]');
  if (!checkbox) return;
  const task = resolve(checkbox);
  const claim = task?.completed ? reopen : complete;
  if (!task || !claim?.(task)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

/** Share click handling between Live Preview and Reading view: Cmd/Ctrl-click opens a task, and a click completes a repeat. */
export function bindNoteTaskEdit(root: HTMLElement, resolve: (checkbox: HTMLElement) => Task | undefined, open: OpenTask, complete?: (task: Task) => boolean, reopen?: (task: Task) => boolean): () => void {
  const click = (event: MouseEvent): void => {
    handleTaskEditClick(event, resolve, open);
    handleRecurringTaskClick(event, resolve, complete, reopen);
  };
  root.addEventListener("click", click, true);
  return () => root.removeEventListener("click", click, true);
}

export function noteTaskEditEditor(getDateFormat: () => string, open: OpenTask, getSectionHeadingLevel: () => number = () => 1, complete?: (task: Task) => boolean) {
  return ViewPlugin.fromClass(class {
    // Every checkbox click resolves its task; reuse one scan per document version.
    private scanned?: { doc: Text; key: string; tasks: Map<number, Task> };
    private resolve = (checkbox: HTMLElement): Task | undefined => {
      const path = this.view.state.field(editorInfoField, false)?.file?.path;
      if (!path) return;
      const doc = this.view.state.doc;
      const line = doc.lineAt(this.view.posAtDOM(checkbox));
      if (!/^\s*-\s+\[[^\]]\]/.test(line.text)) return;
      const key = `${path}\u0000${getDateFormat()}\u0000${getSectionHeadingLevel()}\u0000${todayIso()}`;
      if (this.scanned?.doc !== doc || this.scanned.key !== key) {
        const tasks = scanTasks(path, doc.toString(), new Date(), getDateFormat(), getSectionHeadingLevel());
        this.scanned = { doc, key, tasks: new Map(tasks.map(task => [task.line, task])) };
      }
      return this.scanned.tasks.get(line.number - 1);
    };
    private dispose: () => void;

    constructor(private view: EditorView) {
      this.dispose = bindNoteTaskEdit(view.dom, this.resolve, open, complete);
    }

    destroy(): void { this.dispose(); }
  });
}

/** Reading-view sections can span the whole note; reuse one scan per section text and context. */
interface SectionScan { path: string; text: string; format: string; level: number; day: string; tasks: Map<number, Task> }
const sectionScans: SectionScan[] = [];

function sectionTasks(path: string, text: string, format: string, level: number): Map<number, Task> {
  const day = todayIso();
  const index = sectionScans.findIndex(scan => scan.path === path && scan.format === format && scan.level === level && scan.day === day && scan.text === text);
  if (index >= 0) {
    const [scan] = sectionScans.splice(index, 1);
    sectionScans.unshift(scan);
    return scan.tasks;
  }
  const tasks = new Map(scanTasks(path, text, new Date(), format, level).map(task => [task.line, task]));
  sectionScans.unshift({ path, text, format, level, day, tasks });
  // A few recent sections cover the open notes without retaining old note text.
  sectionScans.length = Math.min(sectionScans.length, 16);
  return tasks;
}

export function registerNoteTaskEdit(root: HTMLElement, context: MarkdownPostProcessorContext, getDateFormat: () => string, open: OpenTask, getSectionHeadingLevel: () => number = () => 1, complete?: (task: Task) => boolean, reopen?: (task: Task) => boolean): void {
  // Most rendered sections have no checklist; they need no listener.
  if (!root.matches?.("li.task-list-item") && !root.querySelector?.("li.task-list-item")) return;
  const child = new MarkdownRenderChild(root);
  context.addChild(child);
  child.register(bindNoteTaskEdit(root, checkbox => {
    const item = checkbox.closest<HTMLElement>("li.task-list-item");
    if (!item) return;
    const section = context.getSectionInfo(item);
    if (!section) return;
    // Obsidian's rendered task line is relative to the containing section.
    const relativeLine = item.getAttribute("data-line");
    if (relativeLine === null || !/^\d+$/.test(relativeLine)) return;
    const line = section.lineStart + Number(relativeLine);
    return sectionTasks(context.sourcePath, section.text, getDateFormat(), getSectionHeadingLevel()).get(line);
  }, open, complete, reopen));
}
