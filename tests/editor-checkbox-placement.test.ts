// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { noteRecurringCompletion } from "../src/note-recurring-completion";

afterEach(() => { document.body.innerHTML = ""; });

/** Live Preview's checkbox, as Obsidian 1.9 draws it: kept as it is where an equal one (same status) takes its place. */
class Checkbox extends WidgetType {
  constructor(readonly status: string) { super(); }
  eq(other: Checkbox): boolean { return other.status === this.status; }
  updateDOM(dom: HTMLElement): boolean {
    const input = dom.firstElementChild as HTMLInputElement;
    input.setAttribute("data-task", this.status);
    input.checked = this.status !== " ";
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const label = document.createElement("label");
    const input = label.appendChild(document.createElement("input"));
    input.type = "checkbox";
    input.className = "task-list-item-checkbox";
    input.setAttribute("data-task", this.status);
    input.checked = this.status !== " ";
    // A click ticks the box itself, then writes the status into the line.
    input.addEventListener("input", () => {
      const line = view.state.doc.lineAt(view.posAtDOM(input));
      const at = line.from + line.text.indexOf("[") + 1;
      view.dispatch({ changes: { from: at, to: at + 1, insert: line.text[line.text.indexOf("[") + 1] === " " ? "x" : " " } });
    });
    return label;
  }
}

const checkboxes = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate): void { if (update.docChanged) this.decorations = this.build(update.view); }
  build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (let number = 1; number <= view.state.doc.lines; number++) {
      const line = view.state.doc.line(number);
      const at = line.text.indexOf("[");
      if (/^- \[.\]/.test(line.text)) builder.add(line.from + at, line.from + at + 3, Decoration.replace({ widget: new Checkbox(line.text[at + 1]) }));
    }
    return builder.finish();
  }
}, { decorations: plugin => plugin.decorations });

function editor(doc: string) {
  const view = new EditorView({ parent: document.body, doc, extensions: [checkboxes, noteRecurringCompletion(() => "YYYY-MM-DD", () => false, vi.fn(), () => "Note.md",
    undefined, () => 1, () => ({ placement: "bottom", section: "Task Log" }))] });
  const boxes = () => Array.from(view.contentDOM.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox"));
  const click = (index: number) => { const box = boxes()[index]; box.checked = !box.checked; box.dispatchEvent(new Event("input")); };
  return { view, boxes, click, shown: () => boxes().map(box => box.checked) };
}

it("leaves no checkbox ticked for the task that moves up into the place of one clicked and moved away", () => {
  const { view, click, shown } = editor("- [ ] One\n- [ ] Two\n- [ ] Three");
  click(0);
  expect(view.state.doc.toString()).toBe("- [ ] Two\n- [ ] Three\n- [x] One");
  expect(shown()).toEqual([false, false, true]);
  // Reopened, it goes back to the top, and the checkbox it leaves is unticked too.
  click(2);
  expect(view.state.doc.toString()).toBe("- [ ] One\n- [ ] Two\n- [ ] Three");
  expect(shown()).toEqual([false, false, false]);
});
