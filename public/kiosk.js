(() => {
  const MAX_PIN = 8;
  const RESET_AFTER_MS = 6000;
  let pin = '';
  let resetTimer = null;

  const $ = (id) => document.getElementById(id);
  const views = { pin: $('pin-view'), busy: $('busy-view'), result: $('result-view') };

  function show(name) {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  }

  function fmtTime(d) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function fmtDuration(hours) {
    const mins = Math.round(hours * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h ? `${h} hr ${m} min` : `${m} min`;
  }

  function tick() {
    const d = new Date();
    $('now-time').textContent = fmtTime(d);
    $('now-date').textContent = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function renderPin() {
    const dots = $('pin-dots');
    dots.innerHTML = '';
    const count = Math.max(4, pin.length);
    for (let i = 0; i < count; i++) {
      const s = document.createElement('span');
      if (i < pin.length) s.className = 'filled';
      dots.appendChild(s);
    }
    $('submit').disabled = pin.length < 4;
  }

  function press(key) {
    if (views.pin.hidden) return;
    if (key === 'clear') pin = '';
    else if (key === 'back') pin = pin.slice(0, -1);
    else if (/^\d$/.test(key) && pin.length < MAX_PIN) pin += key;
    renderPin();
  }

  function showResult(kind, title, detail) {
    $('result-icon').className = `result-icon ${kind}`;
    $('result-icon').textContent = kind === 'error' ? '!' : '✓';
    $('result-title').textContent = title;
    $('result-detail').textContent = detail;
    show('result');
    clearTimeout(resetTimer);
    resetTimer = setTimeout(reset, kind === 'error' ? RESET_AFTER_MS * 1.5 : RESET_AFTER_MS);
  }

  function reset() {
    clearTimeout(resetTimer);
    pin = '';
    renderPin();
    show('pin');
  }

  async function submit() {
    if (pin.length < 4) return;
    const body = { pin };
    try {
      $('busy-text').textContent = 'Saving…';
      show('busy');
      const res = await fetch('/api/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');

      const t = fmtTime(new Date(data.time));
      if (data.action === 'in') {
        let detail = `Clocked in at ${t}. Have a great day!`;
        if (data.missedClockOut) detail += ' Note: you did not clock out last time. Please tell your teacher.';
        showResult('in', `Welcome, ${data.name}!`, detail);
      } else {
        showResult('out', `Goodbye, ${data.name}!`, `Clocked out at ${t}. You worked ${fmtDuration(data.hours)} today.`);
      }
    } catch (err) {
      showResult('error', 'Not recorded', err.message);
    }
  }

  document.querySelector('.keypad').addEventListener('click', (e) => {
    const k = e.target.closest('button')?.dataset.key;
    if (k) press(k);
  });
  $('submit').addEventListener('click', submit);
  $('done').addEventListener('click', reset);

  document.addEventListener('keydown', (e) => {
    if (!views.result.hidden && (e.key === 'Enter' || e.key === 'Escape')) return reset();
    if (views.pin.hidden) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('back');
    else if (e.key === 'Escape') press('clear');
    else if (e.key === 'Enter') submit();
  });

  fetch('/api/config').then((r) => r.json()).then((c) => {
    document.title = c.title;
    $('title').textContent = c.title;
  }).catch(() => {});

  tick();
  setInterval(tick, 1000);
  renderPin();
})();
