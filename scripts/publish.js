const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DATA_DIR = process.env.DATA_DIR || ".";
const MAIN_DIR = process.env.MAIN_REPO_DIR || "../main-repo";
const PENDING_DIR = path.join(DATA_DIR, "pending");

const MAX_NAME_LEN = 80;
const MAX_TEXT_FIELD_LEN = 150;
const MAX_URL_LEN = 300;
const ALLOWED_CATEGORIES = splitList(process.env.ALLOWED_CATEGORIES);
const ALLOWED_HEROES = splitList(process.env.ALLOWED_HEROES);

const MAX_PUBLISH_ATTEMPTS = 5;
const PUSH_RETRY_BASE_DELAY_SECONDS = 3;

function splitList(v) {
  return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

class ValidationError extends Error {}
class AlreadyPublishedError extends Error {}

function assertField(condition, message) {
  if (!condition) throw new ValidationError(message);
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function sanitizeFilename(name) {
  return String(name).trim().replace(/[\/:*?"<>|]/g, "");
}

function isSafeHttpsUrl(str) {
  if (!str || str.length > MAX_URL_LEN) return false;
  try {
    return new URL(str).protocol === "https:";
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
}

function run(args) {
  console.log("$", args.join(" "));
  const res = spawnSync(args[0], args.slice(1), { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Command failed (exit ${res.status}): ${args.join(" ")}`);
}

function gitHasStagedChanges(repoDir) {
  const res = spawnSync("git", ["-C", repoDir, "diff", "--cached", "--quiet"]);
  return res.status === 1;
}

function getCurrentBranch(repoDir) {
  const res = spawnSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Could not determine current branch of ${repoDir}: ${res.stderr}`);
  return res.stdout.trim();
}

function tryPush(repoDir, branch) {
  console.log("$", `git -C ${repoDir} push origin HEAD:${branch}`);
  const res = spawnSync("git", ["-C", repoDir, "push", "origin", `HEAD:${branch}`], { stdio: "inherit" });
  if (res.error) throw res.error;
  return res.status === 0;
}

function fetchAndResetToRemote(repoDir, branch) {
  run(["git", "-C", repoDir, "fetch", "origin", branch]);
  run(["git", "-C", repoDir, "reset", "--hard", `origin/${branch}`]);
}

function sleepSeconds(seconds) {
  spawnSync("sleep", [String(seconds)]);
}

function getCategoryModsArray(catData) {
  if (!catData) return [];
  if (Array.isArray(catData)) return catData;
  if (Array.isArray(catData.groups)) return catData.groups.flatMap((g) => (Array.isArray(g.mods) ? g.mods : []));
  return [];
}

function isAlreadyPublishedSubmission(mods, category, id) {
  const catData = mods.modsData && mods.modsData[category];
  return getCategoryModsArray(catData).some((m) => m && m.meta && m.meta["submission-id"] === id);
}

function randomSuffix() {
  return crypto.randomBytes(3).toString("hex");
}

function resolveUniqueFilenameBase(mainDir, category, baseFilename, previewExt) {
  const MAX_ATTEMPTS = 25;
  let candidate = baseFilename;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const zipTaken = fs.existsSync(path.join(mainDir, `assets/files/${category}/${candidate}.zip`));
    const previewTaken = previewExt
      ? fs.existsSync(path.join(mainDir, `assets/previews/${category}/${candidate}.${previewExt}`))
      : false;
    if (!zipTaken && !previewTaken) return candidate;
    candidate = `${baseFilename}-${randomSuffix()}`;
  }
  throw new ValidationError(`Could not find a free filename for "${baseFilename}" after ${MAX_ATTEMPTS} attempts`);
}

function publishOne(id, meta, constants, mods) {
  assertField(
    typeof meta.name === "string" && /^[a-zA-Z0-9 \-_'.!,]+$/.test(meta.name) && meta.name.length <= MAX_NAME_LEN,
    "Invalid mod name"
  );
  assertField(typeof meta.category === "string" && /^[a-z0-9-]+$/.test(meta.category), "Invalid category");
  if (ALLOWED_CATEGORIES.length) assertField(ALLOWED_CATEGORIES.includes(meta.category), "Invalid category");
  if (meta.heroName) {
    assertField(typeof meta.heroName === "string" && meta.heroName.length <= MAX_NAME_LEN, "Invalid hero");
    if (ALLOWED_HEROES.length) assertField(ALLOWED_HEROES.includes(meta.heroName), "Invalid hero");
  }
  assertField(meta.zip && typeof meta.zip.path === "string", "Invalid submission archive");

  if (isAlreadyPublishedSubmission(mods, meta.category, id)) {
    throw new AlreadyPublishedError(`submission ${id} already has a published entry (matched by submission-id)`);
  }

  const baseFilename = sanitizeFilename(meta.name);
  assertField(baseFilename === meta.filenameBase || !meta.filenameBase, "Invalid filename metadata");

  const srcZipAbs = path.join(DATA_DIR, meta.zip.path);
  assertField(fs.existsSync(srcZipAbs), "Source zip missing in DATA repo checkout");

  let previewFilename = null;
  let finalPreviewRel = null;
  if (meta.preview) {
    assertField(typeof meta.preview.path === "string" && ["webp"].includes(meta.preview.ext), "Invalid preview metadata");
    assertField(fs.existsSync(path.join(DATA_DIR, meta.preview.path)), "Source preview missing in DATA repo checkout");
  }

  const publishFilenameBase = resolveUniqueFilenameBase(
    MAIN_DIR,
    meta.category,
    baseFilename,
    meta.preview ? meta.preview.ext : null
  );

  const finalZipRel = `assets/files/${meta.category}/${publishFilenameBase}.zip`;
  const finalZipAbs = path.join(MAIN_DIR, finalZipRel);

  if (meta.preview) {
    previewFilename = `${publishFilenameBase}.${meta.preview.ext}`;
    finalPreviewRel = `assets/previews/${meta.category}/${previewFilename}`;
  }

  const finalLinks = [];
  for (const link of meta.links || []) {
    assertField(link && ["author", "sender", "source", "modded"].includes(link.type), "Invalid link type");
    assertField(typeof link.url === "string" && link.url.length <= MAX_TEXT_FIELD_LEN, "Invalid link");
    finalLinks.push({ type: link.type, url: link.url });
    if (link.isNew) {
      assertField(typeof link.newAuthorUrl === "string" && link.newAuthorUrl.length <= MAX_URL_LEN, "Invalid link URL");
      if (link.newAuthorUrl) assertField(isSafeHttpsUrl(link.newAuthorUrl), "Link URL must be https://");
      const map = link.type === "author" ? "MOD_AUTHOR" : link.type === "sender" ? "MOD_SENDER" : "MOD_SOURCES";
      if (!constants[map]) constants[map] = {};
      if (!(link.url in constants[map])) constants[map][link.url] = link.newAuthorUrl || "";
    }
  }

  const modEntry = {
    name: meta.name,
    ...(previewFilename ? { preview: previewFilename } : {}),
    file: `${publishFilenameBase}.zip`,
    ...(meta.tags && Object.keys(meta.tags).length ? { tags: meta.tags } : {}),
    ...(finalLinks.length ? { links: finalLinks } : {}),
    meta: { date: Math.floor(Date.now() / 1000), "commit-sha": "", "submission-id": id }
  };

  if (!mods.modsData[meta.category]) mods.modsData[meta.category] = [];
  const catData = mods.modsData[meta.category];
  if (catData && typeof catData === "object" && Array.isArray(catData.groups)) {
    const groupName = meta.heroName || "Misc";
    const groupId = slugify(groupName);
    let group = catData.groups.find((g) => g.id === groupId);
    if (!group) {
      group = { id: groupId, name: groupName, mods: [] };
      catData.groups.push(group);
    }
    group.mods.push(modEntry);
  } else if (Array.isArray(catData)) {
    catData.push(modEntry);
  } else {
    mods.modsData[meta.category] = [modEntry];
  }
  if (!Array.isArray(mods.recentlyAddedMods)) mods.recentlyAddedMods = [];
  mods.recentlyAddedMods.unshift({ name: meta.name, category: meta.category });

  fs.mkdirSync(path.dirname(finalZipAbs), { recursive: true });
  fs.copyFileSync(srcZipAbs, finalZipAbs);
  if (finalPreviewRel) {
    const finalPreviewAbs = path.join(MAIN_DIR, finalPreviewRel);
    fs.mkdirSync(path.dirname(finalPreviewAbs), { recursive: true });
    fs.copyFileSync(path.join(DATA_DIR, meta.preview.path), finalPreviewAbs);
  }
}

function loadPendingMetas(ids) {
  const metaById = new Map();
  const unparsableIds = [];
  for (const id of ids) {
    const metaPath = path.join(PENDING_DIR, id, "meta.json");
    if (!fs.existsSync(metaPath)) {
      console.warn(`skip ${id}: no meta.json found`);
      continue;
    }
    try {
      metaById.set(id, readJson(metaPath));
    } catch (err) {
      console.error(`FAILED to parse meta.json for ${id}:`, err.message);
      unparsableIds.push(id);
    }
  }
  return { metaById, unparsableIds };
}

function attemptPublishPass(metaById) {
  const constantsPath = path.join(MAIN_DIR, "assets/data/constants.json");
  const modsPath = path.join(MAIN_DIR, "assets/data/mods.json");
  const constants = readJson(constantsPath);
  const mods = readJson(modsPath);

  const publishedIds = [];
  const failedIds = [];

  for (const [id, meta] of metaById) {
    try {
      publishOne(id, meta, constants, mods);
      console.log(`published ${id} (${meta.name})`);
      publishedIds.push(id);
    } catch (err) {
      if (err instanceof AlreadyPublishedError) {
        console.log(`${id}: ${err.message} - treating as already published, will clean up pending/`);
        publishedIds.push(id);
      } else {
        console.error(`FAILED to publish ${id} (${meta.name || "?"}):`, err.message);
        failedIds.push(id);
      }
    }
  }

  if (publishedIds.length > 0) {
    writeJson(modsPath, mods);
    writeJson(constantsPath, constants);
    run(["git", "-C", MAIN_DIR, "add", "assets/files", "assets/previews", "assets/data/mods.json", "assets/data/constants.json"]);
    if (gitHasStagedChanges(MAIN_DIR)) {
      const commitMsg = `chore: publish ${publishedIds.length} approved mod\n\n` +
        publishedIds.map((id) => `- ${id}`).join("\n");
      run([
        "git", "-C", MAIN_DIR,
        "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-m", commitMsg
      ]);
    } else {
      console.log("Nothing actually changed in the main repo (all submissions were already published).");
    }
  }

  return { publishedIds, failedIds };
}

function publishToMainWithRetry(metaById) {
  const branch = getCurrentBranch(MAIN_DIR);
  let lastResult = { publishedIds: [], failedIds: [] };

  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    lastResult = attemptPublishPass(metaById);

    if (lastResult.publishedIds.length === 0) {
      return lastResult;
    }

    const headSha = spawnSync("git", ["-C", MAIN_DIR, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const remoteSha = spawnSync("git", ["-C", MAIN_DIR, "rev-parse", `origin/${branch}`], { encoding: "utf8" }).stdout.trim();
    if (headSha === remoteSha) {
      return lastResult;
    }

    if (tryPush(MAIN_DIR, branch)) {
      console.log(`Pushed ${lastResult.publishedIds.length} submission(s) to the main repo.`);
      return lastResult;
    }

    if (attempt === MAX_PUBLISH_ATTEMPTS) {
      throw new Error(
        `Could not push to ${branch} in the main repo after ${MAX_PUBLISH_ATTEMPTS} attempts ` +
        `(repeated non-fast-forward rejections). Leaving affected submissions in pending/ for the next run.`
      );
    }

    const delay = PUSH_RETRY_BASE_DELAY_SECONDS * attempt;
    console.warn(
      `Push to ${branch} was rejected (likely a concurrent commit from another job) - ` +
      `retrying (attempt ${attempt + 1}/${MAX_PUBLISH_ATTEMPTS}) after resetting to origin/${branch} ` +
      `and waiting ${delay}s.`
    );
    fetchAndResetToRemote(MAIN_DIR, branch);
    sleepSeconds(delay);
  }

  return lastResult;
}

function main() {
  if (!fs.existsSync(PENDING_DIR)) {
    console.log("No pending/ directory in the DATA repo checkout - nothing to publish.");
    return;
  }
  const ids = fs.readdirSync(PENDING_DIR).filter((f) => fs.statSync(path.join(PENDING_DIR, f)).isDirectory());
  if (ids.length === 0) {
    console.log("pending/ is empty - nothing to publish.");
    return;
  }

  const { metaById, unparsableIds } = loadPendingMetas(ids);
  const failedIds = [...unparsableIds];

  let publishedIds = [];
  if (metaById.size > 0) {
    const result = publishToMainWithRetry(metaById);
    publishedIds = result.publishedIds;
    failedIds.push(...result.failedIds);
  }

  if (publishedIds.length > 0) {
    for (const id of publishedIds) {
      fs.rmSync(path.join(PENDING_DIR, id), { recursive: true, force: true });
    }
    run(["git", "-C", DATA_DIR, "add", "pending"]);
    if (gitHasStagedChanges(DATA_DIR)) {
      const cleanupMsg = `chore: clean up published pending submissions [skip ci]\n\n` +
        publishedIds.map((id) => `- ${id}`).join("\n");
      run([
        "git", "-C", DATA_DIR,
        "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "-m", cleanupMsg
      ]);
      run(["git", "-C", DATA_DIR, "push"]);
    }
  } else {
    console.log("Nothing to publish to the main repo.");
  }

  if (failedIds.length > 0) {
    console.error(
      `WARNING: ${failedIds.length} submission(s) failed validation and were left in pending/ for manual ` +
      `inspection: ${failedIds.join(", ")}`
    );
    process.exitCode = 1;
  }
}

main();
