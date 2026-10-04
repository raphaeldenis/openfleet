import { DestroyRef, afterNextRender, type Injector } from '@angular/core';

/** Gives focus back to the control that opened a panel, but only when nothing else took it meanwhile: a user who moved on is never yanked back. */
export function restoreFocusWhenFree({ target, injector }: { target: () => HTMLElement | undefined; injector: Injector }): void {
  if (injector.get(DestroyRef).destroyed) return;
  afterNextRender(
    () => {
      const isFocusFree = document.activeElement === null || document.activeElement === document.body;
      if (isFocusFree) target()?.focus();
    },
    { injector },
  );
}
