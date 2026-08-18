import chalk from "chalk";

/**
 * Color palette, modeled on Claude Code's classic terminal look.
 * Each entry is a chalk style function applied to plain text.
 */
export interface Palette {
  /** Prompt bar + user-turn marker (❯). */
  prompt: (s: string) => string;
  user: (s: string) => string;
  /** Tool names and headers (⚙). */
  tool: (s: string) => string;
  success: (s: string) => string;
  error: (s: string) => string;
  warn: (s: string) => string;
  /** Secondary text (metadata, continuation markers). */
  dim: (s: string) => string;
  /** Accent for the logo / banner. */
  accent: (s: string) => string;
  /** Footer / status line. */
  footer: (s: string) => string;
}

/** Claude Code's terracotta prompt color. */
const TERRACOTTA = chalk.hex("#d97757");

/** DeepSeek brand blue — used for the whale logo / wordmark on the splash. */
export const DEEPSEEK_BLUE = chalk.hex("#4d6bfe");

export const COLOR_NAMES = [
  "default",
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;
export type PromptColor = (typeof COLOR_NAMES)[number];

function colorFn(name: string | undefined): (s: string) => string {
  switch (name) {
    case "red":
      return chalk.red;
    case "blue":
      return chalk.blue;
    case "green":
      return chalk.green;
    case "yellow":
      return chalk.yellow;
    case "purple":
      return chalk.hex("#a78bfa");
    case "orange":
      return chalk.hex("#fb923c");
    case "pink":
      return chalk.hex("#f472b6");
    case "cyan":
      return chalk.cyan;
    default:
      return TERRACOTTA;
  }
}

export const THEME_NAMES = ["default", "ocean", "mono"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

/** Build the active palette from config values (falls back to default). */
export function getPalette(theme?: string, promptColor?: string): Palette {
  const prompt = colorFn(promptColor);
  switch (theme) {
    case "ocean":
      return {
        prompt,
        user: prompt,
        tool: chalk.cyan,
        success: chalk.green,
        error: chalk.red,
        warn: chalk.yellow,
        dim: chalk.dim,
        accent: chalk.cyan,
        footer: chalk.dim,
      };
    case "mono":
      return {
        prompt,
        user: prompt,
        tool: chalk.bold,
        success: chalk.bold,
        error: chalk.bold,
        warn: chalk.bold,
        dim: chalk.dim,
        accent: chalk.bold,
        footer: chalk.dim,
      };
    default:
      return {
        prompt,
        user: prompt,
        tool: chalk.cyan,
        success: chalk.green,
        error: chalk.red,
        warn: chalk.yellow,
        dim: chalk.dim,
        accent: TERRACOTTA,
        footer: chalk.dim,
      };
  }
}
