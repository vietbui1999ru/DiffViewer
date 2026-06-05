export class Broadcaster {
  constructor() {
    this.clients = new Set();
  }

  subscribe(client) {
    if (!client || typeof client.send !== 'function') throw new TypeError('client must have a send() method');
    this.clients.add(client);
  }
  unsubscribe(client) { this.clients.delete(client); }

  emit(snapshot) {
    for (const client of [...this.clients]) {
      try {
        client.send(snapshot);
      } catch (err) {
        console.error('[broadcaster] dropped client:', err);
        this.clients.delete(client);
      }
    }
  }
}
