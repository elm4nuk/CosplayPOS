import type { ServerResponse } from 'node:http';

export type BusEvent = 'hello' | 'stock' | 'transaction' | 'catalog' | 'event' | 'restore';

interface Client {
  res: ServerResponse;
  userId: number;
}

/** Penyiar Server-Sent Events ke semua perangkat kasir yang terhubung. */
export class EventBus {
  #clients = new Set<Client>();
  #heartbeat: NodeJS.Timeout | null = null;

  add(res: ServerResponse, userId: number): () => void {
    const client: Client = { res, userId };
    this.#clients.add(client);
    if (!this.#heartbeat) {
      this.#heartbeat = setInterval(() => this.#writeAll(': ping\n\n'), 25_000);
      this.#heartbeat.unref();
    }
    return () => this.#remove(client);
  }

  get size(): number {
    return this.#clients.size;
  }

  publish(event: BusEvent, data: unknown): void {
    this.#writeAll(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Tutup koneksi milik user tertentu (mis. setelah sesi dicabut). */
  disconnectUser(userId: number): void {
    for (const c of [...this.#clients]) if (c.userId === userId) this.#end(c);
  }

  closeAll(): void {
    for (const c of [...this.#clients]) this.#end(c);
  }

  #writeAll(chunk: string): void {
    for (const c of [...this.#clients]) {
      try {
        c.res.write(chunk);
      } catch {
        this.#remove(c);
      }
    }
  }

  #end(c: Client): void {
    try {
      c.res.end();
    } catch {
      // sudah tertutup
    }
    this.#remove(c);
  }

  #remove(c: Client): void {
    this.#clients.delete(c);
    if (this.#clients.size === 0 && this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
