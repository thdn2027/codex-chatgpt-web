import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir, getConfigPath, loadConfig } from "./config";
import { inspectCodexIntegration } from "./codex-integration";

export interface AgentInspection {
  configPath: string;
  protocol?: string;
  config: {
    multi_agent?: boolean;
    multi_agent_v2?: boolean;
    max_depth?: number;
  };
  integration: ReturnType<typeof inspectCodexIntegration>;
  files: Record<string, boolean>;
  warnings: string[];
}

function readOptionalJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function inspectAgentCapability(): AgentInspection {
  const config = loadConfig();
  const codexHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  const modelCandidates = [
    join(codexHome, "models.json"),
    join(codexHome, "models_cache.json"),
    join(codexHome, "cache", "models.json"),
  ];

  const integration = inspectCodexIntegration();
  const warnings: string[] = [];
  const modelFiles: Record<string, boolean> = {};

  for (const file of modelCandidates) {
    modelFiles[file] = existsSync(file);
  }

  if (!config.subagentProtocol) {
    warnings.push("subagent protocol is not present in config");
  }
  if (!config.subagentProtocol || config.subagentProtocol === "compatibility-v1") {
    if (!config.subagentProtocol) warnings.push("assuming compatibility-v1 from default behavior");
  }
  if (!integration.installed) {
    warnings.push("Codex integration route is not installed");
  }
  if (!Object.values(modelFiles).some(Boolean)) {
    warnings.push("No Codex model cache file found");
  }

  return {
    configPath: getConfigPath(),
    protocol: config.subagentProtocol,
    config: {
      multi_agent: config.subagentProtocol === "compatibility-v1",
      multi_agent_v2: config.subagentProtocol === "native",
      max_depth: 2,
    },
    integration,
    files: modelFiles,
    warnings,
  };
}

export function formatAgentInspection(value: AgentInspection): string {
  return JSON.stringify(value, null, 2);
}
