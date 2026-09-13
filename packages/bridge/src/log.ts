/** One compact line per message, per the robustness requirement. */

const START = Date.now();

function stamp(): string {
  const ms = Date.now() - START;
  const s = (ms / 1000).toFixed(2).padStart(7, " ");
  return `${s}s`;
}

export type Direction = "->" | "<-" | "--";

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function log(scope: string, dir: Direction, summary: string): void {
  process.stdout.write(`${stamp()} ${scope.padEnd(9)} ${dir} ${truncate(summary)}\n`);
}

export function info(message: string): void {
  process.stdout.write(`${stamp()} ${"bridge".padEnd(9)} -- ${message}\n`);
}

export function warn(message: string): void {
  process.stdout.write(`${stamp()} ${"bridge".padEnd(9)} !! ${message}\n`);
}

/** Banner output: no timestamp, meant to be read by a human at startup. */
export function banner(lines: string[]): void {
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
}
