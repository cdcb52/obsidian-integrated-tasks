import { vi } from "vitest";

/**
 * Lays the task sidebar out for happy-dom, which lays nothing out: its rows, gaps and empty hints stack top to bottom
 * (`ROW` px each; a folded row none; a gap as tall as it says), 300px wide, the list scrolling in a 1000px pane. The
 * lifted row sits where its inline left/top and translate put it.
 */
export const ROW = 20;
const HOLDERS = ".tm-nav-item, .tm-drop-gap, .tm-nav-empty";

function translation(element: HTMLElement): { x: number; y: number } {
  const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(element.style.transform);
  return match ? { x: parseFloat(match[1]), y: parseFloat(match[2]) } : { x: 0, y: 0 };
}

function box(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

function heightOf(element: HTMLElement): number {
  if (element.classList.contains("tm-drop-gap")) return parseFloat(element.style.getPropertyValue("--tm-gap-height")) || ROW;
  if (element.style.height !== "" && parseFloat(element.style.height) === 0) return 0;
  return ROW;
}

/** Installs the layout, pointer capture and immediate frames; motion is off (the system asks for reduced motion). */
export function layOutSidebar(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("tm-drag-preview") || this.classList.contains("tm-drag-chip")) {
      const shift = translation(this);
      return box((parseFloat(this.style.left) || 0) + shift.x, (parseFloat(this.style.top) || 0) + shift.y, 300, ROW);
    }
    const list = this.closest(".tm-nav-list");
    if (list && this.matches(HOLDERS)) {
      const scroller = list.parentElement as HTMLElement;
      let top = -(scroller.scrollTop || 0);
      for (const element of Array.from(list.querySelectorAll<HTMLElement>(HOLDERS))) {
        const height = heightOf(element);
        if (element === this) return box(0, top, 300, height);
        top += height;
      }
    }
    // The pane: far enough around the rows that no drag comes near its edges (and scrolls it), unless a test says so.
    return box(0, -500, 300, 2000);
  });
  Object.assign(HTMLElement.prototype, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
  // Frames run at once, so none is ever left waiting: no id comes back to cancel.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { callback(performance.now()); return undefined as unknown as number; });
  window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query })) as unknown as typeof window.matchMedia;
  document.elementsFromPoint = () => [];
  document.elementFromPoint = () => null;
}

export function firePointer(element: Element, type: string, init: Record<string, unknown> = {}): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries({ button: 0, pointerId: 1, pointerType: "mouse", clientX: 100, clientY: 0, altKey: false, ...init })) Object.defineProperty(event, key, { value });
  element.dispatchEvent(event);
  return event;
}

/** The middle of `row` as laid out now. */
export function middleOf(row: HTMLElement): number {
  const rect = row.getBoundingClientRect();
  return rect.top + rect.height / 2;
}

/**
 * Grabs `row` by its middle and moves the pointer: `to` gives each point (by default 100px across), as a row to aim
 * at (`at`, px down from its top) or a height. Returns how to let go there, and to press Escape instead.
 */
export function grab(row: HTMLElement) {
  const label = row.querySelector<HTMLElement>(".tm-nav-label") ?? row;
  const y = middleOf(row);
  firePointer(label, "pointerdown", { clientY: y });
  let last = { clientX: 100, clientY: y };
  const api = {
    /** Moves over `target`, `at` px from its top (or, as a number, to that height), `dx` px across from the start. */
    to(target: HTMLElement | number, at = ROW / 2, dx = 0) {
      const clientY = typeof target === "number" ? target : target.getBoundingClientRect().top + at;
      last = { clientX: 100 + dx, clientY };
      firePointer(row, "pointermove", last);
      return api;
    },
    drop() { firePointer(row, "pointerup", last); },
    escape() { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); }
  };
  // Past the slop, so the drag begins where the row is.
  firePointer(row, "pointermove", { clientX: 100, clientY: y + 6 });
  return api;
}

export const gap = (): HTMLElement | null => document.querySelector<HTMLElement>(".tm-navigation .tm-drop-gap");
/** The row (or hint) shown just above the gap, skipping folded rows; and the gap's depth. */
export function gapPlace(): { above: string | null; depth: string } | undefined {
  const element = gap();
  if (!element) return undefined;
  let above = element.previousElementSibling as HTMLElement | null;
  while (above && (above.classList.contains("tm-drag-source") || !above.matches(HOLDERS))) above = above.previousElementSibling as HTMLElement | null;
  return { above: above?.querySelector(".tm-nav-label")?.textContent ?? above?.textContent ?? null, depth: element.style.getPropertyValue("--tm-depth") };
}
