import { Notice, TFile } from "obsidian";
import type TaskManagerPlugin from "./main";
import type { Project } from "./types";
import type { ProjectDraft } from "./project-creator";
import { openDatePopover } from "./date-popover";
import { openActionMenu, openTagsPopover, priorityIcons } from "./task-menu";
import { openConfirm } from "./confirm-modal";
import { openChoicePopover, PRIORITY_CHOICES, type Choice } from "./choice-popover";
import { activeProjects } from "./project-progress";
import { PROJECT_COLORS, projectColorValue } from "./project-properties";
import { STATUS_ICONS, STATUS_LABELS, TASK_STATUSES } from "./task-status";

export interface ProjectMenuOptions {
  /** Where the menu opens (the pointer, for a right-click); else below `anchor`. */
  at?: { x: number; y: number };
  /** Adds or edits the description, on the project's own page, where it shows. */
  editDescription?: () => void;
}

/** Saves a change to a project's properties; a failure shows as a notice. */
function updateProject(plugin: TaskManagerPlugin, project: Project, change: (draft: ProjectDraft) => ProjectDraft): void {
  void plugin.updateProject(project.path, change).catch((cause: unknown) => {
    new Notice(cause instanceof Error ? cause.message : "Could not update the project.");
  });
}

/**
 * A project's actions, like a task's: priority at once; status, dates, parent, tags, colour and name in popovers
 * beside the menu; its description (on its page); add it to the task sidebar's Favorites; open its note, or delete it.
 */
export function openProjectMenu(plugin: TaskManagerPlugin, project: Project, anchor: HTMLElement, options: ProjectMenuOptions = {}): void {
  const rect = anchor.getBoundingClientRect();
  const beside = (property: keyof ProjectDraft) => (target: HTMLElement): void => openProjectProperty(plugin, project, property, target, true, () => menu.close());
  const favorite = `project:${project.path}`;
  const favorited = plugin.isFavorite(favorite);
  // The button reads as pressed while its menu is open.
  anchor.setAttribute("aria-expanded", "true");
  const menu = openActionMenu({
    doc: anchor.ownerDocument, at: options.at ?? { x: rect.left, y: rect.bottom + 4 }, label: "Project actions", returnFocus: anchor,
    onClose: () => anchor.setAttribute("aria-expanded", "false"),
    entries: [
      { kind: "icons", label: "Priority", key: "p", buttons: priorityIcons(project.priority, priority => updateProject(plugin, project, draft => ({ ...draft, priority: priority ? String(priority) : "" }))) },
      { kind: "separator" },
      { kind: "submenu", label: "Status", icon: project.status ? STATUS_ICONS[project.status] : "circle-dashed", key: "s", open: beside("status") },
      { kind: "submenu", label: "Start date", icon: "calendar", key: "d", open: beside("date") },
      { kind: "submenu", label: "End date", icon: "calendar-check", key: "e", open: beside("endDate") },
      { kind: "submenu", label: "Deadline", icon: "flag", key: "D", open: beside("deadline") },
      { kind: "submenu", label: "Parent project", icon: "folder-tree", key: "g", open: beside("parent") },
      { kind: "submenu", label: "Tags", icon: "tag", key: "t", open: beside("tags") },
      { kind: "submenu", label: "Color", icon: "palette", key: "c", open: beside("color") },
      { kind: "submenu", label: "Rename", icon: "pencil", key: "n", open: beside("name") },
      { kind: "separator" },
      ...options.editDescription ? [{ kind: "item" as const, label: project.description ? "Edit description" : "Add description", icon: "align-left", run: options.editDescription }] : [],
      { kind: "item", label: favorited ? "Remove from favorites" : "Add to favorites", icon: favorited ? "star-off" : "star",
        run: () => void plugin.toggleFavorite(favorite).catch((cause: unknown) => { new Notice(cause instanceof Error ? cause.message : "Could not change the favorites."); }) },
      { kind: "item", label: "Open note", icon: "file-text", run: () => {
        const file = plugin.app.vault.getAbstractFileByPath(project.path);
        if (file instanceof TFile) void plugin.app.workspace.getLeaf("tab").openFile(file);
      } },
      { kind: "separator" },
      { kind: "item", label: "Delete project", icon: "trash-2", danger: true, run: () => confirmDeleteProject(plugin, project) }
    ]
  });
}

function confirmDeleteProject(plugin: TaskManagerPlugin, project: Project): void {
  const tasks = project.openTasks + project.completedTasks;
  openConfirm(plugin.app, {
    title: `Delete “${project.name}”?`,
    message: `Its note${tasks ? `, with ${tasks} task${tasks === 1 ? "" : "s"},` : ""} moves to the trash. Subprojects keep their notes.`,
    confirm: "Delete project", danger: true,
    run: () => void plugin.deleteProject(project.path).catch((cause: unknown) => { new Notice(cause instanceof Error ? cause.message : "Could not delete the project."); })
  });
}

/** A project property's popover beside `anchor` (the property itself, or a menu row): a date, priority, parent, tags, colour or name. */
export function openProjectProperty(plugin: TaskManagerPlugin, project: Project, property: keyof ProjectDraft, anchor: HTMLElement, beside = false, done?: () => void): void {
  const current = plugin.projectDraft(project);
  const save = (change: (draft: ProjectDraft) => ProjectDraft): void => { done?.(); updateProject(plugin, project, change); };
  if (property === "date" || property === "endDate" || property === "deadline") {
    const label = property === "date" ? "Start date" : property === "endDate" ? "End date" : "Deadline";
    const value = property === "date" ? project.scheduledDate : property === "endDate" ? project.endDate : project.deadline;
    openDatePopover({
      anchor, beside, kind: "date", label, dateFormat: plugin.dateFormat(), value: { date: value },
      // The note stores dates in the vault's format; the editor reads ISO dates too.
      save: next => save(draft => ({ ...draft, [property]: next.date ?? "" }))
    });
  } else if (property === "priority") {
    openChoicePopover({ anchor, beside, label: "Priority", choices: PRIORITY_CHOICES, cycleKey: "p", selected: current.priority, choose: value => save(draft => ({ ...draft, priority: value })) });
  } else if (property === "status") {
    const choices: Choice[] = TASK_STATUSES.map(status => ({ value: status, label: STATUS_LABELS[status], icon: STATUS_ICONS[status] }));
    choices.push({ value: "", label: "No status", separated: true });
    openChoicePopover({ anchor, beside, label: "Status", choices, cycleKey: "s", selected: project.status ?? "", choose: value => save(draft => ({ ...draft, status: value })) });
  } else if (property === "parent") {
    // Not the project itself, nor one of its subprojects: a project cannot sit inside itself.
    const projects = plugin.index.projects();
    const inside = (candidate: Project): boolean => {
      for (let path: string | undefined = candidate.path, depth = 0; path && depth < 50; depth++) {
        if (path === project.path) return true;
        path = projects.find(item => item.path === path)?.parentPath;
      }
      return false;
    };
    const choices: Choice[] = activeProjects(projects).filter(item => !inside(item)).sort((a, b) => a.name.localeCompare(b.name))
      .map(item => ({ value: item.path, label: item.name, icon: "circle", color: item.color }));
    choices.push({ value: "", label: "No parent", separated: true });
    openChoicePopover({ anchor, beside, label: "Parent project", choices, selected: current.parent, input: { placeholder: "Find a project", filter: true },
      choose: value => save(draft => ({ ...draft, parent: value })) });
  } else if (property === "tags") {
    const own = current.tags.split(/[,\s]+/).filter(Boolean);
    // Other projects' tags are the ones to offer.
    const vault = [...new Set(plugin.index.projects().filter(item => item.path !== project.path)
      .flatMap(item => plugin.projectDraft(item).tags.split(/[,\s]+/)).filter(tag => tag && !own.includes(tag)))].sort((a, b) => a.localeCompare(b));
    let tags = own;
    const write = (): void => updateProject(plugin, project, draft => ({ ...draft, tags: tags.join(", ") }));
    openTagsPopover({
      anchor, beside, tags: [...own.map(name => ({ name, state: "all" as const })), ...vault.map(name => ({ name, state: "none" as const }))],
      // Frontmatter tags have no spaces: a typed "open house" becomes "open-house".
      toggle: (tag, on) => { tags = on ? [...new Set([...tags, tag])] : tags.filter(item => item !== tag); write(); },
      add: added => { tags = [...new Set([...tags, ...added.map(tag => tag.replace(/\s+/g, "-"))])]; write(); }
    });
  } else if (property === "color") {
    const choices: Choice[] = PROJECT_COLORS.map(color => ({ value: color, label: color[0].toUpperCase() + color.slice(1), icon: "circle", color: projectColorValue(color) }));
    choices.push({ value: "", label: "No color", separated: true });
    openChoicePopover({
      anchor, beside, label: "Color", choices, selected: current.color,
      input: { placeholder: "Find a color, or type a hex such as #3b82f6", filter: true,
        parse: text => /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? { value: `#${text.replace(/^#/, "").toLowerCase()}`, label: `Use #${text.replace(/^#/, "").toLowerCase()}` } : undefined },
      choose: value => save(draft => ({ ...draft, color: value }))
    });
  } else if (property === "name") {
    openChoicePopover({
      anchor, beside, label: "Rename project", choices: [],
      input: { placeholder: "Project name", value: project.name, invalid: "", parse: text => text && text !== project.name ? { value: text, label: `Rename to “${text}”` } : undefined },
      choose: name => save(draft => ({ ...draft, name }))
    });
  }
}
