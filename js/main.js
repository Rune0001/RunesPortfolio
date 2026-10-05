/* Live local clock in the hero meta bar.
   Change TIMEZONE if you're not on Asia/Dhaka — the label in
   index.html ("Bangladesh / UTC+6") needs updating to match. */

var TIMEZONE = 'Asia/Dhaka';

(function () {
  var el = document.getElementById('clock');
  if (!el) return;

  var fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit'
  });

  function tick() {
    el.textContent = fmt.format(new Date());
  }

  tick();
  setInterval(tick, 30000);
})();


/* Click-to-copy Discord tag */
(function () {
  var btn = document.getElementById('copy-discord');
  var hint = document.getElementById('copy-hint');
  if (!btn) return;

  function done(msg) {
    hint.textContent = msg;
    btn.classList.add('is-copied');
    setTimeout(function () {
      hint.textContent = 'Click to copy';
      btn.classList.remove('is-copied');
    }, 1800);
  }

  function fallback(text) {
    var t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    try { document.execCommand('copy'); done('Copied!'); } catch (e) { done('Copy failed'); }
    document.body.removeChild(t);
  }

  btn.addEventListener('click', function () {
    var text = btn.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Copied!'); }, function () { fallback(text); });
    } else {
      fallback(text);
    }
  });
})();

/* Live game stats: reads stats.json (refreshed hourly by a GitHub Action).
   The numbers already in the HTML stay as the fallback if it can't load. */
(function () {
  var nodes = document.querySelectorAll('[data-stat]');
  if (!nodes.length) return;

  function short(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  fetch('stats.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
    .then(function (data) {
      nodes.forEach(function (el) {
        var p = el.getAttribute('data-stat').split('.');
        var v = data[p[0]] && data[p[0]][p[1]];
        if (typeof v === 'number') el.textContent = short(v);
      });
    })
    .catch(function () {});
})();

/* Video start times: the #t= fragment is ignored by some browsers/hosts,
   so also seek once the video is ready. */
document.querySelectorAll('video[data-start]').forEach(function (v) {
  var start = parseFloat(v.getAttribute('data-start'));
  var done = false;
  function seek() {
    if (done || v.currentTime >= start) { done = true; return; }
    try { v.currentTime = start; done = true; } catch (e) {}
  }
  v.addEventListener('loadedmetadata', seek);
  v.addEventListener('canplay', seek);
  v.addEventListener('play', seek);
});
