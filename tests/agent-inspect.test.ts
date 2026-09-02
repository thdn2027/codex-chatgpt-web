import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectAgentCapability } from "../src/agent-inspect";
import { defaultConfig, saveConfig } from "../src/config";

const roots: string[] = [];

function fixture(): { root: string; codexHome: string; appHome: string } {
  const root = join(tmpdir(), `codex-chatgpt-web-agent-inspect-${process.pid}-${Date.now()}-${Math.random()}`);
  const codexHome = join(root, "codex");
  const appHome = join(root, "app");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(appHome, { recursive: true });
  roots.push(root);
  process.env.CODEX_HOME = codexHome;
  process.env.CODEX_CHATGPT_WEB_HOME = appHome;
  return { root, codexHome, appHome };
}

function writeCompatibilityConfig(codexHome: string): void {
  writeFileSync(
    join(codexHome, "config.toml"),
    [
      "[features]",
      "multi_agent = true",
      "multi_agent_v2 = false",
      "",
      "[agents]",
      "max_depth = 2",
      "",
    ].join("\n"),
  );
}

function saveCompatibilityAppConfig(): void {
  const appConfig = defaultConfig("browser-only");
  appConfig.subagentProtocol = "compatibility-v1";
  saveConfig(appConfig);
}

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent capability inspection", () => {
  test("reports the actual Codex feature state instead of inferring it from the requested protocol", () => {
    const { codexHome } = fixture();
    saveCompatibilityAppConfig();

    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "[features]",
        "multi_agent = false # intentionally inconsistent with requested protocol",
        "multi_agent_v2 = true",
        "",
        "[agents]",
        "max_depth = 1",
        "",
      ].join("\n"),
    );

    const inspection = inspectAgentCapability();

    expect(inspection.protocol).toBe("compatibility-v1");
    expect(inspection.config).toEqual({
      multi_agent: false,
      multi_agent_v2: true,
      max_depth: 1,
    });
    expect(inspection.warnings).toContain("Codex multi_agent is disabled for Compatibility V1");
    expect(inspection.warnings).toContain("Codex multi_agent_v2 is enabled for Compatibility V1");
    expect(inspection.warnings).toContain("Codex agent max_depth is below the Compatibility V1 minimum of 2");
  });

  test("detects a stale V2 routed model cache while Compatibility V1 is selected", () => {
    const { codexHome } = fixture();
    saveCompatibilityAppConfig();
    writeCompatibilityConfig(codexHome);
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "chatgpt-web/high", visibility: "list", supported_in_api: true, multi_agent_version: "v2" },
          { slug: "gpt-5.6-sol", visibility: "list", supported_in_api: true, multi_agent_version: "v1" },
        ],
      }),
    );

    const inspection = inspectAgentCapability();

    expect(inspection.catalog?.webModels).toEqual([
      { slug: "chatgpt-web/high", multi_agent_version: "v2", supported_in_api: true, visibility: "list" },
    ]);
    expect(inspection.warnings).toContain(
      "Codex model cache still advertises chatgpt-web/high as multi_agent_version=v2 while Compatibility V1 is selected",
    );
  });

  test("does not treat an intentionally invalidated models cache as an error", () => {
    const { codexHome } = fixture();
    saveCompatibilityAppConfig();
    writeCompatibilityConfig(codexHome);

    const inspection = inspectAgentCapability();

    expect(inspection.files[join(codexHome, "models_cache.json")]).toBe(false);
    expect(inspection.warnings.some(warning => warning.includes("models cache is missing"))).toBe(false);
    expect(inspection.nextSteps).toContain(
      "Run `codex-chatgpt-web subagents compatibility-v1`, fully restart Codex, then start a new task before testing subagents.",
    );
  });

  test("calls out thread pinning when config and routed catalog already agree", () => {
    const { codexHome } = fixture();
    saveCompatibilityAppConfig();
    writeCompatibilityConfig(codexHome);
    writeFileSync(
      join(codexHome, "models_cache.json"),
      JSON.stringify({
        models: [
          { slug: "chatgpt-web/high", visibility: "list", supported_in_api: true, multi_agent_version: "v1" },
        ],
      }),
    );

    const inspection = inspectAgentCapability();

    expect(inspection.warnings).toEqual(["Codex integration route is not installed"]);
    expect(inspection.nextSteps).toContain(
      "If spawn_agent is still absent, discard the current Codex task and create a fresh task because affected Codex versions pin multi-agent protocol at thread creation.",
    );
  });
});
