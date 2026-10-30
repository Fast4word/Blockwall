/*! BlockWall v1.0.0
 *  Detects ad blockers and locks page content until the blocker is turned off.
 *  No dependencies. Exposes window.AdBlockWall.
 *
 *  Quick start:
 *    <script src="blockwall.js" data-auto data-target="#content"></script>
 *  or:
 *    <script src="blockwall.js"></script>
 *    <script>AdBlockWall.init({ target: "#content" });</script>
 */
(function (root) {
    'use strict';
  
    if (root.AdBlockWall) return;
  
    var doc = root.document;
    var currentScript = doc.currentScript;
  
    var DEFAULTS = {
      target: null,            // CSS selector of the content to lock. Default: every direct child of <body>.
      mode: 'blur',            // 'blur' keeps content visible but unreadable, 'hide' hides it completely.
      title: 'Please turn off your ad blocker',
      message: 'Ads keep this site free. Turn off your ad blocker for this site, then press the button below.',
      buttonText: "I've turned it off",
      checkingText: 'Checking\u2026',
      stillBlockedText: 'An ad blocker is still active. Turn it off for this site and try again.',
      networkCheck: true,      // Also try to load a well-known ad script. Set false if your CSP blocks outside requests.
      baitUrl: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
      recheckInterval: 15000,  // ms between automatic re-checks. 0 turns them off.
      zIndex: 2147483000,
      onDetect: null,          // called when an ad blocker is found and the wall goes up
      onClear: null            // called when the blocker is gone and the wall comes down
    };
  
    var CSS =
      'html.abw-locked,html.abw-locked body{overflow:hidden!important}' +
      '.abw-blur{filter:blur(12px) saturate(.85)!important;pointer-events:none!important;user-select:none!important}' +
      '.abw-hide{visibility:hidden!important}' +
      '.abw-overlay{position:fixed;top:0;right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:center;' +
      'padding:20px;box-sizing:border-box;background:rgba(18,22,30,.7);' +
      'font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#18202b}' +
      '.abw-overlay *{box-sizing:border-box}' +
      '.abw-card{width:100%;max-width:440px;padding:28px;border-radius:14px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.35)}' +
      '.abw-title{margin:0 0 10px;font-size:22px;line-height:1.25;font-weight:700}' +
      '.abw-msg{margin:0 0 20px;color:#3b4656}' +
      '.abw-btn{display:inline-block;padding:11px 18px;border:0;border-radius:8px;background:#2447f5;color:#fff;' +
      'font:inherit;font-weight:600;cursor:pointer}' +
      '.abw-btn:hover{background:#1b38c4}' +
      '.abw-btn:focus-visible{outline:3px solid #9db0ff;outline-offset:2px}' +
      '.abw-btn:disabled{opacity:.6;cursor:default}' +
      '.abw-status{min-height:1.5em;margin:14px 0 0;font-size:14px;color:#b3261e}';
  
    var opts = assign({}, DEFAULTS);
    var started = false;
    var locked = false;
    var pending = null;
    var overlay = null;
    var styleEl = null;
    var statusEl = null;
    var btnEl = null;
    var observer = null;
    var targets = [];
    var timer = null;
    var previousFocus = null;
    var overlayStyle = '';
    var lastSoon = 0;
  
    function assign(a, b) {
      for (var k in b) {
        if (Object.prototype.hasOwnProperty.call(b, k)) a[k] = b[k];
      }
      return a;
    }
  
    function ready(fn) {
      if (doc.readyState === 'loading') {
        doc.addEventListener('DOMContentLoaded', fn, { once: true });
      } else {
        fn();
      }
    }
  
    function emit(type, cb) {
      try {
        if (typeof cb === 'function') cb();
      } catch (e) {
        if (root.console) root.console.error(e);
      }
      try {
        doc.dispatchEvent(new root.CustomEvent('adblockwall:' + type));
      } catch (e2) { /* old browser without CustomEvent constructor */ }
    }
  
    /* ---------- Detection ---------- */
  
    // Check 1: a bait element with class names that cosmetic filters hide.
    function elementBlocked() {
      return new Promise(function (resolve) {
        if (!doc.body) { resolve(false); return; }
        var el = doc.createElement('div');
        el.className = 'adsbox ad-banner ad_unit pub_300x250 pub_728x90 text-ad textAd text_ad text_ads text-ads ad-placement';
        // No !important here: a filter's display:none!important must be able to win.
        el.setAttribute('style', 'position:absolute;left:-9999px;top:-9999px;width:300px;height:250px;pointer-events:none;');
        el.innerHTML = '&nbsp;';
        doc.body.appendChild(el);
  
        setTimeout(function () {
          var blocked = false;
          try {
            var cs = root.getComputedStyle(el);
            blocked = !el.isConnected ||
              el.offsetHeight === 0 || el.offsetWidth === 0 ||
              el.clientHeight === 0 || el.clientWidth === 0 ||
              cs.display === 'none' || cs.visibility === 'hidden';
          } catch (e) {
            blocked = false;
          }
          if (el.parentNode) el.parentNode.removeChild(el);
          resolve(blocked);
        }, 150);
      });
    }
  
    // Check 2: request a well-known ad script. Network-level blockers make this fail.
    function networkBlocked() {
      if (!opts.networkCheck || !opts.baitUrl) return Promise.resolve(false);
      if (typeof root.fetch !== 'function') return Promise.resolve(false);
      if (root.navigator && root.navigator.onLine === false) return Promise.resolve(false);
  
      var ctl = typeof root.AbortController === 'function' ? new root.AbortController() : null;
      var timedOut = false;
      var t = setTimeout(function () {
        timedOut = true;
        if (ctl) ctl.abort();
      }, 5000);
  
      var init = { method: 'GET', mode: 'no-cors' };
      if (ctl) init.signal = ctl.signal;
  
      return root.fetch(opts.baitUrl, init).then(function () {
        clearTimeout(t);
        return false;
      }, function () {
        clearTimeout(t);
        return !timedOut; // a timeout is "unknown", not "blocked"
      });
    }
  
    function detect() {
      return Promise.all([elementBlocked(), networkBlocked()]).then(function (r) {
        return !!(r[0] || r[1]);
      });
    }
  
    function check() {
      if (pending) return pending;
      pending = detect().then(function (blocked) {
        pending = null;
        setState(blocked);
        return blocked;
      }, function () {
        pending = null;
        return false;
      });
      return pending;
    }
  
    function setState(blocked) {
      if (blocked && !locked) {
        lock();
        emit('detected', opts.onDetect);
      } else if (!blocked && locked) {
        unlock();
        emit('cleared', opts.onClear);
      }
    }
  
    /* ---------- Lock ---------- */
  
    function buildOverlay() {
      var o = doc.createElement('div');
      o.className = 'abw-overlay';
      o.setAttribute('role', 'alertdialog');
      o.setAttribute('aria-modal', 'true');
      o.setAttribute('aria-labelledby', 'abw-title');
      o.setAttribute('aria-describedby', 'abw-msg');
  
      var card = doc.createElement('div');
      card.className = 'abw-card';
  
      var h = doc.createElement('h2');
      h.className = 'abw-title';
      h.id = 'abw-title';
      h.textContent = opts.title;
  
      var p = doc.createElement('p');
      p.className = 'abw-msg';
      p.id = 'abw-msg';
      p.textContent = opts.message;
  
      btnEl = doc.createElement('button');
      btnEl.type = 'button';
      btnEl.className = 'abw-btn';
      btnEl.textContent = opts.buttonText;
      btnEl.addEventListener('click', function () {
        btnEl.disabled = true;
        statusEl.textContent = opts.checkingText;
        check().then(function () {
          if (locked && btnEl) {
            statusEl.textContent = opts.stillBlockedText;
            btnEl.disabled = false;
            btnEl.focus();
          }
        });
      });
  
      statusEl = doc.createElement('p');
      statusEl.className = 'abw-status';
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
  
      card.appendChild(h);
      card.appendChild(p);
      card.appendChild(btnEl);
      card.appendChild(statusEl);
      o.appendChild(card);
      return o;
    }
  
    function getTargets() {
      var list = opts.target
        ? [].slice.call(doc.querySelectorAll(opts.target))
        : [].slice.call(doc.body.children);
      return list.filter(function (el) {
        return el !== overlay &&
          !(overlay && el.contains(overlay)) &&
          !/^(SCRIPT|STYLE|LINK|NOSCRIPT|TEMPLATE)$/.test(el.tagName) &&
          !el.hasAttribute('data-abw-ignore');
      });
    }
  
    function findRecord(el) {
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].el === el) return targets[i];
      }
      return null;
    }
  
    function applyTargets() {
      var cls = opts.mode === 'hide' ? 'abw-hide' : 'abw-blur';
      getTargets().forEach(function (el) {
        if (!findRecord(el)) {
          targets.push({
            el: el,
            hadInert: el.hasAttribute('inert'),
            aria: el.getAttribute('aria-hidden')
          });
          if (observer) observer.observe(el, { attributes: true, attributeFilter: ['class', 'inert'] });
        }
        if (!el.classList.contains(cls)) el.classList.add(cls);
        if (!el.hasAttribute('inert')) el.setAttribute('inert', '');
        if (el.getAttribute('aria-hidden') !== 'true') el.setAttribute('aria-hidden', 'true');
      });
    }
  
    // Puts the wall back if something removes or edits it.
    function guard() {
      if (!locked || !overlay) return;
      if (!styleEl.isConnected) (doc.head || doc.documentElement).appendChild(styleEl);
      if (!overlay.isConnected && doc.body) doc.body.appendChild(overlay);
      if (overlay.getAttribute('style') !== overlayStyle) overlay.setAttribute('style', overlayStyle);
      if (overlay.className !== 'abw-overlay') overlay.className = 'abw-overlay';
      if (!doc.documentElement.classList.contains('abw-locked')) doc.documentElement.classList.add('abw-locked');
      applyTargets();
    }
  
    function lock() {
      if (locked || !doc.body) return;
      locked = true;
      previousFocus = doc.activeElement;
  
      styleEl = doc.createElement('style');
      styleEl.id = 'abw-style';
      styleEl.textContent = CSS;
      (doc.head || doc.documentElement).appendChild(styleEl);
  
      overlayStyle = 'z-index:' + opts.zIndex + ';';
      overlay = buildOverlay();
      overlay.setAttribute('style', overlayStyle);
      doc.body.appendChild(overlay);
      doc.documentElement.classList.add('abw-locked');
  
      if (typeof root.MutationObserver === 'function') {
        observer = new root.MutationObserver(guard);
        observer.observe(doc.documentElement, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
        observer.observe(doc.body, { childList: true, attributes: true, attributeFilter: ['class', 'style'] });
        if (doc.head) observer.observe(doc.head, { childList: true });
        observer.observe(overlay, { attributes: true });
      }
  
      applyTargets();
      if (btnEl) btnEl.focus();
    }
  
    function unlock() {
      if (!locked) return;
      locked = false;
  
      if (observer) { observer.disconnect(); observer = null; }
  
      targets.forEach(function (rec) {
        var el = rec.el;
        el.classList.remove('abw-blur', 'abw-hide');
        if (!rec.hadInert) el.removeAttribute('inert');
        if (rec.aria === null) el.removeAttribute('aria-hidden');
        else el.setAttribute('aria-hidden', rec.aria);
      });
      targets = [];
  
      doc.documentElement.classList.remove('abw-locked');
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      overlay = null;
      styleEl = null;
      statusEl = null;
      btnEl = null;
  
      if (previousFocus && typeof previousFocus.focus === 'function') {
        try { previousFocus.focus(); } catch (e) { /* element may be gone */ }
      }
      previousFocus = null;
    }
  
    /* ---------- Public API ---------- */
  
    function soon() {
      var now = Date.now();
      if (now - lastSoon < 3000) return;
      lastSoon = now;
      check();
    }
  
    function onVisible() { if (!doc.hidden) soon(); }
    function onFocus() { soon(); }
  
    var api = {
      version: '1.0.0',
  
      // Merge options without starting anything.
      configure: function (options) {
        if (options) assign(opts, options);
        return api;
      },
  
      // Start checking: detect now, then on focus and on an interval.
      init: function (options) {
        if (started) return api;
        started = true;
        api.configure(options);
        ready(function () {
          if (!started) return;
          check();
          if (opts.recheckInterval > 0) timer = setInterval(check, opts.recheckInterval);
          doc.addEventListener('visibilitychange', onVisible);
          root.addEventListener('focus', onFocus);
        });
        return api;
      },
  
      // Resolves true if an ad blocker is detected. Changes nothing on the page.
      detect: detect,
  
      // Detects, then raises or lowers the wall to match. Resolves true if blocked.
      check: check,
  
      // Raise or lower the wall by hand (for previews). The next check() overrides it.
      lock: function () { ready(lock); return api; },
      unlock: function () { unlock(); return api; },
  
      isLocked: function () { return locked; },
  
      destroy: function () {
        started = false;
        if (timer) { clearInterval(timer); timer = null; }
        doc.removeEventListener('visibilitychange', onVisible);
        root.removeEventListener('focus', onFocus);
        unlock();
      }
    };
  
    root.AdBlockWall = api;
  
    // <script src="blockwall.js" data-auto data-target="#content"></script>
    if (currentScript && currentScript.hasAttribute('data-auto')) {
      var ds = currentScript.dataset;
      var o = {};
      ['target', 'mode', 'title', 'message', 'buttonText'].forEach(function (k) {
        if (ds[k] != null) o[k] = ds[k];
      });
      if (ds.recheckInterval != null) o.recheckInterval = Number(ds.recheckInterval) || 0;
      if (ds.networkCheck === 'false') o.networkCheck = false;
      api.init(o);
    }
  })(window);