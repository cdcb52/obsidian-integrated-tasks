import type { App, PaneType, WorkspaceLeaf } from "obsidian";

/**
 * Where the task sidebar opens what it lists: a new tab, split or window, as `getLeaf` gives; or for false the tab in
 * front (unless pinned), whatever it shows, as the file explorer opens a file. Obsidian's own choice would open a new
 * tab beside a task list, which is no note, and the task view would open beside a note.
 */
export function leafFor(app: App, newLeaf: PaneType | boolean): WorkspaceLeaf {
  if (newLeaf) return app.workspace.getLeaf(newLeaf);
  const front = app.workspace.getMostRecentLeaf?.(app.workspace.rootSplit);
  return front && !front.getViewState().pinned ? front : app.workspace.getLeaf(false);
}
