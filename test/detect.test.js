'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectProject, detectCached, _internal } = require('../src/core/detect');
const T = require('../src/core/techmap');

const tmpRoots = [];
function mk(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsharp-detect-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files || {})) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}
test.after(() => {
  for (const r of tmpRoots) {
    try { fs.chmodSync(path.join(r, '.env'), 0o600); } catch { /* ignore */ }
    fs.rmSync(r, { recursive: true, force: true });
  }
});

const topicsOf = (r) => new Set(r.topics);
const tech = (r, t) => r.techs.find((x) => x.topic === t);

test('techmap only uses canonical topic ids', () => {
  const all = new Set(T.TOPICS);
  const check = (pairs, where) => {
    for (const [t, w] of pairs) {
      assert.ok(all.has(t), `${where}: unknown topic ${t}`);
      assert.ok(w > 0 && w <= 1, `${where}: bad weight ${w}`);
    }
  };
  for (const tbl of ['NPM', 'PY', 'CARGO', 'IMAGES', 'EXT']) {
    for (const [k, v] of Object.entries(T[tbl])) check(v, `${tbl}.${k}`);
  }
  for (const tbl of ['NPM_PREFIX', 'GO', 'CARGO_PREFIX', 'JVM']) {
    for (const [k, v] of T[tbl]) check(v, `${tbl}.${k}`);
  }
});

test('Next.js + Prisma + TypeScript project', () => {
  const root = mk({
    'package.json': JSON.stringify({
      dependencies: { next: '14', react: '18', 'react-dom': '18', '@prisma/client': '5', jsonwebtoken: '9' },
      devDependencies: { typescript: '5', prisma: '5', '@aws-sdk/client-s3': '3' },
    }),
    'pnpm-lock.yaml': 'lockfileVersion: 6\n',
    'tsconfig.json': '{}',
    'next.config.mjs': 'export default {}',
    'src/a.ts': '', 'src/b.ts': '', 'src/c.tsx': '', 'src/d.tsx': '',
  });
  const r = detectProject(root);
  for (const t of ['nextjs', 'react', 'prisma', 'typescript', 'nodejs', 'auth', 'aws']) {
    assert.ok(topicsOf(r).has(t), `missing ${t}: ${r.topics}`);
  }
  assert.equal(tech(r, 'nextjs').weight, 1);
  assert.ok(tech(r, 'nextjs').evidence.includes('package.json:next'));
  assert.ok(tech(r, 'nodejs').evidence.some((e) => e === 'pnpm-lock.yaml'));
  assert.ok(tech(r, 'aws').evidence.includes('package.json:@aws-sdk/client-s3'));
  // sorted desc
  for (let i = 1; i < r.techs.length; i++) assert.ok(r.techs[i - 1].weight >= r.techs[i].weight);
  assert.deepEqual(r.topics, r.techs.map((t) => t.topic));
  assert.equal(typeof r.fingerprint, 'string');
  assert.ok(r.fingerprint.length > 0);
  for (const t of r.techs) assert.ok(t.evidence.length <= 5);
});

test('Python fastapi + sqlalchemy + psycopg (requirements + pyproject + Pipfile)', () => {
  const root = mk({
    'requirements.txt': '# deps\nfastapi==0.110\nSQLAlchemy>=2 # orm\n-r other.txt\npsycopg[binary]\n',
    'pyproject.toml': [
      '[project]', 'name = "x"', 'dependencies = [', '  "boto3>=1",', '  "openai",', ']',
      '[tool.poetry.dependencies]', 'python = "^3.11"', 'torch = "2"',
    ].join('\n'),
    'Pipfile': '[packages]\ncryptography = "*"\n[dev-packages]\npytest = "*"\n',
  });
  const r = detectProject(root);
  for (const t of ['python', 'http', 'api-design', 'sql', 'postgresql', 'aws', 'llm', 'ai-ml', 'cryptography']) {
    assert.ok(topicsOf(r).has(t), `missing ${t}: ${r.topics}`);
  }
  assert.ok(tech(r, 'postgresql').evidence.includes('requirements.txt:psycopg'));
  assert.ok(tech(r, 'sql').evidence.includes('requirements.txt:sqlalchemy'));
});

test('Rust tokio + axum', () => {
  const root = mk({
    'Cargo.toml': '[package]\nname = "x"\n[dependencies]\ntokio = { version = "1", features = ["full"] }\naxum = "0.7"\nserde.workspace = true\n[dependencies.sqlx]\nversion = "0.7"\n',
  });
  const r = detectProject(root);
  for (const t of ['rust', 'concurrency', 'http', 'sql']) assert.ok(topicsOf(r).has(t), `missing ${t}: ${r.topics}`);
  assert.ok(tech(r, 'concurrency').evidence.includes('Cargo.toml:tokio'));
});

test('Go gin + pgx', () => {
  const root = mk({
    'go.mod': 'module example.com/x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgithub.com/jackc/pgx/v5 v5.5.0 // indirect\n)\nrequire github.com/redis/go-redis/v9 v9.0.0\n',
  });
  const r = detectProject(root);
  for (const t of ['go', 'http', 'postgresql', 'sql', 'redis']) assert.ok(topicsOf(r).has(t), `missing ${t}: ${r.topics}`);
  assert.ok(tech(r, 'http').evidence.includes('go.mod:gin-gonic/gin'));
});

test('compose images, Dockerfile, k8s Deployment, CI, git, terraform', () => {
  const root = mk({
    'docker-compose.yml': 'services:\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: "docker.io/bitnami/redis:7"\n  q:\n    image: rabbitmq:3-management # mq\n',
    'Dockerfile': 'FROM --platform=linux/amd64 node:20-slim AS build\nFROM build\n',
    'k8s/app.yaml': 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n',
    '.github/workflows/ci.yml': 'on: push\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    'infra/main.tf': 'provider "aws" {\n  region = "us-east-1"\n}\n',
  });
  const r = detectProject(root);
  for (const t of ['postgresql', 'redis', 'distributed-systems', 'docker', 'nodejs', 'kubernetes', 'ci-cd', 'git', 'aws']) {
    assert.ok(topicsOf(r).has(t), `missing ${t}: ${r.topics}`);
  }
  assert.equal(tech(r, 'postgresql').weight, 0.9);
  assert.ok(tech(r, 'postgresql').evidence.includes('docker-compose.yml:postgres'));
  assert.ok(tech(r, 'redis').evidence.includes('docker-compose.yml:redis'));
  assert.ok(tech(r, 'nodejs').evidence.includes('Dockerfile:FROM node'));
  assert.ok(tech(r, 'kubernetes').evidence.includes('k8s/app.yaml'));
  assert.ok(tech(r, 'aws').evidence.includes('infra/main.tf:provider aws'));
});

test('terraform without aws provider does not imply aws', () => {
  const root = mk({ 'main.tf': 'provider "google" {}\n' });
  assert.ok(!detectProject(root).topics.includes('aws'));
});

test('monorepo children in apps/* and packages/* are inspected', () => {
  const root = mk({
    'package.json': JSON.stringify({ devDependencies: { turbo: '1' } }),
    'apps/web/package.json': JSON.stringify({ dependencies: { next: '14' } }),
    'packages/db/package.json': JSON.stringify({ dependencies: { pg: '8' } }),
    'services/ml/requirements.txt': 'torch\n',
    'backend/go.mod': 'module x\nrequire github.com/gin-gonic/gin v1\n',
  });
  const r = detectProject(root);
  assert.ok(tech(r, 'nextjs').evidence.includes('apps/web/package.json:next'));
  assert.ok(tech(r, 'postgresql').evidence.includes('packages/db/package.json:pg'));
  assert.ok(tech(r, 'ai-ml').evidence.includes('services/ml/requirements.txt:torch'));
  assert.ok(tech(r, 'http').evidence.includes('backend/go.mod:gin-gonic/gin'));
});

test('malformed manifests and binary garbage never throw', () => {
  const garbage = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919) % 256));
  const root = mk({
    'package.json': '{"dependencies": {"react": ',
    'pyproject.toml': garbage,
    'Cargo.toml': garbage,
    'go.mod': garbage,
    'requirements.txt': garbage,
    'Pipfile': '[[[[',
    'docker-compose.yml': garbage,
    'Dockerfile': garbage,
    'pom.xml': garbage,
    'k8s/x.yaml': garbage,
  });
  fs.writeFileSync(path.join(root, 'apps'), 'not a dir');
  const r = detectProject(root);
  assert.ok(Array.isArray(r.techs));
  assert.ok(r.topics.includes('nodejs'));
  assert.ok(!r.topics.includes('react'));
  // Non-existent dir.
  const r2 = detectProject(path.join(root, 'nope'));
  assert.deepEqual(r2.techs, []);
  // Arrays / nulls in package.json.
  assert.equal(_internal.parsePackageJson('null').size, 0);
  assert.equal(_internal.parsePackageJson('{"dependencies": ["react"]}').size, 0);
});

test('symlink loops and symlinks outside the project are not followed', () => {
  const outside = mk({
    'package.json': JSON.stringify({ dependencies: { mongoose: '8' } }),
    'x1.go': '', 'x2.go': '', 'x3.go': '', 'x4.go': '',
  });
  const root = mk({ 'a.js': '', 'b.js': '', 'c.js': '' });
  fs.symlinkSync(root, path.join(root, 'loop'));
  fs.symlinkSync(outside, path.join(root, 'ext'));
  fs.mkdirSync(path.join(root, 'apps'));
  fs.symlinkSync(outside, path.join(root, 'apps', 'evil'));
  fs.symlinkSync(path.join(outside, 'package.json'), path.join(root, 'package.json'));
  const r = detectProject(root);
  assert.ok(!r.topics.includes('mongodb'), `followed outside symlink: ${r.topics}`);
  assert.ok(!r.topics.includes('go'));
  assert.ok(r.topics.includes('javascript'));
  const js = tech(r, 'javascript').evidence.find((e) => e.startsWith('files:*.js'));
  assert.equal(js, 'files:*.js x3');
});

test('symlinked manifest inside the project is allowed', () => {
  const root = mk({ 'real/package.json': JSON.stringify({ dependencies: { express: '4' } }) });
  fs.symlinkSync(path.join(root, 'real', 'package.json'), path.join(root, 'package.json'));
  assert.ok(detectProject(root).topics.includes('http'));
});

test('node_modules and other build dirs are ignored', () => {
  const files = { 'index.js': '', 'b.js': '', 'c.js': '' };
  for (let i = 0; i < 20; i++) {
    files[`node_modules/pkg${i}/index.py`] = '';
    files[`dist/x${i}.rs`] = '';
    files[`.venv/y${i}.go`] = '';
  }
  files['node_modules/evil/package.json'] = JSON.stringify({ dependencies: { mongoose: '1' } });
  const r = detectProject(mk(files));
  for (const t of ['python', 'rust', 'go', 'mongodb']) assert.ok(!r.topics.includes(t), `leaked ${t}`);
});

test('maxEntries and maxDepth are respected', () => {
  const files = {};
  for (let i = 0; i < 200; i++) files[`src/f${i}.py`] = '';
  files['a/b/c/d/e/deep1.rs'] = ''; files['a/b/c/d/e/deep2.rs'] = ''; files['a/b/c/d/e/deep3.rs'] = '';
  const root = mk(files);
  const r = detectProject(root, { maxEntries: 50 });
  assert.equal(r.truncated, true);
  assert.ok(r.scanned <= 50);
  const py = tech(r, 'python');
  const n = Number(/x(\d+)/.exec(py.evidence.find((e) => e.startsWith('files:')))[1]);
  assert.ok(n < 50, `counted ${n}`);
  assert.ok(!detectProject(root).topics.includes('rust'), 'maxDepth=3 should not reach depth 5');
  assert.ok(detectProject(root, { maxDepth: 6 }).topics.includes('rust'));
});

test('extension census ignores < 3 files and caps weight at 0.7', () => {
  const r = detectProject(mk({ 'a.go': '', 'b.go': '', 'x.py': '', 'y.py': '', 'z.py': '' }));
  assert.ok(!r.topics.includes('go'));
  assert.equal(tech(r, 'python').weight, 0.7);
});

test('.env and secret files are never read', () => {
  const root = mk({
    '.env': 'OPENAI_API_KEY=sk-secret\nimage: postgres\n{"dependencies":{"redis":"1"}}\n',
    'package.json': JSON.stringify({ dependencies: {} }),
    'secrets.yaml': 'apiVersion: v1\nkind: Deployment\n',
  });
  fs.chmodSync(path.join(root, '.env'), 0o000);
  const opened = [];
  const origOpen = fs.openSync;
  const origRead = fs.readFileSync;
  fs.openSync = function (p, ...rest) { opened.push(String(p)); return origOpen.call(this, p, ...rest); };
  fs.readFileSync = function (p, ...rest) { opened.push(String(p)); return origRead.call(this, p, ...rest); };
  let r;
  try { r = detectProject(root); } finally { fs.openSync = origOpen; fs.readFileSync = origRead; }
  assert.ok(!opened.some((p) => path.basename(p).startsWith('.env')), `opened: ${opened}`);
  assert.ok(!opened.some((p) => path.basename(p) === 'secrets.yaml'));
  for (const t of r.techs) for (const e of t.evidence) assert.ok(!e.includes('.env'), e);
  for (const t of ['llm', 'postgresql', 'redis', 'kubernetes']) assert.ok(!r.topics.includes(t), `leaked ${t}`);
});

test('detectCached: hit returns same result, recomputes on manifest change, TTL and LRU', () => {
  const home = mk({});
  const p = { projects: path.join(home, 'cache', 'projects.json') };
  const root = mk({ 'package.json': JSON.stringify({ dependencies: { react: '18' } }) });
  const now = 1_700_000_000_000;
  const a = detectCached(root, p, { now });
  assert.equal(a.cached, false);
  const b = detectCached(root, p, { now: now + 1000 });
  assert.equal(b.cached, true);
  assert.deepEqual(b.topics, a.topics);
  assert.deepEqual(b.techs, a.techs);

  // Manifest change -> recompute (bump mtime explicitly so the test is not timing sensitive).
  const pj = path.join(root, 'package.json');
  fs.writeFileSync(pj, JSON.stringify({ dependencies: { react: '18', redis: '4' } }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(pj, later, later);
  const c = detectCached(root, p, { now: now + 2000 });
  assert.equal(c.cached, false);
  assert.ok(c.topics.includes('redis'));
  assert.equal(detectCached(root, p, { now: now + 3000 }).cached, true);

  // Older than 24h -> recompute.
  assert.equal(detectCached(root, p, { now: now + 2000 + 25 * 3600 * 1000 }).cached, false);

  // LRU cap at 50 entries.
  for (let i = 0; i < 55; i++) detectCached(mk({}), p, { now: now + 1e8 + i });
  const cache = JSON.parse(fs.readFileSync(p.projects, 'utf8'));
  assert.equal(Object.keys(cache.entries).length, 50);
});

test('detectCached survives a corrupt cache file', () => {
  const home = mk({ 'cache/projects.json': '{nope' });
  const p = { projects: path.join(home, 'cache', 'projects.json') };
  const r = detectCached(mk({ 'go.mod': 'module x\n' }), p, {});
  assert.ok(r.topics.includes('go'));
});

test('timing on real repos (informational)', () => {
  const home = mk({});
  const p = { projects: path.join(home, 'cache', 'projects.json') };
  for (const repo of [path.resolve(__dirname, '..'), '/home/aman/famgraph']) {
    if (!fs.existsSync(repo)) continue;
    let t0 = process.hrtime.bigint();
    const r = detectCached(repo, p, {});
    const cold = Number(process.hrtime.bigint() - t0) / 1e6;
    t0 = process.hrtime.bigint();
    const h = detectCached(repo, p, {});
    const hot = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(h.cached, true);
    console.log(`# ${repo}: cold ${cold.toFixed(1)} ms, cache hit ${hot.toFixed(1)} ms, scanned ${r.scanned}, topics ${r.topics.slice(0, 10).join(',')}`);
    assert.ok(hot < 100, `cache hit too slow: ${hot}`);
  }
});
