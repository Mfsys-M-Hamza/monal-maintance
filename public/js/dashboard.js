/* Dashboard charts (Chart.js). One measure per chart — no dual axes. */
(function () {
  'use strict';
  const el = document.getElementById('dash-data');
  if (!el || !window.Chart) return;
  const d = JSON.parse(el.textContent);
  const TEAL = '#0f8b8d', NAVY = '#0f2a4a';
  // Validated categorical slots 1–2 for the two-series bill chart.
  const SITE = '#2a78d6', ACCOM = '#eb6834';
  const GRID = '#e8edf3', INK = '#4a5a6e';
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  Chart.defaults.font.family = '"Segoe UI", system-ui, -apple-system, Roboto, Arial, sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = INK;
  Chart.defaults.animation = reduced ? false : { duration: 350 };
  Chart.defaults.plugins.tooltip.backgroundColor = NAVY;
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 6;
  Chart.defaults.maintainAspectRatio = false;

  const nf = (dp) => (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: dp });
  const scales = (unit, opts = {}) => ({
    x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 14, maxTicksLimit: window.innerWidth < 600 ? 5 : 8 }, ...(opts.x || {}) },
    y: { beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { callback: nf(0) }, title: { display: !!unit, text: unit }, ...(opts.y || {}) },
  });
  const tooltip = (unit, dp = 2) => ({ callbacks: { label: (c) => `${c.dataset.label}: ${nf(dp)(c.parsed.y ?? c.parsed.x)} ${unit}` } });
  const empty = (arr) => !arr.some((v) => v > 0);

  function noData(canvas, text) {
    const box = canvas.parentElement;
    box.innerHTML = `<div class="empty">${text}</div>`;
  }

  function line(id, label, data, unit) {
    const c = document.getElementById(id);
    if (empty(data)) return noData(c, 'No recorded consumption in this period.');
    new Chart(c, {
      type: 'line',
      data: { labels: d.dates, datasets: [{ label, data, borderColor: TEAL, backgroundColor: 'rgba(15,139,141,.10)', fill: true, tension: 0.25, borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: TEAL }] },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: tooltip(unit) }, scales: scales(unit) },
    });
  }

  function bar(id, label, data, unit, color = TEAL) {
    const c = document.getElementById(id);
    if (empty(data)) return noData(c, 'No data recorded in this period.');
    new Chart(c, {
      type: 'bar',
      data: { labels: d.dates, datasets: [{ label, data, backgroundColor: color, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28 }] },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: tooltip(unit) }, scales: scales(unit) },
    });
  }

  line('ch-elec', 'Electricity', d.electricity, 'kWh');
  bar('ch-lpg', 'LPG', d.lpg, 'kg');
  bar('ch-runtime', 'Runtime', d.runtime, 'h', NAVY);
  bar('ch-diesel', 'Diesel', d.diesel, 'L');

  // Site comparison — one metric at a time (horizontal bars, sorted by value)
  const metricInfo = { kwh: ['Electricity', 'kWh'], lpg: ['LPG', 'kg'], gen: ['Generator runtime', 'h'], diesel: ['Diesel', 'L'], bills: ['Bills', 'PKR'] };
  const sc = document.getElementById('ch-sites');
  let siteChart = null;
  function drawSites(metric) {
    const rows = d.sites.slice().sort((a, b) => b[metric] - a[metric]);
    const [label, unit] = metricInfo[metric];
    const cfg = {
      type: 'bar',
      data: { labels: rows.map((r) => r.name), datasets: [{ label, data: rows.map((r) => r[metric]), backgroundColor: TEAL, borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22 }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${label}: ${nf(2)(c.parsed.x)} ${unit}` } } },
        scales: { x: { beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { callback: nf(0) }, title: { display: true, text: unit } }, y: { grid: { display: false } } } },
    };
    if (siteChart) { siteChart.data = cfg.data; siteChart.options = cfg.options; siteChart.update(); } else siteChart = new Chart(sc, cfg);
  }
  if (sc && d.sites.length) {
    drawSites('kwh');
    document.querySelectorAll('[data-site-metric]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('[data-site-metric]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', String(x === b)); });
      drawSites(b.dataset.siteMetric);
    }));
  } else if (sc) noData(sc, 'No sites in view.');

  // Monthly bills — stacked: project site vs accommodation
  const bc = document.getElementById('ch-bills');
  if (empty(d.billsSite) && empty(d.billsAccommodation)) noData(bc, 'No bills recorded for these months.');
  else new Chart(bc, {
    type: 'bar',
    data: { labels: d.months, datasets: [
      { label: 'Project site', data: d.billsSite, backgroundColor: SITE, borderRadius: 4, borderColor: '#fff', borderWidth: { top: 2 }, maxBarThickness: 40 },
      { label: 'Accommodation', data: d.billsAccommodation, backgroundColor: ACCOM, borderRadius: 4, borderColor: '#fff', borderWidth: { top: 2 }, maxBarThickness: 40 },
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end', labels: { boxWidth: 12, boxHeight: 12, useBorderRadius: true, borderRadius: 3 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: PKR ${nf(0)(c.parsed.y)}`, footer: (items) => `Total: PKR ${nf(0)(items.reduce((a, i) => a + i.parsed.y, 0))}` } } },
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, grid: { color: GRID }, border: { display: false }, ticks: { callback: nf(0) }, title: { display: true, text: 'PKR' } } },
    },
  });
})();
