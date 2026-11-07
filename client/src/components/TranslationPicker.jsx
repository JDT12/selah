import { useEffect, useState } from 'react';
import { bibleInfo, creditHtml, setViewTranslation, viewTranslation } from '../esv.js';

/**
 * The Bible translations that are connected and the one a view reads in: its own pick (kept per device, see
 * viewTranslation) or the favorite. `view` is 'side', 'study', 'passage' or 'insert'; without one it's the favorite.
 * Picks up changes made in Settings → Bible.
 */
export function useBible(view = null) {
  const [info, setInfo] = useState(null);
  const [picked, setPicked] = useState(() => (view ? viewTranslation(view) : ''));
  useEffect(() => {
    let live = true;
    const load = () => bibleInfo().then((i) => live && setInfo(i));
    load();
    window.addEventListener('noteapp:bible-changed', load);
    return () => { live = false; window.removeEventListener('noteapp:bible-changed', load); };
  }, []);
  const translations = info?.translations ?? [];
  const tr = translations.some((t) => t.id === picked) ? picked : info?.favorite ?? '';
  const pick = (id) => {
    setPicked(id);
    if (view) setViewTranslation(view, id === info?.favorite ? '' : id);
  };
  return {
    connected: info ? translations.length > 0 : null,
    translations,
    tr,
    label: translations.find((t) => t.id === tr)?.label ?? 'Bible',
    pick,
  };
}

/** A small translation menu for a view (nothing when only one translation is connected). */
export function TranslationPicker({ bible, className = '' }) {
  if (bible.translations.length < 2) return null;
  return (
    <select className={`input tr-picker ${className}`} value={bible.tr} onChange={(e) => bible.pick(e.target.value)} aria-label="Translation" title="Translation">
      {bible.translations.map((t) => <option key={t.id} value={t.id} title={t.name}>{t.label}</option>)}
    </select>
  );
}

/** The credit under a passage's text (its translation, linked; API.Bible too when it came from there). */
export function Credit({ passage, className = 'passage-credit' }) {
  if (!passage) return null;
  return <p className={className} dangerouslySetInnerHTML={{ __html: creditHtml(passage) }} />;
}
