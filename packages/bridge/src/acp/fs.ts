/**
 * Client-side ACP file-system methods: `fs/read_text_file` and `fs/write_text_file`.
 *
 * We advertise these in `initialize` as
 *   clientCapabilities.fs = { readTextFile: true, writeTextFile: true }
 * and per the spec every path the agent sends MUST be absolute. We additionally
 * refuse anything that resolves outside the session `cwd`.
 */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import type { ReadTextFileRequest, WriteTextFileRequest } from "@agentclientprotocol/sdk";

/**
 * Resolve the real path of the nearest existing ancestor, so that symlinked
 * roots (on macOS, /tmp -> /private/tmp) compare correctly even when the target
 * file does not exist yet.
 */
async function realpathOfNearestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      current = parent;
    }
  }
}

export class ScopedFs {
  private rootPromise: Promise<string>;

  constructor(private readonly cwd: string) {
    this.rootPromise = realpath(cwd).catch(() => resolve(cwd));
  }

  /**
   * Refuse absolute-but-outside-cwd paths, and refuse relative paths outright:
   * ACP requires absolute paths, so a relative one is a protocol violation.
   */
  private async assertInsideCwd(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      // ACP: "All file paths in the protocol MUST be absolute."
      throw RequestError.invalidParams(
        { path },
        `path must be absolute, got ${JSON.stringify(path)}`,
      );
    }
    const root = await this.rootPromise;
    const resolved = resolve(path);
    const real = await realpathOfNearestExisting(resolved);
    const rel = relative(root, real);
    if (rel === "") return resolved;
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw RequestError.invalidParams(
        { path, cwd: this.cwd },
        `path is outside the Couchmode session directory and was refused: ${path}`,
      );
    }
    return resolved;
  }

  /** `fs/read_text_file` -> `{ content }`. `line` is 1-based; `limit` counts lines. */
  async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    const path = await this.assertInsideCwd(params.path);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      throw RequestError.resourceNotFound(`file://${path}`);
    }

    const hasLine = typeof params.line === "number" && params.line !== null;
    const hasLimit = typeof params.limit === "number" && params.limit !== null;
    if (!hasLine && !hasLimit) return { content };

    const lines = content.split("\n");
    const start = hasLine ? Math.max(0, (params.line as number) - 1) : 0;
    const end = hasLimit ? start + (params.limit as number) : lines.length;
    return { content: lines.slice(start, end).join("\n") };
  }

  /** `fs/write_text_file` -> empty result. The client MUST create the file if absent. */
  async writeTextFile(params: WriteTextFileRequest): Promise<void> {
    const path = await this.assertInsideCwd(params.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
  }
}
