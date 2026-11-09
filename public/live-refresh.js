// Background refresh never reloads the document or stores drafts on the server.
(() => {
  const interval = 5000;
  let revision = 0;
  for (const event of ['input', 'change', 'pointerdown', 'keydown', 'toggle']) {
    document.addEventListener(event, () => { revision++; }, true);
  }
  const fields = root => [...root.querySelectorAll('input,select,textarea')];
  function dirty(field) {
    if (field.type === 'file') return !!field.files?.length;
    if (['checkbox', 'radio'].includes(field.type)) return field.checked !== field.defaultChecked;
    if (field.tagName === 'SELECT') {
      const defaults = [...field.options].filter(o => o.defaultSelected).map(o => o.value);
      if (!defaults.length && field.options.length && !field.multiple) defaults.push(field.options[0].value);
      return JSON.stringify([...field.selectedOptions].map(o => o.value)) !== JSON.stringify(defaults);
    }
    return field.value !== field.defaultValue;
  }
  function ready(root) {
    if (!root || document.hidden || document.querySelector('dialog[open]')) return false;
    const active = document.activeElement;
    if (active && root.contains(active) && active.matches('input,select,textarea,[contenteditable="true"]')) return false;
    // A draft, selected file, active save, loaded preview or playing media stays intact.
    if (root.querySelector('form button:disabled,video,audio,img[src^="blob:"],img[src^="data:"],#ops-invite a')) return false;
    return !fields(root).some(f => (f.closest('form') || f.type === 'file') && dirty(f));
  }
  function key(node, root) {
    const path = [];
    for (let el = node; el && el !== root; el = el.parentElement) {
      if (el.id) { path.unshift('#' + el.id); break; }
      const attrs = [...el.attributes].filter(a => a.name.startsWith('data-') && !['data-version'].includes(a.name));
      let part = el.tagName + attrs.map(a => '[' + a.name + '=' + a.value + ']').join('');
      if (el.name) part += '[name=' + el.name + ']';
      if (el.tagName === 'DETAILS') part += ':' + (el.querySelector('summary')?.textContent || '').trim();
      if (el.tagName === 'TR') part += ':' + (el.cells?.[0]?.textContent || '').trim();
      if (el.matches('article.item,.pay-record')) part += ':' + (el.querySelector('strong')?.textContent || '').trim();
      if (!attrs.length && !el.name && !['DETAILS', 'TR'].includes(el.tagName)) {
        part += ':' + [...(el.parentElement?.children || [])].filter(n => n.tagName === el.tagName).indexOf(el);
      }
      path.unshift(part);
    }
    return path.join('/');
  }
  function preserve(root, draw) {
    const left = window.scrollX, top = window.scrollY;
    const active = document.activeElement;
    const focused = active && root.contains(active) ? key(active, root) : null;
    const nodes = [...root.querySelectorAll('details,input,select,textarea,.scroll,.table-wrap,.sidebar,.side-navigation')];
    const saved = new Map(nodes.map(el => [key(el, root), {
      open: el.tagName === 'DETAILS' ? el.open : undefined,
      value: !el.closest('form') && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? el.value : undefined,
      left: el.scrollLeft, top: el.scrollTop
    }]));
    draw();
    for (const el of root.querySelectorAll('details,input,select,textarea,.scroll,.table-wrap,.sidebar,.side-navigation')) {
      const state = saved.get(key(el, root));
      if (!state) continue;
      if (state.open !== undefined) el.open = state.open;
      if (state.value !== undefined && el.type !== 'file') el.value = state.value;
      el.scrollLeft = state.left; el.scrollTop = state.top;
    }
    if (focused) [...root.querySelectorAll('button,a,summary,input,select,textarea')].find(el => key(el, root) === focused)?.focus({preventScroll: true});
    window.scrollTo({left, top, behavior: 'instant'});
  }
  function start(task, canRun = () => true) {
    let running = false, stopped = false;
    async function tick() {
      if (stopped || running || document.hidden || !canRun()) return;
      running = true;
      try { await task(); } catch { /* Keep the last good screen during a temporary network error. */ }
      finally { running = false; }
    }
    const timer = setInterval(tick, interval);
    const visible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', tick);
    return () => { stopped = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('online', tick); };
  }
  window.LiveRefresh = {interval, ready, preserve, start, revision: () => revision};
})();
