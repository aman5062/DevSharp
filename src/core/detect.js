'use strict';
// Local, offline project-technology detection.
//
// Reads ONLY a fixed set of small manifest files (package.json, pyproject.toml,
// go.mod, Cargo.toml, compose files, Dockerfiles, CI markers, small k8s yaml,
// *.tf) plus directory listings for a bounded extension census. It never reads
// source code, never reads .env / secret-looking files, never follows symlinks
// out of the project, and never touches the network.
//
// README files are intentionally NOT parsed: they are prose, frequently mention
// technologies the project does not use ("unlike Redis, we ..."), and would add
// noise for little signal compared to real dependency manifests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, writeJson, isInside } = require('./fsutil');
const T = require('./techmap');

const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_SMALL_YAML_BYTES = 64 * 1024;
const MAX_EVIDENCE = 5;
const CACHE_MAX_ENTRIES = 50;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Signal strengths.
const W_DEP = 1.0;
const W_IMAGE = 0.9;
const W_CONFIG = 0.8;
const W_EXT_MAX = 0.7;
const EXT_MIN_FILES = 3;

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'target', 'vendor', '.venv', 'venv',
  '__pycache__', '.next', 'coverage', 'bower_components', 'site-packages', 'out',
]);
const MONOREPO_PARENTS = ['apps', 'packages', 'services'];
const MAX_MONOREPO_CHILDREN = 40;
// Conventional single-level sub-projects (e.g. backend/ + web/ + mobile/ side by side).
const SUBPROJECT_DIRS = ['backend', 'frontend', 'web', 'api', 'server', 'client', 'mobile', 'app', 'worker'];
const K8S_DIRS = ['k8s', 'kubernetes', 'manifests', 'deploy', 'deployment', 'helm', 'charts'];
const COMPOSE_NAMES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const LOCKFILES = new Set(['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'bun.lockb', 'npm-shrinkwrap.json']);
const CI_FILES = ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', '.travis.yml'];

// Files we must never open, even if some rule would otherwise match them.
function isSecretName(name) {
  return /^\.env/i.test(name) || /\.(pem|key|p12|pfx|jks|keystore)$/i.test(name) ||
    /secret|credential|password/i.test(name) || name === '.npmrc' || name === '.pypirc' || name === '.netrc';
}

// Which basenames count as manifests (and feed the fingerprint).
function isManifestName(name) {
  return name === 'package.json' || LOCKFILES.has(name) || name === 'tsconfig.json' ||
    /^(vite|next)\.config\.[cm]?[jt]s$/.test(name) ||
    /^requirements.*\.txt$/.test(name) || name === 'pyproject.toml' || name === 'Pipfile' ||
    name === 'Cargo.toml' || name === 'go.mod' || name === 'pom.xml' ||
    name === 'build.gradle' || name === 'build.gradle.kts' ||
    /^Dockerfile(\.[\w.-]+)?$/.test(name) || /\.dockerfile$/i.test(name) ||
    COMPOSE_NAMES.has(name) || /^docker-compose\.[\w-]+\.ya?ml$/.test(name) ||
    name === 'Chart.yaml' || CI_FILES.includes(name);
}

// ---------------------------------------------------------------------------
// Safe filesystem helpers

function lstatSafe(p) {
  try { return fs.lstatSync(p); } catch { return null; }
}

function readdirSafe(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

// Read at most `cap` bytes of a regular file inside `root`. Symlinks are only
// followed when they resolve inside the project. Returns null on any problem.
function readCapped(root, file, cap = MAX_MANIFEST_BYTES) {
  if (isSecretName(path.basename(file))) return null;
  const st = lstatSafe(file);
  if (!st) return null;
  if (st.isSymbolicLink() && !isInside(root, file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return null;
    const len = Math.min(fst.size, cap);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = fs.readSync(fd, buf, off, len - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.toString('utf8', 0, off);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Evidence strings are built from our own table keys plus relative paths, but
// paths are user-controlled: strip control/bidi/invisible chars and cap length.
// (Kept local so detection has no dependency on the display sanitizer.)
function cleanEvidence(s) {
  // eslint-disable-next-line no-control-regex
  const out = String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, '').trim();
  return out.length > 120 ? `${out.slice(0, 119)}…` : out;
}

// ---------------------------------------------------------------------------
// Accumulator

function makeAcc() {
  const map = new Map();
  return {
    map,
    add(topic, weight, evidence) {
      if (!topic || !(weight > 0)) return;
      const w = Math.min(1, Math.round(weight * 1000) / 1000);
      let e = map.get(topic);
      if (!e) { e = { topic, weight: 0, evidence: [] }; map.set(topic, e); }
      if (w > e.weight) e.weight = w;
      const ev = cleanEvidence(evidence);
      if (ev && e.evidence.length < MAX_EVIDENCE && !e.evidence.includes(ev)) e.evidence.push(ev);
    },
    addPairs(pairs, base, evidence) {
      if (!pairs) return;
      for (const [topic, w] of pairs) this.add(topic, base * w, evidence);
    },
  };
}

// ---------------------------------------------------------------------------
// Parsers (each must tolerate arbitrary garbage)

const NPM_NAME = /^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+$/i;

function parsePackageJson(text) {
  const names = new Set();
  let j;
  try { j = JSON.parse(text); } catch { return names; }
  if (!j || typeof j !== 'object') return names;
  for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const d = j[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const n of Object.keys(d)) if (n.length <= 214 && NPM_NAME.test(n)) names.add(n.toLowerCase());
    }
  }
  return names;
}

function normPy(name) {
  return String(name).toLowerCase().replace(/[-_.]+/g, '-');
}

function pyNameFromSpec(spec) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? normPy(m[1]) : null;
}

function parseRequirements(text) {
  const out = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const n = pyNameFromSpec(line);
    if (n) out.add(n);
  }
  return out;
}

function parsePyproject(text) {
  const out = new Set();
  let section = '';
  let inArray = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (!inArray) {
      const h = /^\[\[?([^\]]+)\]\]?$/.exec(line);
      if (h) { section = h[1].trim(); continue; }
    }
    if (inArray) {
      for (const m of line.matchAll(/["']([^"']+)["']/g)) { const n = pyNameFromSpec(m[1]); if (n) out.add(n); }
      if (line.includes(']')) inArray = false;
      continue;
    }
    const isProjectDeps = section === 'project' && /^dependencies\s*=\s*\[/.test(line);
    const isOptional = section === 'project.optional-dependencies' && /^[\w.-]+\s*=\s*\[/.test(line);
    const isGroupDeps = section.startsWith('dependency-groups') && /^[\w.-]+\s*=\s*\[/.test(line);
    if (isProjectDeps || isOptional || isGroupDeps) {
      const rest = line.slice(line.indexOf('[') + 1);
      for (const m of rest.matchAll(/["']([^"']+)["']/g)) { const n = pyNameFromSpec(m[1]); if (n) out.add(n); }
      if (!rest.includes(']')) inArray = true;
      continue;
    }
    if (/^tool\.poetry\.(dev-)?dependencies$/.test(section) || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
      const k = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line);
      if (k && k[1].toLowerCase() !== 'python') out.add(normPy(k[1]));
    }
  }
  return out;
}

function parsePipfile(text) {
  const out = new Set();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { section = h[1].trim(); continue; }
    if (section !== 'packages' && section !== 'dev-packages') continue;
    const k = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line);
    if (k) out.add(normPy(k[1]));
  }
  return out;
}

function parseCargo(text) {
  const out = new Set();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) {
      section = h[1].trim();
      // [dependencies.tokio] table form
      const t = /^(?:target\..+\.)?(?:dev-|build-)?dependencies\.["']?([A-Za-z0-9_-]+)["']?$/.exec(section)
        || /^workspace\.dependencies\.["']?([A-Za-z0-9_-]+)["']?$/.exec(section);
      if (t) out.add(t[1].toLowerCase());
      continue;
    }
    if (/^((target\..+\.)?(dev-|build-)?dependencies|workspace\.dependencies)$/.test(section)) {
      const k = /^["']?([A-Za-z0-9_-]+)["']?\s*(?:\.|=)/.exec(line);
      if (k) out.add(k[1].toLowerCase());
    }
  }
  return out;
}

function goRequireText(text) {
  const lines = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (inBlock) {
      if (line.startsWith(')')) { inBlock = false; continue; }
      lines.push(line);
    } else if (/^require\s*\($/.test(line)) {
      inBlock = true;
    } else if (/^require\s+\S/.test(line)) {
      lines.push(line.slice(7).trim());
    }
  }
  return lines.map((l) => l.split(/\s+/)[0]).join('\n');
}

// Registry/org and tag stripped: "docker.io/bitnami/redis:7" -> "redis".
function imageBase(ref) {
  let s = String(ref).trim().replace(/^["']|["']$/g, '').toLowerCase();
  s = s.replace(/@.*$/, '');
  const slash = s.lastIndexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon > slash) s = s.slice(0, colon);
  return s.slice(slash + 1);
}

function imagePairs(ref) {
  const base = imageBase(ref);
  if (!base || !/^[a-z0-9][a-z0-9._-]*$/.test(base)) return null;
  const exact = T.lookup(T.IMAGES, null, base);
  if (exact) return { key: base, pairs: exact };
  for (const k of Object.keys(T.IMAGES)) {
    if (base.startsWith(`${k}-`)) return { key: k, pairs: T.IMAGES[k] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest discovery (shared with the cheap cache fingerprint)

// Returns [{ dir (abs), rel ('' or 'apps/web'), entries: Dirent[] }].
function manifestDirs(root) {
  const rootEntries = readdirSafe(root);
  const dirs = [{ dir: root, rel: '', entries: rootEntries }];
  for (const name of SUBPROJECT_DIRS) {
    const ent = rootEntries.find((e) => e.name === name);
    if (!ent || !ent.isDirectory()) continue;
    const cdir = path.join(root, name);
    dirs.push({ dir: cdir, rel: name, entries: readdirSafe(cdir) });
  }
  for (const parent of MONOREPO_PARENTS) {
    const ent = rootEntries.find((e) => e.name === parent);
    if (!ent || !ent.isDirectory()) continue; // symlinks are Dirent.isSymbolicLink, not isDirectory
    const pdir = path.join(root, parent);
    let n = 0;
    for (const child of readdirSafe(pdir)) {
      if (!child.isDirectory() || child.name.startsWith('.') || SKIP_DIRS.has(child.name)) continue;
      if (++n > MAX_MONOREPO_CHILDREN) break;
      const cdir = path.join(pdir, child.name);
      dirs.push({ dir: cdir, rel: `${parent}/${child.name}`, entries: readdirSafe(cdir) });
    }
  }
  return dirs;
}

function fingerprintOf(root, dirs) {
  const parts = [];
  const rs = lstatSafe(root);
  if (rs) parts.push(`.:${rs.mtimeMs}`);
  for (const d of dirs) {
    for (const e of d.entries) {
      const special = e.name === '.git' || e.name === '.github' || K8S_DIRS.includes(e.name);
      if (!special && !isManifestName(e.name)) continue;
      const st = lstatSafe(path.join(d.dir, e.name));
      if (st) parts.push(`${d.rel}/${e.name}:${st.mtimeMs}:${st.size}`);
    }
  }
  parts.sort();
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-directory manifest analysis

function analyzeManifests(root, d, acc) {
  const pre = d.rel ? `${d.rel}/` : '';
  const names = new Set(d.entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => e.name));
  const read = (name) => readCapped(root, path.join(d.dir, name));

  if (names.has('package.json')) {
    acc.add('nodejs', W_CONFIG, `${pre}package.json`);
    acc.add('javascript', W_CONFIG * 0.75, `${pre}package.json`);
    const text = read('package.json');
    if (text) {
      for (const n of parsePackageJson(text)) {
        acc.addPairs(T.lookup(T.NPM, T.NPM_PREFIX, n), W_DEP, `${pre}package.json:${n}`);
      }
    }
  }
  for (const n of names) {
    if (LOCKFILES.has(n)) acc.add('nodejs', W_CONFIG, `${pre}${n}`);
  }
  if (names.has('tsconfig.json')) acc.add('typescript', W_CONFIG, `${pre}tsconfig.json`);
  for (const n of names) {
    if (/^vite\.config\.[cm]?[jt]s$/.test(n)) acc.add('browser', W_CONFIG, `${pre}${n}`);
    if (/^next\.config\.[cm]?[jt]s$/.test(n)) {
      acc.add('nextjs', W_CONFIG, `${pre}${n}`);
      acc.add('react', W_CONFIG, `${pre}${n}`);
    }
  }

  // Python
  const pyDeps = [];
  for (const n of names) {
    if (/^requirements.*\.txt$/.test(n)) {
      acc.add('python', W_CONFIG, `${pre}${n}`);
      const text = read(n);
      if (text) for (const dep of parseRequirements(text)) pyDeps.push([dep, `${pre}${n}`]);
    }
  }
  if (names.has('pyproject.toml')) {
    acc.add('python', W_CONFIG, `${pre}pyproject.toml`);
    const text = read('pyproject.toml');
    if (text) for (const dep of parsePyproject(text)) pyDeps.push([dep, `${pre}pyproject.toml`]);
  }
  if (names.has('Pipfile')) {
    acc.add('python', W_CONFIG, `${pre}Pipfile`);
    const text = read('Pipfile');
    if (text) for (const dep of parsePipfile(text)) pyDeps.push([dep, `${pre}Pipfile`]);
  }
  for (const [dep, file] of pyDeps) acc.addPairs(T.lookup(T.PY, null, dep), W_DEP, `${file}:${dep}`);

  // Rust
  if (names.has('Cargo.toml')) {
    acc.add('rust', W_CONFIG, `${pre}Cargo.toml`);
    const text = read('Cargo.toml');
    if (text) {
      for (const c of parseCargo(text)) {
        acc.addPairs(T.lookup(T.CARGO, T.CARGO_PREFIX, c), W_DEP, `${pre}Cargo.toml:${c}`);
      }
    }
  }

  // Go
  if (names.has('go.mod')) {
    acc.add('go', W_CONFIG, `${pre}go.mod`);
    const text = read('go.mod');
    if (text) {
      for (const [needle, pairs] of T.lookupSubstring(T.GO, goRequireText(text))) {
        const short = needle.replace(/\/$/, '').split('/').slice(-2).join('/');
        acc.addPairs(pairs, W_DEP, `${pre}go.mod:${short}`);
      }
    }
  }

  // JVM
  for (const n of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    if (!names.has(n)) continue;
    acc.add('java', W_CONFIG, `${pre}${n}`);
    const text = read(n);
    if (text) {
      for (const [needle, pairs] of T.lookupSubstring(T.JVM, text)) {
        acc.addPairs(pairs, W_DEP, `${pre}${n}:${needle.replace(/-$/, '')}`);
      }
    }
  }

  // Docker
  for (const n of names) {
    if (!/^Dockerfile(\.[\w.-]+)?$/.test(n) && !/\.dockerfile$/i.test(n)) continue;
    acc.add('docker', W_CONFIG, `${pre}${n}`);
    const text = read(n);
    if (!text) continue;
    for (const m of text.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)) {
      const hit = imagePairs(m[1]);
      if (hit) acc.addPairs(hit.pairs, W_CONFIG, `${pre}${n}:FROM ${hit.key}`);
    }
  }
  for (const n of names) {
    if (!COMPOSE_NAMES.has(n) && !/^docker-compose\.[\w-]+\.ya?ml$/.test(n)) continue;
    acc.add('docker', W_IMAGE, `${pre}${n}`);
    const text = read(n);
    if (!text) continue;
    for (const m of text.matchAll(/^\s*-?\s*image:\s*["']?([^"'\s#]+)/gm)) {
      const hit = imagePairs(m[1]);
      if (hit) acc.addPairs(hit.pairs, W_IMAGE, `${pre}${n}:${hit.key}`);
    }
  }
  if (names.has('Chart.yaml')) acc.add('kubernetes', W_CONFIG, `${pre}Chart.yaml`);
}

const K8S_KIND = /^\s*kind:\s*["']?(Deployment|StatefulSet|DaemonSet|ReplicaSet|CronJob|Job|Pod|Service|Ingress|ConfigMap|HorizontalPodAutoscaler|Kustomization)\b/m;

function isYaml(name) { return /\.ya?ml$/i.test(name); }

function analyzeInfra(root, rootEntries, acc) {
  const has = (n) => rootEntries.find((e) => e.name === n);

  const git = has('.git');
  if (git && (git.isDirectory() || git.isFile())) acc.add('git', W_CONFIG, '.git');

  const gh = has('.github');
  if (gh && gh.isDirectory()) {
    const wf = readdirSafe(path.join(root, '.github', 'workflows')).filter((e) => e.isFile() && isYaml(e.name));
    if (wf.length) acc.add('ci-cd', W_CONFIG, '.github/workflows');
  }
  for (const n of CI_FILES) {
    const e = has(n);
    if (e && (e.isFile() || e.isDirectory())) acc.add('ci-cd', W_CONFIG, n);
  }
  const circle = has('.circleci');
  if (circle && circle.isDirectory()) acc.add('ci-cd', W_CONFIG, '.circleci');

  // Kubernetes: small yaml files in the root and in conventional k8s dirs (one nested level).
  const candidates = [];
  for (const e of rootEntries) {
    if (e.isFile() && isYaml(e.name) && !e.name.startsWith('.') && !COMPOSE_NAMES.has(e.name) &&
        !/^docker-compose/.test(e.name) && !LOCKFILES.has(e.name)) {
      candidates.push([path.join(root, e.name), e.name]);
    }
  }
  for (const k of K8S_DIRS) {
    const e = has(k);
    if (!e || !e.isDirectory()) continue;
    const kdir = path.join(root, k);
    for (const c of readdirSafe(kdir)) {
      if (c.name.startsWith('.')) continue;
      if (c.isFile() && c.name === 'Chart.yaml') acc.add('kubernetes', W_CONFIG, `${k}/Chart.yaml`);
      else if (c.isFile() && isYaml(c.name)) candidates.push([path.join(kdir, c.name), `${k}/${c.name}`]);
      else if (c.isDirectory()) {
        for (const g of readdirSafe(path.join(kdir, c.name))) {
          if (!g.isFile() || g.name.startsWith('.')) continue;
          if (g.name === 'Chart.yaml') acc.add('kubernetes', W_CONFIG, `${k}/${c.name}/Chart.yaml`);
          else if (isYaml(g.name)) candidates.push([path.join(kdir, c.name, g.name), `${k}/${c.name}/${g.name}`]);
        }
      }
    }
  }
  let checked = 0;
  for (const [file, rel] of candidates) {
    if (checked >= 20) break;
    const st = lstatSafe(file);
    if (!st || !st.isFile() || st.size > MAX_SMALL_YAML_BYTES) continue;
    checked++;
    const text = readCapped(root, file, MAX_SMALL_YAML_BYTES);
    if (text && K8S_KIND.test(text) && /^\s*apiVersion:/m.test(text)) {
      acc.add('kubernetes', W_CONFIG, rel);
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded BFS walk for the extension census. Never opens files.

function walk(root, { maxEntries, maxDepth }) {
  const counts = new Map();
  const tfFiles = [];
  let seen = 0;
  let truncated = false;
  const queue = [[root, '', 0]];
  outer:
  for (let qi = 0; qi < queue.length; qi++) {
    const [abs, rel, depth] = queue[qi];
    for (const e of readdirSafe(abs)) {
      if (++seen > maxEntries) { truncated = true; break outer; }
      if (e.isSymbolicLink()) continue; // never follow symlinks
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        if (depth + 1 <= maxDepth) queue.push([path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1]);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!ext || !T.EXT[ext]) continue;
        counts.set(ext, (counts.get(ext) || 0) + 1);
        if (ext === '.tf' && tfFiles.length < 20) tfFiles.push([path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name]);
      }
    }
  }
  return { counts, tfFiles, seen: Math.min(seen, maxEntries), truncated };
}

function analyzeCensus(root, census, acc) {
  let max = 0;
  for (const c of census.counts.values()) if (c > max) max = c;
  for (const [ext, c] of census.counts) {
    if (c < EXT_MIN_FILES || ext === '.tf') continue;
    const base = Math.max(0.1, W_EXT_MAX * (c / max));
    acc.addPairs(T.EXT[ext], base, `files:*${ext} x${c}`);
  }
  for (const [file, rel] of census.tfFiles) {
    const text = readCapped(root, file);
    if (text && (/provider\s+"aws"/.test(text) || /source\s*=\s*"hashicorp\/aws"/.test(text))) {
      acc.add('aws', W_CONFIG, `${rel}:provider aws`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API

function resolveRoot(dir) {
  const abs = path.resolve(String(dir || '.'));
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function detectProject(dir, { maxEntries = 3000, maxDepth = 3, now } = {}) {
  const root = resolveRoot(dir);
  const acc = makeAcc();
  const st = lstatSafe(root);
  const empty = { dir: root, techs: [], topics: [], fingerprint: '', detectedAt: now || Date.now(), scanned: 0, truncated: false };
  if (!st || !st.isDirectory()) return empty;

  const dirs = manifestDirs(root);
  for (const d of dirs) {
    try { analyzeManifests(root, d, acc); } catch { /* never throw on a weird project */ }
  }
  try { analyzeInfra(root, dirs[0].entries, acc); } catch { /* ignore */ }
  let census = { seen: 0, truncated: false };
  try {
    census = walk(root, { maxEntries, maxDepth });
    analyzeCensus(root, census, acc);
  } catch { /* ignore */ }

  const techs = [...acc.map.values()]
    .filter((t) => T.TOPICS.includes(t.topic))
    .sort((a, b) => b.weight - a.weight || a.topic.localeCompare(b.topic));
  return {
    dir: root,
    techs,
    topics: techs.map((t) => t.topic),
    fingerprint: fingerprintOf(root, dirs),
    detectedAt: now || Date.now(),
    scanned: census.seen,
    truncated: census.truncated,
  };
}

// Cheap fingerprint without analysis: a handful of readdir + lstat calls.
function quickFingerprint(dir) {
  const root = resolveRoot(dir);
  return fingerprintOf(root, manifestDirs(root));
}

function detectCached(dir, paths, { now, maxEntries, maxDepth } = {}) {
  const t = now || Date.now();
  const root = resolveRoot(dir);
  const file = paths && paths.projects;
  let cache = file ? readJson(file, null) : null;
  if (!cache || typeof cache !== 'object' || cache.version !== 1 || typeof cache.entries !== 'object' || !cache.entries) {
    cache = { version: 1, entries: {} };
  }
  const fp = quickFingerprint(root);
  const hit = Object.prototype.hasOwnProperty.call(cache.entries, root) ? cache.entries[root] : null;
  if (hit && hit.fingerprint === fp && typeof hit.detectedAt === 'number' &&
      t - hit.detectedAt >= 0 && t - hit.detectedAt < CACHE_TTL_MS && hit.result && Array.isArray(hit.result.techs)) {
    return { ...hit.result, cached: true };
  }
  const opts = { now: t };
  if (maxEntries) opts.maxEntries = maxEntries;
  if (maxDepth) opts.maxDepth = maxDepth;
  const result = detectProject(root, opts);
  if (file) {
    cache.entries[root] = { detectedAt: t, fingerprint: result.fingerprint, result };
    const keys = Object.keys(cache.entries)
      .sort((a, b) => (cache.entries[b].detectedAt || 0) - (cache.entries[a].detectedAt || 0));
    for (const k of keys.slice(CACHE_MAX_ENTRIES)) delete cache.entries[k];
    try { writeJson(file, cache); } catch { /* cache is best-effort */ }
  }
  return { ...result, cached: false };
}

module.exports = {
  detectProject, detectCached, quickFingerprint,
  // exported for tests
  _internal: { parsePackageJson, parseRequirements, parsePyproject, parsePipfile, parseCargo, goRequireText, imageBase, isSecretName },
};
