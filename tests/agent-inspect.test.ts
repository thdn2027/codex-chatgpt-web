import { describe, expect, test } from "bun:test";
import {
  analyzeAgentCapability,
  parseCodexAgentConfig,
  type RuntimeModelCatalog,
} from "../src/agent-inspect";

const compatibilityV1Config = [
  'model = "chatgpt-web/high"',
  "",
  "[features]",
  "multi_agent = true # Managed by codex-chatgpt-web",
  "multi_agent_v2 = false # Managed by codex-chatgpt-web",
  "",
  "[agents]",
  "max_depth = 2 # Managed by codex-chatgpt-web",
  "",
].join("\n");

function catalog(version: "v1" | "v2" | "disabled" = "v1"): RuntimeModelCatalog {
  return {
    models: [
      {
        slug: "gpt-5.6-sol",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        multi_agent_version: version,
      },
      {
        slug: "chatgpt-web/high",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        multi_agent_version: version,
      },
    ],
  };
}

describe("agent capability inspection", () => {
  test("parses effective Compatibility V1 config including default agents.enabled=true", () => {
    expect(parseCodexAgentConfig(compatibilityV1Config)).toEqual({
      selectedModel: "chatgpt-web/high",
      multiAgent: true,
      multiAgentV2: false,
      agentsEnabled: true,
      maxDepth: 2,
    });
  });

  test("treats agents.enabled=false as a hard blocker even when legacy multi_agent is true", () => {
    const configText = compatibilityV1Config.replace(
      "[agents]\n",
      "[agents]\nenabled = false\n",
    );
    const report = analyzeAgentCapability({
      protocol: "compatibility-v1",
      configText,
      integrationInstalled: true,
      integrationActive: true,
      runtimeCatalog: catalog(),
      codexVersion: "codex-cli 0.142.5",
    });

    expect(report.readyForFreshThread).toBe(false);
    expect(report.blockers).toContain("Codex [agents].enabled is false");
  });

  test("requires the selected routed model to advertise multi_agent_version=v1", () => {
    const report = analyzeAgentCapability({
      protocol: "compatibility-v1",
      configText: compatibilityV1Config,
      integrationInstalled: true,
      integrationActive: true,
      runtimeCatalog: catalog("disabled"),
      codexVersion: "codex-cli 0.142.5",
    });

    expect(report.readyForFreshThread).toBe(false);
    expect(report.blockers.join("\n")).toContain("chatgpt-web/high");
    expect(report.blockers.join("\n")).toContain("multi_agent_version=v1");
  });

  test("reports a fresh-thread-ready V1 runtime when config and runtime catalog agree", () => {
    const report = analyzeAgentCapability({
      protocol: "compatibility-v1",
      configText: compatibilityV1Config,
      integrationInstalled: true,
      integrationActive: true,
      runtimeCatalog: catalog(),
      codexVersion: "codex-cli 0.142.5",
    });

    expect(report.readyForFreshThread).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.freshThreadRequired).toBe(true);
    expect(report.selectedModel).toMatchObject({
      slug: "chatgpt-web/high",
      multiAgentVersion: "v1",
    });
  });
});
