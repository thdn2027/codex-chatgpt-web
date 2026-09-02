#!/usr/bin/env bun
import { formatAgentInspection, inspectAgentCapability } from "./agent-inspect";

const json = process.argv.slice(2).includes("--json");
const unknown = process.argv.slice(2).filter(arg => arg !== "--json");
if (unknown.length > 0) {
  process.stderr.write(`agent-inspect: unknown arguments: ${unknown.join(" ")}\n`);
  process.exitCode = 1;
} else {
  const report = inspectAgentCapability();
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatAgentInspection(report));
  if (!report.readyForFreshThread) process.exitCode = 1;
}
