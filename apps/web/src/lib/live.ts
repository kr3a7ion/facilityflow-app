/**
 * The live connection to the host.
 *
 * Replaces asking the same questions on a timer. The host writes one line down an open
 * response the moment anything happens and the screen refetches what it needs — so a
 * technician sees a P1 the second the supervisor assigns it, and a quiet afternoon costs
 * nothing instead of a request a minute from every device in the building.
 *
 * Built to fail safely, because a maintenance department cannot be left staring at a
 * stale board because a socket died quietly:
 *
 *  - If the stream never opens — an old browser, something in the building eating
 *    `text/event-stream` — the caller is told, and goes back to polling. The app is never
 *    worse off than it was.
 *  - A phone walking through a basement drops the connection constantly. EventSource
 *    reconnects on its own; what it cannot do is tell you it has been gone, so the host's
 *    heartbeat is watched and a stream that has gone silent is torn down and rebuilt
 *    rather than left looking connected.
 *  - On reconnect the client refetches everything, because whatever happened while it was
 *    away was never delivered.
 */
export type LiveKind = 'notification' | 'jobs' | 'plant' | 'ping' | 'ring' | 'emergency';

export interface LiveHandlers {
  onEvent: (kind: LiveKind) => void;
  /** Called whenever the connection state changes, for the dot in the top bar. */
  onState: (live: boolean) => void;
  /** Called after any reconnection, so the caller can refetch what it missed. */
  onResync: () => void;
}

/**
 * Longer than the host's 25-second heartbeat with room for a slow radio. Shorter and a
 * phone on weak wifi would spend its day tearing down a connection that was about to
 * deliver.
 */
const SILENCE_LIMIT_MS = 70_000;

export function connectLive(h: LiveHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    h.onState(false);
    return () => {};
  }

  let source: EventSource | null = null;
  let watchdog: ReturnType<typeof setInterval> | null = null;
  let lastMessageAt = Date.now();
  let everOpened = false;
  let closed = false;

  const open = (): void => {
    if (closed) return;
    source = new EventSource('/api/events');

    source.onopen = () => {
      lastMessageAt = Date.now();
      // Only a reconnection needs a resync; the first open is the app's own initial load.
      if (everOpened) h.onResync();
      everOpened = true;
      h.onState(true);
    };

    const handle = (kind: LiveKind) => (): void => {
      lastMessageAt = Date.now();
      h.onState(true);
      if (kind !== 'ping') h.onEvent(kind);
    };
    for (const kind of ['notification', 'jobs', 'plant', 'ping', 'ring', 'emergency'] as LiveKind[]) {
      source.addEventListener(kind, handle(kind));
    }

    source.onerror = () => {
      h.onState(false);
      // EventSource retries by itself; it only needs help when it has given up.
      if (source?.readyState === EventSource.CLOSED) {
        source.close();
        source = null;
        if (!closed) setTimeout(open, 5000);
      }
    };
  };

  open();

  watchdog = setInterval(() => {
    if (closed || !source) return;
    if (Date.now() - lastMessageAt < SILENCE_LIMIT_MS) return;
    // Silent for longer than the heartbeat allows. The socket is open as far as the
    // browser is concerned and dead as far as the building is concerned, which is the
    // failure that would otherwise leave somebody trusting a board that stopped updating
    // twenty minutes ago.
    h.onState(false);
    source.close();
    source = null;
    open();
  }, 20_000);
  watchdog.unref?.();

  return () => {
    closed = true;
    if (watchdog) clearInterval(watchdog);
    source?.close();
    source = null;
  };
}
