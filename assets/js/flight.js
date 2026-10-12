/* Guilderland Family Dentistry — scroll-driven flythrough.
 *
 * Native scroll only (no hijacking). The page scrolls through a tall #tour
 * section; a sticky stage draws one frame of the image sequence on a canvas.
 * Which frame is shown comes from content/flight.json: a list of passages,
 * each mapping a scroll distance (vh) to a span of one clip (clip seconds).
 *
 * The mode (motion vs still images) is decided early by the inline script in
 * <head>; chapter stills are lazy-loaded, so a motion-mode visitor does not
 * download them. Still mode = reduced motion, Save-Data / 2G, very low memory,
 * the visitor's "Still images" choice, a failed config load, or a 10 s timeout
 * (the head script falls back if this file never sets html.flight-ready).
 */
(function () {
  "use strict";

  var root = document.documentElement;
  var tour = document.getElementById("tour");
  if (!tour) return;

  var params = new URLSearchParams(location.search);
  var DEBUG = params.has("debug");
  var PREF_KEY = "gfd-motion";

  function writePref(v) { try { localStorage.setItem(PREF_KEY, v); } catch (e) {} }

  // Motion toggles work in both modes: store the choice and reload with an explicit query
  // (a hash-only change would not reload the page).
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-motion]");
    if (!b) return;
    e.preventDefault();
    var v = b.getAttribute("data-motion");
    writePref(v);
    var u = new URL(location.href);
    u.searchParams.set("motion", v);
    u.hash = "tour";
    location.replace(u.toString());
  });

  if (!root.classList.contains("has-flight")) return; // still-image mode chosen in <head>

  var stage = tour.querySelector(".stage");
  var canvas = stage.querySelector("canvas");
  var poster = stage.querySelector(".poster");
  var loaderEl = stage.querySelector(".loader");
  var loaderBar = loaderEl && loaderEl.querySelector("i");
  var chapters = Array.prototype.slice.call(tour.querySelectorAll("[data-chapter]"));
  var railItems = Array.prototype.slice.call(tour.querySelectorAll("[data-rail]"));
  var header = document.querySelector(".site-header");
  var ctx = canvas.getContext("2d", { alpha: false });
  var CHAPTER_ORDER = ["hero", "place", "welcome", "services", "hygiene", "visit"];

  var cfg, manifest, passages = [], totalPx = 0, vh = 0, count = 0, fps = 20;
  var isMobile = null, set = null, frameW = 1280, frameH = 720;
  var cache = new Map();          // index -> {img, ready, settled}
  var queue = [];                 // indices still to request, in priority order
  var wanted = new Set();         // current priority window (never evicted)
  var inflight = 0, MAX_INFLIGHT = 6, CAP = 48, AHEAD = 28, BEHIND = 10;
  var current = { frame: 0, passage: 0, local: 0 }, lastDrawn = -1, lastDir = 1, lastY = 0;
  var rafPending = false, live = false, readyCount = 0, gen = 0, stopped = false;

  function isRunning() { return !stopped && root.classList.contains("has-flight"); }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0 || 1), 0, 1); return t * t * (3 - 2 * t); }
  function pad(n) { return ("0000" + n).slice(-4); }
  function frameURL(i) { return set.dir + "frame-" + pad(i) + ".webp?v=" + (manifest.version || "1"); }

  // ---------- frame sets (phone crop vs full frame) ----------
  function chooseSet() {
    // phones and portrait tablets get the square crop; landscape phones keep the full frame
    var mobile = window.innerWidth < 768 || window.innerHeight > window.innerWidth * 1.15;
    if (mobile === isMobile) return false;
    isMobile = mobile;
    var next = (isMobile && manifest.sets.mobile) ? manifest.sets.mobile : manifest.sets.desktop;
    if (set && next.dir === set.dir) return false;
    set = next; frameW = set.width; frameH = set.height;
    CAP = isMobile ? 30 : 48;
    AHEAD = Math.round(CAP * 0.6); BEHIND = Math.round(CAP * 0.22);
    // drop everything from the previous set
    cache.forEach(function (e) { release(e); });
    cache.clear(); queue = []; wanted = new Set(); inflight = 0; readyCount = 0; gen++;
    lastDrawn = -1;
    var p = (isMobile && manifest.sets.mobile && manifest.sets.mobile.poster) || manifest.poster;
    if (p && poster.getAttribute("src") !== p) poster.src = p;
    return true;
  }

  // ---------- layout ----------
  function measure(force) {
    var h = window.innerHeight, w = window.innerWidth;
    // Ignore small height changes (mobile URL bar) to keep scroll positions stable.
    if (!force && Math.abs(h - vh) < 120 && w === measure.w) return false;
    measure.w = w; vh = h;
    totalPx = 0;
    passages.forEach(function (p) { p.start = totalPx; p.len = Math.round(p.vh / 100 * vh); totalPx += p.len; });
    tour.style.setProperty("--tour-h", (totalPx + vh) + "px");
    sizeCanvas();
    return true;
  }

  function sizeCanvas() {
    var r = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 2.5 : 2);
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; lastDrawn = -1; }
  }

  // ---------- timeline ----------
  // Frame range of each passage, made monotonic so a passage never ends past the
  // first frame of the next one (clips overlap by the cross-fade length).
  function buildRanges() {
    passages.forEach(function (p) {
      var o = cfg.clips[p.clip].offset;
      p.f0 = clamp(Math.round((o + p.from) * fps), 0, count - 1);
      p.f1 = clamp(Math.round((o + (p.mode === "hold" ? p.from : p.to)) * fps), 0, count - 1);
    });
    for (var i = 0; i < passages.length - 1; i++) {
      var a = passages[i], b = passages[i + 1];
      if (a.f1 > b.f0) a.f1 = b.f0;
      if (a.f0 > a.f1) a.f0 = a.f1;
    }
  }

  function locate(y) {
    var i = 0;
    for (; i < passages.length - 1; i++) if (y < passages[i].start + passages[i].len) break;
    var p = passages[i];
    var local = p.len ? clamp((y - p.start) / p.len, 0, 1) : 0;
    var f = p.mode === "hold" ? p.f0 : Math.round(p.f0 + (p.f1 - p.f0) * local);
    return { passage: i, local: local, frame: f };
  }

  function chapterAlpha(p, local) {
    var a = p.textIn ? smooth(p.textIn[0], p.textIn[1], local) : 1;
    var out = p.textOut ? smooth(p.textOut[0], p.textOut[1], local) : 0;
    return { a: Math.min(a, 1 - out), leaving: out > 0 };
  }

  // The scroll position where a chapter is fully shown: the first passage of that
  // chapter, at the middle of its fully-visible window.
  function chapterTarget(id) {
    var ps = passages.filter(function (q) { return q.chapter === id; });
    if (!ps.length) return null;
    var hold = ps.filter(function (q) { return q.mode === "hold"; })[0];
    var p = hold || ps[0];
    var lo = p.textIn ? p.textIn[1] : 0, hi = p.textOut ? p.textOut[0] : 1;
    return { p: p, local: hold ? 0.5 : (lo + hi) / 2 };
  }

  function updateText(st) {
    var p = passages[st.passage];
    chapters.forEach(function (el) {
      var id = el.getAttribute("data-chapter");
      var copy = el.querySelector(".chapter-copy");
      var a = 0, leaving = false;
      if (p.chapter === id) { var r = chapterAlpha(p, st.local); a = r.a; leaving = r.leaving; }
      var y = (1 - a) * 16 * (leaving ? -1 : 1);
      copy.style.opacity = a.toFixed(3);
      copy.style.transform = "translate3d(0," + y.toFixed(1) + "px,0)";
      el.classList.toggle("is-active", a > 0.5);
      el.setAttribute("aria-hidden", String(a <= 0.5));
      el.toggleAttribute("inert", a <= 0.5);
    });
    var cur = p.chapter;
    if (!cur) { for (var k = st.passage; k >= 0; k--) if (passages[k].chapter) { cur = passages[k].chapter; break; } }
    var ci = CHAPTER_ORDER.indexOf(cur);
    railItems.forEach(function (li, idx) {
      li.classList.toggle("is-current", idx === ci);
      li.classList.toggle("is-past", idx < ci);
      var a = li.querySelector("a"); if (a) { if (idx === ci) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current"); }
    });
  }

  // ---------- frames ----------
  function release(e) {
    e.img.onload = e.img.onerror = null;   // detach first: clearing src would fire onerror
    e.img.removeAttribute("src");
  }

  function want(list) {
    wanted = new Set();
    var q = [];
    for (var k = 0; k < list.length; k++) {
      var i = list[k];
      if (i < 0 || i >= count || wanted.has(i)) continue;
      wanted.add(i);
      if (!cache.has(i)) q.push(i);
    }
    queue = q;
    pump();
  }

  function pump() {
    if (!isRunning()) return;
    while (inflight < MAX_INFLIGHT && queue.length) {
      var i = queue.shift();
      if (!cache.has(i)) load(i);
    }
  }

  function load(i) {
    var img = new Image();
    img.decoding = "async";
    var entry = { img: img, ready: false, settled: false }, g = gen;
    cache.set(i, entry);
    inflight++;
    function settle(ok) {
      if (entry.settled) return;
      entry.settled = true;
      if (g !== gen) return;               // the frame set changed while this was loading
      inflight = Math.max(0, inflight - 1);
      if (cache.get(i) !== entry) { pump(); return; } // replaced or evicted meanwhile
      if (ok) { entry.ready = true; onFrameReady(i); } else { cache.delete(i); if (!live && i === current.frame) { fail("image"); return; } }
      evict();
      pump();
    }
    img.onload = function () { if (img.decode) img.decode().then(function () { settle(true); }, function () { settle(true); }); else settle(true); };
    img.onerror = function () { settle(false); };
    img.src = frameURL(i);
  }

  function evict() {
    var ready = [];
    cache.forEach(function (e, i) { if (e.ready) ready.push(i); });
    var over = ready.length - CAP;
    if (over <= 0) return;
    var cur = current.frame;
    var drop = ready.filter(function (i) { return !wanted.has(i); });   // never drop what the current window needs
    drop.sort(function (a, b) { return Math.abs(b - cur) - Math.abs(a - cur); });
    for (var k = 0; k < drop.length && k < over; k++) { release(cache.get(drop[k])); cache.delete(drop[k]); }
  }

  function onFrameReady(i) {
    readyCount++;
    if (loaderEl && !loaderEl.classList.contains("is-done")) {
      var need = Math.max(1, Math.min(20, count, wanted.size));
      var pct = Math.min(100, Math.round(readyCount / need * 100));
      loaderBar.style.setProperty("--p", pct + "%");
      if (pct >= 100) {
        loaderEl.classList.add("is-done");
        loaderEl.setAttribute("aria-hidden", "true");
        var t = loaderEl.querySelector("span"); if (t) t.textContent = "Tour ready";
      }
    }
    if (Math.abs(i - current.frame) <= 2) schedule();
  }

  function nearestReady(f) {
    var c = cache.get(f);
    if (c && c.ready) return f;
    for (var d = 1; d < 90; d++) {
      var a = cache.get(f - d * lastDir); if (a && a.ready) return f - d * lastDir;
      var b = cache.get(f + d * lastDir); if (b && b.ready) return f + d * lastDir;
    }
    return -1;
  }

  function draw(f) {
    var idx = nearestReady(f);
    if (idx < 0 || idx === lastDrawn) return;
    var img = cache.get(idx).img;
    var cw = canvas.width, ch = canvas.height;
    var iw = img.naturalWidth || frameW, ih = img.naturalHeight || frameH;
    var s = Math.max(cw / iw, ch / ih);
    var dw = iw * s, dh = ih * s;
    var p = passages[current.passage];
    var fx = (isMobile && p && typeof p.fx === "number") ? p.fx : 0.5;
    ctx.drawImage(img, (cw - dw) * fx, (ch - dh) / 2, dw, dh);
    lastDrawn = idx;
    if (!live) { live = true; canvas.classList.add("is-live"); root.classList.add("flight-ready"); }
  }

  // ---------- loop ----------
  function schedule() { if (isRunning() && !rafPending) { rafPending = true; requestAnimationFrame(tick); } }

  function tick() {
    rafPending = false;
    if (!isRunning()) return;
    var rect = tour.getBoundingClientRect();
    var y = clamp(-rect.top, 0, totalPx);
    if (y !== lastY) lastDir = y > lastY ? 1 : -1;
    lastY = y;
    current = locate(y);
    var list = [current.frame];
    for (var d = 1; d <= AHEAD; d++) { list.push(current.frame + d * lastDir); if (d <= BEHIND) list.push(current.frame - d * lastDir); }
    want(list);
    evict();
    draw(current.frame);
    updateText(current);
    if (header) header.classList.toggle("is-over-film", rect.bottom > 80);
    if (DEBUG) hud();
  }

  // ---------- rail & focus ----------
  function scrollToLocal(p, local) {
    if (!isRunning()) return;
    var top = tour.getBoundingClientRect().top + window.scrollY + p.start + p.len * local;
    window.scrollTo(0, Math.round(top));
  }
  function scrollToChapter(id) { var t = chapterTarget(id); if (t) scrollToLocal(t.p, t.local); }

  tour.addEventListener("click", function (e) {
    if (!isRunning()) return;
    var a = e.target.closest("[data-goto]");
    if (!a) return;
    e.preventDefault();
    scrollToChapter(a.getAttribute("data-goto"));
  });
  // Keyboard users tabbing into a chapter that is not on screen: bring it to where it is fully visible.
  tour.addEventListener("focusin", function (e) {
    if (!isRunning()) return;
    var ch = e.target.closest("[data-chapter]");
    if (!ch || ch.classList.contains("is-active")) return;
    scrollToChapter(ch.getAttribute("data-chapter"));
  });

  // ---------- debug ----------
  var hudEl;
  function hud() {
    if (!hudEl) { hudEl = document.createElement("div"); hudEl.className = "debug-hud"; document.body.appendChild(hudEl); }
    var p = passages[current.passage], ready = 0;
    cache.forEach(function (c) { if (c.ready) ready++; });
    hudEl.textContent = "passage " + p.id + "  local " + current.local.toFixed(3) +
      "\nframe " + current.frame + " / " + (count - 1) + "  drawn " + lastDrawn +
      "\ncache " + ready + " ready / " + cache.size + "  cap " + CAP + "  queue " + queue.length + "  inflight " + inflight +
      "\nset " + (isMobile ? "mobile" : "desktop") + "  vh " + vh + "  total " + totalPx + "px";
  }
  window.__tour = {
    state: function () { var r = 0; cache.forEach(function (c) { if (c.ready) r++; }); return { passage: passages[current.passage].id, local: current.local, frame: current.frame, drawn: lastDrawn, cache: cache.size, ready: r, cap: CAP, inflight: inflight, set: isMobile ? "mobile" : "desktop", count: count, totalPx: totalPx, vh: vh }; },
    passages: function () { return passages.map(function (p) { return { id: p.id, start: p.start, len: p.len, chapter: p.chapter, f0: p.f0, f1: p.f1 }; }); },
    goTo: function (id, local) { var p = passages.filter(function (q) { return q.id === id; })[0]; if (p) scrollToLocal(p, local == null ? 0.5 : local); },
    goToChapter: scrollToChapter,
    frameAt: function (id, local) { var p = passages.filter(function (q) { return q.id === id; })[0]; return locate(p.start + p.len * local).frame; }
  };

  // ---------- boot ----------
  function fail(why) {
    if (stopped) return;
    stopped = true;
    gen++;
    queue = []; wanted.clear();
    cache.forEach(release); cache.clear(); inflight = 0;
    window.removeEventListener("scroll", schedule);
    var hero = tour.querySelector('[data-chapter="hero"]');
    var restoreFocus = tour.contains(document.activeElement) && hero && !hero.contains(document.activeElement);
    root.classList.remove("has-flight", "flight-ready");
    root.classList.add("is-static");
    root.dataset.staticReason = why;
    tour.style.removeProperty("--tour-h");
    canvas.classList.remove("is-live");
    chapters.forEach(function (el) {
      el.removeAttribute("aria-hidden"); el.removeAttribute("inert");
      el.classList.toggle("is-active", el === hero);
      var copy = el.querySelector(".chapter-copy");
      copy.style.removeProperty("opacity"); copy.style.removeProperty("transform");
    });
    if (header) header.classList.remove("is-over-film");
    document.dispatchEvent(new Event("gfd:static"));
    if (restoreFocus) {
      var link = hero.querySelector("a");
      if (link) link.focus({ preventScroll: true });
    }
  }

  document.addEventListener("gfd:static", function () { fail(root.dataset.staticReason || "unavailable"); });
  if (!ctx) { fail("canvas"); return; }

  Promise.all([
    fetch("content/flight.json", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw 0; return r.json(); }),
    fetch("assets/frames/manifest.json", { cache: "no-cache" }).then(function (r) { if (!r.ok) throw 0; return r.json(); })
  ]).then(function (res) {
    if (!root.classList.contains("has-flight")) return;   // the 10 s watchdog already fell back to stills
    cfg = res[0]; manifest = res[1];
    passages = cfg.passages.map(function (p) { return Object.assign({}, p); });
    count = manifest.count; fps = manifest.fps;
    buildRanges();
    chooseSet();
    measure(true);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", function () {
      if (!isRunning()) return;
      // remember where the visitor is in the timeline: passage lengths scale with the viewport height
      var rect = tour.getBoundingClientRect();
      var inside = rect.top <= 0 && -rect.top <= totalPx, past = -rect.top > totalPx;
      var keep = { i: current.passage, local: current.local, bottom: rect.bottom };
      chooseSet();
      var changed = measure(false);
      if (!changed) sizeCanvas();
      else if (inside) scrollToLocal(passages[keep.i], keep.local);
      else if (past) window.scrollBy(0, tour.getBoundingClientRect().bottom - keep.bottom);
      schedule();
    });
    schedule();
  }).catch(function () { fail("config"); });
})();
