/**
 * Spatial focus manager for the 10-foot UI.
 *
 * A TV remote has four arrows, Enter and Back. Tab order cannot express "the
 * thing to the right of this", so focus moves by geometry: from the focused
 * element's rect, pick the nearest candidate whose centre lies in the pressed
 * direction.
 *
 * Layers model focus stealing. A modal pushes a layer and only that layer is
 * navigable until it pops, so the feed underneath cannot be reached by accident.
 */

export type NavKey = "up" | "down" | "left" | "right" | "enter" | "back" | "menu";

/**
 * Normalise a keyboard event to a remote button.
 *
 * Fire TV's WebView reports the D-pad as arrow keys and the centre button as
 * Enter, but Back arrives in several shapes depending on Fire OS version and
 * how the shell forwards it, so every known spelling is accepted. `keyCode` 4
 * is Android's KEYCODE_BACK and 82 is KEYCODE_MENU; both are deprecated in the
 * DOM but still what some Fire OS builds send.
 */
export function toNavKey(event: KeyboardEvent): NavKey | null {
  switch (event.key) {
    case "ArrowUp":
    case "Up":
      return "up";
    case "ArrowDown":
    case "Down":
      return "down";
    case "ArrowLeft":
    case "Left":
      return "left";
    case "ArrowRight":
    case "Right":
      return "right";
    case "Enter":
    case " ":
    case "Spacebar":
      return "enter";
    case "Escape":
    case "Esc":
    case "Backspace":
    case "GoBack":
    case "BrowserBack":
      return "back";
    case "ContextMenu":
    case "Menu":
      return "menu";
    default:
      break;
  }
  switch (event.keyCode) {
    case 4:
      return "back";
    case 82:
      return "menu";
    default:
      return null;
  }
}

export interface FocusOptions {
  /** Layer this target belongs to. Only the top layer is navigable. */
  layer?: string;
  /** Enter pressed while focused. */
  onEnter?: () => void;
  /**
   * First chance at a direction key. Return true to consume it - used by
   * scrollers that pan their content until they run out of room.
   */
  onKey?: (key: NavKey) => boolean;
  /** Focus order hint used when a layer is opened; lowest wins. */
  priority?: number;
}

interface Target extends FocusOptions {
  el: HTMLElement;
  layer: string;
}

const BASE_LAYER = "base";

/** Centre point of a rect, used for direction tests and distance scoring. */
function centre(rect: DOMRect): { x: number; y: number } {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export class FocusManager {
  private targets: Target[] = [];
  private layers: string[] = [BASE_LAYER];
  private current: HTMLElement | null = null;
  private onBack: (() => void) | null = null;
  private onMenu: (() => void) | null = null;

  get activeLayer(): string {
    return this.layers[this.layers.length - 1] ?? BASE_LAYER;
  }

  get focused(): HTMLElement | null {
    return this.current;
  }

  register(el: HTMLElement, options: FocusOptions = {}): void {
    const layer = options.layer ?? BASE_LAYER;
    this.targets = this.targets.filter((target) => target.el !== el);
    this.targets.push({ ...options, el, layer });
    el.tabIndex = -1;
    el.classList.add("focusable");
  }

  unregister(el: HTMLElement): void {
    this.targets = this.targets.filter((target) => target.el !== el);
    if (this.current === el) this.current = null;
  }

  /** Drop every target belonging to a layer, e.g. when a modal closes. */
  clearLayer(layer: string): void {
    for (const target of this.targets) {
      if (target.layer === layer) target.el.classList.remove("focused");
    }
    this.targets = this.targets.filter((target) => target.layer !== layer);
  }

  setBackHandler(handler: (() => void) | null): void {
    this.onBack = handler;
  }

  setMenuHandler(handler: (() => void) | null): void {
    this.onMenu = handler;
  }

  pushLayer(layer: string): void {
    this.layers.push(layer);
    this.focusFirstInLayer();
  }

  /**
   * Drop every layer above the base and forget their targets.
   *
   * Used when the world changes underneath an overlay - a new session, say -
   * so a modal cannot be left holding focus over a screen it no longer
   * describes.
   */
  resetToBase(): void {
    while (this.layers.length > 1) {
      const layer = this.layers.pop()!;
      this.clearLayer(layer);
    }
    this.focusFirstInLayer();
  }

  popLayer(): void {
    if (this.layers.length <= 1) return;
    const layer = this.layers.pop()!;
    this.clearLayer(layer);
    this.focusFirstInLayer();
  }

  private inActiveLayer(): Target[] {
    const layer = this.activeLayer;
    return this.targets.filter((target) => target.layer === layer && isVisible(target.el));
  }

  focusFirstInLayer(): void {
    const candidates = this.inActiveLayer().sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    const first = candidates[0];
    if (first) {
      this.focus(first.el);
      return;
    }
    // Nothing focusable here. Drop the ring as well as the pointer: a layer
    // with no targets must not leave a bright focus ring sitting on whatever
    // was focused underneath it, which from a sofa reads as "the remote is
    // pointed there" when it is not.
    this.clearRing();
    this.current = null;
  }

  focus(el: HTMLElement): void {
    // Clear every ring, not just the one we believe is current. The two can
    // diverge when a layer is torn down while an overlay is being rebuilt, and
    // the symptom - a modal on screen with the ring on the prompt bar behind
    // it - is exactly the kind of thing nobody can diagnose from across a room.
    this.clearRing();
    this.current = el;
    el.classList.add("focused");
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** There is exactly one focus ring on screen, or none. */
  private clearRing(): void {
    this.current?.classList.remove("focused");
    for (const target of this.targets) target.el.classList.remove("focused");
  }

  /** Handle a remote button. Returns true when the key was consumed. */
  handleKey(event: KeyboardEvent): boolean {
    const key = toNavKey(event);
    if (!key) return false;

    if (key === "menu") {
      this.onMenu?.();
      return true;
    }
    if (key === "back") {
      this.onBack?.();
      return true;
    }

    const target = this.targets.find((candidate) => candidate.el === this.current);
    if (!target || target.layer !== this.activeLayer) {
      this.focusFirstInLayer();
      return true;
    }

    if (key === "enter") {
      target.onEnter?.();
      return true;
    }

    // Scrollers get first refusal on direction keys.
    if (target.onKey?.(key)) return true;
    return this.move(key);
  }

  private move(direction: "up" | "down" | "left" | "right"): boolean {
    if (!this.current) {
      this.focusFirstInLayer();
      return true;
    }
    const fromRect = this.current.getBoundingClientRect();
    const from = centre(fromRect);
    const horizontal = direction === "left" || direction === "right";

    const aligned: Array<{ el: HTMLElement; score: number }> = [];
    const offRow: Array<{ el: HTMLElement; score: number }> = [];

    for (const target of this.inActiveLayer()) {
      if (target.el === this.current) continue;
      const toRect = target.el.getBoundingClientRect();
      const to = centre(toRect);
      const dx = to.x - from.x;
      const dy = to.y - from.y;

      // Along-axis distance must be positive in the pressed direction.
      const along =
        direction === "left" ? -dx : direction === "right" ? dx : direction === "up" ? -dy : dy;
      if (along <= 1) continue;
      const across = horizontal ? Math.abs(dy) : Math.abs(dx);

      // Does the candidate share the row (or column) being moved along?
      const overlaps = horizontal
        ? toRect.bottom > fromRect.top && toRect.top < fromRect.bottom
        : toRect.right > fromRect.left && toRect.left < fromRect.right;

      // Weight cross-axis drift heavily so "right" prefers a true neighbour
      // over something far off to the side but slightly closer.
      const entry = { el: target.el, score: along + across * 3 };
      (overlaps ? aligned : offRow).push(entry);
    }

    // Stay in the row. Pressing right from the activity feed should reach the
    // panel beside it or nothing at all - never jump up to the top bar because
    // it happens to be the only thing further right. Vertical moves may leave
    // the column, since that is the only way to reach a control that is not
    // directly above or below, such as the agent name.
    const candidates = aligned.length > 0 ? aligned : horizontal ? [] : offRow;

    let best: { el: HTMLElement; score: number } | null = null;
    for (const candidate of candidates) {
      if (!best || candidate.score < best.score) best = candidate;
    }

    if (best) {
      this.focus(best.el);
      return true;
    }
    return false;
  }
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export interface ScrollerOptions {
  /** Floor for one press, for panels shorter than a page. */
  minStep?: number;
  /** Fraction of the visible height one press moves. */
  page?: number;
  /** Called after a pan, so the owner can react to a deliberate scroll. */
  onPan?: (key: "up" | "down") => void;
}

/** Consecutive presses closer together than this count as a held button. */
const REPEAT_WINDOW_MS = 450;
/** How far a held button accelerates. Four presses covers a very long feed. */
const MAX_ACCELERATION = 4;

/**
 * Turn an element into a D-pad scroller: up/down pan the content, and the key
 * is released back to the focus manager only once the edge is reached, so focus
 * leaves the panel exactly when there is nothing left to scroll.
 *
 * Two things make that bearable on a transcript that has grown to thousands of
 * pixels. A press moves most of a page rather than a fixed sliver, and holding
 * the button accelerates - the remote repeats the key, and each repeat inside
 * REPEAT_WINDOW_MS scrolls further than the last. Without both, "get me back
 * to the prompt bar" is dozens of presses, and while the agent is streaming the
 * content can grow faster than a fixed step can chase it.
 */
export function scrollerKeyHandler(
  el: HTMLElement,
  options: ScrollerOptions | number = {},
): (key: NavKey) => boolean {
  // A number still means "minimum step", which is how the modal detail pane
  // and older call sites use it.
  const {
    minStep = 220,
    page = 0.85,
    onPan,
  } = typeof options === "number" ? { minStep: options } : options;

  let lastKey: NavKey | null = null;
  let lastAt = 0;
  let repeats = 0;

  return (key) => {
    if (key !== "up" && key !== "down") return false;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    if (key === "up" && atTop) return false;
    if (key === "down" && atBottom) return false;

    const now = Date.now();
    repeats = key === lastKey && now - lastAt < REPEAT_WINDOW_MS ? repeats + 1 : 0;
    lastKey = key;
    lastAt = now;

    const step = Math.max(minStep, el.clientHeight * page);
    const accelerated = step * Math.min(1 + repeats * 0.5, MAX_ACCELERATION);
    // Instant, not smooth. A held D-pad repeats every few dozen milliseconds,
    // so smooth scrolling queues animations the viewer then has to wait out -
    // and a transcript that is still growing can re-pin itself to the bottom
    // during one, undoing the scroll that is halfway through playing.
    el.scrollBy({ top: key === "up" ? -accelerated : accelerated, behavior: "auto" });
    onPan?.(key);
    return true;
  };
}
