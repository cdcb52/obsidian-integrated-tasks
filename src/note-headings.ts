import { scanHeadings, type NoteHeading } from "./structure";

/** A heading as a task view groups by it: its line and name, which must still read so when the note is changed. */
export type HeadingRef = Pick<NoteHeading, "line" | "name">;

/** A note's lines, without the newline that ends its last one, and how to put them back together. */
function splitNote(content: string): { lines: string[]; join: (lines: string[]) => string } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const ended = lines.length > 1 && lines[lines.length - 1] === "";
  if (ended || content === "") lines.pop();
  return {
    lines,
    join: next => {
      // A section moved or added never leaves blank lines at the end.
      const kept = [...next];
      while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
      return kept.join(eol) + (ended || content === "" ? eol : "");
    }
  };
}

/** Where a section ends: the next heading as high as its own level or higher, else the note's end. */
function sectionEnd(headings: NoteHeading[], heading: NoteHeading, level: number, total: number): number {
  return headings.find(other => other.line > heading.endLine && other.level <= level)?.line ?? total;
}

/** Puts `block` into `lines` at `at`, with a blank line between it and text on either side. */
function insertBlock(lines: string[], at: number, block: string[]): string[] {
  const before = at > 0 && lines[at - 1].trim() ? [""] : [];
  const after = at < lines.length && lines[at].trim() ? [""] : [];
  return [...lines.slice(0, at), ...before, ...block, ...after, ...lines.slice(at)];
}

/**
 * Adds a heading named `name` at `level` at the end of the note; when the note ends with a section named `keepLast`
 * (the completed tasks section), just above it, so that section stays last.
 */
export function addSection(content: string, name: string, level: number, keepLast?: string): string {
  const { lines, join } = splitNote(content);
  const headings = scanHeadings(lines);
  const sections = headings.filter(heading => heading.level === level);
  const last = sections[sections.length - 1];
  if (keepLast && last?.name.toLocaleLowerCase() === keepLast.toLocaleLowerCase() && sectionEnd(headings, last, level, lines.length) === lines.length) {
    return join(insertBlock(lines, last.line, [`${"#".repeat(level)} ${name}`]));
  }
  // At the end, after the last line with text.
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return join(insertBlock(lines, lines.length, [`${"#".repeat(level)} ${name}`]));
}

/**
 * Moves the section under `from` (its heading and everything up to the next heading at `level` or higher) to just
 * before the section under `before`, or (without one) after the last section. Each must still be a heading at
 * `level` on its line, with its name; otherwise the note changed since and nothing is moved.
 */
export function moveSection(content: string, level: number, from: HeadingRef, before?: HeadingRef): string {
  const { lines, join } = splitNote(content);
  const headings = scanHeadings(lines);
  const sections = headings.filter(heading => heading.level === level);
  const find = (ref: HeadingRef): NoteHeading => {
    const found = sections.find(heading => heading.line === ref.line && heading.name === ref.name);
    if (!found) throw new Error("The note changed since it was shown. Try again.");
    return found;
  };
  const source = find(from);
  const start = source.line;
  const end = sectionEnd(headings, source, level, lines.length);
  const others = sections.filter(heading => heading !== source);
  const last = others[others.length - 1];
  const at = before ? find(before).line : last ? sectionEnd(headings, last, level, lines.length) : lines.length;
  // Before itself, or before the section that follows it: it stays where it is.
  if (at >= start && at <= end) return content;
  const block = lines.slice(start, end);
  while (block.length > 1 && !block[block.length - 1].trim()) block.pop();
  const rest = [...lines.slice(0, start), ...lines.slice(end)];
  return join(insertBlock(rest, at > start ? at - (end - start) : at, block));
}
