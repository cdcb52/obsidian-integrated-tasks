import { lineEnding } from "./markdown";
import { noteSnapshot, type NoteSnapshot } from "./task-block";
import { indentWidth } from "./task-indentation";
import { completedSectionName, scanHeadings, type NoteHeading } from "./structure";
import type { Task } from "./types";

/**
 * Where completing a task moves it in its note: nowhere ("keep"), below the rest of its list ("bottom"), or under a
 * heading of its own at the end of the note ("section").
 */
export type CompletedPlacement = "keep" | "bottom" | "section";

export interface PlacementOptions {
  placement: CompletedPlacement;
  /** The heading completed tasks move under with "section"; a heading below it names the section each came from. */
  section: string;
  sectionHeadingLevel?: number;
  dateFormat?: string;
}

/** A task whose status just went from open to closed (done or cancelled), or back: its first line, and which it is now. */
export interface StatusChange { line: number; closed: boolean }

const LIST_ITEM = /^[ \t]*(?:[-+*]|\d+[.)])\s+/;
const CHECKLIST = /^[ \t]*[-+*]\s+\[[^\]]\]/;

/**
 * Moves tasks whose status just changed (see StatusChange), each with its notes and subtasks: a completed one below the
 * rest of its list, or (with "section") under the completed tasks' heading, in a heading named after its own section;
 * a reopened one to the top of its list, or from that heading back to the top of the section it came from. A subtask
 * stays with its task, among its siblings. `content` is the note as the changes left it.
 */
export function placeChangedTasks(path: string, content: string, changes: StatusChange[], options: PlacementOptions): string {
  if (options.placement === "keep" || !changes.length) return content;
  const note = noteSnapshot(path, content, options.dateFormat, options.sectionHeadingLevel);
  const slots = note.lines.map(line => [line]);
  placeInSlots(slots, note, changes, options);
  return slots.flat().join(lineEnding(content));
}

type Side = "before" | "after";
/** Lines going in at one place: `head`, headings to create first, then the moved blocks, in the note's order. */
interface Group { rank: number; head: string[]; lines: string[] }

/**
 * As placeChangedTasks, on a note's lines kept one per slot (so planned edits keep their line numbers): each moved block
 * leaves its slots empty and joins the slot it goes before or after. `note` is the note these slots were read from.
 */
export function placeInSlots(slots: string[][], note: NoteSnapshot, changes: StatusChange[], options: PlacementOptions): void {
  if (options.placement === "keep" || !changes.length) return;
  const { lines } = note;
  const level = options.sectionHeadingLevel ?? 1;
  // Headings at the level below sections name, under the completed tasks' heading, the sections tasks came from.
  const subLevel = level < 6 ? level + 1 : undefined;
  const headings = scanHeadings(lines);
  const headingLines = new Set(headings.flatMap(heading => [heading.line, heading.endLine]));
  const logName = completedSectionName(options.section).toLocaleLowerCase();
  const log = options.placement === "section" ? note.sections.find(section => section.name.toLocaleLowerCase() === logName) : undefined;
  const logEnd = log ? note.sections.find(section => section.line > log.line)?.line ?? lines.length : 0;
  const inLog = (line: number): boolean => Boolean(log) && line > log!.endLine && line < logEnd;
  const subheadings = log && subLevel ? headings.filter(heading => heading.level === subLevel && inLog(heading.line)) : [];
  const tasks = [...note.tasks.values()];

  const blockEnd = (start: number, indent: number): number => {
    let end = start + 1;
    for (let cursor = end; cursor < lines.length; cursor++) {
      if (!lines[cursor].trim()) continue;
      if (headingLines.has(cursor) || indentWidth(lines[cursor]) <= indent) break;
      end = cursor + 1;
    }
    return end;
  };
  /** The list `start` is in: its items at that indentation, around it, up to a heading or a line less indented. */
  const run = (start: number): { first: number; end: number } => {
    const indent = indentWidth(lines[start]);
    let first = CHECKLIST.test(lines[start]) ? start : -1;
    for (let cursor = start - 1; cursor >= 0; cursor--) {
      const line = lines[cursor];
      if (!line.trim()) continue;
      if (headingLines.has(cursor) || note.nonBody.has(cursor) && indentWidth(line) <= indent) break;
      const depth = indentWidth(line);
      if (depth > indent) continue;
      if (depth < indent || !LIST_ITEM.test(line)) break;
      if (CHECKLIST.test(line)) first = cursor;
    }
    let end = blockEnd(start, indent);
    for (let cursor = end; cursor < lines.length; cursor++) {
      const line = lines[cursor];
      if (!line.trim()) continue;
      if (headingLines.has(cursor) || indentWidth(line) !== indent || !LIST_ITEM.test(line)) break;
      cursor = end = blockEnd(cursor, indent);
      cursor--;
    }
    return { first: first < 0 ? start : first, end };
  };
  const firstChecklist = (from: number, to: number): number => {
    for (let line = from; line < to; line++) if (!note.nonBody.has(line) && !headingLines.has(line) && CHECKLIST.test(lines[line])) return line;
    return -1;
  };
  const lastText = (from: number, to: number): number => {
    for (let line = to - 1; line > from; line--) if (lines[line].trim()) return line;
    return from;
  };
  const indentOf = (line: number): string => /^[ \t]*/.exec(lines[line])![0];
  const headingLine = (depth: number, name: string): string => `${"#".repeat(depth)} ${name}`;
  const named = (items: NoteHeading[], name: string | undefined): NoteHeading | undefined =>
    name === undefined ? undefined : items.find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());

  // Blocks that move, each to one place; a block inside another moving one goes with it.
  const moving = changes.map(change => note.tasks.get(change.line) && { change, task: note.tasks.get(change.line)! })
    .filter((entry): entry is { change: StatusChange; task: Task } => Boolean(entry))
    .map(entry => ({ ...entry, start: entry.task.line, end: blockEnd(entry.task.line, entry.task.indent) }))
    .sort((a, b) => a.start - b.start);
  const roots = moving.filter(entry => !moving.some(other => other !== entry && other.start < entry.start && entry.start < other.end));

  const targets = new Map<string, { slot: number; side: Side; groups: Map<string, Group> }>();
  const join = (slot: number, side: Side, key: string, rank: number, head: string[]): Group => {
    const place = `${side}:${slot}`;
    const target = targets.get(place) ?? { slot, side, groups: new Map<string, Group>() };
    targets.set(place, target);
    const group = target.groups.get(key) ?? { rank, head, lines: [] };
    target.groups.set(key, group);
    return group;
  };
  /** Where an open or closed block goes in its own list (or, for a subtask, among its siblings). */
  const inList = (task: Task, closed: boolean): { slot: number; side: Side } => {
    if (task.parentId) {
      const siblings = tasks.filter(item => item.parentId === task.parentId).sort((a, b) => a.line - b.line);
      const last = siblings[siblings.length - 1];
      return closed ? { slot: blockEnd(last.line, last.indent) - 1, side: "after" } : { slot: siblings[0].line, side: "before" };
    }
    const list = run(task.line);
    return closed ? { slot: list.end - 1, side: "after" } : { slot: list.first, side: "before" };
  };
  const emptied: NoteHeading[] = [];
  for (const entry of roots) {
    const { task, change } = entry;
    let group: Group | undefined;
    // Lines from another list take its indentation.
    let indent: string | undefined;
    const logged = !task.parentId && inLog(task.line);
    if (options.placement === "section" && !task.parentId && change.closed && !logged) {
      const origin = subLevel ? task.section : undefined;
      if (!log) {
        // The completed tasks' heading goes at the end of the note, with a heading for the task's section under it.
        const slot = lastText(-1, lines.length);
        join(slot, "after", "log", 1, ["", headingLine(level, completedSectionName(options.section))]);
        group = origin ? join(slot, "after", `log/${origin.toLocaleLowerCase()}`, 2, ["", headingLine(subLevel!, origin)]) : join(slot, "after", "log", 1, []);
      } else {
        const sub = named(subheadings, origin);
        const scopeStart = sub ? sub.endLine + 1 : log.endLine + 1;
        const scopeEnd = sub ? headings.find(heading => heading.line > sub.line && heading.level <= subLevel!)?.line ?? logEnd
          : subheadings[0]?.line ?? logEnd;
        const first = origin && !sub ? -1 : firstChecklist(scopeStart, Math.min(scopeEnd, logEnd));
        if (first >= 0) {
          group = join(run(first).end - 1, "after", "list", 0, []);
          indent = indentOf(first);
        } else if (origin && !sub) {
          group = join(lastText(log.line, logEnd), "after", `log/${origin.toLocaleLowerCase()}`, 2, ["", headingLine(subLevel!, origin)]);
          indent = "";
        } else {
          group = join(sub ? sub.endLine : log.endLine, "after", "log", 1, []);
          indent = "";
        }
      }
      indent ??= "";
    } else if (options.placement === "section" && logged && !change.closed) {
      // Back to the top of the section it came from, when the note still has it; under no heading, the note's top.
      const sub = subLevel ? [...subheadings].reverse().find(heading => heading.line < task.line) : undefined;
      const origin = sub?.name;
      const section = origin === undefined ? undefined : named(note.sections.filter(item => item !== log), origin);
      if (origin !== undefined && !section) continue;
      const bodyStart = lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line)) + 1 : 0;
      const scopeStart = section ? section.endLine + 1 : bodyStart;
      const scopeEnd = section ? note.sections.find(item => item.line > section.line)?.line ?? lines.length : note.sections[0]?.line ?? lines.length;
      const first = firstChecklist(scopeStart, scopeEnd);
      if (first >= 0) { group = join(first, "before", "list", 0, []); indent = indentOf(first); }
      else if (section) { group = join(section.endLine, "after", "list", 0, []); indent = ""; }
      else { group = join(scopeStart, "before", "list", 0, []); indent = ""; }
      if (sub) emptied.push(sub);
    } else {
      const place = inList(task, change.closed);
      group = join(place.slot, place.side, "list", 0, []);
    }
    const block = slots.slice(entry.start, entry.end).flat();
    for (let line = entry.start; line < entry.end; line++) slots[line] = [];
    group.lines.push(...(indent === undefined ? block : reindent(block, indent)));
  }

  // A heading left with nothing under it goes too (with the blank lines it leaves at the note's end).
  for (const sub of emptied) {
    const end = headings.find(heading => heading.line > sub.line && heading.level <= subLevel!)?.line ?? logEnd;
    if ([...targets.values()].some(target => target.slot >= sub.line && target.slot < end)) continue;
    let blank = true;
    for (let line = sub.endLine + 1; line < end; line++) if (slots[line].some(text => text.trim())) blank = false;
    if (!blank) continue;
    const last = end === slots.length && slots[end - 1]?.length === 1 && !slots[end - 1][0].trim() ? end - 1 : end;
    for (let line = sub.line; line < last; line++) slots[line] = [];
    if (end === slots.length) for (let line = sub.line - 1; line >= 0 && slots[line].every(text => !text.trim()); line--) slots[line] = [];
  }

  for (const { slot, side, groups } of targets.values()) {
    const added = [...groups.values()].sort((a, b) => a.rank - b.rank).flatMap(group => [...group.head, ...group.lines]);
    // A heading created where nothing comes before it needs no blank line above it.
    if (added[0] === "" && slots.slice(0, side === "after" ? slot + 1 : slot).every(lines => lines.every(text => !text.trim()))) added.shift();
    if (side === "after") slots[slot].push(...added);
    else slots[slot].unshift(...added);
  }
}

/** A block moved to another list: its first line's indentation comes off every line, and `indent` goes on. */
function reindent(block: string[], indent: string): string[] {
  const lead = /^[ \t]*/.exec(block[0] ?? "")![0];
  return block.map(line => {
    if (!line.trim()) return line;
    return indent + (line.startsWith(lead) ? line.slice(lead.length) : line.trimStart());
  });
}
