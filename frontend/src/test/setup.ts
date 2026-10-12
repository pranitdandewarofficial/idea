/**
 * Test environment shims. `@testing-library/jest-dom` is deliberately not a
 * dependency, so assertions stay plain vitest ones.
 */
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => cleanup());

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

// jsdom does not implement scrolling; the shell scrolls to the top on navigation.
if (typeof window !== "undefined" && !window.scrollTo) {
  window.scrollTo = (() => {}) as unknown as typeof window.scrollTo;
}

// Canvas is not implemented in jsdom; the city renderer must tolerate that.
if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as unknown as HTMLCanvasElement["getContext"];
}
