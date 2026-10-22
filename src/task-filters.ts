import { TASK_PROPERTIES } from "./task-properties";
import type { SmartList, TaskFilter, TaskGrouping, TaskProperty, TaskSort } from "./types";

export function cloneTaskFilters(filters: readonly TaskFilter[]): TaskFilter[] {
  return filters.map(filter => ({
    ...filter,
    values: [...filter.values],
    ...(filter.conditions ? {
      conditions: filter.conditions.map(condition => ({ ...condition, values: [...condition.values] }))
    } : {})
  }));
}

/** A smart list's saved values, without its id: its name, filters (copied), sorting and grouping. */
export type SmartListDraft = Omit<SmartList, "id">;
export function smartListDraft(list?: SmartList): SmartListDraft {
  return list ? { name: list.name, filters: cloneTaskFilters(list.filters), sort: list.sort, descending: list.descending, grouping: list.grouping,
    ...(list.showProjects === false ? { showProjects: false } : {}), ...(list.scope ? { scope: list.scope } : {}) }
    : { name: "", filters: [], sort: "date", descending: false, grouping: "default" };
}

/**
 * Saved View options or a smart list, rid of a property that no longer exists: filters on it go, and a sort or grouping
 * by it goes back to the default.
 */
export function forgetUnknownProperties(options: { filters?: TaskFilter[]; sort?: TaskSort; grouping?: TaskGrouping }): void {
  const known = (key: unknown): boolean => TASK_PROPERTIES.some(property => property.key === key);
  if (Array.isArray(options.filters)) options.filters = options.filters.filter(filter => known(filter?.property));
  if (typeof options.sort === "string" && options.sort !== "date" && !known(options.sort)) options.sort = "date";
  if (typeof options.grouping === "string" && !["default", "none", "date"].includes(options.grouping) && !known(options.grouping)) options.grouping = "default";
}

/** View options › No date, for both the scheduled date and the deadline. */
export const UNDATED_FILTERS: readonly TaskFilter[] = [
  { property: "scheduledDate", operator: "missing", values: [] },
  { property: "deadline", operator: "missing", values: [] }
];
const DATE_PROPERTIES = new Set<TaskProperty>(["scheduledDate", "scheduledTime", "deadline", "deadlineTime"]);

/** A view's filters narrowed to its tasks without a date: any on dates give way to No date for both. */
export function undatedFilters(filters: readonly TaskFilter[]): TaskFilter[] {
  return cloneTaskFilters([...filters.filter(filter => !DATE_PROPERTIES.has(filter.property)), ...UNDATED_FILTERS]);
}
