/**
 * Generates a markdown eval report from one or two result JSON files.
 * Usage: node --import tsx evals/report.ts <current.json> [base.json]
 * Prints to stdout so the caller can redirect to a file.
 */
import fs from "fs";

interface ToolCall { name: string; args: Record<string, unknown> }

interface CaseResult {
  id: string;
  question: string;
  expect_tools: string[];
  first_tool: string | null;
  tools: ToolCall[];
  pass: boolean;
  response_chars: number;
}

interface RunResult {
  timestamp: string;
  git: string;
  model: string;
  pass: number;
  total: number;
  cases: CaseResult[];
}

const [currentPath, basePath] = process.argv.slice(2);

if (!currentPath || !fs.existsSync(currentPath)) {
  process.stderr.write("Usage: report.ts <current.json> [base.json]\n");
  process.exit(1);
}

const current = JSON.parse(fs.readFileSync(currentPath, "utf-8")) as RunResult;
const base = basePath && fs.existsSync(basePath)
  ? JSON.parse(fs.readFileSync(basePath, "utf-8")) as RunResult
  : null;

function toolLabel(tools: ToolCall[]): string {
  return tools.length ? "`[" + tools.map((t) => t.name).join(", ") + "]`" : "_no tool_";
}

const pct = Math.round((current.pass / current.total) * 100);
const badge = pct === 100 ? "🟢" : pct >= 80 ? "🟡" : "🔴";

const lines: string[] = [];

// ── Header ────────────────────────────────────────────────────────────────────

lines.push(`## ${badge} Eval — ${current.pass}/${current.total} passed (${pct}%)`);
lines.push(``);
lines.push(`| | |`);
lines.push(`|:--|:--|`);
lines.push(`| **Model** | \`${current.model}\` |`);
lines.push(`| **Commit** | \`${current.git}\` |`);
lines.push(`| **Run at** | ${new Date(current.timestamp).toUTCString()} |`);
lines.push(``);

// ── Comparison ────────────────────────────────────────────────────────────────

if (base) {
  const prevById = new Map(base.cases.map((c) => [c.id, c]));
  const regressions = current.cases.filter((c) => !c.pass && prevById.get(c.id)?.pass);
  const improvements = current.cases.filter((c) => c.pass && !prevById.get(c.id)?.pass);
  const basePct = Math.round((base.pass / base.total) * 100);
  const delta = current.pass - base.pass;
  const deltaStr = delta > 0 ? `+${delta}` : String(delta);
  const trendEmoji = delta > 0 ? "📈" : delta < 0 ? "📉" : "➡️";

  lines.push(`### ${trendEmoji} vs base (\`${base.git}\`)`);
  lines.push(``);
  lines.push(`| | Base | PR | Delta |`);
  lines.push(`|:--|:--|:--|:--|`);
  lines.push(`| Pass rate | ${base.pass}/${base.total} (${basePct}%) | ${current.pass}/${current.total} (${pct}%) | **${deltaStr}** |`);
  lines.push(`| Model | \`${base.model}\` | \`${current.model}\` | |`);
  lines.push(``);

  if (regressions.length) {
    lines.push(`<details open>`);
    lines.push(`<summary>⚠️ Regressions (${regressions.length})</summary>`);
    lines.push(``);
    lines.push(`| Question | Was | Now |`);
    lines.push(`|:--|:--|:--|`);
    for (const c of regressions) {
      lines.push(`| ${c.question} | ${toolLabel(prevById.get(c.id)!.tools)} | ${toolLabel(c.tools)} |`);
    }
    lines.push(``);
    lines.push(`</details>`);
    lines.push(``);
  }

  if (improvements.length) {
    lines.push(`<details open>`);
    lines.push(`<summary>✨ Improvements (${improvements.length})</summary>`);
    lines.push(``);
    lines.push(`| Question | Was | Now |`);
    lines.push(`|:--|:--|:--|`);
    for (const c of improvements) {
      lines.push(`| ${c.question} | ${toolLabel(prevById.get(c.id)?.tools ?? [])} | ${toolLabel(c.tools)} |`);
    }
    lines.push(``);
    lines.push(`</details>`);
    lines.push(``);
  }

  if (!regressions.length && !improvements.length) {
    lines.push(`_No routing changes vs base._`);
    lines.push(``);
  }
}

// ── Failing cases ─────────────────────────────────────────────────────────────

const failing = current.cases.filter((c) => !c.pass);
if (failing.length) {
  lines.push(`### ❌ Failing (${failing.length})`);
  lines.push(``);
  lines.push(`| Question | Expected | Got |`);
  lines.push(`|:--|:--|:--|`);
  for (const c of failing) {
    const expected = c.expect_tools.length
      ? "`[" + c.expect_tools.join(", ") + "]`"
      : "_no tool_";
    lines.push(`| ${c.question} | ${expected} | ${toolLabel(c.tools)} |`);
  }
  lines.push(``);
}

// ── Passing cases (collapsible) ───────────────────────────────────────────────

const passing = current.cases.filter((c) => c.pass);
lines.push(`<details>`);
lines.push(`<summary>✅ Passing (${passing.length})</summary>`);
lines.push(``);
lines.push(`| Question | Tools called |`);
lines.push(`|:--|:--|`);
for (const c of passing) {
  lines.push(`| ${c.question} | ${toolLabel(c.tools)} |`);
}
lines.push(``);
lines.push(`</details>`);
lines.push(``);
lines.push(`---`);
lines.push(`_🤖 [betabot eval](../evals/run.ts)_`);

process.stdout.write(lines.join("\n") + "\n");
