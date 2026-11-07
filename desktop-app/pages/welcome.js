const $ = (id) => document.getElementById(id);
const fail = (e) => { $('error').textContent = e?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') ?? String(e); };
$('offline').onclick = async () => {
  $('offline').disabled = true;
  $('error').textContent = '';
  document.querySelector('#offline strong').textContent = 'Setting up your library…';
  try { await window.selahDesktop.firstRun({ mode: 'offline' }); } catch (e) { fail(e); $('offline').disabled = false; }
};
$('connect').onclick = () => { $('choices').hidden = true; $('server').hidden = false; $('url').focus(); };
$('back').onclick = () => { $('choices').hidden = false; $('server').hidden = true; };
$('server').onsubmit = async (e) => {
  e.preventDefault();
  try { await window.selahDesktop.firstRun({ mode: 'connect', server: $('url').value }); } catch (err) { fail(err); }
};
