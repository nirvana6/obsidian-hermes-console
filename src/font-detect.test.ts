import { beforeEach, describe, expect, it } from "vitest";

import {
  FONT_CANDIDATES,
  pickFirstInstalledFont,
  resolveFontFamily,
  resetFontDetectionCache,
} from "./font-detect";
import { DEFAULT_FONT_FAMILY } from "./settings";

beforeEach(() => {
  resetFontDetectionCache();
});

describe("pickFirstInstalledFont", () => {
  it("returns the first candidate that reports as installed", () => {
    const installed = pickFirstInstalledFont(
      (family) => family === "FiraCode NFM",
      ["MesloLGM Nerd Font Mono", "FiraCode NFM", "JetBrainsMono NFM"],
    );
    expect(installed).toBe("FiraCode NFM");
  });

  it("returns null when nothing is installed", () => {
    expect(pickFirstInstalledFont(() => false, ["A", "B"])).toBeNull();
  });

  it("prefers earlier candidates over later ones regardless of quality", () => {
    const installed = pickFirstInstalledFont(() => true, ["MesloLGM Nerd Font Mono", "Menlo"]);
    expect(installed).toBe("MesloLGM Nerd Font Mono");
  });

  it("keeps Nerd families ahead of the macOS faces the shipped default was written for", () => {
    const nerdPos = FONT_CANDIDATES.indexOf("MesloLGM Nerd Font Mono");
    expect(nerdPos).toBeGreaterThanOrEqual(0);
    expect(nerdPos).toBeLessThan(FONT_CANDIDATES.indexOf("Menlo"));
  });
});

describe("resolveFontFamily", () => {
  const detected = (): string | null => "MesloLGM Nerd Font Mono";
  const nothingDetected = (): string | null => null;

  it("replaces the shipped default with the detected font", () => {
    expect(resolveFontFamily(DEFAULT_FONT_FAMILY, detected)).toBe("MesloLGM Nerd Font Mono");
  });

  it("treats an emptied field like the default and detects", () => {
    expect(resolveFontFamily("   ", detected)).toBe("MesloLGM Nerd Font Mono");
  });

  it("never overrides a value the user typed", () => {
    const detector = (): string | null => {
      throw new Error("must not run detection for user-set values");
    };
    expect(resolveFontFamily("JetBrainsMono NFM", detector)).toBe("JetBrainsMono NFM");
    expect(resolveFontFamily(`  ${DEFAULT_FONT_FAMILY.replace(",", ", ")}  `, detected)).toBe(
      `  ${DEFAULT_FONT_FAMILY.replace(",", ", ")}  `,
    );
  });

  it("falls back to the shipped default stack when detection finds nothing", () => {
    // Even with no hit there must be a guard: an identical-to-default value
    // that survived casing/spacing normalization should still resolve plainly.
    const spacedDefault = DEFAULT_FONT_FAMILY.replace(",", ",  ");
    expect(spacedDefault).not.toBe(DEFAULT_FONT_FAMILY);
    expect(
      resolveFontFamily(DEFAULT_FONT_FAMILY, nothingDetected),
    ).toBe(DEFAULT_FONT_FAMILY);
    // A near-miss that is not exactly the default is treated as user-set.
    expect(resolveFontFamily(spacedDefault, nothingDetected)).toBe(spacedDefault);
  });

  it("caches detection across calls (detect-once per session)", () => {
    let calls = 0;
    const countingDetector = (): string | null => {
      calls += 1;
      return "FiraCode NFM";
    };
    expect(resolveFontFamily(DEFAULT_FONT_FAMILY, countingDetector)).toBe("FiraCode NFM");
    expect(resolveFontFamily(DEFAULT_FONT_FAMILY, countingDetector)).toBe("FiraCode NFM");
    expect(calls).toBe(1);
    resetFontDetectionCache();
    resolveFontFamily(DEFAULT_FONT_FAMILY, countingDetector);
    expect(calls).toBe(2);
  });
});
