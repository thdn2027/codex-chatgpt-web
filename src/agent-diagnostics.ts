import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { inspectCodexIntegration, readCodexSubagentProtocol } from "./codex-integration";

export interface AgentDiagnosticReport {
  protocol: string;
  config: {
    multiAgent?: boolean;
    multiAgentV2?: boolean;
    maxDepth?: number;
  };
  integration: ReturnType<typeof inspectCodexIntegration>;
  files: {
    configPath: string;
    modelsCacheCandidates: string[];
    existingModelCaches: string[];
  };
  warnings: string[];
}

function readConfigValues(): AgentDiagnosticReport["config"] {
  const path = join(homedir(), ".codex", "config.toml");
  if (!existsSync(path)) return {};

  const content = readFileSync(path, "utf8");
  return {
    multiAgent: /multi_agent\s*=\s*true/.test(content),
    multiAgentV2: /multi_agent_v2\s*=\s*true/.test(content),
    maxDepth: Number(content.match(/max_depth\s*=\s*(\d+)/)?.[1] ?? 0) || undefined,
  };
}

export function inspectAgentDiagnostics(): AgentDiagnosticReport {
  const codexDir = join(homedir(), ".codex");
  const candidates = [
    join(codexDir, "models_cache.json"),
    join(codexDir, "models.json"),
    join(codexDir, "cache", "models.json"),
  ];

  const existing = candidates.filter(existsSync);
  const warnings: string[] = [];
  const config = readConfigValues();

  if (config.multiAgent !== true) {
    warnings.push("multi_agent is not enabled in ~/.codex/config.toml");
  }

  if (config.multiAgentV2 === true) {
    warnings.push("native multi_agent_v2 is enabled; compatibility-v1 debugging expects v2 disabled");
  }

  let protocol = "unknown";
  try {
    protocol = readCodexSubagentProtocol();
  } catch {
    warnings.push("Unable to read codex subagent protocol state");
  }

  return {
    protocol,
    config,
    integration: inspectCodexIntegration(),
    files: {
      configPath: join(codexDir, "config.toml"),
      modelsCacheCandidates: candidates,
      existingModelCaches: existing,
    },
    warnings,
  };
}
