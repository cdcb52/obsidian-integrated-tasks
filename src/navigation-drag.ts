import { Platform } from "obsidian";
import { DRAG_SLOP, FOLDED, LiftedRow, listenForEscape, LONG_PRESS_MS, PRESS_SLOP, Slides, UNFOLDED } from "./drag-motion";

/** What makes way for the gap in the task sidebar (and slides as it moves), and what the pointer can rest on mid-slide. */
const MOVERS = ".tm-nav-item:not(.tm-drag-preview), .tm-drop-gap, .tm-nav-empty";
const HOLDERS = ".tm-nav-item, .tm-drop-gap, .tm-nav-empty";
/** Once above or below a row is chosen, the other side needs the lifted row this far past the row's middle. */
export const SIDE_HYSTERESIS_PX = 4;
/** Resting this long over a closed folder opens it, as the file explorer does. */
export const SPRING_MS = 600;
/** Within this far of the list's top or bottom edge, a drag scrolls the list, faster nearer the edge. */
const EDGE_PX = 28;
const MAX_SCROLL_PX = 14;

export interface Point { clientX: number; clientY: number }

/** Where the gap opens: before or after a row, or at the start or end of a list of rows, indented `depth` levels. */
export interface NavGap { element: HTMLElement; where: "before" | "after" | "start" | "end"; depth: number }

/** What dropping in a place does, and how the sidebar shows it while the pointer is there. */
export interface NavIntent {
  /** Where the gap opens; none when nothing makes way (a list dropped back where it is, Favorites folded away). */
  gap?: NavGap;
  /** A row lit up as where it goes: a folder it goes into, or Favorites' heading. */
  highlight?: HTMLElement;
  /** True when the dragged rows leave their place for the gap (a move); false when they stay (added to Favorites). */
  moves: boolean;
  /** What the drop does, as Obsidian's drag manager says it ("Move into Work"); none for the item's own place. */
  action?: string;
  /** Does the drop; none: a drop here changes nothing. */
  commit?: () => Promise<void>;
  /** After a drop, where the dragged rows wait for the list to redraw: in the gap (the default), or out of sight. */
  land?: "gap" | "hide";
  /** Opens what the pointer rests on (a closed folder) after a while, its rows added under it. */
  spring?: () => void;
  /** Which side of which row this place was chosen by, so the other side needs the pointer a little further. */
  side?: { row: HTMLElement; after: boolean };
  /** The same place as the pointer moves sideways over the gap: deeper or shallower (a project or a file). */
  sideways?: (x: number) => NavIntent;
}

/** A drag in progress: what is dragged (as the sidebar describes it), and where it came from. */
export interface NavDrag<T> {
  item: T;
  /** The dragged row and the rows that go with it (a project's subprojects, an open folder's contents); none from elsewhere. */
  rows: HTMLElement[];
  /** How deep the dragged row is, and how tall. */
  depth: number;
  height: number;
  /** Where the pointer was when the drag began: moving right or left of it nests and outdents. */
  x: number;
  /** Its own place: a drop there changes nothing. */
  home: NavIntent;
}

export interface NavDragHost<T> {
  /** The list the rows are in, and the element that scrolls it. */
  list(): HTMLElement | undefined;
  scroller(): HTMLElement | undefined;
  /** Classes the lifted row's layer takes, so it looks as it does in the list (style, density). */
  layerClasses(): string[];
  /**
   * What dropping over `element` (a row, or a list's empty hint) at `point` does: `drag.home` where it does not go,
   * undefined to keep the place chosen before (between rows).
   */
  resolve(element: HTMLElement, point: Point, drag: NavDrag<T>): NavIntent | undefined;
  /** What a drag of `row` carries, as it starts; none: the row does not drag. */
  source(row: HTMLElement): { item: T; rows: HTMLElement[]; movable: boolean } | undefined;
  /**
   * The dragged row's own place, `depth` deep, for a drag that began at `x`, where moving sideways may still nest or
   * outdent it (a project, a file); none: just its place.
   */
  home?(row: HTMLElement, item: T, depth: number, x: number): NavIntent | undefined;
  /** The name the label following the pointer outside the sidebar shows. */
  label(item: T): string;
  /** Let go outside the sidebar at `point` (a file into a note, or onto a folder in the file explorer): true if taken. */
  dropOutside?(point: Point, item: T): boolean;
  /** A drag has ended (and a redraw may happen). */
  onIdle(): void;
}

function depthOf(row: Element): number {
  return Number.parseInt((row as HTMLElement).style?.getPropertyValue("--tm-nav-depth") || "0", 10) || 0;
}

/**
 * Drags the task sidebar's rows as the task lists drag theirs: the row lifts and follows the pointer, the rows it
 * leaves close up, and a gap opens where it would land, the other rows sliding aside. Where a row may go, and what
 * a drop does, is the sidebar's (see NavDragHost); this does the motion.
 */
export class NavDragController<T> {
  /** A row is being dragged: a redraw now would take it from under the pointer. */
  dragging = false;
  private readonly slides = new Slides(MOVERS, HOLDERS);
  private gap?: HTMLElement;
  private gapKey?: string;
  /** The place a drop now goes, and the gap's key at the dragged row's own place. */
  private intent?: NavIntent;
  private homeKey?: string;
  private highlighted?: HTMLElement;
  /** The dragged rows, and whether they are folded away (moving) or shown faded (staying where they are). */
  private sources: HTMLElement[] = [];
  private folded = false;
  private drag?: NavDrag<T>;
  /** A drag from elsewhere (the file explorer), through Obsidian's drag manager. */
  private external?: NavDrag<T>;
  private spring?: { highlight: HTMLElement; timer: number };
  private keys = new WeakMap<HTMLElement, number>();
  private lastKey = 0;
  /** Each row's way to end a press or drag in flight, for `dispose`. */
  private teardowns = new Set<() => void>();

  constructor(private readonly host: NavDragHost<T>) {}

  /** `element`'s box where it rests once the rows sliding past it settle. */
  rect(element: Element): { left: number; right: number; top: number; bottom: number; height: number } {
    return this.slides.settledRect(element);
  }

  /** The place chosen now (for hysteresis, and for tests). */
  get current(): NavIntent | undefined { return this.intent; }

  /** Ends any press or drag in flight, for a list about to be redrawn or closed. Nothing is dropped. */
  dispose(): void {
    for (const teardown of this.teardowns) teardown();
    this.teardowns.clear();
    this.clearSpring();
    this.removeGap(false);
    this.restoreSources();
    this.external = undefined;
  }

  /**
   * Lets `row` be dragged by the pointer (on touch screens, after a long press). `native` rows (files) keep the
   * native drag the file explorer's have while the Option (Alt) key is held, for dropping onto a tab or into Canvas.
   */
  bind(row: HTMLElement, native = false): void {
    const doc = row.ownerDocument;
    const win = (): Window => doc.defaultView ?? window;
    let pointer: number | undefined;
    let origin = { x: 0, y: 0 };
    let dragging = false;
    let lifted: LiftedRow | undefined;
    let layer: HTMLElement | undefined;
    let chip: HTMLElement | undefined;
    let outside = false;
    let label = "";
    let latest: Point | undefined;
    /** The latest pointer position is handled once per frame, however many moves arrive. */
    let scheduled = false;
    let frame = 0;
    let stopEscape: (() => void) | undefined;
    let suppressClickUntil = 0;
    // Touch: a long press lifts the row (armed), and moving the finger then drags it; let go without moving, it opens
    // the row's menu instead (the long press's own menu waits for that).
    let press: { timer: number; id: number; x: number; y: number } | undefined;
    let armed = false;
    let menu: { x: number; y: number } | undefined;
    let replaying = false;
    const cancelPress = (): void => {
      if (press) win().clearTimeout(press.timer);
      press = undefined;
    };
    // Until the drag captures the pointer, it may leave the row (a short row, a quick move); the window hears it.
    let listening = false;
    const listen = (on: boolean): void => {
      if (on === listening) return;
      listening = on;
      const target = win();
      if (on) {
        target.addEventListener("pointermove", move, true);
        target.addEventListener("pointerup", up, true);
        target.addEventListener("pointercancel", cancel, true);
      } else {
        target.removeEventListener("pointermove", move, true);
        target.removeEventListener("pointerup", up, true);
        target.removeEventListener("pointercancel", cancel, true);
      }
    };
    const reset = (): void => {
      this.teardowns.delete(teardown);
      if (!dragging && !listening && !press && !armed && pointer === undefined) return;
      const ended = dragging;
      if (scheduled) win().cancelAnimationFrame(frame);
      scheduled = false;
      latest = undefined;
      listen(false);
      cancelPress();
      stopEscape?.();
      stopEscape = undefined;
      lifted?.remove();
      lifted = undefined;
      layer?.remove();
      layer = undefined;
      chip?.remove();
      chip = undefined;
      outside = false;
      doc.body.removeClass("tm-list-dragging");
      armed = false;
      row.removeClass("is-drag-armed");
      if (native) row.draggable = true;
      pointer = undefined;
      dragging = false;
      this.clearSpring();
      if (ended) {
        this.drag = undefined;
        this.dragging = false;
        this.host.onIdle();
      }
    };
    const cancelDrag = (): void => {
      this.removeGap(false);
      this.restoreSources();
      reset();
    };
    // A row redrawn or closed mid-press never hears the press end: `dispose` ends it.
    const teardown = (): void => {
      if (dragging && pointer !== undefined) {
        try { row.releasePointerCapture(pointer); } catch { /* Already released. */ }
      }
      if (dragging) cancelDrag(); else reset();
    };
    /** No drop: the row flies back and its slot opens again. */
    const flyBack = (): void => {
      const copy = lifted;
      const home = this.drag?.home;
      chip?.remove();
      chip = undefined;
      copy?.element.removeClass("is-outside");
      if (home?.gap) this.place(home);
      else this.removeGap(true);
      const to = this.gap ? this.rect(this.gap) : copy?.rect;
      void (copy && to ? copy.glide(to) : Promise.resolve()).then(() => {
        this.removeGap(false);
        this.restoreSources();
        reset();
      });
    };
    const begin = (event: PointerEvent): void => {
      const source = this.host.source(row);
      if (!source) { reset(); return; }
      row.setPointerCapture(event.pointerId);
      const list = this.host.list();
      const rect = row.getBoundingClientRect();
      const depth = depthOf(row);
      const home: NavIntent = !source.movable ? { moves: false }
        : this.host.home?.(row, source.item, depth, origin.x) ?? { gap: { element: row, where: "before", depth }, moves: true };
      this.drag = { item: source.item, rows: source.rows.length ? source.rows : [row], depth, height: rect.height, x: origin.x, home };
      label = this.host.label(source.item);
      layer = doc.body.createDiv({ cls: ["tm-navigation", "tm-nav-drag-layer", ...this.host.layerClasses()], attr: { "aria-hidden": "true" } });
      lifted = new LiftedRow(row, origin, { into: layer, classes: ["tm-drag-preview"], remove: ["is-active", "is-drop-target", "is-drag-armed"] });
      doc.body.addClass("tm-list-dragging");
      stopEscape = listenForEscape(doc, () => {
        if (!dragging || pointer === undefined) return false;
        const id = pointer;
        pointer = undefined;
        suppressClickUntil = Date.now() + 250;
        try { row.releasePointerCapture(id); } catch { /* Already released. */ }
        listen(false);
        flyBack();
        return true;
      });
      this.sources = this.drag.rows;
      // The gap takes the row's place, so the row lifts without anything moving; a row that only goes into
      // Favorites stays where it is, faded.
      this.slides.slide(list ?? doc, () => {
        this.homeKey = home.gap ? this.slotKey(home.gap, true) : undefined;
        this.place(home, false);
        if (!home.moves) this.fold(false);
      });
      dragging = true;
      this.dragging = true;
    };
    /** One frame's work for the latest pointer position: where the drop goes, then what follows the pointer. */
    const update = (): void => {
      scheduled = false;
      const point = latest;
      const drag = this.drag;
      if (!point || !dragging || !lifted || !drag) return;
      const scroller = this.host.scroller();
      const bounds = scroller?.getBoundingClientRect();
      const isOutside = Boolean(bounds && (point.clientX < bounds.left || point.clientX > bounds.right || point.clientY < bounds.top || point.clientY > bounds.bottom));
      if (isOutside !== outside) {
        outside = isOutside;
        // Outside the sidebar the rows go back to how they were; a drop there is the file's, into a note or a folder.
        if (outside) this.place(drag.home);
      }
      if (!outside) {
        // Above or below is judged by the lifted row's middle, wherever on it the row was grabbed.
        const probe = { clientX: point.clientX, clientY: point.clientY - lifted.offset.y + drag.height / 2 };
        const next = this.resolveAt(probe, drag);
        if (next) this.place(next);
      }
      lifted.follow(point.clientX, point.clientY);
      lifted.element.toggleClass("is-outside", outside);
      if (outside) {
        chip ??= doc.body.createDiv({ cls: "tm-drag-chip", text: label, attr: { "aria-hidden": "true" } });
        chip.style.left = `${point.clientX + 12}px`;
        chip.style.top = `${point.clientY + 8}px`;
      } else {
        chip?.remove();
        chip = undefined;
      }
      // Near the list's top or bottom edge, it scrolls; and keeps scrolling while the pointer rests there.
      if (!outside && scroller && bounds && this.autoscroll(scroller, bounds, point.clientY)) schedule();
    };
    const schedule = (): void => {
      if (scheduled) return;
      scheduled = true;
      frame = win().requestAnimationFrame(update);
    };
    const flush = (): void => {
      if (!scheduled) return;
      win().cancelAnimationFrame(frame);
      update();
    };
    const move = (event: PointerEvent): void => {
      if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > PRESS_SLOP) cancelPress();
      if (pointer !== event.pointerId) return;
      if (!dragging && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_SLOP) return;
      event.preventDefault();
      if (!dragging) begin(event);
      if (!dragging) return;
      latest = { clientX: event.clientX, clientY: event.clientY };
      schedule();
    };
    const up = (event: PointerEvent): void => {
      const pressing = press?.id === event.pointerId;
      cancelPress();
      if (pointer !== event.pointerId) { if (pressing) listen(false); return; }
      if (armed && !dragging) {
        // A long press let go without moving: the row's menu, which the long press held back.
        suppressClickUntil = Date.now() + 250;
        const at = menu;
        reset();
        if (at) {
          replaying = true;
          try { row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })); }
          finally { replaying = false; }
        }
        menu = undefined;
        return;
      }
      if (!dragging) { reset(); return; }
      event.preventDefault(); event.stopPropagation();
      suppressClickUntil = Date.now() + 250;
      // The last move counts, even if its frame has not run yet.
      latest = { clientX: event.clientX, clientY: event.clientY };
      flush();
      pointer = undefined;
      try { row.releasePointerCapture(event.pointerId); } catch { /* Already released. */ }
      listen(false);
      stopEscape?.();
      stopEscape = undefined;
      const drag = this.drag!;
      if (outside) {
        let taken = false;
        try { taken = Boolean(this.host.dropOutside?.({ clientX: event.clientX, clientY: event.clientY }, drag.item)); }
        catch { taken = false; }
        if (!taken) { flyBack(); return; }
        this.removeGap(false);
        this.restoreSources();
        reset();
        return;
      }
      const intent = this.intent;
      const home = !intent?.commit || (intent.moves && this.gapKey !== undefined && this.gapKey === this.homeKey);
      if (home) { flyBack(); return; }
      const to = this.gap ? this.rect(this.gap) : intent.highlight ? this.rect(intent.highlight) : lifted?.rect;
      void (lifted && to ? lifted.glide(to) : Promise.resolve()).then(() => {
        // The rows take their new place at once; the list redraws to match once the drop is written. The drop starts
        // before the drag ends, so a redraw the drag held back waits for it too.
        this.land(intent, [this.sources]);
        let written: Promise<void>;
        try { written = intent.commit!(); } catch (error) { written = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
        reset();
        void written.catch(() => {});
      });
    };
    const cancel = (event: PointerEvent): void => {
      const pressing = press?.id === event.pointerId;
      cancelPress();
      if (pointer !== event.pointerId) { if (pressing) listen(false); return; }
      if (dragging) cancelDrag(); else reset();
    };
    row.addEventListener("click", event => {
      if (Date.now() > suppressClickUntil) return;
      event.preventDefault(); event.stopImmediatePropagation();
      suppressClickUntil = 0;
    }, true);
    row.addEventListener("pointerdown", event => {
      if (event.button !== 0 || this.dragging || (Platform?.isMacOS && event.ctrlKey)) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, .tm-nav-collapse")) return;
      // With Option (Alt) held, a file drags natively, as from the file explorer.
      if (native && event.altKey) return;
      cancelPress();
      reset();
      this.teardowns.add(teardown);
      if (native) row.draggable = false;
      origin = { x: event.clientX, y: event.clientY };
      if (event.pointerType === "touch") {
        const at = { id: event.pointerId, x: event.clientX, y: event.clientY };
        press = { ...at, timer: win().setTimeout(() => {
          press = undefined;
          pointer = at.id;
          armed = true;
          menu = undefined;
          row.addClass("is-drag-armed");
          win().navigator.vibrate?.(10);
        }, LONG_PRESS_MS) };
        listen(true);
        return;
      }
      pointer = event.pointerId;
      listen(true);
    });
    // Once lifted, the finger drags the row instead of scrolling the list or closing the sidebar.
    row.addEventListener("touchmove", event => {
      if (!armed && !dragging) return;
      event.preventDefault(); event.stopPropagation();
    }, { passive: false });
    // A long press's own menu: before the row lifts it wins; once lifted, it waits for the finger to let go unmoved.
    row.addEventListener("contextmenu", event => {
      if (replaying) return;
      if (press) { cancelPress(); listen(false); return; }
      if (!armed && !dragging) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!dragging) menu = { x: event.clientX, y: event.clientY };
    }, true);
    row.addEventListener("lostpointercapture", event => {
      if (event.target === row && dragging && pointer !== undefined) cancelDrag();
    });
  }

  /**
   * A drag from elsewhere (a file from the file explorer) over the sidebar at `point`: the gap opens where it would
   * land, as for the sidebar's own rows. Returns what a drop there does.
   */
  hoverExternal(point: Point, item: T, height: number): NavIntent | undefined {
    if (this.dragging) return undefined;
    this.external ??= { item, rows: [], depth: 0, height, x: point.clientX, home: { moves: false } };
    this.external.item = item;
    this.drag = this.external;
    try {
      const next = this.resolveAt(point, this.external);
      if (next) this.place(next);
      return this.intent?.commit ? this.intent : undefined;
    } finally { this.drag = undefined; }
  }

  /** The drag from elsewhere has left the sidebar (or ended): the gap closes. */
  leaveExternal(): void {
    if (!this.external) return;
    this.external = undefined;
    this.clearSpring();
    this.removeGap(true);
  }

  /**
   * The drag from elsewhere is let go over the sidebar: its rows already here (`blocks`, each a row and the rows
   * that go with it) take the new place at once, and the drop is made.
   */
  dropExternal(blocks: HTMLElement[][]): NavIntent | undefined {
    const intent = this.external && this.intent?.commit ? this.intent : undefined;
    this.external = undefined;
    this.clearSpring();
    if (intent) this.land(intent, blocks);
    this.removeGap(false);
    this.intent = undefined;
    this.unhighlight();
    return intent;
  }

  /** The drop place under `point`: the row (or gap) resting there once rows stop sliding, as the sidebar reads it. */
  private resolveAt(point: Point, drag: NavDrag<T>): NavIntent | undefined {
    const element = this.restingAt(point);
    if (!element) return undefined;
    if (element === this.gap) return this.intent?.sideways?.(point.clientX);
    return this.host.resolve(element, point, drag);
  }

  /**
   * What rests under the point once sliding rows settle: aiming at where rows are drawn mid-slide would move the gap
   * again, and again. Between rows (or beside the list) it is nothing, and the place stays as it was.
   */
  private restingAt(point: Point): HTMLElement | undefined {
    const list = this.host.list();
    if (!list) return undefined;
    const doc = list.ownerDocument;
    const stack = doc.elementsFromPoint?.(point.clientX, point.clientY) ?? [];
    const under = stack.length ? stack : [doc.elementFromPoint?.(point.clientX, point.clientY)].filter((element): element is Element => Boolean(element));
    const first = under.find(element => !element.closest(".tm-nav-drag-layer, .tm-drag-chip"));
    const holder = first?.closest<HTMLElement>(HOLDERS);
    if (holder && list.contains(holder) && this.slides.offset(holder) === 0 && !this.hidden(holder)) return holder;
    for (const element of Array.from(list.querySelectorAll<HTMLElement>(HOLDERS))) {
      if (this.hidden(element)) continue;
      const rect = this.slides.settledRect(element);
      if (rect.height > 0 && point.clientY >= rect.top && point.clientY < rect.bottom) return element;
    }
    return undefined;
  }

  private hidden(element: HTMLElement): boolean {
    return element.classList.contains("tm-drag-source") || element.classList.contains("tm-drag-preview");
  }

  /** Scrolls the list when `y` is near its top or bottom edge; true while it can scroll further. */
  private autoscroll(scroller: HTMLElement, bounds: DOMRect, y: number): boolean {
    const top = y - bounds.top;
    const bottom = bounds.bottom - y;
    const step = top < EDGE_PX ? -Math.ceil(MAX_SCROLL_PX * (EDGE_PX - top) / EDGE_PX)
      : bottom < EDGE_PX ? Math.ceil(MAX_SCROLL_PX * (EDGE_PX - bottom) / EDGE_PX) : 0;
    if (!step) return false;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    return scroller.scrollTop !== before;
  }

  /** Opens (or moves) the gap to where `intent` puts it, folding the dragged rows away when they move with it. */
  private place(intent: NavIntent, animate = true): void {
    const drag = this.drag;
    // The latest description of a place decides the drop, even when the gap stays where it is.
    this.intent = intent;
    if (intent.highlight !== this.highlighted) {
      this.unhighlight();
      intent.highlight?.addClass("is-drop-target");
      this.highlighted = intent.highlight;
      this.armSpring(intent);
    }
    const fold = Boolean(intent.moves && drag?.rows.length);
    const key = intent.gap ? this.slotKey(intent.gap, fold) : undefined;
    if (key === this.gapKey && fold === this.folded) return;
    const change = (): void => {
      this.gapKey = key;
      this.fold(fold);
      const place = intent.gap;
      if (!place) { this.gap?.remove(); this.gap = undefined; return; }
      this.gap ??= createDiv({ cls: "tm-drop-gap", attr: { "aria-hidden": "true" } });
      this.gap.style.setProperty("--tm-gap-height", `${drag?.height ?? 28}px`);
      this.gap.style.setProperty("--tm-depth", String(place.depth));
      if (place.where === "before") place.element.before(this.gap);
      else if (place.where === "after") place.element.after(this.gap);
      else if (place.where === "start") place.element.prepend(this.gap);
      else place.element.append(this.gap);
    };
    const list = this.host.list();
    if (animate && list) this.slides.slide(list, change);
    else change();
  }

  /** Folds the dragged rows away (they move with the gap) or shows them, faded, where they are (they stay). */
  private fold(on: boolean): void {
    if (on === this.folded && this.sources.every(row => row.classList.contains(on ? "tm-drag-source" : "is-being-dragged"))) return;
    this.folded = on;
    for (const row of this.sources) {
      row.toggleClass("tm-drag-source", on);
      row.toggleClass("is-being-dragged", !on);
      row.setCssStyles(on ? FOLDED : UNFOLDED);
    }
  }

  /** The dragged rows come back as they were. */
  private restoreSources(): void {
    for (const row of this.sources) {
      row.removeClass("tm-drag-source", "is-being-dragged");
      row.setCssStyles(UNFOLDED);
    }
    this.sources = [];
    this.folded = false;
    this.homeKey = undefined;
  }

  /**
   * After a drop the rows take their new place before the list redraws: into the gap, indented as it is (each block's
   * rows keeping their depth under its first), or out of sight (into a closed folder). Rows that stay come back.
   */
  private land(intent: NavIntent, blocks: HTMLElement[][]): void {
    const gap = this.gap;
    const rows = blocks.flat();
    if (intent.moves && gap?.isConnected && intent.land !== "hide") {
      const depth = Number.parseInt(gap.style.getPropertyValue("--tm-depth") || "0", 10) || 0;
      for (const block of blocks) {
        const shift = depth - depthOf(block[0] ?? gap);
        for (const row of block) {
          gap.before(row);
          row.style.setProperty("--tm-nav-depth", String(depthOf(row) + shift));
        }
      }
      for (const row of rows) { row.removeClass("tm-drag-source", "is-being-dragged"); row.setCssStyles(UNFOLDED); }
    } else if (intent.moves && intent.land === "hide") {
      for (const row of rows) { row.removeClass("is-being-dragged"); row.addClass("tm-drag-source"); row.setCssStyles(FOLDED); }
    } else {
      for (const row of rows) { row.removeClass("tm-drag-source", "is-being-dragged"); row.setCssStyles(UNFOLDED); }
    }
    if (rows === this.sources || blocks[0] === this.sources) this.sources = [];
    this.folded = false;
    this.homeKey = undefined;
    this.removeGap(false);
    this.unhighlight();
  }

  private removeGap(animated: boolean): void {
    const gap = this.gap;
    this.gap = undefined;
    this.gapKey = undefined;
    this.intent = undefined;
    this.unhighlight();
    if (!gap) return;
    const list = this.host.list();
    if (animated && gap.isConnected && list) this.slides.slide(list, () => gap.remove());
    else gap.remove();
  }

  private unhighlight(): void {
    this.highlighted?.removeClass("is-drop-target");
    this.highlighted = undefined;
    this.clearSpring();
  }

  /** Resting on a closed folder opens it after a while (see NavIntent.spring); moving elsewhere first stops that. */
  private armSpring(intent: NavIntent): void {
    this.clearSpring();
    const highlight = intent.highlight;
    const open = intent.spring;
    const win = highlight?.ownerDocument.defaultView;
    if (!highlight || !open || !win) return;
    const timer = win.setTimeout(() => {
      this.spring = undefined;
      if (this.highlighted !== highlight) return;
      const list = this.host.list();
      if (list) this.slides.slide(list, open); else open();
      // The place is the same; what is under the pointer is read again on the next move. Its rows show now, so a
      // drop lands in the gap among them.
      for (const place of [intent, this.intent]) {
        if (place?.highlight !== highlight) continue;
        place.spring = undefined;
        if (place.land === "hide") place.land = "gap";
      }
    }, SPRING_MS);
    this.spring = { highlight, timer };
  }

  private clearSpring(): void {
    if (!this.spring) return;
    this.spring.highlight.ownerDocument.defaultView?.clearTimeout(this.spring.timer);
    this.spring = undefined;
  }

  /**
   * Where the gap would sit, as one key however it is described: "after row 3" and "before row 4" are the same
   * place, as are places only folded-away dragged rows separate. Its list, the row shown above it, and its depth.
   */
  private slotKey(place: NavGap, folded = this.folded): string {
    const shown = (element: Element | null): boolean => Boolean(element?.instanceOf(HTMLElement) && element !== this.gap
      && !element.classList.contains("tm-drag-preview") && !(folded && this.sources.includes(element)));
    const container = place.where === "start" || place.where === "end" ? place.element : place.element.parentElement;
    let above: Element | null = place.where === "start" ? null : place.where === "end" ? place.element.lastElementChild
      : place.where === "after" ? place.element : place.element.previousElementSibling;
    while (above && !shown(above)) above = above.previousElementSibling;
    return `${container ? this.targetKey(container) : 0}:${above?.instanceOf(HTMLElement) ? this.targetKey(above) : "start"}:${place.depth}`;
  }

  private targetKey(element: HTMLElement): number {
    let key = this.keys.get(element);
    if (key === undefined) { key = ++this.lastKey; this.keys.set(element, key); }
    return key;
  }
}
