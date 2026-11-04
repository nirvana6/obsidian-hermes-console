import { Platform } from "obsidian";

/**
 * Shell integration for OSC 133 command detection.
 * Init scripts are embedded as string constants and written to the plugin
 * directory on first use, so no extra files need to ship in the release.
 */

const BASH_SCRIPT = `
# Hermes Console - shell integration for bash
if [ -n "$__LOT_SHELL_INTEGRATION" ]; then return 0 2>/dev/null || exit 0; fi
__LOT_SHELL_INTEGRATION=1
__lot_prompt_command() {
  local ec="$?"
  printf '\\e]133;D;%s\\e\\\\' "$ec"
  printf '\\e]133;A\\e\\\\'
}
if [ -n "$PROMPT_COMMAND" ]; then
  PROMPT_COMMAND="__lot_prompt_command;\${PROMPT_COMMAND}"
else
  PROMPT_COMMAND="__lot_prompt_command"
fi
PS0='$(__lot_preexec)'
__lot_preexec() { printf '\\e]133;B\\e\\\\'; }
printf '\\e]133;A\\e\\\\'
`.trim();

const ZSH_SCRIPT = `
# Hermes Console - shell integration for zsh
if [[ -n "$__LOT_SHELL_INTEGRATION" ]]; then return 0; fi
__LOT_SHELL_INTEGRATION=1
if [[ -n "$__LOT_USER_ZDOTDIR" ]]; then
  ZDOTDIR="$__LOT_USER_ZDOTDIR"
  [[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
elif [[ -f "$HOME/.zshrc" ]]; then
  source "$HOME/.zshrc"
fi
__lot_precmd() {
  local ec="$?"
  printf '\\e]133;D;%s\\e\\\\' "$ec"
  printf '\\e]133;A\\e\\\\'
}
__lot_preexec() { printf '\\e]133;B\\e\\\\'; }
autoload -Uz add-zsh-hook
add-zsh-hook precmd __lot_precmd
add-zsh-hook preexec __lot_preexec
printf '\\e]133;A\\e\\\\'
`.trim();

const PWSH_SCRIPT = `
# Hermes Console - shell integration for PowerShell
if ($env:__LOT_SHELL_INTEGRATION) { return }
$env:__LOT_SHELL_INTEGRATION = "1"
$__lot_original_prompt = $function:prompt
function prompt {
    $ec = $global:LASTEXITCODE
    [Console]::Out.Write("\`e]133;D;$ec\`e\\")
    [Console]::Out.Write("\`e]133;A\`e\\")
    $result = & $__lot_original_prompt
    [Console]::Out.Write("\`e]133;B\`e\\")
    return $result
}
[Console]::Out.Write("\`e]133;A\`e\\")
`.trim();

function joinPath(...parts: string[]): string {
  const path = window.require("path") as typeof import("path");
  return path.join(...parts);
}

/**
 * zsh's compinit aborts ("compinit:201: bad pattern") when ZDOTDIR points at a
 * directory whose path contains non-ASCII bytes, and the aborted compinit is
 * what defines `compdef` — every completion framework downstream then fails
 * with "command not found: compdef". There is no one-line .zshrc workaround:
 * the path is already on the call stack once the files are sourced. Keeping the
 * integration scripts on an ASCII path is the only reliable fix.
 */
export function containsNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

/**
 * Pick an ASCII-safe directory outside the vault where shell-integration
 * scripts can live even when the vault path is not ASCII. Returns null when
 * no candidate is ASCII-safe (degrades to the in-vault directory).
 */
export function resolveAsciiIntegrationDir(home: string, tmp: string): string | null {
  // POSIX separators on purpose: this only runs on the zsh branch (macOS/Linux)
  // and must not depend on window.require so it stays a pure, testable function.
  const candidates = [
    `${home}/.local/share/hermes-console/shell-integration`,
    `${tmp}/hermes-console/shell-integration`,
  ];
  for (const dir of candidates) {
    if (dir && !containsNonAscii(dir)) return dir;
  }
  return null;
}

/** Write a script to disk if it doesn't exist or has changed. */
function ensureScript(dir: string, filename: string, content: string): string {
  // Direct Node fs access is intentional here: shell integration needs actual
  // init script files because shells accept file paths/env vars, not Obsidian
  // Vault adapter handles. Scripts are written only under this plugin directory.
  const fs = window.require("fs") as typeof import("fs");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = joinPath(dir, filename);
  try {
    const existing = fs.readFileSync(filePath, "utf-8");
    if (existing === content) return filePath;
  } catch {
    // file doesn't exist yet
  }
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

interface ShellIntegrationResult {
  env: Record<string, string>;
  args: string[];
}

/**
 * Returns extra env vars and args to inject shell integration hooks.
 * Scripts are materialized to pluginDir/shell-integration/ on demand.
 */
export function getShellIntegration(
  shellPath: string,
  pluginDir: string
): ShellIntegrationResult {
  const lower = shellPath.toLowerCase();
  const scriptDir = joinPath(pluginDir, "shell-integration");

  if (Platform.isWin) {
    if (lower.includes("pwsh") || lower.includes("powershell")) {
      const initPath = ensureScript(scriptDir, "pwsh-init.ps1", PWSH_SCRIPT);
      return {
        env: {},
        args: ["-NoLogo", "-NoExit", "-File", initPath],
      };
    }
    // cmd.exe — no hook support
    return { env: {}, args: [] };
  }

  // macOS / Linux
  if (lower.includes("zsh") || lower.endsWith("/zsh")) {
    // When the plugin directory (inside the vault) is not ASCII-safe, keep the
    // integration scripts on an ASCII path instead — see containsNonAscii().
    // Focus the mirror on zsh only: bash has no compinit and tolerates
    // non-ASCII BASH_ENV paths.
    let integrationDir = scriptDir;
    if (containsNonAscii(scriptDir)) {
      const os = window.require("os") as typeof import("os");
      const asciiDir = resolveAsciiIntegrationDir(os.homedir(), os.tmpdir());
      if (asciiDir) integrationDir = asciiDir;
    }
    const initFile = ensureScript(integrationDir, "zsh-init.zsh", ZSH_SCRIPT);
    // Use the user's ZDOTDIR if set; otherwise let zsh resolve $HOME at runtime.
    // Passing an empty __LOT_USER_ZDOTDIR lets ZSH_SCRIPT's elif branch source $HOME/.zshrc.
    const customZdotdir = process.env.ZDOTDIR;
    const scriptZdotdir = customZdotdir || "${HOME}";
    ensureScript(integrationDir, ".zshenv",   `[[ -f "${scriptZdotdir}/.zshenv"   ]] && source "${scriptZdotdir}/.zshenv"\n`);
    ensureScript(integrationDir, ".zprofile", `[[ -f "${scriptZdotdir}/.zprofile" ]] && source "${scriptZdotdir}/.zprofile"\n`);
    ensureScript(integrationDir, ".zshrc",    `source "${initFile}"\n`);
    return {
      env: {
        __LOT_USER_ZDOTDIR: customZdotdir ?? "",
        ZDOTDIR: integrationDir,
      },
      args: [],
    };
  }

  if (lower.includes("bash") || lower.endsWith("/bash") || lower.endsWith("/sh")) {
    const initPath = ensureScript(scriptDir, "bash-init.sh", BASH_SCRIPT);
    return {
      env: { BASH_ENV: initPath },
      args: [],
    };
  }

  return { env: {}, args: [] };
}
