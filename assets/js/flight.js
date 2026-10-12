/* Native-scroll tour. A fully buffered, short-GOP film replaces hundreds of
 * per-frame requests. Only one seek may be outstanding; subsequent input updates
 * its target. The film stays paused, so native page scrolling remains in charge.
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
  var video = document.createElement("video");
  video.className = "tour-video";
  video.muted = true; video.defaultMuted = true; video.playsInline = true;
  video.preload = "auto";
  video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.disablePictureInPicture = true;
  canvas.insertAdjacentElement("afterend", video);
  var copies = chapters.map(function (el) { return el.querySelector(".chapter-copy"); });
  var textState = [], railChapter = null;
  var sourceURL = null, controller = null, loadTimer = null;
  var videoReady = false, seekBusy = false, desiredFrame = 0, seekFrame = 0;
  var visualY = null, tickTime = 0, seekStart = 0;
  var seeks = 0, maxSeekMs = 0, totalSeekMs = 0, downloadedBytes = 0;
  var CHAPTER_ORDER = ["hero", "place", "welcome", "services", "hygiene", "visit"];

  var cfg, manifest, passages = [], totalPx = 0, vh = 0, count = 0, fps = 20;
  var isMobile = null, set = null, frameW = 1280, frameH = 720;
  var current = { frame: 0, passage: 0, local: 0 }, lastDrawn = -1;
  var rafPending = false, live = false, gen = 0, stopped = false;

  function isRunning() { return !stopped && root.classList.contains("has-flight"); }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function smooth(e0, e1, x) { var t = clamp((x - e0) / (e1 - e0 || 1), 0, 1); return t * t * (3 - 2 * t); }

  // ---------- frame sets (phone crop vs full frame) ----------
  function chooseSet() {
    var mobile = window.innerWidth < 768 || window.innerHeight > window.innerWidth * 1.15;
    if (mobile === isMobile) return false;
    isMobile = mobile;
    set = isMobile ? cfg.media.mobile : cfg.media.desktop;
    frameW = set.width; frameH = set.height;
    loadFilm(set.src);
    return true;
  }

  function progress(loaded, total) {
    downloadedBytes = loaded;
    if (!loaderEl) return;
    var pct = total ? Math.min(99, Math.round(loaded / total * 100)) : 0;
    loaderBar.style.setProperty("--p", pct + "%");
    loaderEl.querySelector("span").textContent = total ? "Preparing your visit · " + pct + "%" : "Preparing your visit";
  }

  async function loadFilm(src) {
    var g = ++gen;
    if (controller) controller.abort();
    clearTimeout(loadTimer);
    controller = new AbortController();
    var signal = controller.signal;
    root.classList.add("flight-loading");
    // A network failure leaves a usable still-image page, never a stuck loader.
    loadTimer = setTimeout(function () { if (g === gen) fail("video-timeout"); }, 20000);
    try {
      var response = await fetch(src, { signal: signal, cache: "force-cache" });
      if (!response.ok) throw new Error("Film unavailable");
      var total = Number(response.headers.get("Content-Length")) || 0;
      var blob;
      if (response.body && response.body.getReader) {
        var reader = response.body.getReader(), chunks = [], loaded = 0;
        while (true) {
          var part = await reader.read();
          if (part.done) break;
          chunks.push(part.value); loaded += part.value.byteLength;
          progress(loaded, total);
        }
        blob = new Blob(chunks, { type: "video/mp4" });
      } else { blob = await response.blob(); progress(blob.size, blob.size); }
      if (g !== gen || !isRunning()) return;
      var oldURL = sourceURL;
      sourceURL = URL.createObjectURL(blob);
      videoReady = false; seekBusy = false; lastDrawn = -1;
      video.onloadeddata = function () {
        if (g !== gen || !isRunning()) return;
        clearTimeout(loadTimer);
        videoReady = true; live = true;
        root.classList.remove("flight-loading"); root.classList.add("flight-ready");
        video.classList.add("is-live");
        if (loaderEl) {
          loaderEl.classList.add("is-done"); loaderEl.setAttribute("aria-hidden", "true");
          loaderEl.querySelector("span").textContent = "Tour ready";
        }
        schedule();
      };
      video.onerror = function () { if (g === gen) fail("video-decode"); };
      video.src = sourceURL;
      video.load();
      if (oldURL) URL.revokeObjectURL(oldURL);
    } catch (error) {
      if (g === gen && isRunning()) fail("video-network");
    }
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
    return true;
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
    chapters.forEach(function (el, index) {
      var id = el.getAttribute("data-chapter");
      var copy = copies[index];
      var a = 0, leaving = false;
      if (p.chapter === id) { var r = chapterAlpha(p, st.local); a = r.a; leaving = r.leaving; }
      var y = (1 - a) * 16 * (leaving ? -1 : 1);
      var state = a.toFixed(3) + ":" + y.toFixed(1);
      if (textState[index] === state) return;
      textState[index] = state;
      copy.style.opacity = a.toFixed(3);
      copy.style.transform = "translate3d(0," + y.toFixed(1) + "px,0)";
      el.classList.toggle("is-active", a > 0.5);
      el.setAttribute("aria-hidden", String(a <= 0.5));
      el.toggleAttribute("inert", a <= 0.5);
    });
    var cur = p.chapter;
    if (!cur) { for (var k = st.passage; k >= 0; k--) if (passages[k].chapter) { cur = passages[k].chapter; break; } }
    if (cur === railChapter) return;
    railChapter = cur;
    var ci = CHAPTER_ORDER.indexOf(cur);
    railItems.forEach(function (li, idx) {
      li.classList.toggle("is-current", idx === ci);
      li.classList.toggle("is-past", idx < ci);
      var a = li.querySelector("a"); if (a) { if (idx === ci) a.setAttribute("aria-current", "step"); else a.removeAttribute("aria-current"); }
    });
  }

  // ---------- buffered film & scroll loop ----------
  video.addEventListener("seeked", function () {
    if (!videoReady || !isRunning()) return;
    seekBusy = false;
    lastDrawn = seekFrame;
    var elapsed = performance.now() - seekStart;
    seeks++; totalSeekMs += elapsed; maxSeekMs = Math.max(maxSeekMs, elapsed);
    // Let the browser present this frame before asking for the newest target.
    schedule();
  });

  function draw(frame) {
    desiredFrame = frame;
    if (!videoReady || seekBusy || video.seeking || lastDrawn === frame) return;
    var time = Math.min((frame + 0.25) / fps, Math.max(0, video.duration - 0.001));
    if (Math.abs(video.currentTime - time) < 0.002) { lastDrawn = frame; return; }
    seekFrame = frame; seekStart = performance.now(); seekBusy = true;
    video.currentTime = time;
  }

  function schedule() {
    if (isRunning() && !rafPending && !document.hidden) {
      rafPending = true; requestAnimationFrame(tick);
    }
  }

  function tick(now) {
    rafPending = false;
    if (!isRunning() || document.hidden) return;
    var rect = tour.getBoundingClientRect();
    var targetY = clamp(-rect.top, 0, totalPx);
    var dt = tickTime ? Math.min(64, now - tickTime) : 16;
    tickTime = now;
    if (visualY === null || rect.top > vh || rect.bottom < 0) visualY = targetY;
    else visualY += (targetY - visualY) * (1 - Math.exp(-dt / 65));
    if (Math.abs(targetY - visualY) < 0.5) visualY = targetY;
    current = locate(visualY);
    if (rect.top < vh && rect.bottom > 0) draw(current.frame);
    updateText(current);
    if (header) header.classList.toggle("is-over-film", rect.bottom > 80);
    if (DEBUG) hud();
    if (visualY !== targetY) schedule();
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
  function state() {
    return { passage: passages[current.passage].id, local: current.local,
      frame: current.frame, drawn: lastDrawn, target: desiredFrame,
      engine: "buffered-video", ready: videoReady, seeking: seekBusy,
      seeks: seeks, averageSeekMs: seeks ? +(totalSeekMs / seeks).toFixed(1) : 0,
      maxSeekMs: +maxSeekMs.toFixed(1), downloadedBytes: downloadedBytes,
      set: isMobile ? "mobile" : "desktop", count: count, totalPx: totalPx, vh: vh };
  }
  function hud() {
    if (!hudEl) { hudEl = document.createElement("div"); hudEl.className = "debug-hud"; document.body.appendChild(hudEl); }
    var s = state();
    hudEl.textContent = "buffered video · " + s.set + " · " + (videoReady ? "ready" : "loading") +
      "\nframe " + s.frame + " / " + (count - 1) + " · drawn " + s.drawn +
      "\nseeks " + seeks + " · average " + s.averageSeekMs + " ms · max " + s.maxSeekMs + " ms";
  }
  window.__tour = {
    state: state,
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
    if (controller) controller.abort();
    clearTimeout(loadTimer);
    videoReady = false; video.pause();
    video.removeAttribute("src"); video.load();
    if (sourceURL) { URL.revokeObjectURL(sourceURL); sourceURL = null; }
    video.classList.remove("is-live");
    root.classList.remove("flight-loading");
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
  if (!video.canPlayType("video/mp4") || !window.AbortController) { fail("video-support"); return; }
  document.addEventListener("visibilitychange", function () { tickTime = 0; schedule(); });

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
      if (changed && inside) scrollToLocal(passages[keep.i], keep.local);
      else if (changed && past) window.scrollBy(0, tour.getBoundingClientRect().bottom - keep.bottom);
      schedule();
    });
    schedule();
  }).catch(function () { fail("config"); });
})();
