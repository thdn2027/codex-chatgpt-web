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

afterEach(() => {
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_CHATGPT_WEB_HOME;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent capability inspection", () => {
  test("reports the actual Codex feature state instead of inferring it from the requested protocol", () => {
    const { codexHome } = fixture();
    const appConfig = defaultConfig("browser-only");
    appConfig.subagentProtocol = "compatibility-v1";
    saveConfig(appConfig);

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
});
