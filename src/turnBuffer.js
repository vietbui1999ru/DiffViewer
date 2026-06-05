export class TurnBuffer {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.events = [];
    this.byPath = new Map(); // path -> index in this.events
    this.startedAt = null;
  }

  add(event) {
    if (this.startedAt === null) this.startedAt = this.now();
    if (this.byPath.has(event.path)) {
      this.events[this.byPath.get(event.path)] = event; // keep latest, same slot
    } else {
      this.byPath.set(event.path, this.events.length);
      this.events.push(event);
    }
  }

  flush(sessionId, turnNumber) {
    return {
      sessionId,
      turnNumber,
      events: this.events,
      startedAt: this.startedAt,
      completedAt: this.now(),
    };
  }
}

export class SessionRegistry {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.buffers = new Map();    // sessionId -> TurnBuffer
    this.turnCounts = new Map(); // sessionId -> number
  }

  add(sessionId, event) {
    let b = this.buffers.get(sessionId);
    if (!b) { b = new TurnBuffer(this.now); this.buffers.set(sessionId, b); }
    b.add(event);
  }

  // returns TurnSnapshot, or null when there is nothing to emit
  flush(sessionId) {
    const b = this.buffers.get(sessionId);
    this.buffers.delete(sessionId); // GC on every turn-end
    if (!b || b.events.length === 0) return null;
    const turnNumber = (this.turnCounts.get(sessionId) ?? 0) + 1;
    this.turnCounts.set(sessionId, turnNumber);
    return b.flush(sessionId, turnNumber);
  }
}
