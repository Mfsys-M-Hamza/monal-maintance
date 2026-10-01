/* Client-side enhancements. Every calculation shown here is repeated and enforced on the server. */
(function () {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const fmt = (n, dp = 2) => (n === null || n === undefined || !isFinite(n) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  const num = (el) => { if (!el || el.value.trim() === '') return null; const n = Number(el.value); return isFinite(n) ? n : null; };
  const round = (n, dp = 3) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

  // ---------- Navigation ----------
  const toggle = $('[data-nav-toggle]');
  const setNav = (open) => { document.body.classList.toggle('nav-open', open); if (toggle) toggle.setAttribute('aria-expanded', String(open)); };
  if (toggle) toggle.addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
  $$('[data-nav-close]').forEach((el) => el.addEventListener('click', () => setNav(false)));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setNav(false); });
  $$('[data-dismiss]').forEach((b) => b.addEventListener('click', () => b.closest('.alert').remove()));

  // ---------- Confirmation dialog for destructive actions ----------
  const dialog = $('#confirm-dialog');
  let pendingForm = null;
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.dataset.confirm && !form.dataset.confirmed) {
      e.preventDefault();
      pendingForm = form;
      $('#confirm-text').textContent = form.dataset.confirm;
      if (dialog && dialog.showModal) dialog.showModal();
      else if (window.confirm(form.dataset.confirm)) { form.dataset.confirmed = '1'; form.requestSubmit(); }
      return;
    }
    // Prevent duplicate submissions
    if (form.dataset.submitting) { e.preventDefault(); return; }
    if (form.method.toLowerCase() === 'post') {
      form.dataset.submitting = '1';
      const btn = e.submitter || $('button[type=submit]', form);
      if (btn) {
        btn.classList.add('is-loading');
        // Preserve the clicked button's name/value (e.g. "save and add another")
        if (btn.name) { const h = document.createElement('input'); h.type = 'hidden'; h.name = btn.name; h.value = btn.value; form.appendChild(h); }
        $$('button[type=submit]', form).forEach((b) => { b.disabled = true; });
      }
      setTimeout(() => { delete form.dataset.submitting; $$('button[type=submit]', form).forEach((b) => { b.disabled = false; b.classList.remove('is-loading'); }); }, 8000);
    }
  });
  if (dialog) {
    $('[data-confirm-cancel]', dialog).addEventListener('click', () => { pendingForm = null; dialog.close(); });
    $('[data-confirm-ok]', dialog).addEventListener('click', () => {
      dialog.close();
      if (pendingForm) { pendingForm.dataset.confirmed = '1'; pendingForm.requestSubmit(); }
    });
  }

  // ---------- Dependent selects (meter / generator / tank filtered by site) ----------
  function filterBySite(siteSelect) {
    const siteId = siteSelect.value;
    $$(`[data-site-filtered="${siteSelect.name}"]`).forEach((sel) => {
      let keep = false;
      $$('option', sel).forEach((o) => {
        if (!o.value) return;
        const show = !siteId || o.dataset.site === siteId;
        o.hidden = !show; o.disabled = !show;
        if (show && o.selected) keep = true;
      });
      if (!keep) sel.value = '';
      const visible = $$('option', sel).filter((o) => o.value && !o.hidden);
      if (visible.length === 1 && !sel.value) sel.value = visible[0].value;
      sel.dispatchEvent(new Event('change'));
    });
  }
  $$('select[data-site-source]').forEach((s) => { s.addEventListener('change', () => filterBySite(s)); filterBySite(s); });

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Request failed');
    return r.json();
  }

  function notice(el, html, kind) {
    if (!el) return;
    el.innerHTML = html || '';
    el.className = html ? `alert alert-${kind || 'warn'}` : '';
    el.hidden = !html;
  }

  // ---------- Electricity form ----------
  const elec = $('form[data-form="electricity"]');
  if (elec) {
    const meter = $('[name=meter_id]', elec), date = $('[name=record_date]', elec), cur = $('[name=current_reading]', elec);
    const prevOut = $('#prev-reading'), consOut = $('#consumption'), box = $('#calc-box'), info = $('#entry-notice'), srcOut = $('#prev-source');
    let prev = null, pre = 0;
    const recalc = () => {
      const c = num(cur);
      prevOut.textContent = prev === null ? '—' : fmt(prev);
      if (prev === null || c === null) { consOut.textContent = '—'; box.classList.remove('bad'); return; }
      const v = round(c - prev + pre);
      consOut.textContent = `${fmt(v)} kWh`;
      box.classList.toggle('bad', c < prev);
      if (c < prev) consOut.textContent = 'Current reading is lower than previous';
    };
    const load = async () => {
      if (!meter.value || !date.value) { prev = null; recalc(); return; }
      try {
        const q = new URLSearchParams({ meter: meter.value, date: date.value });
        if (elec.dataset.recordId) q.set('exclude', elec.dataset.recordId);
        const d = await getJson(`/api/electricity/previous?${q}`);
        prev = d.previous; pre = d.preEventKwh || 0;
        srcOut.textContent = d.source.type === 'reading' ? `from reading on ${d.source.date}` : d.source.type === 'event' ? `new baseline after meter ${d.source.eventType} on ${d.source.date}` : `meter initial reading (${d.source.date})`;
        if (pre) srcOut.textContent += ` · includes ${fmt(pre)} kWh from the replaced/reset meter`;
        const msgs = [];
        if (d.duplicateId) msgs.push(`A reading already exists for this meter on this date. <a href="/electricity/${d.duplicateId}">View it</a>.`);
        if (d.locked) msgs.push('This date is in a locked reporting period.');
        notice(info, msgs.join(' '), d.locked ? 'error' : 'warn');
      } catch (e) { prev = null; notice(info, e.message, 'error'); }
      recalc();
    };
    [meter, date].forEach((el) => el.addEventListener('change', load));
    cur.addEventListener('input', recalc);
    load();
  }

  // ---------- Stock forms (LPG / diesel) ----------
  const stock = $('form[data-form="stock"]');
  if (stock) {
    const open = $('[name=opening]', stock), rec = $('[name=received]', stock), close = $('[name=closing]', stock), date = $('[name=record_date]', stock);
    const scope = $(`[name=${stock.dataset.scope}]`, stock);
    const out = $('#consumed'), box = $('#calc-box'), info = $('#entry-notice'), hint = $('#opening-hint');
    let expected = null;
    let openingTouched = !!open.value && !!stock.dataset.recordId;
    open.addEventListener('input', () => { openingTouched = true; recalc(); });
    const unitText = () => (stock.dataset.unit || '');
    const recalc = () => {
      const o = num(open), r = num(rec) || 0, c = num(close);
      if (o === null || c === null) { out.textContent = '—'; box.classList.remove('bad'); return; }
      const v = round(o + r - c);
      box.classList.toggle('bad', v < 0);
      out.textContent = v < 0 ? 'Invalid: closing exceeds opening + received' : `${fmt(v)} ${unitText()}`;
      const mismatch = expected !== null && round(o) !== round(expected);
      $('#mismatch-note').hidden = !mismatch;
    };
    const load = async () => {
      if (!scope.value || !date.value) return;
      try {
        const url = stock.dataset.kind === 'lpg' ? `/api/lpg/suggest?site=${scope.value}&date=${date.value}` : `/api/diesel/suggest?tank=${scope.value}&date=${date.value}`;
        const d = await getJson(url);
        if (stock.dataset.kind === 'lpg') {
          stock.dataset.unit = d.unit === 'kg' ? 'kg' : 'cylinders';
          $$('[data-unit-label]', stock).forEach((el) => { el.textContent = d.unit === 'kg' ? 'kg' : 'cylinders'; });
          $('#unit-note').textContent = d.unit === 'kg' ? 'This site records LPG in kilograms.' : `This site records LPG in cylinders (net ${d.cylinder_kg} kg per cylinder). Enter cylinder counts, not kilograms.`;
        }
        expected = d.opening;
        if (d.opening !== null) {
          hint.textContent = `Carried forward from closing stock on ${d.previousDate}.`;
          if (!openingTouched) open.value = d.opening;
        } else {
          hint.textContent = 'No previous record — enter the opening stock.';
        }
        const msgs = [];
        if (d.duplicateId && String(d.duplicateId) !== stock.dataset.recordId) msgs.push(`A record already exists for this date. <a href="/${stock.dataset.kind}/${d.duplicateId}">View it</a>.`);
        if (d.locked) msgs.push('This date is in a locked reporting period.');
        notice(info, msgs.join(' '), d.locked ? 'error' : 'warn');
      } catch (e) { notice(info, e.message, 'error'); }
      recalc();
    };
    [rec, close].forEach((el) => el.addEventListener('input', recalc));
    [scope, date].forEach((el) => el.addEventListener('change', () => { if (!stock.dataset.recordId) openingTouched = false; load(); }));
    load();
  }

  // ---------- Generator session form ----------
  const gen = $('form[data-form="generator"]');
  if (gen) {
    const s = $('[name=start_at]', gen), e = $('[name=stop_at]', gen), ho = $('[name=opening_hour_meter]', gen), hc = $('[name=closing_hour_meter]', gen);
    const out = $('#runtime'), note = $('#runtime-note'), box = $('#calc-box');
    const recalc = () => {
      if (!s.value) { out.textContent = '—'; return; }
      if (!e.value) { out.textContent = 'Running'; note.textContent = 'Leave stop time empty while the generator is running; stop the session later.'; box.classList.remove('bad'); return; }
      const ms = Date.parse(e.value + ':00+05:00') - Date.parse(s.value + ':00+05:00');
      box.classList.toggle('bad', ms <= 0);
      if (ms <= 0) { out.textContent = 'Stop must be after start'; note.textContent = ''; return; }
      const h = ms / 3600000;
      out.textContent = `${fmt(h)} h (${Math.floor(h)}h ${Math.round((h % 1) * 60)}m)`;
      const days = s.value.slice(0, 10) !== e.value.slice(0, 10);
      let txt = days ? 'Crosses midnight — hours will be allocated to each date in daily reports.' : '';
      const o = num(ho), c = num(hc);
      if (o !== null && c !== null) txt += ` Hour-meter: ${fmt(c - o)} h.`;
      note.textContent = txt;
    };
    [s, e, ho, hc].forEach((el) => el && el.addEventListener('input', recalc));
    recalc();
    const now = $('[data-set-now]', gen);
    if (now) now.addEventListener('click', () => { e.value = now.dataset.setNow; recalc(); });
  }

  // ---------- Bill form ----------
  const bill = $('form[data-form="bill"]');
  if (bill) {
    const amt = $('[name=amount_pkr]', bill), paid = $('[name=amount_paid]', bill), out = $('#outstanding'), st = $('#pay-status');
    const meter = $('[name=meter_id]', bill), acct = $('[name=account_ref]', bill);
    const recalc = () => {
      const a = num(amt) || 0, p = num(paid) || 0;
      out.textContent = `PKR ${fmt(a - p)}`;
      st.textContent = p <= 0 ? 'Unpaid' : p < a ? 'Partially Paid' : p > a ? 'Paid amount exceeds bill' : 'Paid';
      $('#calc-box').classList.toggle('bad', p > a);
    };
    [amt, paid].forEach((el) => el.addEventListener('input', recalc));
    if (meter && acct) meter.addEventListener('change', () => {
      const o = meter.selectedOptions[0];
      if (o && o.dataset.account && !acct.value) acct.value = o.dataset.account;
      const cat = $('#bill-category');
      if (cat) cat.textContent = o && o.value ? (o.dataset.location === 'site' ? 'Project site' : 'Accommodation') : '—';
    });
    const month = $('[name=billing_month]', bill), ps = $('[name=period_start]', bill), pe = $('[name=period_end]', bill);
    if (month && !bill.dataset.recordId) month.addEventListener('change', () => {
      if (!/^\d{4}-\d{2}$/.test(month.value)) return;
      const [y, m] = month.value.split('-').map(Number);
      ps.value = `${month.value}-01`;
      pe.value = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    });
    recalc();
  }

  // ---------- Report filter: show daily vs monthly fields ----------
  const rf = $('form[data-form="report"]');
  if (rf) {
    const kind = $$('[name=kind]', rf);
    const sync = () => {
      const k = (kind.find((r) => r.checked) || {}).value || 'daily';
      rf.action = `/reports/${k}`;
      kind.forEach((r) => r.parentElement.classList.toggle('active', r.checked));
      $$('[data-kind]', rf).forEach((el) => { el.hidden = el.dataset.kind !== k; $$('input', el).forEach((i) => { i.disabled = el.dataset.kind !== k; }); });
    };
    kind.forEach((r) => r.addEventListener('change', sync));
    sync();
  }

  // ---------- Auto-submit filters ----------
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form.requestSubmit()));
})();
