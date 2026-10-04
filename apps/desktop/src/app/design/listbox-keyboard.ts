import { nextTabIndex } from './tablist-keyboard';

const OPTION_SELECTOR = '[role="option"]';

/** Moves focus between the options of a vertical listbox on ArrowUp / ArrowDown / Home / End, wrapping at both ends. */
export function moveFocusWithinListbox(event: KeyboardEvent, listbox: HTMLElement): void {
  const options = Array.from(listbox.querySelectorAll<HTMLElement>(OPTION_SELECTOR));
  const currentIndex = options.indexOf(document.activeElement as HTMLElement);
  const targetIndex = nextTabIndex(event, { currentIndex, tabCount: options.length, orientation: 'vertical' });
  if (targetIndex === undefined) return;
  event.preventDefault();
  options[targetIndex]!.focus();
}
