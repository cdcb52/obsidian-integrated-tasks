import type { App, PaneType, TFile, WorkspaceLeaf } from "obsidian";

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

/**
 * Opens `file` where `leafFor` says. In the tab in front, that tab becomes the active one with focus in it, as when the
 * file explorer opens a file: otherwise the task sidebar keeps focus, and Obsidian (whose active tab did not change)
 * tells nothing, such as the sidebar, that another file opened. A new tab is made active only when Obsidian's Always
 * focus new tabs is on, as for any new tab.
 */
export async function openFileIn(app: App, file: TFile, newLeaf: PaneType | boolean): Promise<WorkspaceLeaf> {
  const leaf = leafFor(app, newLeaf);
  await (newLeaf ? leaf.openFile(file) : leaf.openFile(file, { active: true }));
  return leaf;
}
