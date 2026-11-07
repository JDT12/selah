// The copyright notices the publishers ask for wherever their text is quoted (server/esv.js, server/bible.js), and
// which translations a note quotes, so a Word document or a WordPress post can end with the right notices.

export const ESV_COPYRIGHT = 'Scripture quotations are from the ESV® Bible (The Holy Bible, English Standard Version®), © 2001 by '
  + 'Crossway, a publishing ministry of Good News Publishers. Used by permission. All rights reserved.';

export const NLT_COPYRIGHT = 'Scripture quotations marked NLT are taken from the Holy Bible, New Living Translation, copyright © 1996, '
  + '2004, 2015 by Tyndale House Foundation. Used by permission of Tyndale House Publishers, Carol Stream, Illinois 60188. '
  + 'All rights reserved.';

const BUILT_IN = { ESV: ESV_COPYRIGHT, NLT: NLT_COPYRIGHT };

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The copyright notices for the translations `text` quotes, in the order first quoted. A quotation is marked the way
 * Selah inserts it: "— John 3:16 (ESV)", "… loved the world” (John 3:16 NLT)" or a bare "(KJV)".
 * `translations`: [{ label, copyright }] (the connected ones); the ESV and NLT are known even when not connected.
 */
export function quotedCopyrights(text, translations = []) {
  const notices = new Map(Object.entries(BUILT_IN));
  for (const t of translations) if (t.label && t.copyright) notices.set(t.label, t.copyright);
  const found = [];
  for (const [label, notice] of notices) {
    const at = text.search(new RegExp(`\\((?:[^()]{0,80}\\s)?${escapeRe(label)}\\)`));
    if (at >= 0) found.push({ at, notice });
  }
  return [...new Set(found.sort((a, b) => a.at - b.at).map((f) => f.notice))];
}
