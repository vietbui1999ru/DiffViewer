import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';

let tmpBus;
let app;

// Test exec: a JS reimplementation of the annotate-write contract (exclusive-create,
// zero-padded turn/seq from 0000, consumed:false, task_annotation event append) so the
// HTTP handler + exec wiring can be verified without depending on the real bash binary.
function makeTestAnnotateExec(busDir) {
  return async ({ task, turn, anchor, author, body }) => {
    const dir = path.join(busDir, 'annotations', task);
    fs.mkdirSync(dir, { recursive: true });
    const turn4 = String(turn).padStart(4, '0');
    const seq = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${turn4}-`) && n.endsWith('.json')).length;
    const seq4 = String(seq).padStart(4, '0');
    const file = path.join(dir, `${turn4}-${seq4}.json`);
    const fd = fs.openSync(file, 'wx');
    const ts = new Date().toISOString();
    const record = { task, turn, anchor, ts, author, body, consumed: false };
    fs.writeSync(fd, JSON.stringify(record) + '\n');
    fs.closeSync(fd);
    const event = { ts, event: 'task_annotation', task, turn, anchor, author, seq };
    fs.appendFileSync(path.join(busDir, 'events.jsonl'), JSON.stringify(event) + '\n');
  };
}

beforeEach(() => {
  tmpBus = fs.mkdtempSync(path.join(os.tmpdir(), 'diffviewer-annotate-bus-'));
  app = createApp({ annotateExec: makeTestAnnotateExec(tmpBus) });
});

afterEach(() => {
  fs.rmSync(tmpBus, { recursive: true, force: true });
});

async function postAnnotate(payload) {
  return app.request('/annotate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

describe('POST /annotate — annotation loop write path', () => {
  it('ANN-01 fresh write creates <turn>-0000.json with consumed:false', async () => {
    const res = await postAnnotate({
      task: 'TASK-1', turn: 3, anchor: 'card:src/a.js', bodyText: 'check this', author: 'human',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');

    const file = path.join(tmpBus, 'annotations', 'TASK-1', '0003-0000.json');
    expect(fs.existsSync(file)).toBe(true);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.consumed).toBe(false);
    expect(rec.task).toBe('TASK-1');
    expect(rec.turn).toBe(3);
    expect(rec.anchor).toBe('card:src/a.js');
    expect(rec.body).toBe('check this');
    expect(rec.author).toBe('human');
  });

  it('ANN-02 second write on same turn creates <turn>-0001.json; first file intact', async () => {
    await postAnnotate({ task: 'TASK-2', turn: 1, bodyText: 'first note' });
    await postAnnotate({ task: 'TASK-2', turn: 1, bodyText: 'second note' });

    const dir = path.join(tmpBus, 'annotations', 'TASK-2');
    const first = path.join(dir, '0001-0000.json');
    const second = path.join(dir, '0001-0001.json');
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);

    const r0 = JSON.parse(fs.readFileSync(first, 'utf8'));
    const r1 = JSON.parse(fs.readFileSync(second, 'utf8'));
    expect(r0.body).toBe('first note');
    expect(r0.consumed).toBe(false);
    expect(r1.body).toBe('second note');
    expect(r1.consumed).toBe(false);
  });

  it('ANN-03 missing task returns 400', async () => {
    const res = await postAnnotate({ turn: 1, bodyText: 'no task' });
    expect(res.status).toBe(400);
    // No artifact written
    expect(fs.existsSync(path.join(tmpBus, 'annotations'))).toBe(false);
  });

  it('ANN-04 a task_annotation event is appended to events.jsonl', async () => {
    await postAnnotate({ task: 'TASK-4', turn: 2, anchor: 'card:x.js', bodyText: 'hi' });
    const log = fs.readFileSync(path.join(tmpBus, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(log).toHaveLength(1);
    const ev = JSON.parse(log[0]);
    expect(ev.event).toBe('task_annotation');
    expect(ev.task).toBe('TASK-4');
    expect(ev.turn).toBe(2);
    expect(ev.anchor).toBe('card:x.js');
    expect(ev.seq).toBe(0);
  });

  it('ANN-05 consumed defaults to false', async () => {
    await postAnnotate({ task: 'TASK-5', turn: 0, bodyText: 'default flag' });
    const file = path.join(tmpBus, 'annotations', 'TASK-5', '0000-0000.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(rec.consumed).toBe(false);
  });
});
