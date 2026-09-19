import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const agentDefinitionSchema = z.object({
  title: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Extra env for the child process. Values are never logged or sent to clients. */
  env: z.record(z.string()).default({}),
  /**
   * Priority list of ACP session mode ids. The bridge calls `session/set_mode`
   * with the first one the agent advertises in its `session/new` response.
   */
  preferredModes: z.array(z.string()).default([]),
  /** Command the user should run to log in with this agent's own CLI. */
  loginHint: z.string().optional(),
});

export type AgentDefinition = z.infer<typeof agentDefinitionSchema> & { name: string };

const agentsFileSchema = z.object({
  agents: z.record(agentDefinitionSchema),
});

const here = dirname(fileURLToPath(import.meta.url));

/** `~/.couchmode/agents.json` - user overrides, merged over the bundled defaults. */
export const USER_AGENTS_PATH = join(homedir(), ".couchmode", "agents.json");

async function readAgentsFile(path: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  const result = agentsFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${path} is not a valid agents file: ${result.error.issues[0]?.message}`);
  }
  return result.data.agents;
}

export interface AgentRegistry {
  list(): AgentDefinition[];
  get(name: string): AgentDefinition | undefined;
}

export async function loadAgents(): Promise<AgentRegistry> {
  const bundled = await readAgentsFile(join(here, "agents.json"));
  if (!bundled) throw new Error("bundled agents.json is missing from the build");
  const user = await readAgentsFile(USER_AGENTS_PATH);

  const merged: Record<string, unknown> = { ...bundled, ...(user ?? {}) };
  const entries = new Map<string, AgentDefinition>();
  for (const [name, value] of Object.entries(merged)) {
    entries.set(name, { name, ...agentDefinitionSchema.parse(value) });
  }

  return {
    list: () => [...entries.values()],
    get: (name) => entries.get(name),
  };
}
