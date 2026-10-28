/**
 * dsh-teacher-skill — DSH host plugin.
 *
 * Mounts teacher.skill HTML decks and answer-card submissions under /teacher
 * on the existing DSH web server, so the same remote URL that opens DSH also
 * opens the course.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { homedir } from 'node:os';
import { timingSafeEqual } from 'node:crypto';

export const name = 'teacher-course';
export const inject = ['webServer'];
export const VERSION = '0.1.0';

export const PREFIX = '/teacher';
export const ROUTES = Object.freeze({
  health: '/teacher/api/health',
  latest: '/teacher/api/answers/latest',
  answers: '/teacher/api/answers',
});

const MOUNT_GUARD = Symbol.for('dsh-teacher-skill.mounted.v1');
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ANSWERS = 100;

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
});

/** Find a sensible workspace root without assuming a drive letter. */
export function defaultWorkspaceRoot() {
  const candidates = [
    process.env.DSH_TEACHER_WORKSPACE_ROOT,
    'D:\\wake\\HarnessWorkspace',
    join(homedir(), 'HarnessWorkspace'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue;
    try { if (existsSync(candidate)) return resolve(candidate); } catch {}
  }
  return resolve(process.cwd());
}

export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: config.enabled !== false,
    workspaceRoot: resolve(String(config.workspaceRoot || process.env.DSH_TEACHER_WORKSPACE_ROOT || defaultWorkspaceRoot())),
    token: typeof config.token === 'string' ? config.token : '',
    maxBodyBytes: Number.isInteger(config.maxBodyBytes) ? Math.min(Math.max(config.maxBodyBytes, 1024), 8 * 1024 * 1024) : MAX_BODY_BYTES,
  };
}

/** Reject path segments that could escape a course folder. */
export function safeSegment(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text || text === '.' || text === '..') return false;
  if (text.includes('/') || text.includes('\\') || text.includes('\0')) return false;
  if (text.startsWith('.')) return false;
  return true;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (value.includes('\0')) return false;
  const parts = value.split(/[\\/]+/);
  if (parts.some(part => part === '..' || part === '.' || part === '')) return false;
  return true;
}

export function resolveCourseRoot(workspaceRoot, workspace, course) {
  if (!safeSegment(workspace) || !safeSegment(course)) return null;
  const root = resolve(workspaceRoot, workspace, '讲义', course);
  const expected = resolve(workspaceRoot, workspace, '讲义');
  if (root !== expected && !root.startsWith(`${expected}${sep}`)) return null;
  return root;
}

export function resolveCourseFile(workspaceRoot, workspace, course, relativePath) {
  const courseRoot = resolveCourseRoot(workspaceRoot, workspace, course);
  if (!courseRoot || !safeRelativePath(relativePath)) return null;
  const file = resolve(courseRoot, ...relativePath.split(/[\\/]+/));
  if (file !== courseRoot && !file.startsWith(`${courseRoot}${sep}`)) return null;
  return file;
}

export function contentType(file) {
  return MIME[extname(String(file)).toLowerCase()] || 'application/octet-stream';
}

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res, status, text) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow);
  sendText(res, 405, 'method not allowed');
}

function authorized(req, cfg) {
  if (!cfg.token) return true;
  const supplied = req.headers['x-teacher-token'];
  if (typeof supplied !== 'string') return false;
  const expected = Buffer.from(cfg.token);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function readBody(req, limit) {
  return new Promise(resolvePromise => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const timer = setTimeout(() => finish(null), 10000);
    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', finish);
      req.off('aborted', finish);
      resolvePromise(value);
    }
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) { finish(null); req.resume?.(); return; }
      chunks.push(buffer);
    }
    function onEnd() {
      if (!chunks.length) return finish({});
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(null); }
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', finish);
    req.on('aborted', finish);
  });
}

function validAnswer(answer) {
  if (!answer || typeof answer !== 'object') return false;
  const id = typeof answer.id === 'string' ? answer.id.trim() : '';
  if (!id || id.length > 64) return false;
  if (typeof answer.value !== 'string') return false;
  return answer.value.length <= 20000;
}

function timestampName(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Write the latest submission plus a timestamped copy. Exported for tests. */
export function writeAnswers(workspaceRoot, payload, now = new Date()) {
  if (!payload || typeof payload !== 'object') throw new Error('invalid payload');
  const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
  const course = typeof payload.course === 'string' ? payload.course.trim() : '';
  if (!safeSegment(workspace) || !safeSegment(course)) throw new Error('invalid workspace or course');
  if (!Array.isArray(payload.answers) || payload.answers.length === 0 || payload.answers.length > MAX_ANSWERS) {
    throw new Error('answers must be a non-empty array');
  }
  if (!payload.answers.every(validAnswer)) throw new Error('invalid answer item');

  const courseRoot = resolveCourseRoot(workspaceRoot, workspace, course);
  if (!courseRoot) throw new Error('course path escapes workspace root');
  const answersDir = join(courseRoot, 'answers');
  mkdirSync(answersDir, { recursive: true });

  const record = {
    schema: 'teacher.skill/answers/v1',
    workspace,
    course,
    unit: typeof payload.unit === 'string' || typeof payload.unit === 'number' ? String(payload.unit).slice(0, 32) : '',
    title: typeof payload.title === 'string' ? payload.title.slice(0, 200) : '',
    answers: payload.answers.map(answer => ({ id: String(answer.id).slice(0, 64), value: String(answer.value).slice(0, 20000) })),
    submitted_at: now.toISOString(),
  };
  const text = `${JSON.stringify(record, null, 2)}\n`;
  const latest = join(answersDir, 'latest.json');
  const temp = join(answersDir, `.latest-${process.pid}-${now.getTime()}.tmp`);
  writeFileSync(temp, text, 'utf8');
  renameSync(temp, latest);
  writeFileSync(join(answersDir, `${timestampName(now)}.json`), text, 'utf8');
  return { file: 'answers/latest.json', count: record.answers.length };
}

function readLatest(workspaceRoot, workspace, course) {
  const courseRoot = resolveCourseRoot(workspaceRoot, workspace, course);
  if (!courseRoot) return null;
  const file = join(courseRoot, 'answers', 'latest.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function parseCourseQuery(req) {
  const url = new URL(req.url || '/', 'http://localhost');
  const workspace = (url.searchParams.get('workspace') || '').trim();
  const course = (url.searchParams.get('course') || '').trim();
  return { workspace, course };
}

function staticHandler(cfg) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET, HEAD');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); }
    catch { return sendText(res, 400, 'bad path'); }
    if (!pathname.startsWith(`${PREFIX}/`)) return sendText(res, 404, 'not found');
    let relative = pathname.slice(PREFIX.length + 1);
    if (!relative || relative.endsWith('/')) relative += 'index.html';
    const parts = relative.split('/').filter(Boolean);
    if (parts.length < 3) return sendText(res, 404, 'not found');
    const workspace = parts.shift();
    const course = parts.shift();
    const rest = parts.join('/');
    if (!safeSegment(workspace) || !safeSegment(course) || !safeRelativePath(rest)) {
      return sendText(res, 404, 'not found');
    }
    if (rest.split('/').includes('answers')) return sendText(res, 404, 'not found');
    const file = resolveCourseFile(cfg.workspaceRoot, workspace, course, rest);
    if (!file || !existsSync(file)) return sendText(res, 404, 'not found');
    let info;
    try { info = statSync(file); } catch { return sendText(res, 404, 'not found'); }
    if (!info.isFile()) return sendText(res, 404, 'not found');
    res.writeHead(200, {
      'content-type': contentType(file),
      'content-length': info.size,
      'cache-control': /\.(html?|json)$/i.test(file) ? 'no-cache' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file);
    stream.on('error', () => { if (!res.writableEnded) res.destroy(); });
    stream.pipe(res);
  };
}

/** Build the route table. Exported so tests can inspect it without a DSH host. */
export function makeRoutes(rawConfig) {
  const cfg = normalizeConfig(rawConfig);
  return [
    {
      kind: 'exact',
      path: ROUTES.health,
      handler: async (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-teacher-skill',
          version: VERSION,
          authRequired: Boolean(cfg.token),
          prefix: PREFIX,
        });
      },
    },
    {
      kind: 'exact',
      path: ROUTES.latest,
      handler: async (req, res) => {
        if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
        if (!authorized(req, cfg)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        const { workspace, course } = parseCourseQuery(req);
        if (!safeSegment(workspace) || !safeSegment(course)) {
          return sendJson(res, 400, { ok: false, error: 'workspace and course are required' });
        }
        const record = readLatest(cfg.workspaceRoot, workspace, course);
        if (!record) return sendJson(res, 404, { ok: false, error: 'no submission' });
        sendJson(res, 200, { ok: true, record });
      },
    },
    {
      kind: 'exact',
      path: ROUTES.answers,
      handler: async (req, res) => {
        if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
        if (!authorized(req, cfg)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
        const type = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (type !== 'application/json') return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' });
        const body = await readBody(req, cfg.maxBodyBytes);
        if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid or oversized JSON body' });
        try {
          const saved = writeAnswers(cfg.workspaceRoot, body);
          return sendJson(res, 200, { ok: true, saved: true, ...saved });
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : 'invalid payload' });
        }
      },
    },
    {
      kind: 'prefix',
      path: PREFIX,
      handler: staticHandler(cfg),
    },
  ];
}

export function apply(ctx, rawConfig) {
  if (!ctx || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    throw new Error('dsh-teacher-skill requires ctx.webServer (DSH host plugin)');
  }
  const cfg = normalizeConfig(rawConfig);
  if (!cfg.enabled) return;

  const mount = () => {
    if (globalThis[MOUNT_GUARD]?.ok) return () => {};
    const mounted = { ok: false };
    const disposers = [];
    const dispose = () => {
      for (const fn of disposers.splice(0).reverse()) {
        try { if (typeof fn === 'function') fn(); } catch {}
      }
      mounted.ok = false;
      if (globalThis[MOUNT_GUARD] === mounted) delete globalThis[MOUNT_GUARD];
    };
    try {
      for (const route of makeRoutes(cfg)) disposers.push(ctx.webServer.register(route));
      mounted.ok = true;
      globalThis[MOUNT_GUARD] = mounted;
      ctx.logger?.info?.(`[teacher-course] mounted at ${PREFIX} (workspaceRoot=${cfg.workspaceRoot})`);
      return dispose;
    } catch (error) {
      dispose();
      throw error;
    }
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => mount(), 'dsh-teacher-skill: routes');
  } else {
    return mount();
  }
}

export default { name, inject, apply };
