import { existsSync, readFileSync } from "node:fs";
import { getConfigPath, loadConfig } from "./config";
import {
  getCodexConfigPath,
  getCodexModelsCachePath,
  inspectCodexIntegration,
  readCodexSubagentProtocol,
} from "./codex-integration";
import {
  findAgentMaxDepthAssignment,
  findFeatureAssignment,
  findMultiAgentV2Assignment,
  splitLines,
} from "./codex-integration-document";
import { CHATGPT_WEB_MODEL_PREFIX } from "./chatgpt-web-models";

type JsonObject = Record<string, unknown>;

export interface AgentCatalogModel {
  slug: string;
  multi_agent_version?: string;
  supported_in_api?: boolean;
  visibility?: string;
}

export interface AgentInspection {
  configPath: string;
  codexConfigPath: string;
  protocol: string;
  config: {
    multi_agent?: boolean;
    multi_agent_v2?: boolean;
    max_depth?: number;
  };
  integration: ReturnType<typeof inspectCodexIntegration>;
  catalog?: {
    path: string;
    webModels: AgentCatalogModel[];
  };
  files: Record<string, boolean>;
  warnings: string[];
}

function assignmentBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function readCodexAgentState(path: string): AgentInspection["config"] {
  if (!existsSync(path)) return {};
  const lines = splitLines(readFileSync(path, "utf8"));
  const multiAgent = findFeatureAssignment(lines, "multi_agent");
  const multiAgentV2 = findMultiAgentV2Assignment(lines);
  const maxDepth = findAgentMaxDepthAssignment(lines);
  return {
    multi_agent: assignmentBoolean(multiAgent.value),
    multi_agent_v2: assignmentBoolean(multiAgentV2.value),
    max_depth: maxDepth.value === undefined ? undefined : Number(maxDepth.value),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readAgentCatalog(path: string): AgentInspection["catalog"] | undefined {
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, webModels: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { path, webModels: [] };
  const models = (value as JsonObject).models;
  if (!Array.isArray(models)) return { path, webModels: [] };
  const webModels = models.flatMap(model => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return [];
    const record = model as JsonObject;
    const slug = optionalString(record.slug);
    if (!slug?.startsWith(CHATGPT_WEB_MODEL_PREFIX)) return [];
    return [{
      slug,
      ...(optionalString(record.multi_agent_version) === undefined
        ? {}
        : { multi_agent_version: optionalString(record.multi_agent_version) }),
      ...(optionalBoolean(record.supported_in_api) === undefined
        ? {}
        : { supported_in_api: optionalBoolean(record.supported_in_api) }),
      ...(optionalString(record.visibility) === undefined
        ? {}
        : { visibility: optionalString(record.visibility) }),
    } satisfies AgentCatalogModel];
  });
  return { path, webModels };
}

export function inspectAgentCapability(): AgentInspection {
  const config = loadConfig();
  const protocol = readCodexSubagentProtocol(config.subagentProtocol);
  const codexConfigPath = getCodexConfigPath();
  const modelsCachePath = getCodexModelsCachePath();
  const integration = inspectCodexIntegration();
  const codexAgentState = readCodexAgentState(codexConfigPath);
  const catalog = readAgentCatalog(modelsCachePath);
  const warnings: string[] = [];

  if (!integration.installed) warnings.push("Codex integration route is not installed");
  if (!existsSync(codexConfigPath)) warnings.push(`Codex config is missing: ${codexConfigPath}`);

  if (protocol === "compatibility-v1") {
    if (codexAgentState.multi_agent !== true) {
      warnings.push("Codex multi_agent is disabled for Compatibility V1");
    }
    if (codexAgentState.multi_agent_v2 !== false) {
      warnings.push("Codex multi_agent_v2 is enabled for Compatibility V1");
    }
    if ((codexAgentState.max_depth ?? 0) < 2) {
      warnings.push("Codex agent max_depth is below the Compatibility V1 minimum of 2");
    }
    for (const model of catalog?.webModels ?? []) {
      if (model.multi_agent_version !== "v1") {
        warnings.push(
          `Codex model cache still advertises ${model.slug} as multi_agent_version=${model.multi_agent_version ?? "missing"} while Compatibility V1 is selected`,
        );
      }
    }
  }

  return {
    configPath: getConfigPath(),
    codexConfigPath,
    protocol,
    config: codexAgentState,
    integration,
    ...(catalog ? { catalog } : {}),
    files: {
      [codexConfigPath]: existsSync(codexConfigPath),
      [modelsCachePath]: existsSync(modelsCachePath),
    },
    warnings,
  };
}

export function formatAgentInspection(value: AgentInspection): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
