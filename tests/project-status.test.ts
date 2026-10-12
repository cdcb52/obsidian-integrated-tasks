import { expect, it } from "vitest";
import { activeProjects, projectStatuses, projectTotals } from "../src/project-progress";
import { projectChoices } from "../src/choice-popover";
import type { Project } from "../src/types";

const project = (name: string, openTasks: number, completedTasks: number, extra: Partial<Project> = {}): Project =>
  ({ path: `${name}.md`, name, openTasks, completedTasks, ...extra });

it("counts a project without a status whose tasks are all done as done, else to do", () => {
  const projects = [
    project("Doing", 2, 1), project("Done", 0, 3), project("Empty", 0, 0), project("Shelved", 0, 2, { status: "cancelled" }),
    // A parent whose own tasks are done stays active while a subproject is; once that is done too, so is the parent.
    project("Parent", 0, 1), project("Child", 1, 0, { parentPath: "Parent.md" }),
    project("Finished parent", 0, 1), project("Finished child", 0, 2, { parentPath: "Finished parent.md" })
  ];
  expect(Object.fromEntries(projectStatuses(projects))).toEqual({
    "Doing.md": "todo", "Done.md": "done", "Empty.md": "todo", "Shelved.md": "cancelled",
    "Parent.md": "todo", "Child.md": "todo", "Finished parent.md": "done", "Finished child.md": "done"
  });
  expect(activeProjects(projects).map(item => item.name)).toEqual(["Doing", "Empty", "Parent", "Child"]);
  // Moving a task offers only active projects.
  expect(projectChoices(projects, "Inbox.md").map(choice => choice.label)).toEqual(["Inbox", "Child", "Doing", "Empty", "Parent"]);
});

it("counts a subproject's tasks towards its parent, leaving a cancelled one out", () => {
  const projects = [
    // Two done tasks of its own, twenty open in a subproject: a tenth done, and active.
    project("House", 0, 2), project("Kitchen", 20, 0, { parentPath: "House.md" }),
    // With no tasks of its own, it completes with its subprojects.
    project("Trip", 0, 0), project("Flights", 0, 2, { parentPath: "Trip.md" }), project("Hotel", 0, 1, { parentPath: "Trip.md" }),
    project("Garden", 0, 1), project("Pond", 3, 0, { parentPath: "Garden.md", status: "cancelled" })
  ];
  expect(projectTotals(projects).get("House.md")).toEqual({ open: 20, completed: 2 });
  expect(projectTotals(projects).get("Trip.md")).toEqual({ open: 0, completed: 3 });
  expect(projectTotals(projects).get("Garden.md")).toEqual({ open: 0, completed: 1 });
  expect(Object.fromEntries(projectStatuses(projects))).toMatchObject({ "House.md": "todo", "Trip.md": "done", "Garden.md": "done" });
});

it("lets a status property say a project's status, whatever its tasks", () => {
  const projects = [
    project("Started", 0, 3, { status: "doing" }), project("Shipped", 2, 0, { status: "done" }), project("Dropped", 1, 0, { status: "cancelled" }),
    project("Paused", 0, 0, { status: "waiting" })
  ];
  expect(Object.fromEntries(projectStatuses(projects))).toEqual({ "Started.md": "doing", "Shipped.md": "done", "Dropped.md": "cancelled", "Paused.md": "waiting" });
  expect(activeProjects(projects).map(item => item.name)).toEqual(["Started", "Paused"]);
});
