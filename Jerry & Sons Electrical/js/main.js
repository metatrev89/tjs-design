// Jerry & Sons Electrical — shared site behavior

document.addEventListener('DOMContentLoaded', function () {
  var toggle = document.getElementById('nav-toggle');
  var nav = document.getElementById('main-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // Close the mobile menu after a nav link is tapped
    nav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // In-page anchor links (e.g. "#schedule" on contact.html): scroll
  // explicitly within THIS window via window.scrollTo() with a manually
  // computed offset, instead of relying on the browser's native #hash jump.
  // When a page is embedded in an iframe (as these are on the TJS Design
  // portfolio page), native hash navigation and Element.scrollIntoView() can
  // both scroll the OUTER page instead of (or in addition to) this one in
  // some browsers. window.scrollTo() has no such cross-frame behavior
  // defined anywhere, so it can't leak out. No-op on pages with no matching
  // same-page anchor target.
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var id = a.getAttribute('href').slice(1);
      var target = id && document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      a.blur();
      var y = target.getBoundingClientRect().top + window.pageYOffset;
      window.scrollTo({ top: y, left: 0, behavior: 'auto' });
    });
  });
});
