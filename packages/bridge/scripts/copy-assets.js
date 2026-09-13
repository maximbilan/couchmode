// agents.json is data the CLI reads at runtime, so it must land next to the
// compiled config module.
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await mkdir(join(root, "dist", "config"), { recursive: true });
await copyFile(
  join(root, "src", "config", "agents.json"),
  join(root, "dist", "config", "agents.json"),
);
