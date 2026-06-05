import { describe, it, expect, vi } from 'vitest';
import { Broadcaster } from '../src/broadcaster.js';

const snap = { sessionId: 's1', turnNumber: 1, events: [] };

describe('Broadcaster', () => {
  it('AC-B1/B2 subscribe then emit delivers snapshot', () => {
    const b = new Broadcaster();
    const c = { send: vi.fn() };
    b.subscribe(c);
    b.emit(snap);
    expect(c.send).toHaveBeenCalledWith(snap);
  });

  it('AC-B3 all subscribers receive', () => {
    const b = new Broadcaster();
    const cs = [{ send: vi.fn() }, { send: vi.fn() }, { send: vi.fn() }];
    cs.forEach(c => b.subscribe(c));
    b.emit(snap);
    cs.forEach(c => expect(c.send).toHaveBeenCalledWith(snap));
  });

  it('AC-B4 a throwing client is dropped and not retried', () => {
    const b = new Broadcaster();
    const dead = { send: vi.fn(() => { throw new Error('closed'); }) };
    const live = { send: vi.fn() };
    b.subscribe(dead); b.subscribe(live);
    b.emit(snap);   // dead throws here, gets removed
    b.emit(snap);   // dead must not be called again
    expect(dead.send).toHaveBeenCalledTimes(1);
    expect(live.send).toHaveBeenCalledTimes(2);
  });

  it('AC-B5 unsubscribe stops delivery', () => {
    const b = new Broadcaster();
    const c = { send: vi.fn() };
    b.subscribe(c); b.unsubscribe(c);
    b.emit(snap);
    expect(c.send).not.toHaveBeenCalled();
  });
});
