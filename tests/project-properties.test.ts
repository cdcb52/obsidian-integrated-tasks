import { describe, expect, it } from "vitest";
import { addProjectProperties, parseProjectProperties } from "../src/project-properties";

describe("project note properties", () => {
  it("reads the note's date, end date and priority without project duration", () => {
    expect(parseProjectProperties({ date: "2026-08-28", "end date": "2026-09-10", priority: "p1", duration: "1h 30m" })).toEqual({
      scheduledDate: "2026-08-28", endDate: "2026-09-10", deadline: undefined, priority: 1
    });
  });

  it("accepts date links, property name variants", () => {
    expect(parseProjectProperties({ "Start-Date": ["[[05-09-2026]]"], end_date: "[[10-09-2026|Finish]]", Priority: 2, duration: 45 }, "DD-MM-YYYY")).toEqual({
      scheduledDate: "2026-09-05", endDate: "2026-09-10", deadline: undefined, priority: 2
    });
  });

  it("omits empty or malformed properties", () => {
    expect(parseProjectProperties({ date: "2026-02-30", "end date": null, priority: "critical", duration: -1 })).toEqual({
      scheduledDate: undefined, endDate: undefined, deadline: undefined, priority: undefined
    });
    expect(parseProjectProperties(undefined).priority).toBeUndefined();
  });

  it.each([["high", 1], ["Medium", 2], ["low", 3]])("maps %s priority", (priority, expected) => {
    expect(parseProjectProperties({ priority }).priority).toBe(expected);
  });
});

describe("convert to project", () => {
  it("adds a project tag and every project property, empty but for a To do status", () => {
    const properties = {};
    addProjectProperties(properties);
    expect(properties).toEqual({ tags: ["project"], date: null, "end date": null, deadline: null, priority: null, status: "To do", parent: null, color: null, description: null });
    expect(Object.keys(properties)).toEqual(["tags", "date", "end date", "deadline", "priority", "status", "parent", "color", "description"]);
  });

  it("preserves existing tags, aliases, values and unrelated properties on repeated conversion", () => {
    const properties = { tags: ["work", "#project/client"], "Start-Date": "2026-09-10", deadline: "2026-09-12", Priority: "p1", duration: 45, owner: "Me" };
    const original = structuredClone(properties);
    addProjectProperties(properties);
    addProjectProperties(properties);
    expect(properties).toEqual({ ...original, "end date": null, status: "To do", parent: null, color: null, description: null });
  });

  it("sets an empty status to To do and keeps a status that is set", () => {
    for (const empty of [null, "", "  ", []]) {
      const properties: Record<string, unknown> = { Status: empty };
      addProjectProperties(properties);
      expect(properties.Status).toBe("To do");
      expect(properties).not.toHaveProperty("status");
    }
    const properties: Record<string, unknown> = { status: "In progress" };
    addProjectProperties(properties);
    expect(properties.status).toBe("In progress");
  });

  it("preserves an existing parent link on repeated conversion", () => {
    const properties = { Parent: ["[[Projects/Parent]]"] };
    addProjectProperties(properties);
    addProjectProperties(properties);
    expect(properties.Parent).toEqual(["[[Projects/Parent]]"]);
    expect(properties).not.toHaveProperty("parent");
  });

  it("normalizes scalar tag lists without losing tags or duplicating project", () => {
    const properties = { tags: "work, #project personal" };
    addProjectProperties(properties);
    expect(properties.tags).toEqual(["work", "#project", "personal"]);
  });
});

describe("project status and description", () => {
  it("reads the status as a task status, and the description's text", async () => {
    expect(parseProjectProperties({ status: "In progress", description: "  Launch the site.\nIn spring.  " })).toMatchObject({ status: "doing", description: "Launch the site.\nIn spring." });
    expect(parseProjectProperties({ Status: ["on hold"], Description: ["One", "Two"] })).toMatchObject({ status: "waiting", description: "One\nTwo" });
    expect(parseProjectProperties({ status: "someday", description: "  " })).toMatchObject({ status: undefined, description: undefined });
  });

  it("writes the description under its own property name, and removes it when emptied", async () => {
    const { setProjectDescription } = await import("../src/project-properties");
    const frontmatter: Record<string, unknown> = { tags: ["project"], Description: "Old" };
    setProjectDescription(frontmatter, " New \n");
    expect(frontmatter).toEqual({ tags: ["project"], Description: "New" });
    setProjectDescription(frontmatter, "");
    expect(frontmatter).toEqual({ tags: ["project"] });
    setProjectDescription(frontmatter, "Fresh");
    expect(frontmatter).toEqual({ tags: ["project"], description: "Fresh" });
  });
});
