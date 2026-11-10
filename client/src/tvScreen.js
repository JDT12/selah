import { useCallback, useEffect, useState } from 'react';

/**
 * 13.0: the slides alone on a TV or projector from the iPad app (HDMI or AirPlay). The app's SlidesScreen plugin
 * (mobile-app/ios/App/App/SceneDelegate.swift) shows the slides window on that screen in a web view of its own; it
 * follows Preach and Teach through the server, as it does on a computer. An app built before 13.0's TV support, or a
 * browser, has no plugin, and nothing here does anything.
 */
const plugin = () => (window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins?.SlidesScreen ?? null : null);
export const canUseTv = () => !!plugin();

/** The slides window's address for the TV: no controls, as the audience sees it. */
export const tvUrl = (noteId) => `${location.origin}/?tv=1#slides/${noteId}`;

/**
 * While a sermon or lesson with slides is open in Preach or Teach: is a TV connected, are the slides on it, and a
 * toggle between the slides and mirroring the iPad. The slides go up by themselves when a TV is (or gets) connected,
 * and come down (back to mirroring) when you leave.
 */
export function useTvScreen(noteId) {
  const [connected, setConnected] = useState(false);
  const [showing, setShowing] = useState(true); // your choice: the slides (true) or the iPad mirrored
  useEffect(() => {
    const p = plugin();
    if (!p) return undefined;
    let handle = null;
    let live = true;
    p.status().then((s) => { if (live) setConnected(!!s.connected); }).catch(() => {});
    Promise.resolve(p.addListener('change', (e) => setConnected(!!e.connected))).then((h) => { if (live) handle = h; else h?.remove?.(); }).catch(() => {});
    return () => { live = false; handle?.remove?.(); };
  }, []);
  useEffect(() => {
    const p = plugin();
    if (!p) return undefined;
    if (showing) p.show({ url: tvUrl(noteId) }).catch(() => {});
    else p.hide().catch(() => {});
    return () => { p.hide().catch(() => {}); };
  }, [noteId, showing]);
  const toggle = useCallback(() => setShowing((v) => !v), []);
  return { available: !!plugin(), connected, showing, toggle };
}
