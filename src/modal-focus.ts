import { useLayoutEffect, useRef, type RefObject } from 'react';

type Layer = { root: HTMLElement; close: () => void; canClose: () => boolean; workspace: boolean };
const layers: Layer[] = [];
const isolated = new Map<HTMLElement, boolean>();
let savedOverflow = '';
let savedRootOverflow = '';

function focusable(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, iframe, [tabindex]')]
    .filter(element => element.tabIndex >= 0 && !element.closest('[inert]') && element.getClientRects().length > 0);
}

export function moveFocusFromFrame(frame: HTMLElement, backward: boolean) {
  const items = focusable(layers.at(-1)?.root ?? document.body);
  const index = items.indexOf(frame);
  if (index !== -1) items[(index + (backward ? -1 : 1) + items.length) % items.length]?.focus({ preventScroll: true });
}

function isolate() {
  for (const [element, previous] of isolated) element.inert = previous;
  isolated.clear();
  const top = layers.at(-1);
  if (!top) return;
  // Isolate siblings along the whole ancestor path, never the active layer's ancestors.
  for (let branch = top.root; branch.parentElement; branch = branch.parentElement) {
    for (const sibling of branch.parentElement.children) {
      if (sibling === branch || !(sibling instanceof HTMLElement)) continue;
      isolated.set(sibling, sibling.inert);
      sibling.inert = true;
    }
    if (branch.parentElement === document.body) break;
  }
}

function firstFocus(layer: Layer) {
  (focusable(layer.root)[0] ?? layer.root).focus({ preventScroll: true });
}

function terminalFocused() {
  return document.activeElement instanceof HTMLElement && !!document.activeElement.closest('.xterm');
}

// Also used by the mail iframe bridge: its keyboard events do not bubble.
export function handleLayerKey(event: KeyboardEvent) {
  const top = layers.at(-1);
  if (!top || event.defaultPrevented) return;
  shortcut(event); // The mail iframe uses this path instead of the parent capture listener.
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') {
    if (top.workspace && terminalFocused()) return;
    event.preventDefault(); event.stopPropagation();
    if (top.canClose()) top.close();
  } else if (event.key === 'Tab') {
    if (top.workspace && terminalFocused()) return; // Shell completion keeps Tab.
    const items = focusable(top.root);
    const first = items[0], last = items.at(-1);
    if (!first || !last) { event.preventDefault(); top.root.focus(); return; }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === top.root)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !top.root.contains(active))) { event.preventDefault(); first.focus(); }
  }
}

function shortcut(event: KeyboardEvent) {
  const top = layers.at(-1);
  if (top?.workspace && (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.code === 'KeyM') {
    event.preventDefault(); event.stopImmediatePropagation(); top.close();
  }
}

function containFocus(event: FocusEvent) {
  const top = layers.at(-1);
  if (top && event.target instanceof Node && !top.root.contains(event.target)) firstFocus(top);
}

export function useModalFocus(root: RefObject<HTMLElement | null>, enabled: boolean, onClose: () => void, options: { workspace?: boolean; canClose?: boolean; returnFocus?: HTMLElement | null } = {}) {
  const latest = useRef({ onClose, canClose: options.canClose !== false });
  const trigger = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { latest.current = { onClose, canClose: options.canClose !== false }; });
  const workspace = !!options.workspace;
  useLayoutEffect(() => {
    if (!enabled || !root.current) return;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // StrictMode replays this effect after focus has entered the dialog. Keep
    // the original outside trigger instead of capturing a disposable child.
    const previous = options.returnFocus ?? (active && root.current.contains(active) ? trigger.current : active);
    trigger.current = previous;
    const layer: Layer = { root: root.current, close: () => latest.current.onClose(), canClose: () => latest.current.canClose, workspace };
    if (!layers.length) {
      savedOverflow = document.body.style.overflow;
      savedRootOverflow = document.documentElement.style.overflow;
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      window.addEventListener('keydown', handleLayerKey);
      document.addEventListener('keydown', shortcut, true);
      document.addEventListener('focusin', containFocus, true);
    }
    layers.push(layer); isolate();
    const field = layer.root.querySelector<HTMLElement>('form input:not(:disabled), form textarea:not(:disabled)');
    if (!workspace || !previous || !layer.root.contains(previous) || !previous.getClientRects().length) (field ?? focusable(layer.root)[0] ?? layer.root).focus({ preventScroll: true });
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      isolate();
      if (!layers.length) {
        document.body.style.overflow = savedOverflow;
        document.documentElement.style.overflow = savedRootOverflow;
        window.removeEventListener('keydown', handleLayerKey);
        document.removeEventListener('keydown', shortcut, true);
        document.removeEventListener('focusin', containFocus, true);
      }
      // Layout-effect cleanup can run before maximize's hiding styles are
      // removed. Restore focus after the commit, when the trigger is visible.
      queueMicrotask(() => {
        const top = layers.at(-1);
        if (previous?.isConnected && previous.getClientRects().length && !previous.closest('[inert]') && (!top || top.root.contains(previous))) previous.focus({ preventScroll: true });
        else if (top) firstFocus(top);
      });
    };
  }, [enabled, root, workspace]);
}
