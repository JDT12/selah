/**
 * The Cornell notes layout: a header (topic, date, course or study, speaker), the cue column beside the notes, and a
 * summary across the bottom. It's three plain tables marked with data-cornell, so it saves, searches, exports and
 * posts like any table; the editor styles them as one sheet. Used by the server (the built-in template) and the
 * browser (the /cornell block).
 */

export const CORNELL_ROWS = 4;

/**
 * date: what goes in the Date field ('{{date}}' in the template, filled in when a note is made from it). A class's
 * lecture notes also fill in the topic, the course and the speaker.
 */
export function cornellHtml(date = '', { topic = '', course = '', speaker = '' } = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cell = (tag, text = '') => `<${tag}><p>${text}</p></${tag}>`;
  const head = '<table data-cornell="head"><tbody>'
    + `<tr>${cell('th', 'Topic')}${cell('td', esc(topic))}${cell('th', 'Date')}${cell('td', esc(date))}</tr>`
    + `<tr>${cell('th', 'Course or study')}${cell('td', esc(course))}${cell('th', 'Speaker')}${cell('td', esc(speaker))}</tr>`
    + '</tbody></table>';
  const rows = Array.from({ length: CORNELL_ROWS }, () => `<tr>${cell('td')}${cell('td')}</tr>`).join('');
  const notes = `<table data-cornell="notes"><tbody><tr>${cell('th', 'Cues and questions')}${cell('th', 'Notes')}</tr>${rows}</tbody></table>`;
  const summary = `<table data-cornell="summary"><tbody><tr>${cell('th', 'Summary')}</tr><tr>${cell('td')}</tr></tbody></table>`;
  return `${head}${notes}${summary}<p></p>`;
}
