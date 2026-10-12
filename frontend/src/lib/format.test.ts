/** Formatting helpers: the numbers in the UI must never lie about magnitude. */
import { describe, expect, it } from "vitest";
import {
  bytes, clockTime, compactNumber, duration, groupBy, hueFromSeed, initials, money, percent,
  timeAgo, toneFor, truncate,
} from "./format";

const NOW = Date.parse("2026-10-12T12:00:00Z");

describe("timeAgo", () => {
  it("describes recent activity in human units", () => {
    expect(timeAgo(new Date(NOW - 1000).toISOString(), NOW)).toBe("just now");
    expect(timeAgo(new Date(NOW - 45_000).toISOString(), NOW)).toBe("45s ago");
    expect(timeAgo(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m ago");
    expect(timeAgo(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3h ago");
    expect(timeAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d ago");
  });

  it("is honest about missing or unparseable timestamps", () => {
    expect(timeAgo(null, NOW)).toBe("—");
    expect(timeAgo(undefined, NOW)).toBe("—");
    expect(timeAgo("not-a-date", NOW)).toBe("—");
  });

  it("never reports a negative age for a future timestamp", () => {
    expect(timeAgo(new Date(NOW + 60_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("clockTime", () => {
  it("renders a wall-clock time or an em dash", () => {
    expect(clockTime(null)).toBe("—");
    expect(clockTime("garbage")).toBe("—");
    expect(clockTime(new Date(NOW).toISOString())).toMatch(/\d/);
  });
});

describe("duration", () => {
  it("keeps sub-second latencies visible", () => {
    expect(duration(0.4)).toBe("<1 ms");
    expect(duration(38)).toBe("38 ms");
    expect(duration(1500)).toBe("1.50 s");
    expect(duration(45_000)).toBe("45.0 s");
    expect(duration(125_000)).toBe("2m 5s");
    expect(duration(null)).toBe("—");
    expect(duration(Number.NaN)).toBe("—");
  });
});

describe("compactNumber", () => {
  it("abbreviates without hiding an order of magnitude", () => {
    expect(compactNumber(0)).toBe("0");
    expect(compactNumber(940)).toBe("940");
    expect(compactNumber(1500)).toBe("1.50k");
    expect(compactNumber(48_200)).toBe("48.2k");
    expect(compactNumber(2_400_000)).toBe("2.40M");
    expect(compactNumber(null)).toBe("0");
  });
});

describe("bytes", () => {
  it("uses binary units and drops the decimal for whole values", () => {
    expect(bytes(0)).toBe("0 B");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(2048)).toBe("2.0 KB");
    expect(bytes(20_480)).toBe("20 KB");
    expect(bytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(bytes(-1)).toBe("0 B");
    expect(bytes(null)).toBe("0 B");
  });
});

describe("percent / money", () => {
  it("formats ratios and currency", () => {
    expect(percent(0.5)).toBe("50%");
    expect(percent(0.1234, 1)).toBe("12.3%");
    expect(percent(null)).toBe("—");
    expect(money(0)).toBe("$0.00");
    expect(money(0.0031)).toBe("$0.0031");
    expect(money(12.5)).toBe("$12.50");
  });
});

describe("initials / hueFromSeed", () => {
  it("derives a stable avatar identity", () => {
    expect(initials("Pranit Dandewar")).toBe("PD");
    expect(initials("Mira")).toBe("MI");
    expect(initials("  ")).toBe("?");
    expect(hueFromSeed("dev")).toBe(hueFromSeed("dev"));
    expect(hueFromSeed("dev")).not.toBe(hueFromSeed("rhea"));
    expect(hueFromSeed("x")).toBeGreaterThanOrEqual(0);
    expect(hueFromSeed("x")).toBeLessThan(360);
  });
});

describe("toneFor", () => {
  it("maps backend statuses onto the palette", () => {
    expect(toneFor("task", "completed")).toBe("positive");
    expect(toneFor("task", "failed")).toBe("danger");
    expect(toneFor("task", "repairing")).toBe("warning");
    expect(toneFor("agent", "working")).toBe("accent");
    expect(toneFor("plan", "complete")).toBe("positive");
    expect(toneFor("plan", "blocked")).toBe("danger");
    expect(toneFor("task", "a-status-that-does-not-exist")).toBe("neutral");
  });
});

describe("truncate / groupBy", () => {
  it("truncates with an ellipsis and never past the limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("hello world", 6)).toBe("hello…");
    expect(truncate(null)).toBe("");
  });

  it("groups without dropping items", () => {
    const grouped = groupBy([{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "a", v: 3 }], (item) => item.k);
    expect(Object.keys(grouped).sort()).toEqual(["a", "b"]);
    expect(grouped.a).toHaveLength(2);
  });
});
