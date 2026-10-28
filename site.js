/*
 * TJS Design — shared footer behavior for pages built outside the homepage template.
 * Wires the footer "Get in Touch" form to the same /contact endpoint the homepage uses.
 */
(function () {
  'use strict';
  var URL = 'https://tjs-checkout.trevorspencer89.workers.dev/contact';
  function wire(form) {
    if (form.__tjsWired) return; form.__tjsWired = true;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var $ = function (id) { return document.getElementById(id); };
      var hp = $('tjs-contact-hp'), statusEl = $('tjs-contact-status'), btn = $('tjs-contact-submit');
      if (hp && hp.value) return; // bot trap
      var name = ($('tjs-contact-name').value || '').trim();
      var phone = ($('tjs-contact-phone').value || '').trim();
      var email = ($('tjs-contact-email').value || '').trim();
      if (!name || !email || email.indexOf('@') === -1) {
        statusEl.textContent = 'Please enter your name and a valid email.'; statusEl.style.color = '#FF6B4A'; return;
      }
      btn.disabled = true; btn.textContent = 'Sending…'; statusEl.textContent = '';
      try {
        var res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name, phone: phone, email: email, source: document.title }) });
        var data = {}; try { data = await res.json(); } catch (_) {}
        if (!res.ok || data.error) throw new Error(data.error || 'Something went wrong.');
        form.reset();
        statusEl.textContent = "Thanks — I'll be in touch soon."; statusEl.style.color = '#1FC77D';
        if (window.gtag) try { window.gtag('event', 'generate_lead', { lead_source: 'footer_contact' }); } catch (_) {}
      } catch (err) {
        statusEl.textContent = err.message || 'Something went wrong — try again or text (385) 472-3690.'; statusEl.style.color = '#FF6B4A';
      } finally { btn.disabled = false; btn.textContent = 'Send →'; }
    });
  }
  function init() { var f = document.getElementById('tjs-contact-form'); if (f) wire(f); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
