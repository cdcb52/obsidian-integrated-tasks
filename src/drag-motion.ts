/**
 * The motion a drag shares, wherever a row is dragged (a task list, the task sidebar): rows sliding aside as a gap
 * opens, closes or moves; the lifted copy of the row that follows the pointer and glides into place; and Escape.
 */

/** How long each drag motion takes: lifting, a gap moving, rows sliding, and settling on drop. */
export const DRAG_MOTION_MS = 150;
export const DRAG_EASING = "cubic-bezier(0.2, 0, 0, 1)";
/** On touch screens a row lifts for dragging after a press held this long (and within PRESS_SLOP px of where it began). */
export const LONG_PRESS_MS = 350;
export const PRESS_SLOP = 8;
/** How far the pointer moves before a press becomes a drag. */
export const DRAG_SLOP = 5;

/**
 * A lifted row folds out of the list (its slot closing) while the gap shows where it will land: set on the row itself,
 * as the fold must win over every layout's row sizing, and taken off again as it returns.
 */
export const FOLDED: Partial<CSSStyleDeclaration> = { height: "0", minHeight: "0", paddingBlock: "0", marginBlock: "0", borderWidth: "0", overflow: "hidden", opacity: "0" };
export const UNFOLDED: Partial<CSSStyleDeclaration> = { height: "", minHeight: "", paddingBlock: "", marginBlock: "", borderWidth: "", overflow: "", opacity: "" };

/** How long drag motions take in `doc`: none when the system asks for reduced motion. */
export function motion(doc: Document): number {
  return doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : DRAG_MOTION_MS;
}

/** A box on screen, as far as a drag needs one. */
export interface Box { left: number; right: number; top: number; bottom: number; height: number }

/**
 * Rows sliding into place as something moves among them. `movers` are what make way (and slide), `holders` what
 * the pointer can rest on mid-slide (for `settledRect`).
 */
export class Slides {
  /** Rows (and the gap) sliding into place, with how far each started from where it now sits. */
  private slides = new WeakMap<HTMLElement, { animation: Animation; delta: number }>();
  constructor(private readonly movers: string, private readonly holders: string) {}

  /** How far `row` is still shifted from its place by a slide in progress: 0 once it has settled. */
  offset(row: Element): number {
    const slide = row.instanceOf(HTMLElement) ? this.slides.get(row) : undefined;
    if (!slide || slide.animation.playState === "finished" || slide.animation.playState === "idle") return 0;
    const progress = slide.animation.effect?.getComputedTiming().progress;
    return progress === null || progress === undefined ? 0 : slide.delta * (1 - progress);
  }

  /** `element`'s box where it will rest once the row (or gap) holding it stops sliding. */
  settledRect(element: Element): Box {
    const rect = element.getBoundingClientRect();
    const holder = element.closest(this.holders);
    const shift = holder ? this.offset(holder) : 0;
    return { left: rect.left, right: rect.right, top: rect.top - shift, bottom: rect.bottom - shift, height: rect.height };
  }

  /**
   * Moves something while every row it displaces slides from where it was to where it lands, so rows glide aside
   * as the drop gap opens, closes or moves. A row whose resting place the change leaves alone keeps sliding as it
   * was; one that moves glides on from where it is drawn.
   */
  slide(scope: Element | Document, change: () => void): void {
    const rows = Array.from(scope.querySelectorAll<HTMLElement>(this.movers));
    // Read every position first, then change and read again, then start animations: one layout each way.
    const before = new Map(rows.map(row => { const top = row.getBoundingClientRect().top; return [row, { drawn: top, rest: top - this.offset(row) }]; }));
    change();
    const duration = motion(scope.instanceOf(Document) ? scope : scope.ownerDocument);
    const after = new Map(rows.filter(row => row.isConnected).map(row => [row, row.getBoundingClientRect().top - this.offset(row)]));
    for (const row of rows) {
      const rest = after.get(row);
      const was = before.get(row)!;
      if (rest === undefined) { this.slides.get(row)?.animation.cancel(); continue; }
      if (Math.abs(rest - was.rest) < 0.5) continue;
      this.slides.get(row)?.animation.cancel();
      this.slides.delete(row);
      const delta = was.drawn - rest;
      if (!duration || typeof row.animate !== "function" || Math.abs(delta) < 0.5) continue;
      this.slides.set(row, { animation: row.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], { duration, easing: DRAG_EASING }), delta });
    }
  }
}

/**
 * The lifted row: a floating copy of `row`, placed over it once and then moved only by transform (which needs no
 * layout), with a count when several items move together.
 */
export class LiftedRow {
  readonly element: HTMLElement;
  /** Where the pointer grabbed the row, from its top left corner. */
  readonly offset: { x: number; y: number };
  /** The row's box as it was lifted. */
  readonly rect: DOMRect;
  private base: { left: number; top: number };
  private shift = { x: 0, y: 0 };

  /**
   * Lifts `row` grabbed at `origin`: the copy goes into `into` (its styles follow from there), with `classes` added.
   */
  constructor(row: HTMLElement, origin: { x: number; y: number }, options: { into: HTMLElement; classes: string[]; remove?: string[]; count?: number }) {
    const rect = row.getBoundingClientRect();
    this.rect = rect;
    this.offset = { x: origin.x - rect.left, y: origin.y - rect.top };
    const copy = row.cloneNode(true) as HTMLElement;
    for (const name of options.remove ?? []) copy.removeClass(name);
    copy.addClass(...options.classes);
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    copy.draggable = false;
    copy.style.width = `${rect.width}px`;
    copy.style.height = `${rect.height}px`;
    if (options.count && options.count > 1) {
      const count = copy.createSpan({ cls: "tm-drag-count", text: String(options.count) });
      count.style.left = `${this.offset.x + 8}px`;
      count.style.top = `${this.offset.y + 2}px`;
    }
    options.into.appendChild(copy);
    // Placed over the row once; Obsidian panes can establish a containing block for fixed children, so correct
    // for its displacement. From here on the copy only moves by transform.
    copy.style.left = `${rect.left}px`;
    copy.style.top = `${rect.top}px`;
    const placed = copy.getBoundingClientRect();
    copy.style.left = `${2 * rect.left - placed.left}px`;
    copy.style.top = `${2 * rect.top - placed.top}px`;
    this.base = { left: rect.left, top: rect.top };
    this.element = copy;
  }

  /** Keeps the grabbed point under the pointer at (`x`, `y`). */
  follow(x: number, y: number): void {
    this.shift = { x: x - this.offset.x - this.base.left, y: y - this.offset.y - this.base.top };
    this.element.style.transform = `translate3d(${this.shift.x}px, ${this.shift.y}px, 0px)`;
  }

  /** Glides onto `to` (the gap, or back to the row's slot); resolves when it arrives, at once without motion. */
  async glide(to: { left: number; top: number }): Promise<void> {
    const current = this.element;
    const from = current.getBoundingClientRect();
    // It settles back to the row's size and shadow as it lands.
    current.addClass("is-settling");
    const duration = motion(current.ownerDocument);
    if (!duration || typeof current.animate !== "function") return;
    current.querySelector(".tm-drag-count")?.remove();
    const shifted = (x: number, y: number): string => `translate3d(${x}px, ${y}px, 0px)`;
    const animation = current.animate([{ transform: shifted(this.shift.x, this.shift.y) },
      { transform: shifted(this.shift.x + to.left - from.left, this.shift.y + to.top - from.top) }], { duration, easing: DRAG_EASING, fill: "forwards" });
    await animation.finished.catch(() => {});
  }

  remove(): void { this.element.remove(); }
}

/** Calls `escape` when Escape is pressed (the key going no further); returns how to stop listening. */
export function listenForEscape(doc: Document, escape: () => boolean): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !escape()) return;
    event.preventDefault(); event.stopPropagation();
  };
  doc.addEventListener("keydown", onKey, true);
  return () => doc.removeEventListener("keydown", onKey, true);
}
