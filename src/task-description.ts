import { indentStep, indentText, indentWidth } from "./task-indentation";
import { scanTasks, serializeTask } from "./parser";
import { nonBodyLines } from "./structure";
import type { TaskDraft } from "./types";

/** Whether notes are bullets alone at their margin, as notes typed here are saved (no notes count too). */
export function bulletNotes(description: string | undefined): boolean {
  return (description ?? "").split("\n").every(line => !/^\S/.test(line) || /^[-*+] /.test(line));
}

/**
 * Notes as lines indented beneath a task. With `bullets`, each line at the margin becomes a bullet; without, text,
 * quotes and lists keep the shape typed. Either way a checklist line becomes a bullet's text, so it stays notes rather
 * than a subtask, and a fenced code block is kept as it is.
 */
export function descriptionLines(text: string, indent: number, bullets = true): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const expanded = lines.map(line => line.replace(/^\s*/, spaces => spaces.replace(/\t/g, " ".repeat(indentStep()))));
  const margin = Math.min(...expanded.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length));
  // A blank line first, so a leading "---" is not read as the start of YAML.
  const fenced = nonBodyLines(["", ...expanded]);
  return expanded.map((source, index) => {
    const line = source.slice(Number.isFinite(margin) ? margin : 0);
    if (!line.trim()) return "";
    const bullet = /^\s*[-+*]\s+/.test(line);
    const checkbox = /^\s*[-+*]\s+\[[ xX/?-]\](?:\s|$)/.test(line);
    const value = fenced.has(index + 1) || ((bullet || !bullets || /^\s+\S/.test(line)) && !checkbox) ? line : `- ${line}`;
    return indentText(indent + indentStep() + indentWidth(value)) + value.trimStart();
  });
}

/**
 * Keep original line slots until all task edits/moves have resolved their offsets. Notes that were bullets alone (or
 * none) save as bullets; notes the note writes otherwise keep the shape typed.
 */
export function replaceDescription(slots: string[][], line: number, ownedLines: number[], text: string, indent: number, original?: string): void {
  for (const owned of ownedLines) slots[owned] = [];
  slots[line].push(...descriptionLines(text, indent, bulletNotes(original)));
}

export function newTaskLines(draft: TaskDraft, dateFormat?: string, linkDates = true): string[] {
  const lines = [serializeTask({ ...draft, indent: 0 }, dateFormat, linkDates), ...(draft.additionalLines ?? [])];
  if (draft.description === undefined) return lines;
  const task = scanTasks("", lines.join("\n"), new Date(), dateFormat)[0];
  const slots = lines.map(line => [line]);
  replaceDescription(slots, 0, task?.descriptionLines ?? [], draft.description, 0);
  return slots.flat();
}
