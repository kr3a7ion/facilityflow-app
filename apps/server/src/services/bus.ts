/**
 * Who is watching, and how they are told.
 *
 * Before this, every screen asked the host the same questions on a timer — notifications
 * every minute, the job board every two. A technician could be standing in front of the
 * phone for fifty seconds after a P1 was assigned to them with nothing on screen, and the
 * department paid for that delay in requests from every device all day whether anything
 * had happened or not.
 *
 * One process, one database, one building: there is no message broker to justify here.
 * A map of open connections and a function that writes to them is the whole mechanism.
 *
 * Two rules make it safe:
 *
 *  - **Emit after the commit, never inside it.** Notifications are written inside
 *    transactions. Telling a phone about a job while the transaction could still roll
 *    back would have the device showing work that never existed. Every publish is
 *    deferred to the next tick, which on better-sqlite3's synchronous transactions is
 *    always after the commit has returned.
 *
 *  - **Never let a dead connection break the thing that triggered it.** A phone that
 *    walked out of wifi range mid-write must not fail somebody else's job assignment, so
 *    a failed write only drops that subscriber.
 */
export type EventKind =
  | 'notification'
  | 'jobs'
  | 'plant'
  | 'ping'
  // Somebody is ringing this person's device, or has acknowledged a ring they sent.
  | 'ring'
  // An emergency alert was raised, acknowledged or stood down. Everybody gets it.
  | 'emergency';

export interface Event {
  kind: EventKind;
  /** Small enough to be a nudge, not a payload: the client refetches what it needs. */
  at: string;
}

interface Subscriber {
  userId: string;
  send: (e: Event) => void;
}

let nextId = 1;
const subscribers = new Map<number, Subscriber>();

export function subscribe(userId: string, send: (e: Event) => void): () => void {
  const id = nextId++;
  subscribers.set(id, { userId, send });
  return () => { subscribers.delete(id); };
}

function deliver(e: Event, match: (s: Subscriber) => boolean): void {
  for (const [id, s] of subscribers) {
    if (!match(s)) continue;
    try {
      s.send(e);
    } catch {
      // The far end is gone. Drop it rather than letting a closed socket throw its way
      // back up into whatever business transaction caused this.
      subscribers.delete(id);
    }
  }
}

/** Tell one person. Deferred, so it can be called from inside a transaction safely. */
export function publishTo(userId: string, kind: EventKind): void {
  const e: Event = { kind, at: new Date().toISOString() };
  setImmediate(() => deliver(e, (s) => s.userId === userId));
}

/** Tell everybody watching — a job board change, a plant reading. */
export function publishAll(kind: EventKind): void {
  const e: Event = { kind, at: new Date().toISOString() };
  setImmediate(() => deliver(e, () => true));
}

/**
 * How many of one person's devices are listening right now.
 *
 * Read before a ring is published, because the number that matters is what was connected
 * at the moment the button was pressed — and zero is the answer worth saying out loud.
 */
export function listenerCountFor(userId: string): number {
  let n = 0;
  for (const s of subscribers.values()) if (s.userId === userId) n += 1;
  return n;
}

/** For the Host PC screen: how many devices are listening right now. */
export function listenerCount(): { connections: number; people: number } {
  return {
    connections: subscribers.size,
    people: new Set([...subscribers.values()].map((s) => s.userId)).size,
  };
}

/**
 * A line down every connection on a timer.
 *
 * Not for the client's benefit — for the pipe's. An idle HTTP response through a router
 * or a phone's radio gets reaped somewhere between thirty seconds and a few minutes, and
 * a connection nobody has written to looks exactly like a connection nobody needs. The
 * comment keeps it alive and gives the browser a heartbeat it can notice the absence of.
 */
export function startHeartbeat(everyMs = 25_000): { stop: () => void } {
  const timer = setInterval(() => {
    const e: Event = { kind: 'ping', at: new Date().toISOString() };
    deliver(e, () => true);
  }, everyMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
