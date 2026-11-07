// Live updates from the server (see server/events.js). Each window has an id, sent with every request, so it can
// tell its own changes apart. Messages are passed on as a 'noteapp:live' window event, and 'noteapp:live-reconnect'
// after the stream comes back (the app then catches up on anything it missed).
export const clientId = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);

let source = null;
export function startLive() {
  if (source || typeof EventSource === 'undefined') return;
  let dropped = false;
  source = new EventSource('/api/events');
  source.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      // The phone remote's messages (where a presentation is, a button pressed) aren't changes to fetch.
      window.dispatchEvent(new CustomEvent(data.slides ? 'noteapp:slides' : 'noteapp:live', { detail: data }));
    } catch { /* bad message */ }
  };
  source.onerror = () => { dropped = true; };
  source.onopen = () => {
    if (dropped) window.dispatchEvent(new Event('noteapp:live-reconnect'));
    dropped = false;
  };
}

export function stopLive() {
  source?.close();
  source = null;
}

/** Calls fn after live changes (once for a burst of them) and after a reconnect. Returns the unsubscribe. */
export function onLive(fn, delay = 300) {
  let t = null;
  const run = () => { clearTimeout(t); t = setTimeout(fn, delay); };
  window.addEventListener('noteapp:live', run);
  window.addEventListener('noteapp:live-reconnect', run);
  return () => {
    clearTimeout(t);
    window.removeEventListener('noteapp:live', run);
    window.removeEventListener('noteapp:live-reconnect', run);
  };
}
