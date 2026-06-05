export class Broadcaster {
  constructor() {
    this.clients = new Set();
  }

  subscribe(client) { this.clients.add(client); }
  unsubscribe(client) { this.clients.delete(client); }

  emit(snapshot) {
    for (const client of [...this.clients]) {
      try {
        client.send(snapshot);
      } catch {
        this.clients.delete(client); // drop dead connection
      }
    }
  }
}
