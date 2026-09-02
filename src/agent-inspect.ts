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

export function inspectAgentCapability(): AgentInspection {
  const config = loadConfig();
  const protocol = readCodexSubagentProtocol(config.subagentProtocol);
  const codexConfigPath = getCodexConfigPath();
  const modelsCachePath = getCodexModelsCachePath();
  const integration = inspectCodexIntegration();
  const codexAgentState = readCodexAgentState(codexConfigPath);
  const warnings: string[] = [];

  if (!integration.installed) warnings.push("Codex integration route is not installed");
  if (!existsSync(codexConfigPath)) warnings.push(`Codex config is missing: ${codexConfigPath}`);
  if (!existsSync(modelsCachePath)) warnings.push(`Codex models cache is missing: ${modelsCachePath}`);

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
  }

  return {
    configPath: getConfigPath(),
    codexConfigPath,
    protocol,
    config: codexAgentState,
    integration,
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
