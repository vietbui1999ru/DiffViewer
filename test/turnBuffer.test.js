import { describe, it, expect } from 'vitest';
import { TurnBuffer, SessionRegistry } from '../src/turnBuffer.js';

const ev = (path, tag = path) => ({ tool: 'edit', path, unifiedDiff: tag, isNew: false });

describe('TurnBuffer', () => {
  it('AC-TB1 add+flush preserves first-touch order', () => {
    const b = new TurnBuffer(() => 1);
    b.add(ev('a')); b.add(ev('b')); b.add(ev('c'));
    expect(b.flush().events.map(e => e.path)).toEqual(['a', 'b', 'c']);
  });

  it('AC-TB2 empty flush returns events []', () => {
    expect(new TurnBuffer(() => 1).flush().events).toEqual([]);
  });

  it('AC-TB3 reset clears prior events', () => {
    const b = new TurnBuffer(() => 1);
    b.add(ev('a')); b.flush(); b.reset(); b.add(ev('z'));
    expect(b.flush().events.map(e => e.path)).toEqual(['z']);
  });

  it('AC-TB4 dedupe by path keeps latest at original position', () => {
    const b = new TurnBuffer(() => 1);
    b.add(ev('a', 'a1')); b.add(ev('b', 'b1')); b.add(ev('a', 'a2'));
    const paths = b.flush().events.map(e => e.path);
    expect(paths).toEqual(['a', 'b']);
    expect(b.events.find(e => e.path === 'a').unifiedDiff).toBe('a2');
  });

  it('AC-TB7 startedAt is first add, completedAt is flush time', () => {
    let t = 10;
    const b = new TurnBuffer(() => t);
    b.add(ev('a')); t = 25;
    const snap = b.flush();
    expect(snap.startedAt).toBe(10);
    expect(snap.completedAt).toBe(25);
  });
});

describe('SessionRegistry', () => {
  it('AC-TB5 turnNumber increments per session across flushes', () => {
    const r = new SessionRegistry(() => 1);
    r.add('s1', ev('a'));
    expect(r.flush('s1').turnNumber).toBe(1);
    r.add('s1', ev('b'));
    expect(r.flush('s1').turnNumber).toBe(2);
  });

  it('AC-TB6 / AC-E5 sessions are isolated', () => {
    const r = new SessionRegistry(() => 1);
    r.add('s1', ev('a')); r.add('s2', ev('b'));
    expect(r.flush('s2').events.map(e => e.path)).toEqual(['b']);
    expect(r.flush('s1').events.map(e => e.path)).toEqual(['a']);
  });

  it('AC-E4 empty/absent flush returns null (skip emit)', () => {
    const r = new SessionRegistry(() => 1);
    expect(r.flush('nope')).toBeNull();
  });

  it('AC-E6 buffer deleted on flush; new events start a fresh turn', () => {
    const r = new SessionRegistry(() => 1);
    r.add('s1', ev('a')); r.flush('s1');
    r.add('s1', ev('z'));
    const snap = r.flush('s1');
    expect(snap.events.map(e => e.path)).toEqual(['z']);
    expect(snap.turnNumber).toBe(2);
  });
});
