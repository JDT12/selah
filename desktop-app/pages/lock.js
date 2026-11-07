const $ = (id) => document.getElementById(id);
const d = window.selahDesktop;
const msg = (e) => e?.message?.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') ?? String(e);
$('pin').addEventListener('input', () => { $('pin').value = $('pin').value.replace(/\D/g, ''); });
$('form').onsubmit = async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  try {
    if (!(await d.unlockPin($('pin').value))) { $('error').textContent = 'That PIN isn’t right.'; $('pin').select(); }
  } catch (err) { $('error').textContent = msg(err); }
};
const tryHello = async () => {
  $('error').textContent = '';
  try { if (!(await d.unlockHello())) $('error').textContent = 'Windows Hello didn’t unlock it. Use your PIN.'; } catch (err) { $('error').textContent = msg(err); }
};
d.lockInfo().then((i) => { if (i.hello) { $('hello').hidden = false; $('hello').onclick = tryHello; tryHello(); } });
