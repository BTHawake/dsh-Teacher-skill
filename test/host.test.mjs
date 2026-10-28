import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';

import {
  apply,
  makeRoutes,
  normalizeConfig,
  resolveCourseFile,
  safeSegment,
  writeAnswers,
  ROUTES,
} from '../index.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-teacher-'));
  const course = join(root, 'ws', '讲义', '课程');
  mkdirSync(course, { recursive: true });
  writeFileSync(join(course, 'index.html'), '<h1>demo</h1>', 'utf8');
  writeFileSync(join(course, 'unit-01.html'), '<h1>unit</h1>', 'utf8');
  return { root, course };
}

test('normalizeConfig resolves a writable root', () => {
  const { root } = fixture();
  const cfg = normalizeConfig({ workspaceRoot: root, token: 'secret' });
  assert.equal(cfg.workspaceRoot, root);
  assert.equal(cfg.token, 'secret');
  assert.equal(cfg.enabled, true);
});

test('safeSegment rejects traversal and separators', () => {
  assert.equal(safeSegment('计算机组成原理'), true);
  assert.equal(safeSegment('..'), false);
  assert.equal(safeSegment('a/b'), false);
  assert.equal(safeSegment('a\\b'), false);
  assert.equal(safeSegment('.hidden'), false);
  assert.equal(safeSegment(''), false);
});

test('resolveCourseFile stays inside the course', () => {
  const { root } = fixture();
  assert.ok(resolveCourseFile(root, 'ws', '课程', 'unit-01.html'));
  assert.equal(resolveCourseFile(root, 'ws', '课程', '../secret.txt'), null);
  assert.equal(resolveCourseFile(root, '..', '课程', 'index.html'), null);
});

test('writeAnswers writes latest.json and a timestamped snapshot', () => {
  const { root, course } = fixture();
  const result = writeAnswers(root, {
    workspace: 'ws',
    course: '课程',
    unit: '1',
    title: '测试',
    answers: [{ id: 'Q1', value: 'B' }],
  }, new Date('2026-10-28T12:00:00Z'));
  assert.equal(result.count, 1);
  const latest = JSON.parse(readFileSync(join(course, 'answers', 'latest.json'), 'utf8'));
  assert.equal(latest.schema, 'teacher.skill/answers/v1');
  assert.equal(latest.answers[0].value, 'B');
  const snapshots = readdirSync(join(course, 'answers')).filter(name => /^\d{8}-\d{6}\.json$/.test(name));
  assert.equal(snapshots.length, 1);
});

test('makeRoutes exposes health, answers and static prefix', () => {
  const { root } = fixture();
  const routes = makeRoutes({ workspaceRoot: root });
  assert.deepEqual(routes.map(route => [route.kind, route.path]), [
    ['exact', ROUTES.health],
    ['exact', ROUTES.latest],
    ['exact', ROUTES.answers],
    ['prefix', '/teacher'],
  ]);
});

test('apply registers routes through ctx.webServer', () => {
  const { root } = fixture();
  const registered = [];
  let disposeRoutes;
  const ctx = {
    webServer: {
      register(route) {
        registered.push(route);
        return () => {};
      },
    },
    effect(callback) {
      disposeRoutes = callback();
      return disposeRoutes;
    },
    logger: { info() {} },
  };
  apply(ctx, { workspaceRoot: root });
  assert.equal(registered.length, 4);
  assert.deepEqual(registered.map(route => route.path), [
    ROUTES.health,
    ROUTES.latest,
    ROUTES.answers,
    '/teacher',
  ]);
  disposeRoutes();
});

test('static handler serves course HTML and rejects traversal', async () => {
  const { root } = fixture();
  const prefix = makeRoutes({ workspaceRoot: root }).find(route => route.kind === 'prefix');
  const server = createServer((req, res) => prefix.handler(req, res));
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/teacher/ws/课程/index.html`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /demo/);

    const traversal = await fetch(`http://127.0.0.1:${port}/teacher/ws/课程/../secret.txt`);
    assert.equal(traversal.status, 404);

    const answers = await fetch(`http://127.0.0.1:${port}/teacher/ws/课程/answers/latest.json`);
    assert.equal(answers.status, 404);
  } finally {
    await new Promise(resolvePromise => server.close(resolvePromise));
  }
});
