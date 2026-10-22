import { Platform } from "obsidian";
import { DRAG_SLOP, LiftedRow, listenForEscape, LONG_PRESS_MS, PRESS_SLOP } from "./drag-motion";
import type { HeadingRef } from "./note-headings";

/** A heading's group as drawn (a list's section, or a board's column) and its title, which is grabbed to drag it. */
interface Entry { element: HTMLElement; handle: HTMLElement; heading: HeadingRef }

/** One press on a title: a drag once it moves far enough (on touch, after a long press). */
interface Gesture {
  entry: Entry;
  pointer: number;
  origin: { x: number; y: number };
  /** Ready to drag: at once for a mouse or pen, after a long press on touch. */
  armed: boolean;
  timer?: number;
  lifted?: LiftedRow;
  /** Where it would land: before this entry, or after the last (undefined); `stays` when that is where it is. */
  before?: Entry;
  stays: boolean;
  latest?: { x: number; y: number };
  /** The line marking where it lands, fixed over the view, and how far its containing block shifts it. */
  line?: HTMLElement;
  shift?: { x: number; y: number };
  frame?: number;
  scroller?: HTMLElement;
  stop: () => void;
}

/** How near the edge of what scrolls the pointer scrolls it while dragging, and how fast at most (px per frame). */
const EDGE = 48;
const SPEED = 16;

/**
 * Drags a note's headings in a task view grouped by heading: a list's group titles up and down (`y`), a board's
 * column titles sideways (`x`). The grabbed title lifts and follows the pointer, its group dims, and a line marks
 * where it will land; dropping there moves its group at once and its section in the note (`move`).
 */
export class HeadingDragController {
  private readonly entries: Entry[] = [];
  private gesture?: Gesture;
  /** A heading is being dragged (the view redraws once it ends; see onIdle). */
  dragging = false;
  onIdle?: () => void;

  constructor(private readonly axis: "x" | "y", private readonly move: (heading: HeadingRef, before: HeadingRef | undefined) => Promise<void>) {}

  /** Makes `handle` (a group's title) drag `element` (the group), which holds the section under `heading`. */
  add(element: HTMLElement, handle: HTMLElement, heading: HeadingRef): void {
    const entry = { element, handle, heading };
    this.entries.push(entry);
    handle.addClass("tm-heading-draggable");
    handle.addEventListener("pointerdown", event => this.press(entry, event));
    // Once lifted on touch, the finger drags the heading instead of scrolling.
    handle.addEventListener("touchmove", event => { if (this.gesture?.entry === entry && this.gesture.armed) event.preventDefault(); }, { passive: false });
    handle.addEventListener("contextmenu", event => { if (this.gesture?.entry === entry && this.gesture.armed) event.preventDefault(); });
  }

  /** The view redraws or closes: a drag in flight ends without moving anything. */
  dispose(): void { this.end(); }

  private press(entry: Entry, event: PointerEvent): void {
    if (event.button !== 0 || (Platform.isMacOS && event.ctrlKey) || this.gesture) return;
    // Its fold chevron and add button keep their clicks.
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return;
    const doc = entry.handle.ownerDocument;
    const win = doc.defaultView ?? window;
    const touch = event.pointerType === "touch";
    const onMove = (move: PointerEvent): void => this.moved(move);
    const onUp = (up: PointerEvent): void => { if (up.pointerId === gesture.pointer) void this.drop(); };
    const onCancel = (cancel: PointerEvent): void => { if (cancel.pointerId === gesture.pointer) this.end(); };
    const gesture: Gesture = {
      entry, pointer: event.pointerId, origin: { x: event.clientX, y: event.clientY }, armed: !touch, stays: true,
      stop: () => {
        doc.removeEventListener("pointermove", onMove, true);
        doc.removeEventListener("pointerup", onUp, true);
        doc.removeEventListener("pointercancel", onCancel, true);
      }
    };
    if (touch) gesture.timer = win.setTimeout(() => {
      gesture.armed = true;
      entry.handle.addClass("is-drag-armed");
      win.navigator.vibrate?.(10);
    }, LONG_PRESS_MS);
    this.gesture = gesture;
    doc.addEventListener("pointermove", onMove, true);
    doc.addEventListener("pointerup", onUp, true);
    doc.addEventListener("pointercancel", onCancel, true);
  }

  private moved(event: PointerEvent): void {
    const gesture = this.gesture;
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const distance = Math.hypot(event.clientX - gesture.origin.x, event.clientY - gesture.origin.y);
    // On touch, moving before the long press scrolls instead.
    if (!gesture.armed) { if (distance > PRESS_SLOP) this.end(); return; }
    if (!gesture.lifted) {
      if (distance < DRAG_SLOP) return;
      this.lift(gesture);
    }
    event.preventDefault();
    gesture.latest = { x: event.clientX, y: event.clientY };
    this.schedule(gesture);
  }

  private lift(gesture: Gesture): void {
    const { handle, element } = gesture.entry;
    const doc = handle.ownerDocument;
    doc.getSelection()?.removeAllRanges();
    // The lifted copy goes in the group, so the group's title styles follow it.
    gesture.lifted = new LiftedRow(handle, gesture.origin, { into: element, classes: ["tm-heading-drag-preview"], remove: ["is-drag-armed"] });
    element.addClass("is-heading-dragging");
    doc.body.addClass("tm-heading-dragging");
    gesture.scroller = scrollerOf(element, this.axis);
    // The line is placed once at 0, 0 to learn how far what contains it shifts fixed elements (Obsidian panes can).
    const line = (handle.closest<HTMLElement>(".tm-main-view") ?? doc.body).createDiv({ cls: "tm-heading-drop-line", attr: { "aria-hidden": "true" } });
    line.setCssStyles({ left: "0px", top: "0px" });
    const placed = line.getBoundingClientRect();
    gesture.line = line;
    gesture.shift = { x: placed.left, y: placed.top };
    line.hidden = true;
    this.dragging = true;
    const stopEscape = listenForEscape(doc, () => { this.end(); return true; });
    const stop = gesture.stop;
    gesture.stop = () => { stop(); stopEscape(); };
  }

  private schedule(gesture: Gesture): void {
    if (gesture.frame !== undefined) return;
    const win = gesture.entry.handle.ownerDocument.defaultView ?? window;
    gesture.frame = win.requestAnimationFrame(() => { gesture.frame = undefined; this.update(gesture); });
  }

  /** One frame: the lifted title follows the pointer, the line moves to where it would land, and the edges scroll. */
  private update(gesture: Gesture): void {
    const point = gesture.latest;
    if (this.gesture !== gesture || !point || !gesture.lifted) return;
    gesture.lifted.follow(point.x, point.y);
    const at = this.axis === "y" ? point.y : point.x;
    // Before the first title whose middle is past the pointer; past them all, after the last.
    const middle = (entry: Entry): number => {
      const rect = entry.handle.getBoundingClientRect();
      return this.axis === "y" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    };
    const index = this.entries.findIndex(entry => at < middle(entry));
    const own = this.entries.indexOf(gesture.entry);
    gesture.before = index < 0 ? undefined : this.entries[index];
    gesture.stays = index === own || index === own + 1 || (index < 0 && own === this.entries.length - 1);
    this.mark(gesture);
    const scroller = gesture.scroller;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const [low, high] = this.axis === "y" ? [rect.top, rect.bottom] : [rect.left, rect.right];
    const speed = at < low + EDGE ? -Math.ceil((low + EDGE - at) / EDGE * SPEED) : at > high - EDGE ? Math.ceil((at - high + EDGE) / EDGE * SPEED) : 0;
    if (!speed) return;
    if (this.axis === "y") scroller.scrollTop += speed; else scroller.scrollLeft += speed;
    // It goes on scrolling while the pointer rests there.
    this.schedule(gesture);
  }

  /**
   * The line that marks where the heading lands (none where it already is): across the gap above the group it goes
   * before, or below the last; for columns, down the gap beside them. It floats over the view, moving nothing.
   */
  private mark(gesture: Gesture): void {
    const line = gesture.line;
    if (!line) return;
    line.hidden = gesture.stays;
    if (gesture.stays) return;
    const before = gesture.before;
    const index = before ? this.entries.indexOf(before) : this.entries.length;
    const after = this.entries[index - 1]?.element.getBoundingClientRect();
    const next = before?.element.getBoundingClientRect();
    const edge = next ?? after!;
    const at = this.axis === "y"
      ? next && after ? (after.bottom + next.top) / 2 : next ? next.top - 4 : after!.bottom + 4
      : next && after ? (after.right + next.left) / 2 : next ? next.left - 4 : after!.right + 4;
    const shift = gesture.shift ?? { x: 0, y: 0 };
    if (this.axis === "y") line.setCssStyles({ left: `${edge.left - shift.x}px`, top: `${at - 1.5 - shift.y}px`, width: `${edge.width}px`, height: "3px" });
    else line.setCssStyles({ left: `${at - 1.5 - shift.x}px`, top: `${edge.top - shift.y}px`, width: "3px", height: `${edge.height}px` });
  }

  /** Lets go: a heading dropped elsewhere moves there (its group at once, its section in the note). */
  private async drop(): Promise<void> {
    const gesture = this.gesture;
    if (!gesture) return;
    const lifted = Boolean(gesture.lifted);
    if (lifted && gesture.frame !== undefined) {
      (gesture.entry.handle.ownerDocument.defaultView ?? window).cancelAnimationFrame(gesture.frame);
      gesture.frame = undefined;
      this.update(gesture);
    }
    const { entry, before, stays } = gesture;
    if (lifted) suppressClick(entry.handle.ownerDocument);
    const moving = lifted && !stays;
    if (moving) {
      if (before) before.element.before(entry.element);
      else this.entries[this.entries.length - 1].element.after(entry.element);
    }
    // The view waits to redraw until the move is written, so the group never jumps back meanwhile.
    this.end(moving);
    if (!moving) return;
    try {
      await this.move(entry.heading, before?.heading);
    } finally {
      this.dragging = false;
      this.onIdle?.();
    }
  }

  /** Puts everything back as it was; `holding`: still dragging, for redraws to wait (see drop). */
  private end(holding = false): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.gesture = undefined;
    const { handle, element } = gesture.entry;
    const doc = handle.ownerDocument;
    const win = doc.defaultView ?? window;
    gesture.stop();
    if (gesture.timer !== undefined) win.clearTimeout(gesture.timer);
    if (gesture.frame !== undefined) win.cancelAnimationFrame(gesture.frame);
    gesture.lifted?.remove();
    gesture.line?.remove();
    handle.removeClass("is-drag-armed");
    element.removeClass("is-heading-dragging");
    doc.body.removeClass("tm-heading-dragging");
    if (!this.dragging || holding) return;
    this.dragging = false;
    this.onIdle?.();
  }
}

/** What scrolls `element` along `axis`, to scroll while dragging near its edges. */
function scrollerOf(element: HTMLElement, axis: "x" | "y"): HTMLElement | undefined {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node);
    const overflow = axis === "y" ? style?.overflowY : style?.overflowX;
    if (overflow && /auto|scroll/.test(overflow)) return node;
  }
  return undefined;
}

/** The click that ends a drag (which would fold the group under the title) goes nowhere. */
function suppressClick(doc: Document): void {
  const win = doc.defaultView ?? window;
  const swallow = (event: MouseEvent): void => { event.preventDefault(); event.stopPropagation(); };
  doc.addEventListener("click", swallow, { capture: true, once: true });
  win.setTimeout(() => doc.removeEventListener("click", swallow, true), 300);
}
