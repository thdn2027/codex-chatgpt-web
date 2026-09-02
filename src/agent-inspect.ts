import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { inspectCodexIntegration, getCodexConfigPath, getCodexModelsCachePath, readCodexSubagentProtocol } from "./codex-integration";
import type { SubagentProtocol } from "./config";
import { runCommand } from "./process";

export interface RuntimeModel {
  slug?: string;
  visibility?: string;
  supported_in_api?: boolean;
  priority?: number;
  multi_agent_version?: "v1" | "v2" | "disabled" | string;
}

export interface RuntimeModelCatalog {
  models?: RuntimeModel[];
}

export interface ParsedCodexAgentConfig {
  selectedModel?: string;
  multiAgent?: boolean;
  multiAgentV2?: boolean;
  agentsEnabled: boolean;
  maxDepth?: number;
}

export interface RecentSessionAgentState {
  multiAgentVersion?: string;
  model?: string;
  spawnAgentSeen: boolean;
  waitAgentSeen: boolean;
  path?: string;
}

export interface AgentCapabilityInput {
  protocol: SubagentProtocol;
  configText: string;
  integrationInstalled: boolean;
  integrationActive: boolean;
  runtimeCatalog?: RuntimeModelCatalog;
  runtimeCatalogSource?: "codex-debug-models" | "models-cache";
  recentSession?: RecentSessionAgentState;
  codexVersion?: string;
  bundledCodexVersion?: string;
}

export interface AgentCapabilityReport {
  protocol: SubagentProtocol;
  codexVersion?: string;
  bundledCodexVersion?: string;
  config: ParsedCodexAgentConfig;
  runtimeCatalogSource?: AgentCapabilityInput["runtimeCatalogSource"];
  selectedModel?: {
    slug: string;
    multiAgentVersion?: string;
  };
  recentSession?: RecentSessionAgentState;
  routedV1Models: string[];
  blockers: string[];
  warnings: string[];
  readyForFreshThread: boolean;
  /**
   * Codex persists the selected multi-agent backend on a thread. A thread created before the
   * protocol/catalog change can therefore remain Disabled even after setup has become correct.
   */
  freshThreadRequired: true;
}

function stripTomlComment(raw: string): string {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return raw.slice(0, index).trimEnd();
  }
  return raw.trimEnd();
}

function assignment(line: string): { key: string; value: string } | undefined {
  const stripped = stripTomlComment(line).trim();
  const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(stripped);
  return match ? { key: match[1]!, value: match[2]!.trim() } : undefined;
}

function booleanValue(value: string): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function positiveInteger(value: string): number | undefined {
  const normalized = value.replaceAll("_", "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      return typeof decoded === "string" ? decoded : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return undefined;
}

export function parseCodexAgentConfig(text: string): ParsedCodexAgentConfig {
  let table = "";
  let selectedModel: string | undefined;
  let multiAgent: boolean | undefined;
  let multiAgentV2: boolean | undefined;
  let agentsEnabled: boolean | undefined;
  let maxDepth: number | undefined;

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const tableMatch = /^\[([^\]]+)]$/.exec(line);
    if (tableMatch) {
      table = tableMatch[1]!.trim();
      continue;
    }
    const value = assignment(rawLine);
    if (!value) continue;
    if (!table && value.key === "model") selectedModel = stringValue(value.value);
    else if (table === "features" && value.key === "multi_agent") {
      multiAgent = booleanValue(value.value);
    } else if (table === "features" && value.key === "multi_agent_v2") {
      multiAgentV2 = booleanValue(value.value);
    } else if (table === "features.multi_agent_v2" && value.key === "enabled") {
      multiAgentV2 = booleanValue(value.value);
    } else if (table === "agents" && value.key === "enabled") {
      agentsEnabled = booleanValue(value.value);
    } else if (table === "agents" && value.key === "max_depth") {
      maxDepth = positiveInteger(value.value);
    }
  }

  return {
    ...(selectedModel ? { selectedModel } : {}),
    ...(multiAgent === undefined ? {} : { multiAgent }),
    ...(multiAgentV2 === undefined ? {} : { multiAgentV2 }),
    // Codex defaults [agents].enabled to true. Surface the effective value, not merely presence.
    agentsEnabled: agentsEnabled ?? true,
    ...(maxDepth === undefined ? {} : { maxDepth }),
  };
}

function modelRows(catalog?: RuntimeModelCatalog): RuntimeModel[] {
  return Array.isArray(catalog?.models)
    ? catalog.models.filter(model => model && typeof model === "object")
    : [];
}

function findNestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedString(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const object = value as Record<string, unknown>;
  const direct = object[key];
  if (typeof direct === "string") return direct;
  for (const child of Object.values(object)) {
    const found = findNestedString(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function extractLatestSessionAgentState(lines: string[]): RecentSessionAgentState | undefined {
  let multiAgentVersion: string | undefined;
  let model: string | undefined;
  let spawnAgentSeen = false;
  let waitAgentSeen = false;

  for (const line of lines) {
    if (line.includes("spawn_agent")) spawnAgentSeen = true;
    if (line.includes("wait_agent")) waitAgentSeen = true;
  }

  for (let index = lines.length - 1; index >= 0 && (!multiAgentVersion || !model); index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!multiAgentVersion) {
      const candidate = findNestedString(value, "multi_agent_version");
      if (candidate === "v1" || candidate === "v2" || candidate === "disabled") {
        multiAgentVersion = candidate;
      }
    }
    if (!model) {
      const candidate = findNestedString(value, "model");
      if (candidate) model = candidate;
    }
  }

  if (!multiAgentVersion && !model && !spawnAgentSeen && !waitAgentSeen) return undefined;
  return {
    ...(multiAgentVersion ? { multiAgentVersion } : {}),
    ...(model ? { model } : {}),
    spawnAgentSeen,
    waitAgentSeen,
  };
}

export function analyzeAgentCapability(input: AgentCapabilityInput): AgentCapabilityReport {
  const config = parseCodexAgentConfig(input.configText);
  const rows = modelRows(input.runtimeCatalog);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.integrationInstalled) blockers.push("Codex route integration is not installed");
  else if (!input.integrationActive) blockers.push("Codex route integration is disconnected");

  if (input.protocol === "compatibility-v1") {
    if (config.multiAgent !== true) blockers.push("Codex [features].multi_agent is not true");
    if (config.multiAgentV2 !== false) blockers.push("Codex multi_agent_v2 is not explicitly false");
    if (!config.agentsEnabled) blockers.push("Codex [agents].enabled is false");
    if ((config.maxDepth ?? 0) < 2) blockers.push("Codex [agents].max_depth must be at least 2 for Compatibility V1");
  }

  if (rows.length === 0) {
    blockers.push("Codex runtime model catalog is unavailable");
  }

  const routedV1Models = rows
    .filter(model => model.slug?.startsWith("chatgpt-web/") && model.multi_agent_version === "v1")
    .map(model => model.slug!)
    .toSorted();

  if (input.protocol === "compatibility-v1" && rows.length > 0 && routedV1Models.length === 0) {
    blockers.push("Codex runtime catalog exposes no chatgpt-web model with multi_agent_version=v1");
  }

  let selectedModel: AgentCapabilityReport["selectedModel"];
  if (config.selectedModel) {
    const row = rows.find(model => model.slug === config.selectedModel);
    if (!row && rows.length > 0) {
      blockers.push(`Selected model ${config.selectedModel} is absent from the Codex runtime catalog`);
    } else if (row) {
      selectedModel = {
        slug: config.selectedModel,
        ...(typeof row.multi_agent_version === "string"
          ? { multiAgentVersion: row.multi_agent_version }
          : {}),
      };
      if (input.protocol === "compatibility-v1" && row.multi_agent_version !== "v1") {
        blockers.push(
          `Selected model ${config.selectedModel} must advertise multi_agent_version=v1; got ${String(row.multi_agent_version)}`,
        );
      }
    }
  }

  if (!input.codexVersion) warnings.push("Could not execute `codex --version`");
  if (input.codexVersion && input.bundledCodexVersion && input.codexVersion !== input.bundledCodexVersion) {
    warnings.push(
      `PATH Codex (${input.codexVersion}) differs from ChatGPT.app bundled Codex (${input.bundledCodexVersion})`,
    );
  }
  if (input.recentSession?.multiAgentVersion === "disabled") {
    warnings.push(
      "The most recent Codex session persisted multi-agent backend is disabled; start a new thread after the route/catalog is ready",
    );
  }
  warnings.push("Start a new Codex thread after changing the subagent protocol or model catalog; existing threads keep their original multi-agent backend");

  return {
    protocol: input.protocol,
    ...(input.codexVersion ? { codexVersion: input.codexVersion } : {}),
    ...(input.bundledCodexVersion ? { bundledCodexVersion: input.bundledCodexVersion } : {}),
    config,
    ...(input.runtimeCatalogSource ? { runtimeCatalogSource: input.runtimeCatalogSource } : {}),
    ...(selectedModel ? { selectedModel } : {}),
    ...(input.recentSession ? { recentSession: input.recentSession } : {}),
    routedV1Models,
    blockers,
    warnings,
    readyForFreshThread: blockers.length === 0,
    freshThreadRequired: true,
  };
}

function readCatalog(path: string): RuntimeModelCatalog | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as RuntimeModelCatalog;
    return Array.isArray(value?.models) ? value : undefined;
  } catch {
    return undefined;
  }
}

function commandOutput(command: string, args: string[]): string | undefined {
  try {
    const result = runCommand(command, args);
    if (result.status !== 0) return undefined;
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function runtimeCatalog(): {
  catalog?: RuntimeModelCatalog;
  source?: AgentCapabilityInput["runtimeCatalogSource"];
} {
  const debug = commandOutput("codex", ["debug", "models"]);
  if (debug) {
    try {
      const catalog = JSON.parse(debug) as RuntimeModelCatalog;
      if (Array.isArray(catalog?.models)) return { catalog, source: "codex-debug-models" };
    } catch {
      // Fall through to the exact cache Codex itself uses.
    }
  }
  const catalog = readCatalog(getCodexModelsCachePath());
  return catalog ? { catalog, source: "models-cache" } : {};
}

function newestSessionFiles(root: string, limit = 12): string[] {
  if (!existsSync(root)) return [];
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          files.push({ path, mtimeMs: statSync(path).mtimeMs });
        } catch {
          // Session may be rotated between directory enumeration and stat.
        }
      }
    }
  };
  walk(root);
  return files
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, limit)
    .map(file => file.path);
}

function recentSessionState(): RecentSessionAgentState | undefined {
  const sessionsRoot = join(dirname(getCodexConfigPath()), "sessions");
  for (const path of newestSessionFiles(sessionsRoot)) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const state = extractLatestSessionAgentState(content.split(/\r?\n/));
    if (state) return { ...state, path };
  }
  return undefined;
}

export function inspectAgentCapability(): AgentCapabilityReport {
  const configPath = getCodexConfigPath();
  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const integration = inspectCodexIntegration();
  const runtime = runtimeCatalog();
  const recentSession = recentSessionState();
  const bundledBinary = "/Applications/ChatGPT.app/Contents/Resources/codex";
  return analyzeAgentCapability({
    protocol: readCodexSubagentProtocol(),
    configText,
    integrationInstalled: integration.installed,
    integrationActive: integration.active,
    ...(runtime.catalog ? { runtimeCatalog: runtime.catalog } : {}),
    ...(runtime.source ? { runtimeCatalogSource: runtime.source } : {}),
    ...(recentSession ? { recentSession } : {}),
    codexVersion: commandOutput("codex", ["--version"]),
    ...(existsSync(bundledBinary)
      ? { bundledCodexVersion: commandOutput(bundledBinary, ["--version"]) }
      : {}),
  });
}

export function formatAgentInspection(report: AgentCapabilityReport): string {
  const status = report.readyForFreshThread ? "READY (fresh thread)" : "BLOCKED";
  const lines = [
    `Agent capability: ${status}`,
    `Protocol: ${report.protocol}`,
    `Codex: ${report.codexVersion ?? "unavailable"}`,
    `Runtime catalog: ${report.runtimeCatalogSource ?? "unavailable"}`,
    `Config: multi_agent=${String(report.config.multiAgent)}, multi_agent_v2=${String(report.config.multiAgentV2)}, agents.enabled=${String(report.config.agentsEnabled)}, max_depth=${String(report.config.maxDepth)}`,
    `Routed V1 models: ${report.routedV1Models.join(", ") || "none"}`,
    ...(report.selectedModel
      ? [`Selected model: ${report.selectedModel.slug} (${report.selectedModel.multiAgentVersion ?? "no multi-agent metadata"})`]
      : []),
    ...(report.recentSession
      ? [
          `Recent session: model=${report.recentSession.model ?? "unknown"}, multi_agent_version=${report.recentSession.multiAgentVersion ?? "unknown"}, spawn_agent=${report.recentSession.spawnAgentSeen}, wait_agent=${report.recentSession.waitAgentSeen}`,
          ...(report.recentSession.path ? [`Recent session file: ${report.recentSession.path}`] : []),
        ]
      : []),
    ...report.blockers.map(blocker => `BLOCKER: ${blocker}`),
    ...report.warnings.map(warning => `NOTE: ${warning}`),
  ];
  return `${lines.join("\n")}\n`;
}
