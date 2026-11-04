import { DEFAULT_FONT_FAMILY } from "./settings";

/**
 * Font auto-detection for new installs (and users who reset the field).
 *
 * The shipped default font stack (Menlo/Monaco/'Courier New') only exists on
 * macOS; everywhere else CSS silently falls back to the generic monospace face
 * and the terminal looks degraded without any error being reported. Browsers do
 * not report which entry of font-family list was actually used, and Chromium's
 * full font enumeration (`queryLocalFonts`) sits behind a permission the host
 * app (Obsidian) does not grant to plugins — so instead of guessing we detect:
 * render probe strings with each candidate and compare measurements against a
 * fallback-only baseline.
 *
 * This only ever replaces the *default* value (`resolveFontFamily` short-
 * circuits for anything the user typed), so upstream's default stack is kept
 * as the final fallback and author intent on macOS (Menlo/Monaco hit first in
 * the candidate list) is preserved.
 */

export const FONT_CANDIDATES = [
  // Nerd Font Mono families first: Hermes TUI (p10k) renders private-area
  // glyphs, which a plain monospace face shows as tofu.
  "MesloLGM Nerd Font Mono",
  "Meslo LG S Nerd Font Mono",
  "CaskaydiaMono NFM",
  "FiraCode NFM",
  "JetBrainsMono NFM",
  "DejaVuSansM NFM",
  "SauceCodePro NFM",
  "Hack NFM",
  "Iosevka NFM",
  "CaskaydiaCove NFM",
  "FiraMono NFM",
  "GeistMono NFM",
  "CommitMono NFM",
  "MartianMono NFM",
  // Author's shipped intent on macOS, accepted as-is when installed.
  "SF Mono",
  "Menlo",
  "Monaco",
  "Courier New",
];

/** Probe string mixing glyph shapes so same-width fakes are unlikely. */
const WIDTH_PROBE = "mmmmmmiiiiwwwwHHHH0O0O{}[]()<>WAWA";

const NOT_INSTALLED_FONT = "ThisFamilyDoesNotExist-XYZ";

export function pickFirstInstalledFont(
  isInstalled: (family: string) => boolean,
  candidates: string[] = FONT_CANDIDATES,
): string | null {
  for (const family of candidates) {
    if (isInstalled(family)) return family;
  }
  return null;
}

function looksInstalled(ctx: CanvasRenderingContext2D, family: string): boolean {
  const base = `72px "${NOT_INSTALLED_FONT}", monospace`;
  const probe = `72px "${family}", "${NOT_INSTALLED_FONT}", monospace`;
  ctx.font = base;
  const fallbackWidth = ctx.measureText(WIDTH_PROBE).width;
  ctx.font = probe;
  return Math.abs(ctx.measureText(WIDTH_PROBE).width - fallbackWidth) > 0.5;
}

/**
 * Private-use unicode glyphs (Powerline/Nerd range) only exist in patched
 * fonts. Verify by painting and checking some pixels are actually drawn —
 * some plain monospace faces give tofu an advance so a width probe alone
 * would produce false positives.
 */
function hasNerdGlyphs(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  family: string,
): boolean {
  const size = 96;
  ctx.font = `${size}px "${family}", "${NOT_INSTALLED_FONT}", monospace`;
  ctx.fillStyle = "#000";
  ctx.textBaseline = "top";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillText("\u{E0B2}\u{E0B0}", 4, 4);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 16) return true;
  }
  return false;
}

export function detectTerminalFont(): string | null {
  // Tests and non-DOM environments skip silently.
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 160;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  return pickFirstInstalledFont((family) => {
    if (!looksInstalled(ctx, family)) return false;
    // Nerd families must prove their private-area glyphs really render.
    if (/Nerd Font Mono|NFM$/.test(family)) return hasNerdGlyphs(canvas, ctx, family);
    return true;
  });
}

let cachedDetection: string | null | undefined;

/** Restores first-call semantics; exported for tests. */
export function resetFontDetectionCache(): void {
  cachedDetection = undefined;
}

/**
 * The single integration point for the Terminal's fontFamily option.
 * A user-typed value (including whitespace) always wins. The default stack or
 * an emptied field triggers detection; when nothing is installed that probes
 * better than the generic monospace face, the upstream default stack stays.
 */
export function resolveFontFamily(
  value: string,
  detector: () => string | null = detectTerminalFont,
): string {
  const trimmed = value.trim();
  if (trimmed && trimmed !== DEFAULT_FONT_FAMILY) return value;
  if (cachedDetection === undefined) cachedDetection = detector() ?? null;
  return cachedDetection ?? DEFAULT_FONT_FAMILY;
}
