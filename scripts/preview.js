const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  MAIN_DIR,
  PENDING_DIR,
  AlreadyPublishedError,
  readJson,
  writeJson,
  readLedger,
  loadPendingMetas,
  publishOne,
} = require("./publish");

const REPORT_MARKER = "<!-- publish-preview-report -->";
const REPORT_PATH = "preview_report.md";

function unifiedDiff(beforePath, afterPath, label) {
  const res = spawnSync("diff", ["-u", beforePath, afterPath], { encoding: "utf8" });
  if (res.error) throw res.error;
  if (typeof res.status === "number" && res.status > 1) {
    throw new Error(`diff failed for ${label}: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function ensureTrailingNewline(str) {
  return str.endsWith("\n") ? str : str + "\n";
}

function section(title, diff) {
  if (!diff) return `**${title}:** no changes\n`;
  return [
    `<details>`,
    `<summary><strong>${title}</strong> — click to expand diff</summary>`,
    ``,
    "```diff",
    diff,
    "```",
    ``,
    `</details>`,
    ``,
  ].join("\n");
}

function emptyReport(message) {
  return `${REPORT_MARKER}\n## Publish preview\n\n${message}\n`;
}

function renderReport({ published, alreadyPublished, failed, modsDiff, constantsDiff }) {
  const lines = [REPORT_MARKER, "## Publish preview", ""];

  if (published.length) {
    lines.push(`Would publish **${published.length}** submission if this PR is merged:`);
    for (const p of published) lines.push(`- \`${p.id}\` — ${p.name}`);
    lines.push("");
  }

  if (alreadyPublished.length) {
    lines.push(`Already published previously — merging would just clean up \`pending/\`, no catalog changes:`);
    for (const p of alreadyPublished) lines.push(`- \`${p.id}\` — ${p.name}`);
    lines.push("");
  }

  if (failed.length) {
    lines.push(`⚠️ **${failed.length} submission(s) would currently FAIL to publish:**`);
    for (const f of failed) lines.push(`- \`${f.id}\` — ${f.name}: ${f.message}`);
    lines.push("");
  }

  lines.push(section("assets/data/mods.json", modsDiff));
  lines.push(section("assets/data/constants.json", constantsDiff));

  return lines.join("\n");
}

function main() {
  if (!fs.existsSync(PENDING_DIR)) {
    fs.writeFileSync(REPORT_PATH, emptyReport("No `pending/` directory found on this branch — nothing to preview."));
    return;
  }

  const ids = fs.readdirSync(PENDING_DIR).filter((f) => fs.statSync(path.join(PENDING_DIR, f)).isDirectory());
  if (ids.length === 0) {
    fs.writeFileSync(REPORT_PATH, emptyReport("`pending/` is empty on this branch — nothing to preview."));
    return;
  }

  const { metaById } = loadPendingMetas(ids);

  const constantsPath = path.join(MAIN_DIR, "assets/data/constants.json");
  const modsPath = path.join(MAIN_DIR, "assets/data/mods.json");

  const beforeConstantsRaw = ensureTrailingNewline(fs.readFileSync(constantsPath, "utf8"));
  const beforeModsRaw = ensureTrailingNewline(fs.readFileSync(modsPath, "utf8"));

  const constants = JSON.parse(beforeConstantsRaw);
  const mods = JSON.parse(beforeModsRaw);

  const ledger = readLedger();

  const published = [];
  const alreadyPublished = [];
  const failed = [];

  for (const [id, meta] of metaById) {
    try {
      publishOne(id, meta, constants, mods, ledger);
      published.push({ id, name: meta.name });
    } catch (err) {
      if (err instanceof AlreadyPublishedError) {
        alreadyPublished.push({ id, name: meta.name });
      } else {
        failed.push({ id, name: meta.name || "?", message: err.message });
      }
    }
  }

  const tmpDir = fs.mkdtempSync("/tmp/preview-");
  const beforeConstantsPath = path.join(tmpDir, "constants.before.json");
  const beforeModsPath = path.join(tmpDir, "mods.before.json");
  const afterConstantsPath = path.join(tmpDir, "constants.after.json");
  const afterModsPath = path.join(tmpDir, "mods.after.json");

  fs.writeFileSync(beforeConstantsPath, beforeConstantsRaw);
  fs.writeFileSync(beforeModsPath, beforeModsRaw);
  writeJson(afterConstantsPath, constants);
  writeJson(afterModsPath, mods);

  const constantsDiff = unifiedDiff(beforeConstantsPath, afterConstantsPath, "constants.json");
  const modsDiff = unifiedDiff(beforeModsPath, afterModsPath, "mods.json");

  fs.writeFileSync(
    REPORT_PATH,
    renderReport({ published, alreadyPublished, failed, modsDiff, constantsDiff })
  );
}

main();