import { isClosedStatus } from "./task-status";
import type { Project, ProjectTotals, TaskStatus } from "./types";

/** A fixed outline with an inset pie fill, matching the project's completion ratio. */
export function renderProjectProgress(parent: HTMLElement, project: Project, showPercentage = true): void {
    const { open, completed } = project.totals ?? { open: project.openTasks, completed: project.completedTasks };
    const total = open + completed;
    const ratio = total ? Math.max(0, Math.min(1, completed / total)) : 0;
    const percentage = Math.round(ratio * 100);
    const progress = parent.createDiv({ cls: "tm-project-progress", attr: {
        role: "progressbar",
        "aria-label": `${project.name}: ${completed} of ${total} tasks completed`,
        "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(percentage),
        title: `${percentage}% — ${completed} of ${total} tasks completed`
    } });
    if (project.color) progress.style.setProperty("--tm-project-color", project.color);
    const circle = progress.createSpan({ cls: "tm-project-progress-circle", attr: { "aria-hidden": "true" } });
    circle.style.setProperty("--tm-project-progress", `${ratio * 100}%`);
    if (showPercentage) progress.createSpan({ cls: "tm-project-percentage", text: `${percentage}%` });
}

function subprojects(projects: Project[]): Map<string, Project[]> {
  const children = new Map<string, Project[]>();
  for (const project of projects) if (project.parentPath) children.set(project.parentPath, [...children.get(project.parentPath) ?? [], project]);
  return children;
}

/** Each project's open and completed tasks, its subprojects' included; a cancelled subproject's are left out. */
export function projectTotals(projects: Project[]): Map<string, ProjectTotals> {
  const children = subprojects(projects);
  const totals = new Map<string, ProjectTotals>();
  const total = (project: Project, seen: Set<string>): ProjectTotals => {
    const known = totals.get(project.path);
    if (known) return known;
    seen.add(project.path);
    const sum = { open: project.openTasks, completed: project.completedTasks };
    for (const child of children.get(project.path) ?? []) {
      if (child.status === "cancelled" || seen.has(child.path)) continue;
      const counts = total(child, seen);
      sum.open += counts.open;
      sum.completed += counts.completed;
    }
    totals.set(project.path, sum);
    return sum;
  };
  for (const project of projects) total(project, new Set());
  return totals;
}

/**
 * Each project's status: its `status` property, or without one, as in Things, Done once its tasks are all done (100%)
 * and To do until then. One with no tasks yet is still To do, and so is one with a subproject still open. A
 * subproject's tasks count towards its parent's, so a parent with none of its own is done with its subprojects.
 */
export function projectStatuses(projects: Project[]): Map<string, TaskStatus> {
  const children = subprojects(projects);
  const totals = projectTotals(projects);
  const statuses = new Map<string, TaskStatus>();
  const status = (project: Project, seen: Set<string>): TaskStatus => {
    const known = statuses.get(project.path);
    if (known) return known;
    if (seen.has(project.path)) return "todo";
    seen.add(project.path);
    const { open, completed } = totals.get(project.path)!;
    const result: TaskStatus = project.status ?? (open === 0 && completed > 0
      && !(children.get(project.path) ?? []).some(child => !isClosedStatus(status(child, seen))) ? "done" : "todo");
    statuses.set(project.path, result);
    return result;
  };
  for (const project of projects) status(project, new Set());
  return statuses;
}

/** The projects still in progress: neither done nor cancelled. */
export function activeProjects(projects: Project[]): Project[] {
  const statuses = projectStatuses(projects);
  return projects.filter(project => !isClosedStatus(statuses.get(project.path) ?? "todo"));
}
