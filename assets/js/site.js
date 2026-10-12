/* Guilderland Family Dentistry — accessible interactions, no framework. */
(function () {
  'use strict';
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const motion = root.classList.contains('has-flight') && !reduce.matches;
  const menu = document.getElementById('mobile-menu');
  const menuButton = document.querySelector('.site-header .menu-btn');
  const outside = ['.site-header', '#main', '.site-footer', '.callbar'].map(s => document.querySelector(s)).filter(Boolean);
  function setMenu(open, restore = true) {
    menu.hidden = !open;
    menu.classList.toggle('is-open', open);
    menuButton.setAttribute('aria-expanded', String(open));
    outside.forEach(el => el.toggleAttribute('inert', open));
    if (open) menu.querySelector('.close').focus();
    else if (restore) menuButton.focus();
  }
  menuButton.addEventListener('click', () => setMenu(true));
  menu.querySelector('.close').addEventListener('click', () => setMenu(false));
  menu.addEventListener('click', e => {
    const link = e.target.closest('a');
    if (!link) return;
    setMenu(false, false);
    if (link.hash && link.origin === location.origin) {
      const destination = document.getElementById(link.hash.slice(1));
      if (destination) { destination.setAttribute('tabindex', '-1'); destination.focus({preventScroll:true}); }
    }
  });
  menu.addEventListener('keydown', e => {
    if (e.key === 'Escape') { setMenu(false); return; }
    if (e.key !== 'Tab') return;
    const links = [...menu.querySelectorAll('a[href],button:not([disabled])')];
    const first = links[0], last = links[links.length-1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  matchMedia('(min-width:1051px)').addEventListener('change', e => { if (e.matches && !menu.hidden) setMenu(false, false); });
  function applyStaticMode() {
    if (root.classList.contains('has-flight')) return;
    root.classList.remove('reveal-on');
    document.querySelector('.site-header').classList.remove('is-over-film');
    document.querySelectorAll('[data-goto]').forEach(a => {
      const ids = {welcome:'first-visit',services:'services',hero:'tour',place:'visit',hygiene:'questions',visit:'appointment'};
      if (ids[a.dataset.goto]) a.href = '#' + ids[a.dataset.goto];
    });
    document.querySelectorAll('[data-chapter]').forEach(chapter => {
      chapter.removeAttribute('aria-hidden');
      chapter.removeAttribute('inert');
      chapter.classList.toggle('is-active', chapter.dataset.chapter === 'hero');
      const copy = chapter.querySelector('.chapter-copy');
      copy.style.removeProperty('opacity');
      copy.style.removeProperty('transform');
    });
  }
  applyStaticMode();
  document.addEventListener('gfd:static', applyStaticMode);
  // Native details remain usable if JavaScript is unavailable.
  const services = [...document.querySelectorAll('.service-item')];
  const serviceImage = document.getElementById('service-image');
  const serviceCaption = document.getElementById('service-image-caption');
  const descriptions = {
    family: ['An adult and child\'s toothbrush in the autumn sunlight — illustration','Small habits. Lifelong smiles.'],
    cosmetic: ['White porcelain and lavender on linen — illustration','A little confidence. A brighter day.'],
    restorative: ['Dental instruments on clean linen — illustration','Thoughtful care. A fresh start.'],
    botox: ['Smooth stones on soft sage linen — illustration','A conversation about your comfort.']
  };
  services.forEach(item => item.addEventListener('toggle', () => {
    if (!item.open) return;
    services.forEach(other => { if (other !== item) other.open = false; });
    const key = item.dataset.service;
    serviceImage.src = 'assets/img/svc-' + key + '-1400.webp';
    serviceImage.alt = descriptions[key][0];
    serviceCaption.textContent = descriptions[key][1];
  }));
  const compare = document.getElementById('compare');
  const range = compare.querySelector('input');
  function setPosition() {
    compare.style.setProperty('--pos', range.value + '%');
    range.setAttribute('aria-valuetext', range.value + '% across: before on the left, after on the right');
  }
  range.addEventListener('input', setPosition);
  const tabs = [...document.querySelectorAll('.remodel-tabs [role=tab]')];
  const roomNames = {reception:'front desk',operatory:'treatment room',cabinetry:'clinical cabinetry'};
  function selectTab(tab, focus = false) {
    tabs.forEach(t => { t.setAttribute('aria-selected', String(t === tab)); t.tabIndex = t === tab ? 0 : -1; });
    const key = tab.dataset.pair;
    ['before','after'].forEach(time => {
      const img = compare.querySelector('.img-' + time);
      img.src = 'assets/real/remodel-' + key + '-' + time + '.webp';
      img.alt = 'The ' + roomNames[key] + ' ' + time + ' the remodel';
    });
    compare.setAttribute('aria-labelledby', tab.id);
    range.value = 50; setPosition();
    if (focus) tab.focus();
  }
  tabs.forEach((tab,index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', e => {
      const keys = {ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1};
      if (e.key in keys) { e.preventDefault(); selectTab(tabs[keys[e.key]],true); }
    });
  });
  const mapButton = document.querySelector('[data-load-map]');
  mapButton.addEventListener('click', () => {
    const frame = document.createElement('iframe');
    frame.title = 'Map of Guilderland Family Dentistry, 3734 Carman Road, Schenectady';
    frame.src = 'https://www.google.com/maps?q=Guilderland+Family+Dentistry,+3734+Carman+Rd,+Schenectady,+NY+12303&z=16&output=embed';
    frame.loading = 'lazy';
    frame.referrerPolicy = 'no-referrer-when-downgrade';
    document.getElementById('map').replaceChildren(frame);
    frame.focus();
  });
  function updateHours() {
    const el = document.querySelector('[data-open-now]');
    try {
      const parts = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',weekday:'short',hour:'numeric',minute:'numeric',hour12:false}).formatToParts(new Date());
      const get = type => parts.find(p=>p.type===type)?.value;
      const mins = (+get('hour')%24)*60 + +get('minute');
      const open = ['Mon','Tue','Wed','Thu'].includes(get('weekday')) && mins>=480 && mins<1020;
      el.classList.toggle('is-open',open);
      el.querySelector('span').textContent = open ? 'Open now · here until 5 PM' : 'Closed now · Mon–Thu, 8 AM–5 PM';
      el.hidden = false;
    } catch (_) { el.hidden = true; }
  }
  updateHours();
  document.addEventListener('visibilitychange',()=>{if (!document.hidden) updateHours();});
  if (motion && 'IntersectionObserver' in window) {
    root.classList.add('reveal-on');
    const observer = new IntersectionObserver(entries => entries.forEach(e=>{
      if (e.isIntersecting) { e.target.classList.add('is-in'); observer.unobserve(e.target); }
    }), {threshold:.06,rootMargin:'0px 0px -25px 0px'});
    document.querySelectorAll('.reveal').forEach(el=>observer.observe(el));
  }
  // Only load decorative video when the section is near the viewport.
  function lazyFilm(hostSelector, posterSelector, buttonSelector, src, compact) {
    const host = document.querySelector(hostSelector), poster = host?.querySelector(posterSelector), toggle = host?.querySelector(buttonSelector);
    if (!host || !poster || !toggle || !motion || !('IntersectionObserver' in window) || navigator.connection?.saveData) return;
    const video = document.createElement('video');
    video.muted=true; video.loop=true; video.playsInline=true; video.preload='none';
    video.setAttribute('muted',''); video.setAttribute('playsinline',''); video.setAttribute('aria-hidden','true');
    video.poster=poster.currentSrc||poster.src;
    let attached=false, visible=false, userPaused=false;
    const label = () => {
      const paused = userPaused || video.paused;
      toggle.setAttribute('aria-label',(paused?'Play':'Pause') + (compact?' welcome video':' background video'));
      toggle.textContent=compact?(paused?'▷':'Ⅱ'):(paused?'Play background video':'Pause background video');
      toggle.setAttribute('aria-pressed',String(!paused));
    };
    const play = () => { const promise=video.play(); if(promise) promise.then(label).catch(()=>{label();toggle.hidden=false;}); };
    const observer = new IntersectionObserver(entries=>entries.forEach(e=>{
      visible=e.isIntersecting;
      if(visible&&!reduce.matches) {
        if(!attached){video.src=src;host.insertBefore(video,poster.nextSibling);attached=true;}
        if(!userPaused&&!document.hidden) play();
      } else video.pause();
    }),{threshold:.12});
    observer.observe(host);
    video.addEventListener('loadeddata',()=>{toggle.hidden=false;label();});
    video.addEventListener('error',()=>{video.remove();toggle.hidden=true;observer.disconnect();});
    toggle.addEventListener('click',()=>{
      userPaused=!video.paused;
      if(userPaused){video.pause();label();} else play();
    });
    document.addEventListener('visibilitychange',()=>{
      if(document.hidden) video.pause(); else if(visible&&!userPaused&&!reduce.matches&&attached) play();
    });
    reduce.addEventListener('change',e=>{if(e.matches){video.pause();label();}});
  }
  lazyFilm('.cta-band','[data-ambient-poster]','.ambient-toggle','assets/video/ambient-window.mp4',false);
  lazyFilm('.visit-film','[data-welcome-poster]','.video-toggle','assets/video/welcome-higgsfield.mp4',true);
})();
