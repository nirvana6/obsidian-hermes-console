import fs from "fs";
import { createRequire } from "module";
import os from "os";
import path from "path";

import { afterAll, describe, expect, it } from "vitest";

import {
  containsNonAscii,
  getShellIntegration,
  resolveAsciiIntegrationDir,
} from "./shell-integration";

// The module under test reaches Node built-ins through `window.require`
// (Obsidian's Electron renderer has no ESM loader). In a vitest ESM process
// there is no ambient `require`, so hand one through a window stub.
const nodeRequire = createRequire(import.meta.url);

const originalWindow = globalThis.window;

function stubWindow(entryPoints: { homedir: string; tmpdir: string }): void {
  (globalThis as unknown as { window: { require: (moduleName: string) => unknown } }).window = {
    require: (moduleName: string): unknown => {
      if (moduleName === "os") {
        return { homedir: () => entryPoints.homedir, tmpdir: () => entryPoints.tmpdir };
      }
      return nodeRequire(moduleName);
    },
  };
}

afterAll(() => {
  globalThis.window = originalWindow;
});

describe("containsNonAscii", () => {
  it("detects CJK vault names and passes plain ASCII paths", () => {
    expect(containsNonAscii("/vaults/ Hybrid产业研究笔记.vault/.obsidian")).toBe(true);
    expect(containsNonAscii("/home/user/Documents/notes.vault")).toBe(false);
  });
});

describe("resolveAsciiIntegrationDir", () => {
  it("prefers the home-local candidate when home is ASCII-safe", () => {
    const dir = resolveAsciiIntegrationDir("/home/user", "/tmp");
    expect(dir).toBe("/home/user/.local/share/hermes-console/shell-integration");
  });

  it("falls back to tmpdir when home is non-ASCII", () => {
    const dir = resolveAsciiIntegrationDir("/home/用户", "/tmp");
    expect(dir).toBe(path.join("/tmp", "hermes-console", "shell-integration"));
  });

  it("returns null when no candidate is ASCII-safe (degrades, never lies)", () => {
    expect(resolveAsciiIntegrationDir("/home/用户", "/tmp/临时")).toBeNull();
  });
});

describe("getShellIntegration zsh branch with a non-ASCII vault", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "lot-home-"));
  const fakeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lot-tmp-"));
  const cjkVaultBase = path.join(os.tmpdir(), "lot-vault-产业", ".obsidian", "plugins", "hermes-console");

  afterAll(() => {
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(fakeTmp, { recursive: true, force: true });
    fs.rmSync(path.dirname(cjkVaultBase), { recursive: true, force: true });
  });

  it("moves ZDOTDIR and all integration scripts onto an ASCII path", () => {
    stubWindow({ homedir: fakeHome, tmpdir: fakeTmp });

    const result = getShellIntegration("zsh", cjkVaultBase);

    const inVaultDir = path.join(cjkVaultBase, "shell-integration");
    expect(containsNonAscii(inVaultDir)).toBe(true);
    expect(containsNonAscii(result.env.ZDOTDIR)).toBe(false);
    expect(result.env.ZDOTDIR).not.toBe(inVaultDir);
    expect(result.env.ZDOTDIR).toBe(
      path.join(fakeHome, ".local", "share", "hermes-console", "shell-integration"),
    );
    expect(result.args).toEqual([]);

    // Every materialized script must live on the ASCII path and be pure ASCII.
    const expectedFiles = ["zsh-init.zsh", ".zshenv", ".zprofile", ".zshrc"];
    for (const name of expectedFiles) {
      const filePath = path.join(result.env.ZDOTDIR, name);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(containsNonAscii(content), `${name} must be ASCII-only`).toBe(false);
    }
    expect(fs.readFileSync(path.join(result.env.ZDOTDIR, ".zshrc"), "utf-8")).toBe(
      `source "${path.join(result.env.ZDOTDIR, "zsh-init.zsh")}"\n`,
    );
  });

  it("keeps the in-vault directory when the vault path is ASCII (no behavior change)", () => {
    stubWindow({ homedir: fakeHome, tmpdir: fakeTmp });

    const asciiBase = path.join(os.tmpdir(), "lot-ascii-vault", ".obsidian", "plugins", "hermes-console");
    try {
      const result = getShellIntegration("zsh", asciiBase);

      expect(result.env.ZDOTDIR).toBe(path.join(asciiBase, "shell-integration"));
      expect(
        fs.existsSync(path.join(result.env.ZDOTDIR, ".zshrc")),
      ).toBe(true);
    } finally {
      fs.rmSync(path.dirname(asciiBase), { recursive: true, force: true });
    }
  });
});
