// Progressive touches: the page reads fine without any of this.
(function () {
  'use strict';
  var root = document.documentElement;

  // Theme toggle, remembered in localStorage (read before paint in the <head>).
  var toggle = document.querySelector('[data-theme-toggle]');
  if (toggle) {
    toggle.addEventListener('click', function () {
      var dark = root.dataset.theme
        ? root.dataset.theme === 'dark'
        : matchMedia('(prefers-color-scheme: dark)').matches;
      root.dataset.theme = dark ? 'light' : 'dark';
      try { localStorage.setItem('theme', root.dataset.theme); } catch (e) {}
    });
  }

  // Copy buttons: the hero command, and one on every code block.
  function copyButton(text, extraClass) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy ' + (extraClass || '');
    button.setAttribute('aria-label', 'Copy to clipboard');
    button.dataset.copy = text;
    button.innerHTML = '<span class="copy-label">Copy</span>';
    return button;
  }
  document.querySelectorAll('.prose pre').forEach(function (pre) {
    var code = pre.querySelector('code');
    if (!code) return;
    // Shell blocks: copy the commands, not the comments after them.
    pre.appendChild(copyButton(code.textContent.replace(/\s+$/, '')));
  });
  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-copy]');
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.dataset.copy).then(function () {
      var label = button.querySelector('.copy-label');
      var was = label ? label.textContent : '';
      button.classList.add('copied');
      if (label) label.textContent = 'Copied';
      setTimeout(function () {
        button.classList.remove('copied');
        if (label) label.textContent = was;
      }, 1400);
    });
  });

  // Anchor links on headings.
  document.querySelectorAll('.prose h2[id], .prose h3[id]').forEach(function (heading) {
    var anchor = document.createElement('a');
    anchor.className = 'anchor';
    anchor.href = '#' + heading.id;
    anchor.setAttribute('aria-label', 'Link to this section');
    anchor.textContent = '#';
    heading.appendChild(anchor);
  });

  // Footnotes pop up beside their mark on hover, focus or tap. The mark is
  // still a link to the note at the end, so this is additive.
  var pop = null, popFor = null, hideTimer = null;
  function hidePop() {
    if (pop) pop.remove();
    if (popFor) popFor.classList.remove('open');
    pop = null; popFor = null;
  }
  function showPop(ref) {
    clearTimeout(hideTimer);
    if (popFor === ref) return;
    hidePop();
    var note = document.getElementById(decodeURIComponent(ref.hash.slice(1)));
    if (!note) return;
    pop = document.createElement('div');
    pop.className = 'footnote-pop';
    pop.setAttribute('role', 'tooltip');
    pop.innerHTML = note.innerHTML;
    pop.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
    pop.addEventListener('mouseleave', scheduleHide);
    document.body.appendChild(pop);
    var r = ref.getBoundingClientRect();
    var width = pop.offsetWidth;
    var left = Math.max(16, Math.min(r.left + r.width / 2 - width / 2, innerWidth - width - 16));
    var below = r.bottom + 8 + pop.offsetHeight < innerHeight;
    pop.style.left = (left + scrollX) + 'px';
    pop.style.top = (below ? r.bottom + 8 : r.top - 8 - pop.offsetHeight) + scrollY + 'px';
    popFor = ref;
    ref.classList.add('open');
  }
  function scheduleHide() { hideTimer = setTimeout(hidePop, 160); }
  document.querySelectorAll('.prose .footnote-ref').forEach(function (ref) {
    ref.addEventListener('mouseenter', function () { showPop(ref); });
    ref.addEventListener('mouseleave', scheduleHide);
    ref.addEventListener('focus', function () { showPop(ref); });
    ref.addEventListener('blur', scheduleHide);
    ref.addEventListener('click', function (event) {
      // A tap on a touch screen shows the note in place instead of jumping.
      if (matchMedia('(hover: none)').matches) {
        event.preventDefault();
        if (popFor === ref) hidePop(); else showPop(ref);
      }
    });
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hidePop(); });
  document.addEventListener('click', function (event) {
    if (pop && !event.target.closest('.footnote-pop, .footnote-ref')) hidePop();
  });
  addEventListener('scroll', function () { if (pop && !matchMedia('(hover: none)').matches) hidePop(); }, { passive: true });

  // Contents on this page: highlight the section in view, and open the
  // subsections of the section the reader is in.
  var links = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  var byId = {};
  links.forEach(function (link) { byId[decodeURIComponent(link.hash.slice(1))] = link; });
  var headings = Array.prototype.filter.call(
    document.querySelectorAll('.prose h2[id], .prose h3[id]'),
    function (h) { return byId[h.id]; });
  var current = null;
  function setActive(id) {
    if (id === current) return;
    current = id;
    links.forEach(function (link) { link.classList.remove('active'); });
    document.querySelectorAll('.toc li.open').forEach(function (li) { li.classList.remove('open'); });
    var link = byId[id];
    if (!link) return;
    link.classList.add('active');
    var li = link.parentElement;
    while (li && li.closest('.toc')) {
      if (li.tagName === 'LI') li.classList.add('open');
      li = li.parentElement;
    }
    var sidebar = document.querySelector('[data-sidebar]');
    if (sidebar && sidebar.scrollHeight > sidebar.clientHeight) {
      var top = link.offsetTop - sidebar.clientHeight / 2;
      sidebar.scrollTo({ top: top, behavior: 'auto' });
    }
  }
  function spy() {
    var line = 100; // px below the header
    var active = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].getBoundingClientRect().top <= line) active = headings[i];
      else break;
    }
    if (active) setActive(active.id);
  }
  if (headings.length) {
    var pending = false;
    addEventListener('scroll', function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () { pending = false; spy(); });
    }, { passive: true });
    spy();
  }

  // Small screens: the contents list is a drawer.
  var contentsButton = document.querySelector('[data-contents-toggle]');
  var sidebar = document.querySelector('[data-sidebar]');
  if (contentsButton && sidebar) {
    contentsButton.addEventListener('click', function () {
      var open = sidebar.classList.toggle('open');
      contentsButton.setAttribute('aria-expanded', String(open));
    });
    sidebar.addEventListener('click', function (event) {
      if (event.target.closest('a')) {
        sidebar.classList.remove('open');
        contentsButton.setAttribute('aria-expanded', 'false');
      }
    });
  }
})();
