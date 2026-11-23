(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  const state = {
    weekStart: startOfWeek(new Date()),
    students: [],
    entries: [],
    settings: null,
    expanded: new Set(),
    editingEntry: null,
  };

  /* ---------------- utilities ---------------- */

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function startOfWeek(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
    return x;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function sameDay(a, b) { return a.toDateString() === b.toDateString(); }
  function dayIndex(iso) { return Math.floor((startOfDayMs(new Date(iso)) - state.weekStart.getTime()) / 864e5 + 0.5); }
  function startOfDayMs(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }

  const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtDate = (d) => new Date(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const fmtHours = (h) => (h ? h.toFixed(2) : '—');
  const entryHours = (e) => (e.clock_out ? (new Date(e.clock_out) - new Date(e.clock_in)) / 36e5 : 0);
  const isMissingOut = (e) => !e.clock_out && !sameDay(new Date(e.clock_in), new Date());
  const isOnClock = (e) => !e.clock_out && sameDay(new Date(e.clock_in), new Date());

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast${isError ? ' error' : ''}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3500);
  }

  /* ---------------- auth ---------------- */

  function showLogin() {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-password').focus();
  }

  async function showApp() {
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    await Promise.all([loadSettings(), loadStudents()]);
    await loadReport();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api('POST', '/api/admin/login', { password: $('#login-password').value });
      $('#login-password').value = '';
      showApp();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    await api('POST', '/api/admin/logout').catch(() => {});
    showLogin();
  });

  $('#logout-all').addEventListener('click', async () => {
    if (!confirm('Sign out of admin on every device, including this one?')) return;
    await api('POST', '/api/admin/logout-all').catch(() => {});
    showLogin();
  });

  /* ---------------- tabs ---------------- */

  $$('.tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      $$('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab').forEach((t) => (t.hidden = t.id !== `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'report') loadReport();
      if (b.dataset.tab === 'students') loadStudents();
    })
  );

  /* ---------------- report ---------------- */

  async function loadReport() {
    const from = state.weekStart;
    const to = addDays(from, 7);
    $('#week-label').textContent = `${fmtDate(from)} – ${fmtDate(addDays(to, -1))}, ${addDays(to, -1).getFullYear()}`;
    try {
      state.entries = await api('GET', `/api/admin/entries?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      renderReport();
    } catch (ex) { toast(ex.message, true); }
  }

  function renderReport() {
    const days = DAY_NAMES.map((_, i) => addDays(state.weekStart, i));
    const byStudent = new Map();
    for (const s of state.students) {
      if (s.active) byStudent.set(s.id, { id: s.id, name: s.name, entries: [] });
    }
    for (const e of state.entries) {
      if (!byStudent.has(e.student_id)) byStudent.set(e.student_id, { id: e.student_id, name: e.student_name, entries: [] });
      byStudent.get(e.student_id).entries.push(e);
    }
    const rows = [...byStudent.values()].sort((a, b) => a.name.localeCompare(b.name));

    let grandTotal = 0, missing = 0, edited = 0, studentsWithHours = 0;

    let html = `<thead><tr><th>Student</th>${days
      .map((d, i) => `<th class="num">${DAY_NAMES[i]}<br><span class="muted small">${d.getMonth() + 1}/${d.getDate()}</span></th>`)
      .join('')}<th class="num">Total</th><th>Flags</th></tr></thead><tbody>`;

    for (const r of rows) {
      const perDay = Array(7).fill(0);
      const flagsByDay = Array(7).fill('');
      let total = 0;
      for (const e of r.entries) {
        const i = dayIndex(e.clock_in);
        const h = entryHours(e);
        if (i >= 0 && i < 7) {
          perDay[i] += h;
          if (isMissingOut(e)) flagsByDay[i] = 'missing';
          else if (isOnClock(e) && !flagsByDay[i]) flagsByDay[i] = 'live';
        }
        total += h;
      }
      const nMissing = r.entries.filter(isMissingOut).length;
      const nEdited = r.entries.filter((e) => e.edited_at).length;
      grandTotal += total; missing += nMissing; edited += nEdited;
      if (total > 0) studentsWithHours++;

      const flags = [
        nMissing ? `<span class="tag danger">${nMissing} missing clock-out</span>` : '',
        nEdited ? `<span class="tag">${nEdited} edited</span>` : '',
      ].join(' ');
      const open = state.expanded.has(r.id);

      html += `<tr class="student-row${open ? ' open' : ''}" data-student="${r.id}" tabindex="0">
        <td><span class="caret">${open ? '▾' : '▸'}</span> ${esc(r.name)}</td>
        ${perDay.map((h, i) => `<td class="num ${flagsByDay[i]}">${flagsByDay[i] === 'missing' ? '⚠ ' : flagsByDay[i] === 'live' ? '● ' : ''}${fmtHours(h)}</td>`).join('')}
        <td class="num total">${fmtHours(total)}</td>
        <td>${flags}</td>
      </tr>`;

      html += `<tr class="detail-row${open ? '' : ' collapsed'}"><td colspan="10">${renderEntries(r)}</td></tr>`;
    }
    if (!rows.length) html += `<tr><td colspan="10" class="empty">No students yet. Add some on the Students tab.</td></tr>`;
    html += `</tbody>`;
    $('#report-table').innerHTML = html;

    $('#stats').innerHTML = `
      <div class="stat"><span>${grandTotal.toFixed(2)}</span>Total hours</div>
      <div class="stat"><span>${studentsWithHours}</span>Students with hours</div>
      <div class="stat ${missing ? 'warn' : ''}"><span>${missing}</span>Missing clock-outs</div>
      <div class="stat"><span>${edited}</span>Edited entries</div>`;

    const live = state.students.filter((s) => s.open_since && sameDay(new Date(s.open_since), new Date()));
    $('#on-clock').innerHTML = live.length
      ? `<strong>Clocked in now:</strong> ${live.map((s) => `<span class="chip">${esc(s.name)} <span class="muted">since ${fmtTime(s.open_since)}</span></span>`).join('')}`
      : '';
  }

  function renderEntries(r) {
    if (!r.entries.length) {
      return `<div class="entries"><p class="muted">No entries this week.</p>
        <button class="btn-link" data-add-for="${r.id}">+ Add entry for ${esc(r.name)}</button></div>`;
    }
    return `<div class="entries"><table class="entries-table">
      <thead><tr><th>Date</th><th>In</th><th>Out</th><th class="num">Hours</th><th>Note</th><th></th></tr></thead>
      <tbody>${r.entries.map((e) => `
        <tr class="${isMissingOut(e) ? 'missing' : ''}">
          <td>${fmtDate(e.clock_in)}</td>
          <td>${fmtTime(e.clock_in)}</td>
          <td>${e.clock_out ? fmtTime(e.clock_out) + (sameDay(new Date(e.clock_in), new Date(e.clock_out)) ? '' : ` <span class="muted small">(${fmtDate(e.clock_out)})</span>`)
            : isMissingOut(e) ? '<span class="tag danger">missing</span>' : '<span class="tag live">on clock</span>'}</td>
          <td class="num">${fmtHours(entryHours(e))}</td>
          <td>${esc(e.note || '')} ${e.edited_at ? '<span class="tag" title="Changed by admin">edited</span>' : ''}</td>
          <td class="actions"><button class="btn-link" data-edit="${e.id}">Edit</button></td>
        </tr>`).join('')}
      </tbody></table>
      <button class="btn-link" data-add-for="${r.id}">+ Add entry for ${esc(r.name)}</button></div>`;
  }

  $('#report-table').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit]');
    if (edit) return openEntryDialog(state.entries.find((x) => x.id === Number(edit.dataset.edit)));
    const add = e.target.closest('[data-add-for]');
    if (add) return openEntryDialog(null, Number(add.dataset.addFor));
    const row = e.target.closest('.student-row');
    if (row) toggleRow(Number(row.dataset.student));
  });
  $('#report-table').addEventListener('keydown', (e) => {
    const row = e.target.closest('.student-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleRow(Number(row.dataset.student)); }
  });
  function toggleRow(id) {
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    renderReport();
  }

  $('#week-prev').addEventListener('click', () => { state.weekStart = addDays(state.weekStart, -7); loadReport(); });
  $('#week-next').addEventListener('click', () => { state.weekStart = addDays(state.weekStart, 7); loadReport(); });
  $('#week-today').addEventListener('click', () => { state.weekStart = startOfWeek(new Date()); loadReport(); });
  $('#add-entry').addEventListener('click', () => openEntryDialog(null));
  $('#print').addEventListener('click', () => window.print());

  $('#export-csv').addEventListener('click', () => {
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['Student', 'Date', 'Clock In', 'Clock Out', 'Hours', 'Note', 'Edited By Admin'].map(q).join(',')];
    const totals = new Map();
    for (const e of state.entries) {
      const h = entryHours(e);
      totals.set(e.student_name, (totals.get(e.student_name) || 0) + h);
      lines.push([
        e.student_name,
        new Date(e.clock_in).toLocaleDateString(),
        fmtTime(e.clock_in),
        e.clock_out ? fmtTime(e.clock_out) : (isMissingOut(e) ? 'MISSING' : 'ON CLOCK'),
        h.toFixed(2),
        e.note || '',
        e.edited_at ? 'yes' : '',
      ].map(q).join(','));
    }
    lines.push('', ['Student', 'Weekly Total Hours'].map(q).join(','));
    for (const [name, h] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) lines.push([name, h.toFixed(2)].map(q).join(','));

    const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `timesheet-${toLocalInput(state.weekStart.toISOString()).slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  /* ---------------- entry dialog ---------------- */

  const dlg = $('#entry-dialog');
  const form = $('#entry-form');

  function openEntryDialog(entry, studentId) {
    state.editingEntry = entry || null;
    $('#entry-dialog-title').textContent = entry ? 'Edit entry' : 'Add entry';
    $('#entry-delete').hidden = !entry;
    $('#entry-error').hidden = true;
    const sel = form.student_id;
    sel.innerHTML = state.students
      .map((s) => `<option value="${s.id}">${esc(s.name)}${s.active ? '' : ' (inactive)'}</option>`).join('');
    sel.disabled = !!entry;
    if (entry) {
      sel.value = entry.student_id;
      form.clock_in.value = toLocalInput(entry.clock_in);
      form.clock_out.value = toLocalInput(entry.clock_out);
      form.note.value = entry.note || '';
    } else {
      if (studentId) sel.value = studentId;
      // Default to a weekday in the shown week at 8:00–15:00.
      const today = new Date();
      const base = today >= state.weekStart && today < addDays(state.weekStart, 7) ? today : state.weekStart;
      const d = new Date(base); d.setHours(8, 0, 0, 0);
      const o = new Date(base); o.setHours(15, 0, 0, 0);
      form.clock_in.value = toLocalInput(d.toISOString());
      form.clock_out.value = toLocalInput(o.toISOString());
      form.note.value = '';
    }
    dlg.showModal();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      clock_in: fromLocalInput(form.clock_in.value),
      clock_out: fromLocalInput(form.clock_out.value),
      note: form.note.value.trim(),
    };
    try {
      if (state.editingEntry) await api('PUT', `/api/admin/entries/${state.editingEntry.id}`, body);
      else {
        body.student_id = Number(form.student_id.value);
        state.expanded.add(body.student_id);
        await api('POST', '/api/admin/entries', body);
      }
      dlg.close();
      toast('Entry saved');
      await loadStudents();
      await loadReport();
    } catch (ex) {
      $('#entry-error').textContent = ex.message;
      $('#entry-error').hidden = false;
    }
  });

  $('#entry-cancel').addEventListener('click', () => dlg.close());
  $('#entry-delete').addEventListener('click', async () => {
    if (!state.editingEntry || !confirm('Delete this entry? This cannot be undone.')) return;
    try {
      await api('DELETE', `/api/admin/entries/${state.editingEntry.id}`);
      dlg.close();
      toast('Entry deleted');
      await loadStudents();
      await loadReport();
    } catch (ex) { toast(ex.message, true); }
  });

  /* ---------------- students ---------------- */

  async function loadStudents() {
    try {
      state.students = await api('GET', '/api/admin/students');
      renderStudents();
    } catch (ex) { toast(ex.message, true); }
  }

  function renderStudents() {
    const active = state.students.filter((s) => s.active).length;
    $('#student-count').textContent = `(${active} active${state.students.length > active ? `, ${state.students.length - active} inactive` : ''})`;
    $('#students-table').innerHTML = `<thead><tr><th>Name</th><th>PIN</th><th>Status</th><th></th></tr></thead><tbody>${
      state.students.map((s) => `
        <tr class="${s.active ? '' : 'inactive'}">
          <td>${esc(s.name)}</td>
          <td><code>${esc(s.pin)}</code></td>
          <td>${!s.active ? '<span class="tag">inactive</span>'
            : s.open_since ? (sameDay(new Date(s.open_since), new Date())
              ? `<span class="tag live">on clock since ${fmtTime(s.open_since)}</span>`
              : '<span class="tag danger">missing clock-out</span>') : ''}</td>
          <td class="actions">
            <button class="btn-link" data-act="rename" data-id="${s.id}">Rename</button>
            <button class="btn-link" data-act="pin" data-id="${s.id}">Set PIN</button>
            <button class="btn-link" data-act="newpin" data-id="${s.id}">New PIN</button>
            <button class="btn-link" data-act="toggle" data-id="${s.id}">${s.active ? 'Deactivate' : 'Reactivate'}</button>
            <button class="btn-link danger" data-act="delete" data-id="${s.id}">Delete</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="4" class="empty">No students yet.</td></tr>'
    }</tbody>`;
  }

  $('#students-table').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const s = state.students.find((x) => x.id === Number(b.dataset.id));
    try {
      switch (b.dataset.act) {
        case 'rename': {
          const name = prompt('New name:', s.name);
          if (!name || name === s.name) return;
          await api('PUT', `/api/admin/students/${s.id}`, { name });
          break;
        }
        case 'pin': {
          const pin = prompt(`New PIN for ${s.name} (4–8 digits):`, s.pin);
          if (!pin || pin === s.pin) return;
          await api('PUT', `/api/admin/students/${s.id}`, { pin });
          break;
        }
        case 'newpin': {
          if (!confirm(`Give ${s.name} a new random PIN? Their old PIN will stop working.`)) return;
          const r = await api('PUT', `/api/admin/students/${s.id}`, { regeneratePin: true });
          toast(`${s.name}'s new PIN is ${r.pin}`);
          break;
        }
        case 'toggle':
          await api('PUT', `/api/admin/students/${s.id}`, { active: !s.active });
          break;
        case 'delete':
          if (!confirm(`Permanently delete ${s.name} AND all of their time entries?\n\nTip: use "Deactivate" instead to keep their history.`)) return;
          await api('DELETE', `/api/admin/students/${s.id}`);
          break;
      }
      await loadStudents();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#add-student').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('POST', '/api/admin/students', { name: f.name.value, pin: f.pin.value.trim() || undefined });
      toast(`Added ${r.name} with PIN ${r.pin}`);
      f.reset();
      await loadStudents();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#bulk-students').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const names = f.names.value.split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
    try {
      const r = await api('POST', '/api/admin/students/bulk', { names });
      toast(`Added ${r.created.length} students`);
      f.reset();
      await loadStudents();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#print-pins').addEventListener('click', () => {
    const list = state.students.filter((s) => s.active);
    if (!list.length) return toast('Add some students first.');
    const w = window.open('', '_blank');
    if (!w) return toast('Allow pop-ups to print the PIN slips.', true);
    try {
      const title = esc(state.settings?.title || 'Time Clock');
      const url = esc(location.origin);
      const slips = list.map((s) => `
        <div class="slip">
          <h3>${esc(s.name)}</h3>
          <p>Open <b>${url}</b> and enter your PIN to clock in or out.</p>
          <div class="codes"><div><small>PIN</small><b>${esc(s.pin)}</b></div></div>
          <p class="fine">Keep your PIN private. It is how the app knows it's you.</p>
        </div>`).join('');
      w.document.write(`<!doctype html><title>${title} PIN slips</title>
        <style>
          body{font:13px system-ui;margin:16px}
          .grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
          .slip{border:1px dashed #999;padding:14px 16px;break-inside:avoid}
          h3{margin:0 0 6px;font-size:16px} p{margin:3px 0}
          .codes{display:flex;gap:24px;margin:8px 0}
          .codes small{display:block;color:#666} .codes b{font:700 20px ui-monospace,monospace;letter-spacing:.08em}
          .fine{color:#666;font-size:11px}
        </style>
        <h2>${title}: PINs</h2><div class="grid">${slips}</div>`);
      w.document.close();
      w.focus();
      w.print();
    } catch (ex) {
      w.close();
      toast(ex.message, true);
    }
  });

  /* ---------------- settings ---------------- */

  async function loadSettings() {
    try {
      state.settings = await api('GET', '/api/admin/settings');
      fillSettings();
    } catch (ex) { toast(ex.message, true); }
  }

  function fillSettings() {
    const s = state.settings;
    const f = $('#settings-form');
    f.title.value = s.title;
    f.timezone.value = s.timezone;
    $('#app-title').textContent = `${s.title} · Admin`;
  }

  try {
    const zones = Intl.supportedValuesOf?.('timeZone') || [];
    $('#tz-list').innerHTML = zones.map((z) => `<option value="${esc(z)}">`).join('');
  } catch { /* older browsers */ }

  $('#use-browser-tz').addEventListener('click', () => {
    $('#settings-form').timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  });

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      state.settings = await api('PUT', '/api/admin/settings', {
        title: f.title.value,
        timezone: f.timezone.value.trim(),
      });
      fillSettings();
      toast('Settings saved');
    } catch (ex) { toast(ex.message, true); }
  });

  /* ---------------- boot ---------------- */

  api('GET', '/api/admin/me')
    .then((r) => (r.signedIn ? showApp() : showLogin()))
    .catch(showLogin);
})();
