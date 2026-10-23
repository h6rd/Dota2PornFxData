const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const DATA_DIR = process.env.DATA_DIR || ".";
const MAIN_DIR = process.env.MAIN_REPO_DIR || "../main-repo";
const PENDING_DIR = path.join(DATA_DIR, "pending");

const MAX_NAME_LEN = 80;
const MAX_MOD_NAME_LEN = 30;

const NAME_LENGTH_EXCEPTIONS = new Map([
  ["keeper of the light", 40],
  ["natures prophet", 40],
]);

function getMaxModNameLen(heroName) {
  const override = NAME_LENGTH_EXCEPTIONS.get(String(heroName || "").trim().toLowerCase());
  return override || MAX_MOD_NAME_LEN;
}
const MAX_TEXT_FIELD_LEN = 150;

const MOD_NAME_RE = /^[a-zA-Z0-9 \-_'.,!]+$/;
const MISPLACED_HYPHEN_RE = /(^|[^a-zA-Z0-9])-|-([^a-zA-Z0-9]|$)/;
const NICK_RE = /^[\p{L}\p{N} _.\-!,()\[\]#@+]+$/u;
const SAFE_TEXT_RE = /^[^<>"`\\\u0000-\u001f\u007f]+$/;
const UNSAFE_URL_CHARS_RE = /[\s"'<>`\\]/;
const FALLBACK_HERO_ITEM_SLOT_TAGS = ["base", "totem", "weapon", "spiderling", "tail", "legs", "forge", "bear", "off-hand", "cart", "mount", "head", "arm", "arms", "armor", "shoulders", "back", "shield", "hair", "neck", "rocket"];
const UPLOAD_HIDDEN_TAGS = { herofx: ["sounds"], "hero-items": ["sounds"] };
const NON_SLOT_TAGS = new Set(["effects", "icons", "sounds"]);

function stripHiddenTags(category, tags) {
  const hidden = UPLOAD_HIDDEN_TAGS[category] || [];
  return Object.fromEntries(Object.entries(tags).filter(([k]) => !hidden.includes(k)));
}
function getHeroItemSlotTags(constants) {
  const list = constants && constants.slotTags && constants.slotTags["hero-items"];
  if (Array.isArray(list) && list.length) return new Set(list);
  const cfg = constants && constants.TAG_CONFIGS && constants.TAG_CONFIGS["hero-items"];
  if (cfg && cfg.map && typeof cfg.map === "object") return new Set(Object.keys(cfg.map).filter((k) => !NON_SLOT_TAGS.has(k)));
  return new Set(FALLBACK_HERO_ITEM_SLOT_TAGS);
}
const MAX_URL_LEN = 300;

const MIN_STYLES_PER_MOD = 2;
const MAX_STYLES_PER_MOD = 3;
const STYLE_LABEL_RE = /^[a-zA-Z0-9 _.\-!]+$/;
const MAX_STYLE_LABEL_LEN = 24;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;

function styleFileSuffix(label, n = 2) {
  const clean = sanitizeFilename(label).replace(/^[.\s]+|[.\s]+$/g, "");
  return ` ${clean || `Style ${n}`}`;
}
function styleFileSuffixes(styleDefs) {
  return styleDefs.map((st, i) => (i === 0 ? "" : styleFileSuffix(st.label, i + 1)));
}

function colorsToCss(colors) {
  return colors.length > 1 ? `linear-gradient(135deg, ${colors[0]} 50%, ${colors[1]} 50%)` : colors[0];
}

function validateStyleDefs(styles, meta) {
  assertField(
    Array.isArray(styles) && styles.length >= MIN_STYLES_PER_MOD && styles.length <= MAX_STYLES_PER_MOD,
    `A mod with styles needs ${MIN_STYLES_PER_MOD} or ${MAX_STYLES_PER_MOD} styles`
  );
  const seen = new Set();
  return styles.map((st, i) => {
    assertField(st && typeof st === "object", "Invalid style");
    const label = typeof st.label === "string" ? st.label.trim() : "";
    assertField(label && label.length <= MAX_STYLE_LABEL_LEN && STYLE_LABEL_RE.test(label), `Style ${i + 1}: invalid style name`);
    assertField(!seen.has(label.toLowerCase()), "Style names must be different");
    seen.add(label.toLowerCase());
    const colors = Array.isArray(st.colors) ? st.colors.map((c) => String(c).toLowerCase()) : [];
    assertField(colors.length >= 1 && colors.length <= 2 && colors.every((c) => HEX_COLOR_RE.test(c)), `Style ${i + 1}: invalid color`);
    assertField(st.zip && typeof st.zip.path === "string", `Style ${i + 1}: invalid submission archive`);
    assertField(st.preview && typeof st.preview.path === "string" && st.preview.ext === "webp", `Style ${i + 1}: a WebP preview is required`);
    assertField(fs.existsSync(path.join(DATA_DIR, st.zip.path)), `Style ${i + 1}: source zip missing in DATA repo checkout`);
    assertField(fs.existsSync(path.join(DATA_DIR, st.preview.path)), `Style ${i + 1}: source preview missing in DATA repo checkout`);
    return { label, colors, zip: st.zip, preview: st.preview };
  });
}
const ALLOWED_CATEGORIES = splitList(process.env.ALLOWED_CATEGORIES);
const ALLOWED_HEROES = splitList(process.env.ALLOWED_HEROES);
const HERO_AWARE_CATEGORIES = new Set(["heroes", "hero-items", "herofx", "hero-sounds"]);
const SUBCATEGORY_CATEGORIES = new Set(["item-effects", "creep-deny"]);
const SUBCATEGORY_RE = /^[a-z0-9-]{1,60}$/;

const PREVIEW_VIDEO_CATEGORIES = new Set(["sounds", "hero-sounds", "huds", "ti-bp-effects", "heroes", "mega-kill", "announcers", "music"]);
const YOUTUBE_HOST_RE = /^(m\.|www\.|music\.)?youtube\.com$|^youtu\.be$/i;

function isYouTubeUrl(str) {
  if (!str || str.length > MAX_URL_LEN) return false;
  if (UNSAFE_URL_CHARS_RE.test(str)) return false;
  try {
    const u = new URL(str);
    return u.protocol === "https:" && YOUTUBE_HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

const LINK_TYPE_TO_CONSTANT = {
  author: "MOD_AUTHOR",
  modded: "MOD_AUTHOR",
  sender: "MOD_SENDER",
  source: "MOD_SOURCES",
};

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

const LEDGER_REL = "assets/data/published-submissions.json";

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
  if (UNSAFE_URL_CHARS_RE.test(str)) return false;
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

function ledgerPath() {
  return path.join(MAIN_DIR, LEDGER_REL);
}

function readLedger() {
  const p = ledgerPath();
  if (!fs.existsSync(p)) return new Set();
  const data = readJson(p);
  return new Set(Array.isArray(data) ? data.filter((x) => typeof x === "string") : []);
}

function writeLedger(ledger) {
  writeJson(ledgerPath(), [...ledger].sort());
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

function pushDataRepoWithRetry(repoDir) {
  for (let attempt = 1; attempt <= MAX_PUBLISH_ATTEMPTS; attempt++) {
    console.log("$", `git -C ${repoDir} push`);
    const res = spawnSync("git", ["-C", repoDir, "push"], { stdio: "inherit" });
    if (res.error) throw res.error;
    if (res.status === 0) return;

    if (attempt === MAX_PUBLISH_ATTEMPTS) {
      throw new Error(`Could not push cleanup commit to the DATA repo after ${MAX_PUBLISH_ATTEMPTS} attempts`);
    }
    const delay = PUSH_RETRY_BASE_DELAY_SECONDS * attempt;
    console.warn(`Push to the DATA repo was rejected - rebasing onto remote and retrying after ${delay}s.`);
    sleepSeconds(delay);
    run([
      "git", "-C", repoDir,
      "-c", "user.name=github-actions[bot]",
      "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "pull", "--rebase"
    ]);
  }
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

function listTrackedPaths(mainDir, subpath) {
  const res = spawnSync("git", ["-C", mainDir, "ls-tree", "-r", "--name-only", "HEAD", "--", subpath], {
    encoding: "utf8",
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ls-tree failed for ${subpath}: ${res.stderr}`);
  }
  return new Set(res.stdout.split("\n").filter(Boolean));
}

function resolveUniqueFilenameBase(mainDir, category, baseFilename, previewExt, suffixes = [""]) {
  const MAX_ATTEMPTS = 25;
  const existingZips = listTrackedPaths(mainDir, `assets/files/${category}`);
  const existingPreviews = previewExt ? listTrackedPaths(mainDir, `assets/previews/${category}`) : new Set();

  let candidate = baseFilename;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const taken = suffixes.some((suffix) => {
      const zipRel = `assets/files/${category}/${candidate}${suffix}.zip`;
      const previewRel = previewExt ? `assets/previews/${category}/${candidate}${suffix}.${previewExt}` : null;
      const zipTaken = existingZips.has(zipRel) || fs.existsSync(path.join(mainDir, zipRel));
      const previewTaken = previewRel
        ? existingPreviews.has(previewRel) || fs.existsSync(path.join(mainDir, previewRel))
        : false;
      return zipTaken || previewTaken;
    });
    if (!taken) return candidate;
    candidate = `${baseFilename}-${randomSuffix()}`;
  }
  throw new ValidationError(`Could not find a free filename for "${baseFilename}" after ${MAX_ATTEMPTS} attempts`);
}

function publishOne(id, meta, constants, mods, ledger = new Set()) {
  if (meta && meta.update) return publishUpdate(id, meta, constants, mods, ledger);
  assertField(
    typeof meta.name === "string" && MOD_NAME_RE.test(meta.name) && !MISPLACED_HYPHEN_RE.test(meta.name) &&
      meta.name.length <= getMaxModNameLen(meta.heroName),
    "Invalid mod name"
  );
  assertField(typeof meta.category === "string" && /^[a-z0-9-]+$/.test(meta.category), "Invalid category");
  if (ALLOWED_CATEGORIES.length) assertField(ALLOWED_CATEGORIES.includes(meta.category), "Invalid category");
  if (HERO_AWARE_CATEGORIES.has(meta.category)) {
    assertField(typeof meta.heroName === "string" && meta.heroName.trim(), "A hero is required for this category");
  }
  if (meta.heroName) {
    assertField(typeof meta.heroName === "string" && meta.heroName.length <= MAX_NAME_LEN && /^[A-Za-z0-9 '.\-]+$/.test(meta.heroName), "Invalid hero");
    if (ALLOWED_HEROES.length) assertField(ALLOWED_HEROES.includes(meta.heroName), "Invalid hero");
  }
  let subcategory = null;
  if (SUBCATEGORY_CATEGORIES.has(meta.category)) {
    const raw = typeof meta.subcategory === "string" ? meta.subcategory.trim() : "";
    if (raw) {
      assertField(SUBCATEGORY_RE.test(raw), "Invalid subcategory");
      const catDataForSub = mods.modsData && mods.modsData[meta.category];
      assertField(
        catDataForSub && Array.isArray(catDataForSub.groups) && catDataForSub.groups.some((g) => g && g.id === raw),
        `Unknown subcategory "${raw}" for category "${meta.category}"`
      );
      subcategory = raw;
    } else {
      assertField(meta.category === "creep-deny", "A subcategory is required for this category");
    }
  }
  assertField(meta.zip && typeof meta.zip.path === "string", "Invalid submission archive");
  assertField(meta.preview && typeof meta.preview.path === "string", "A mod preview is required");

  const styleDefs = Array.isArray(meta.styles) && meta.styles.length ? validateStyleDefs(meta.styles, meta) : null;
  if (styleDefs) {
    assertField(styleDefs[0].zip.path === meta.zip.path && styleDefs[0].preview.path === meta.preview.path, "Style 1 does not match the submission files");
  }

  const metaTags = stripHiddenTags(meta.category, meta.tags && typeof meta.tags === "object" && !Array.isArray(meta.tags) ? meta.tags : {});
  for (const [k, v] of Object.entries(metaTags)) {
    assertField(/^[a-zA-Z0-9_-]{1,40}$/.test(k) && typeof v === "boolean", "Invalid tags");
  }
  if (meta.category === "hero-items") {
    const slotTags = getHeroItemSlotTags(constants);
    const slotCount = Object.keys(metaTags).filter((k) => metaTags[k] === true && slotTags.has(k)).length;
    assertField(slotCount === 1, "Hero items require exactly one slot tag");
  }

  if (ledger.has(id) || isAlreadyPublishedSubmission(mods, meta.category, id)) {
    throw new AlreadyPublishedError(`submission ${id} was already published`);
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

  const styleSuffixes = styleDefs ? styleFileSuffixes(styleDefs) : null;
  const publishFilenameBase = resolveUniqueFilenameBase(
    MAIN_DIR,
    meta.category,
    baseFilename,
    meta.preview ? meta.preview.ext : null,
    styleSuffixes || [""]
  );

  const finalZipRel = `assets/files/${meta.category}/${publishFilenameBase}.zip`;
  const finalZipAbs = path.join(MAIN_DIR, finalZipRel);

  if (meta.preview) {
    previewFilename = `${publishFilenameBase}.${meta.preview.ext}`;
    finalPreviewRel = `assets/previews/${meta.category}/${previewFilename}`;
  }

  const finalLinks = [];
  for (const link of meta.links || []) {
    assertField(link && ["author", "sender", "source", "modded", "preview"].includes(link.type), "Invalid link type");
    assertField(typeof link.url === "string" && link.url.length <= MAX_TEXT_FIELD_LEN, "Invalid link");
    if (link.type === "preview") {
      assertField(PREVIEW_VIDEO_CATEGORIES.has(meta.category), "This category does not accept a preview video");
      assertField(isYouTubeUrl(link.url), "Preview video must be a youtube.com / youtu.be link");
      finalLinks.push({ type: link.type, url: link.url });
      continue;
    }
    assertField(
      link.isNew ? NICK_RE.test(link.url) : SAFE_TEXT_RE.test(link.url),
      "Link name contains unsupported characters"
    );
    if (!link.isNew && link.type !== "sender") {
      assertField(hasOwn(constants[LINK_TYPE_TO_CONSTANT[link.type]], link.url), "Unknown author/source: pick one from the list or add it as new");
    }
    finalLinks.push({ type: link.type, url: link.url });
    if (link.isNew) {
      assertField(typeof link.newAuthorUrl === "string" && link.newAuthorUrl.length <= MAX_URL_LEN, "Invalid link URL");
      if (link.newAuthorUrl) assertField(isSafeHttpsUrl(link.newAuthorUrl), "Link URL must be https://");
      const map = LINK_TYPE_TO_CONSTANT[link.type];
      if (!constants[map]) constants[map] = {};
      if (!hasOwn(constants[map], link.url)) constants[map][link.url] = link.newAuthorUrl || "";
    }
  }

  const styleFiles = styleDefs
    ? styleDefs.map((st, i) => {
        const base = `${publishFilenameBase}${styleSuffixes[i]}`;
        return { ...st, fileName: `${base}.zip`, previewName: `${base}.webp` };
      })
    : null;

  const modEntry = {
    name: meta.name,
    ...(styleFiles
      ? {
          styles: styleFiles.map((st) => ({
            label: st.label,
            color: colorsToCss(st.colors),
            preview: st.previewName,
            file: st.fileName
          }))
        }
      : {
          ...(previewFilename ? { preview: previewFilename } : {}),
          file: `${publishFilenameBase}.zip`
        }),
    ...(Object.keys(metaTags).length ? { tags: metaTags } : {}),
    ...(finalLinks.length ? { links: finalLinks } : {}),
    meta: { date: Math.floor(Date.now() / 1000), "commit-sha": "" }
  };

  if (!mods.modsData[meta.category]) mods.modsData[meta.category] = [];
  const catData = mods.modsData[meta.category];
  if (catData && typeof catData === "object" && Array.isArray(catData.groups)) {
    let groupName = meta.heroName || "Misc";
    let groupId = slugify(groupName);
    if (subcategory) {
      const picked = catData.groups.find((g) => g && g.id === subcategory);
      groupId = picked.id;
      groupName = picked.name;
    } else if (!meta.heroName && meta.category === "creep-deny") {
      const isLasthit = /last[\s-]?hit/i.test(meta.name);
      groupName = isLasthit ? "Lasthit" : "Deny";
      groupId = isLasthit ? "last-hit" : "deny";
    }
    const groupNameLc = groupName.trim().toLowerCase();
    let group =
      catData.groups.find((g) => g.id === groupId) ||
      catData.groups.find((g) => typeof g.name === "string" && g.name.trim().toLowerCase() === groupNameLc);
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
  if (styleFiles) {
    for (const st of styleFiles.slice(1)) {
      const zipAbs = path.join(MAIN_DIR, `assets/files/${meta.category}/${st.fileName}`);
      const previewAbs = path.join(MAIN_DIR, `assets/previews/${meta.category}/${st.previewName}`);
      fs.mkdirSync(path.dirname(zipAbs), { recursive: true });
      fs.mkdirSync(path.dirname(previewAbs), { recursive: true });
      fs.copyFileSync(path.join(DATA_DIR, st.zip.path), zipAbs);
      fs.copyFileSync(path.join(DATA_DIR, st.preview.path), previewAbs);
    }
  }
  ledger.add(id);
}

function normModKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findModEntry(mods, category, name) {
  const key = normModKey(name);
  const catData = mods.modsData && mods.modsData[category];
  return getCategoryModsArray(catData).find((m) => m && normModKey(m.name) === key) || null;
}

const UPDATE_EDITABLE_LINK_TYPES = new Set(["source", "modded", "preview"]);

function publishUpdate(id, meta, constants, mods, ledger = new Set()) {
  const upd = meta.update;
  assertField(upd && typeof upd === "object", "Invalid update metadata");
  assertField(typeof meta.category === "string" && /^[a-z0-9-]+$/.test(meta.category), "Invalid category");
  if (ALLOWED_CATEGORIES.length) assertField(ALLOWED_CATEGORIES.includes(meta.category), "Invalid category");
  assertField(typeof upd.name === "string" && upd.name.length > 0 && upd.name.length <= MAX_NAME_LEN, "Invalid update target");
  assertField(meta.zip && typeof meta.zip.path === "string", "Invalid submission archive");
  assertField(meta.preview && typeof meta.preview.path === "string" && meta.preview.ext === "webp", "A WebP mod preview is required");

  const metaTags = stripHiddenTags(meta.category, meta.tags && typeof meta.tags === "object" && !Array.isArray(meta.tags) ? meta.tags : {});
  for (const [k, v] of Object.entries(metaTags)) {
    assertField(/^[a-zA-Z0-9_-]{1,40}$/.test(k) && typeof v === "boolean", "Invalid tags");
  }
  if (meta.category === "hero-items") {
    const slotTags = getHeroItemSlotTags(constants);
    const slotCount = Object.keys(metaTags).filter((k) => metaTags[k] === true && slotTags.has(k)).length;
    assertField(slotCount === 1, "Hero items require exactly one slot tag");
  }

  if (ledger.has(id)) throw new AlreadyPublishedError(`submission ${id} was already published`);

  const entry = findModEntry(mods, meta.category, upd.name);
  assertField(entry, `The mod "${upd.name}" no longer exists in category "${meta.category}"`);
  assertField(
    typeof entry.file === "string" && /^[^\\/]+\.zip$/i.test(entry.file) && !entry.file.includes(".."),
    "This mod's file is hosted externally and can't be replaced by an update"
  );

  const srcZipAbs = path.join(DATA_DIR, meta.zip.path);
  const srcPreviewAbs = path.join(DATA_DIR, meta.preview.path);
  assertField(fs.existsSync(srcZipAbs), "Source zip missing in DATA repo checkout");
  assertField(fs.existsSync(srcPreviewAbs), "Source preview missing in DATA repo checkout");

  const fileBase = entry.file.replace(/\.zip$/i, "");
  const newPreviewName = typeof entry.preview === "string" && /^[^\\/]+\.webp$/i.test(entry.preview)
    ? entry.preview
    : `${fileBase}.webp`;

  const sentLinks = [];
  for (const link of meta.links || []) {
    if (link && link.locked) continue;
    assertField(link && UPDATE_EDITABLE_LINK_TYPES.has(link.type), "Invalid link type for an update");
    assertField(typeof link.url === "string" && link.url.length > 0 && link.url.length <= MAX_TEXT_FIELD_LEN, "Invalid link");
    if (link.type === "preview") {
      assertField(PREVIEW_VIDEO_CATEGORIES.has(meta.category), "This category does not accept a preview video");
      assertField(isYouTubeUrl(link.url), "Preview video must be a youtube.com / youtu.be link");
      sentLinks.push({ type: link.type, url: link.url });
      continue;
    }
    assertField(
      link.isNew ? NICK_RE.test(link.url) : SAFE_TEXT_RE.test(link.url),
      "Link name contains unsupported characters"
    );
    if (!link.isNew && link.type !== "sender") {
      assertField(hasOwn(constants[LINK_TYPE_TO_CONSTANT[link.type]], link.url), "Unknown author/source: pick one from the list or add it as new");
    }
    sentLinks.push({ type: link.type, url: link.url });
    if (link.isNew) {
      assertField(typeof link.newAuthorUrl === "string" && link.newAuthorUrl.length <= MAX_URL_LEN, "Invalid link URL");
      if (link.newAuthorUrl) assertField(isSafeHttpsUrl(link.newAuthorUrl), "Link URL must be https://");
      const map = LINK_TYPE_TO_CONSTANT[link.type];
      if (!constants[map]) constants[map] = {};
      if (!hasOwn(constants[map], link.url)) constants[map][link.url] = link.newAuthorUrl || "";
    }
  }
  const replacedTypes = new Set(sentLinks.map((l) => l.type));
  const keptLinks = (Array.isArray(entry.links) ? entry.links : []).filter((l) => l && !replacedTypes.has(l.type));
  const finalLinks = [...keptLinks, ...sentLinks];

  const keptHidden = {};
  for (const k of UPLOAD_HIDDEN_TAGS[meta.category] || []) {
    if (entry.tags && entry.tags[k] === true) keptHidden[k] = true;
  }
  const finalTags = { ...metaTags, ...keptHidden };
  if (Object.keys(finalTags).length) entry.tags = finalTags;
  else delete entry.tags;
  const oldPreviewName = typeof entry.preview === "string" ? entry.preview : null;
  entry.preview = newPreviewName;
  if (finalLinks.length) entry.links = finalLinks;
  else delete entry.links;
  entry.meta = {
    ...(entry.meta || {}),
    date: Math.floor(Date.now() / 1000),
    "commit-sha": ""
  };
  delete entry.meta["submission-id"];

  const zipAbs = path.join(MAIN_DIR, `assets/files/${meta.category}/${entry.file}`);
  const previewAbs = path.join(MAIN_DIR, `assets/previews/${meta.category}/${newPreviewName}`);
  fs.mkdirSync(path.dirname(zipAbs), { recursive: true });
  fs.mkdirSync(path.dirname(previewAbs), { recursive: true });
  fs.copyFileSync(srcZipAbs, zipAbs);
  fs.copyFileSync(srcPreviewAbs, previewAbs);
  if (oldPreviewName && oldPreviewName !== newPreviewName && /^[^\\/]+$/.test(oldPreviewName) && !oldPreviewName.includes("..")) {
    fs.rmSync(path.join(MAIN_DIR, `assets/previews/${meta.category}/${oldPreviewName}`), { force: true });
  }
  if (!Array.isArray(mods.recentlyAddedMods)) mods.recentlyAddedMods = [];
  mods.recentlyAddedMods = mods.recentlyAddedMods.filter((r) => !(r && r.name === entry.name && r.category === meta.category));
  mods.recentlyAddedMods.unshift({ name: entry.name, category: meta.category });
  ledger.add(id);
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
  const ledger = readLedger();
  const ledgerSizeBefore = ledger.size;

  const publishedIds = [];
  const failedIds = [];

  for (const [id, meta] of metaById) {
    try {
      publishOne(id, meta, constants, mods, ledger);
      console.log(`published ${id} (${meta.name})`);
      publishedIds.push(id);
    } catch (err) {
      if (err instanceof AlreadyPublishedError) {
        console.log(`${id}: ${err.message} - treating as already published, will clean up pending/`);
        ledger.add(id);
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
    if (ledger.size !== ledgerSizeBefore || !fs.existsSync(ledgerPath())) writeLedger(ledger);
    run(["git", "-C", MAIN_DIR, "add", "--sparse", "assets/files", "assets/previews", "assets/data/mods.json", "assets/data/constants.json", LEDGER_REL]);
    if (gitHasStagedChanges(MAIN_DIR)) {
      const commitMsg = `chore: publish approved mod\n\n` +
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

function writeActionsOutput(name, value) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) return;
  try {
    fs.appendFileSync(outFile, `${name}=${value}\n`);
  } catch {
  }
}

function main() {
  if (!fs.existsSync(PENDING_DIR)) {
    console.log("No pending/ directory in the DATA repo checkout - nothing to publish.");
    writeActionsOutput("published_count", 0);
    return;
  }
  const ids = fs.readdirSync(PENDING_DIR).filter((f) => fs.statSync(path.join(PENDING_DIR, f)).isDirectory());
  if (ids.length === 0) {
    console.log("pending/ is empty - nothing to publish.");
    writeActionsOutput("published_count", 0);
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

  writeActionsOutput("published_count", publishedIds.length);

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
      pushDataRepoWithRetry(DATA_DIR);
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

if (require.main === module) {
  main();
}

module.exports = {
  DATA_DIR,
  MAIN_DIR,
  PENDING_DIR,
  ValidationError,
  AlreadyPublishedError,
  readJson,
  writeJson,
  readLedger,
  loadPendingMetas,
  publishOne,
  publishUpdate,
};
