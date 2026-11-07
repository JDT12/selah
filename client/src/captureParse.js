/**
 * Quick capture: "Call Sam about the retreat #church @Ministry" ->
 * { task: false, title: 'Call Sam about the retreat', body: '', tags: ['church'], notebook: { id, name } }.
 * The first line is the title and the rest the body. #word adds a tag, @Notebook picks the notebook (the longest
 * notebook name that follows the @, so "@Bible Study" works), and the word !task makes it a task instead (the rest
 * is then read like the Tasks quick-add: dates, !priority, #list).
 */
export function parseCapture(input, notebooks = []) {
  let text = input ?? '';
  const task = /(^|\s)!task\b/i.test(text);
  if (task) return { task: true, taskText: text.replace(/(^|\s)!task\b/i, ' ').replace(/\s{2,}/g, ' ').trim() };

  let notebook = null;
  const byLength = [...notebooks].sort((a, b) => b.name.length - a.name.length);
  text = text.replace(/(^|\s)@([^\n]+)/, (m, pre, after) => {
    const nb = byLength.find((n) => after.toLowerCase().startsWith(n.name.toLowerCase())
      && !/[\p{L}\p{N}]/u.test(after.charAt(n.name.length)));
    if (!nb || notebook) return m;
    notebook = nb;
    return `${pre}${after.slice(nb.name.length)}`;
  });

  const tags = [];
  text = text.replace(/(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_\-/]*)/gu, (m, pre, tag) => {
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag);
    return pre;
  });

  const lines = text.split('\n');
  const title = lines[0].replace(/\s{2,}/g, ' ').trim();
  const body = lines.slice(1).join('\n').trim();
  return { task: false, title, body, tags, notebook };
}
