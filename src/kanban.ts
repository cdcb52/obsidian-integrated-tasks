import { groupTasks } from "./query";
import { taskGroupTarget, type ListDropGroup } from "./list-drag";
import { STATUS_LABELS, TASK_STATUSES } from "./task-status";
import type { NoteHeading } from "./structure";
import type { Task, TaskGrouping } from "./types";

/** `heading`: a note's heading the column is, which drags to reorder the note's sections. */
export interface KanbanColumn { title: string; tasks: Task[]; target?: ListDropGroup; alert?: boolean; heading?: NoteHeading }
export function kanbanColumns(tasks: Task[], grouping: TaskGrouping): KanbanColumn[] {
  if (grouping === "none") return [{ title: "Tasks", tasks }];
  const property = grouping === "default" ? "section" : grouping;
  const groups = groupTasks(tasks, property);
  if (property === "status") return TASK_STATUSES.map(status => STATUS_LABELS[status])
    .map(title => ({ title, tasks: groups.get(title) ?? [], target: { property, value: title } }));
  if (property === "priority") return [1, 2, 3, undefined].map(value => {
    const title = value ? `P${value}` : "No priority";
    return { title, tasks: groups.get(title) ?? [], target: { property, value } };
  });
  return [...groups].map(([title, tasks]) => ({ title, tasks, target: taskGroupTarget(property, tasks[0]) }));
}
