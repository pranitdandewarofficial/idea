/**
 * Test environment shims. `@testing-library/jest-dom` is deliberately not a
 * dependency, so assertions stay plain vitest ones.
 */
import { afterEach, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";

/**
 * Screens load through `useResource`, whose promises resolve after the test body
 * has asserted. Flush those microtasks inside `act()` before unmounting so the run
 * stays quiet and a real warning is still visible when something is actually wrong.
 */
afterEach(async () => {
  await act(async () => {
    await Promise.resolve();
  });
  cleanup();
});

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({ matches: false, media: query, onchange: null, addListener: () => {},
         removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
         dispatchEvent: () => false }) as unknown as MediaQueryList;
  }
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (window as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
  }
}

// jsdom defines window.scrollTo but throws "Not implemented" when it is called;
// the shell scrolls to the top on every navigation.
if (typeof window !== "undefined") {
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
}

// Canvas is not implemented in jsdom; the city renderer must tolerate that.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement["getContext"];
}
