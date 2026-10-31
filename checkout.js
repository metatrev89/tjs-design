/*
 * TJS Design — drop-in checkout drawer.
 *
 * The one checkout for every page on tjsdesign.online (Plan → Payment → Book Call → Done).
 * Plans and prices live in PLANS below and must match PLANS in tjs-checkout-worker.js.
 *
 * Triggers (either works):
 *   <a href="/" data-tjs-checkout>Get My Website</a>              → opens on the plan picker
 *   <a href="/" data-tjs-checkout="balanced">…</a>                → opens with that plan selected
 *                                                                  (own | balanced | zero)
 *   any link/button whose text starts with "Get My Website"       → opens on the plan picker
 *   window.tjsOpenCheckout({ plan: 'zero' })                      → from page scripts
 * The href stays as a no-JavaScript fallback.
 */
(function () {
  'use strict';
  if (window.tjsOpenCheckout) return;

  var STRIPE_PK = 'pk_live_51T488BA7Unp9hIDTqDfsTtnoHMC3mrC3Eaan1uyB7zaYwEZrTwaOJnO519g3WWP36TpwYrj5KMcnqp8pT3BAPGDy008u13q032';
  var WORKER = 'https://tjs-checkout.trevorspencer89.workers.dev';
  var FONT_H = "'Plus Jakarta Sans',sans-serif";
  var FONT_B = "'DM Sans',sans-serif";

  var PLANS = {
    own:      { name: 'Own It',    upfront: 99999, monthly: 2999,  blurb: 'Lowest total cost' },
    balanced: { name: 'Balanced',  upfront: 49999, monthly: 7999,  blurb: 'Half down, a bit more monthly' },
    zero:     { name: 'Zero Down', upfront: 0,     monthly: 12999, blurb: 'Nothing upfront' }
  };
  var ORDER = ['own', 'balanced', 'zero'];
  var S = { open: false, step: 1, plan: 'own', agreed: false, slot: '', slots: [], slotsLoading: false, slotsError: '' };
  var root = null, stripe = null, elements = null, payEl = null, customer = null, paying = false;

  // ---------- Stripe ----------
  function loadStripe(cb) {
    if (window.Stripe) { stripe = stripe || window.Stripe(STRIPE_PK); return cb(); }
    var existing = document.querySelector('script[src^="https://js.stripe.com/v3"]');
    var s = existing || document.createElement('script');
    if (!existing) { s.src = 'https://js.stripe.com/v3/'; s.async = true; document.head.appendChild(s); }
    s.addEventListener('load', function () { stripe = window.Stripe(STRIPE_PK); cb(); });
    s.addEventListener('error', function () { showError('Could not load the secure payment form. Please refresh and try again.'); });
  }

  // ---------- pricing ----------
  function money(c) { return '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function plan() { return PLANS[S.plan]; }
  function dueCents() { return plan().upfront + plan().monthly; }
  function dueToday() { return money(dueCents()); }
  function yearOneCents(p) { return p.upfront + 12 * p.monthly; }

  // ---------- shell ----------
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function ensureRoot() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'tjsco-root';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Checkout');
    root.style.cssText = 'position:fixed; inset:0; z-index:1000; display:none; justify-content:flex-end;';
    root.innerHTML =
      '<div data-tjsco="close" style="position:absolute; inset:0; background:rgba(15,14,34,.55); backdrop-filter:blur(3px);"></div>' +
      '<div style="position:relative; width:min(480px,100%); height:100%; background:#FBF8F2; box-shadow:-20px 0 60px rgba(0,0,0,.25); display:flex; flex-direction:column; font-family:' + FONT_B + '; color:#17152B; text-align:left;">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; padding:20px 24px; border-bottom:1px solid rgba(23,21,43,.08); flex:none;">' +
          '<div style="display:flex; align-items:center; gap:10px;"><div style="width:34px; height:34px; border-radius:9px; background:#17152B; color:#fff; font-family:' + FONT_H + '; font-weight:800; font-size:14px; display:flex; align-items:center; justify-content:center;">T</div><span style="font-family:' + FONT_H + '; font-weight:800; font-size:16px; color:#17152B;">Checkout</span></div>' +
          '<button type="button" data-tjsco="close" aria-label="Close" style="cursor:pointer; border:none; background:rgba(23,21,43,.06); width:36px; height:36px; border-radius:50%; font-size:20px; color:#17152B; display:flex; align-items:center; justify-content:center;">×</button>' +
        '</div>' +
        '<div id="tjsco-progress" style="flex:none;"></div>' +
        '<div id="tjsco-body" style="flex:1; overflow-y:auto; padding:24px;"></div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('click', onRootClick);
  }

  function renderProgress() {
    var dark = '#17152B', dim = 'rgba(23,21,43,.12)', labels = ['Plan', 'Payment', 'Book Call', 'Done'];
    var bars = '', lbls = '';
    for (var i = 1; i <= 4; i++) {
      bars += '<div style="height:5px; flex:1; border-radius:3px; background:' + (S.step >= i ? dark : dim) + ';"></div>';
      lbls += '<div style="flex:1; font-size:11px; font-weight:700; letter-spacing:.01em; color:' + (S.step >= i ? '#17152B' : '#b3b0bd') + ';">' + labels[i - 1] + '</div>';
    }
    document.getElementById('tjsco-progress').innerHTML =
      '<div style="display:flex; gap:6px; padding:16px 24px 0;">' + bars + '</div>' +
      '<div style="display:flex; gap:6px; padding:9px 24px 0;">' + lbls + '</div>';
  }

  var H3 = 'font-family:' + FONT_H + '; font-weight:800; font-size:22px; color:#17152B; margin:0 0 6px;';
  var SUB = 'font-size:14px; color:#7a7783; margin:0 0 24px;';
  var BTN_DARK = 'cursor:pointer; border:none; width:100%; background:#17152B; color:#fff; font-family:' + FONT_H + '; font-weight:700; font-size:16px; padding:17px; border-radius:13px;';
  var INPUT = 'width:100%; height:48px; border-radius:11px; border:1.5px solid rgba(23,21,43,.2); background:#fff; padding:0 14px; color:#17152B; font-size:15px; font-family:' + FONT_B + '; outline:none; box-sizing:border-box;';
  var LABEL = 'display:block; font-size:13px; font-weight:600; color:#3a3845; margin-bottom:6px;';

  function stepSummary() {
    var p = plan();
    var cards = ORDER.map(function (k) {
      var q = PLANS[k], on = S.plan === k;
      return '<button type="button" data-tjsco="plan" data-plan="' + k + '" aria-pressed="' + on + '" style="cursor:pointer; width:100%; text-align:left; background:' + (on ? 'rgba(47,107,255,.07)' : '#fff') + '; border:2px solid ' + (on ? '#2F6BFF' : 'rgba(23,21,43,.18)') + '; border-radius:14px; padding:14px 16px; display:flex; justify-content:space-between; align-items:center; gap:12px;">' +
        '<div style="display:flex; gap:12px; align-items:center;"><div style="width:20px; height:20px; border-radius:50%; border:2px solid ' + (on ? '#2F6BFF' : 'rgba(23,21,43,.3)') + '; display:flex; align-items:center; justify-content:center; flex:none;">' + (on ? '<div style="width:10px; height:10px; border-radius:50%; background:#2F6BFF;"></div>' : '') + '</div>' +
        '<div><div style="font-family:' + FONT_H + '; font-weight:800; font-size:15px; color:#17152B;">' + q.name + '</div><div style="font-size:12.5px; color:#7a7783; margin-top:2px;">' + q.blurb + ' · ' + money(yearOneCents(q)) + ' year one</div></div></div>' +
        '<div style="text-align:right; white-space:nowrap;"><div style="font-family:' + FONT_H + '; font-weight:800; font-size:15px; color:#17152B;">' + (q.upfront ? money(q.upfront) + ' down' : '$0 down') + '</div><div style="font-size:13px; color:#2F6BFF; font-weight:700;">+ ' + money(q.monthly) + '/mo</div></div>' +
      '</button>';
    }).join('<div style="height:10px"></div>');
    var row = function (l, r, strong) { return '<div style="display:flex; justify-content:space-between; gap:12px; padding:5px 0; font-size:' + (strong ? '15px; font-weight:700; color:#17152B' : '13.5px; color:#55525f') + ';"><span>' + l + '</span><span style="white-space:nowrap;">' + r + '</span></div>'; };
    return '<div>' +
      '<h3 style="' + H3 + '">Choose your plan</h3><p style="font-size:14px; color:#7a7783; margin:0 0 18px;">Same custom website and service on every plan. Pick how you want to pay for it.</p>' +
      cards +
      '<div style="background:#fff; border:1.5px solid rgba(23,21,43,.1); border-radius:14px; padding:14px 16px; margin:18px 0 14px;">' +
        '<div style="font-family:' + FONT_H + '; font-weight:700; font-size:13px; color:#17152B; margin-bottom:8px;">Every plan includes, year one</div>' +
        '<div style="font-size:13px; line-height:1.6; color:#55525f;">Custom website built in under 14 business days · hosting, security &amp; updates · content changes · up to one 30-minute call a month · support by phone, text &amp; email · a branded Google Business Profile post every week (52 a year)</div>' +
      '</div>' +
      row('Due today', dueToday(), true) +
      row((p.upfront ? money(p.upfront) + ' upfront + first month' : 'First month'), '') +
      row('Then ' + money(p.monthly) + '/mo for 11 more months', money(11 * p.monthly)) +
      row('Year-one total (12-month agreement)', money(yearOneCents(p))) +
      row('After year one', 'Essential Care $29.99/mo, cancel anytime') +
      '<label style="display:flex; gap:10px; align-items:flex-start; margin:16px 0 4px; cursor:pointer; font-size:13px; line-height:1.5; color:#3a3845;">' +
        '<input type="checkbox" data-tjsco="agree"' + (S.agreed ? ' checked' : '') + ' style="width:18px; height:18px; margin-top:2px; flex:none; accent-color:#2F6BFF;">' +
        '<span>I agree to a <strong>12-month agreement</strong> and authorize TJS Design to charge my card ' + (p.upfront ? money(p.upfront) + ' plus ' : '') + money(p.monthly) + ' today, then ' + money(p.monthly) + ' monthly for 11 more months. If I cancel early, the rest of year one is still due. After 12 months my plan continues as Essential Care at $29.99/mo month-to-month until I cancel (cancel anytime before the next charge by text, call or email). I agree to the <a href="/terms.html" target="_blank" rel="noopener" style="color:#2F6BFF;">Terms of Service</a>.</span>' +
      '</label>' +
      '<button type="button" data-tjsco="to-payment"' + (S.agreed ? '' : ' disabled') + ' style="' + BTN_DARK + ' margin-top:14px;' + (S.agreed ? '' : ' opacity:.45; cursor:not-allowed;') + '">Continue to Payment →</button>' +
    '</div>';
  }

  function stepPayment() {
    return '<div>' +
      '<h3 style="' + H3 + '">Payment</h3><p style="font-size:14px; color:#7a7783; margin:0 0 16px;">' + plan().name + ' plan · ' + dueToday() + ' today, then ' + money(plan().monthly) + '/mo · secure payment by Stripe.</p>' +
      '<div style="display:flex; align-items:center; gap:11px; background:#FFF4D6; border:1px solid #FBE08F; border-radius:12px; padding:12px 14px; margin-bottom:22px;"><span style="flex:none; width:24px; height:24px; border-radius:50%; background:#FFC53D; color:#17152B; font-size:13px; font-weight:800; display:flex; align-items:center; justify-content:center;">3</span><span style="font-size:13px; color:#6b5e2e; line-height:1.45;"><strong style="color:#17152B;">Next step:</strong> right after payment you\'ll book your 30-minute intake call.</span></div>' +
      '<div style="display:flex; flex-direction:column; gap:14px; margin-bottom:22px;">' +
        '<div><label for="tjsco-name" style="' + LABEL + '">Full name</label><input id="tjsco-name" type="text" placeholder="Jane Smith" autocomplete="name" style="' + INPUT + '"></div>' +
        '<div><label for="tjsco-email" style="' + LABEL + '">Email</label><input id="tjsco-email" type="email" placeholder="jane@business.com" autocomplete="email" style="' + INPUT + '"></div>' +
        '<div><label style="' + LABEL + '">Card details</label><div id="tjsco-payment-element" style="border-radius:11px; border:1.5px solid rgba(23,21,43,.2); background:#fff; padding:12px 14px; min-height:48px;"></div></div>' +
        '<div id="tjsco-error" role="alert" style="color:#e53e3e; font-size:13px; margin-top:-6px; display:none; padding:8px 12px; background:#fff5f5; border-radius:8px; border:1px solid #feb2b2;"></div>' +
      '</div>' +
      '<button type="button" id="tjsco-pay" data-tjsco="pay" style="cursor:pointer; border:none; width:100%; background:linear-gradient(135deg,#FF6B4A,#FF3D9A); color:#fff; font-family:' + FONT_H + '; font-weight:700; font-size:16px; padding:17px; border-radius:13px; box-shadow:0 10px 24px rgba(255,61,154,.3);">Pay ' + dueToday() + ' →</button>' +
      '<div style="display:flex; align-items:center; justify-content:center; gap:16px; margin-top:18px; font-size:12px; color:#9a97a3;"><span>🔒 Stripe Secured</span><span>SSL Encrypted</span><span>PCI Compliant</span></div>' +
      '<div style="text-align:center; font-size:12px; color:#9a97a3; margin-top:10px; line-height:1.6;">Your card is saved for the monthly payments under your 12-month agreement. By paying you agree to our <a href="/terms.html" target="_blank" rel="noopener" style="color:#2F6BFF; text-decoration:none;">Terms of Service</a> (including the <a href="/terms.html#refund-policy" target="_blank" rel="noopener" style="color:#2F6BFF; text-decoration:none;">refund and cancellation policy</a>) and <a href="/privacy.html" target="_blank" rel="noopener" style="color:#2F6BFF; text-decoration:none;">Privacy Policy</a>.</div>' +
      '<button type="button" data-tjsco="back" style="cursor:pointer; border:none; background:transparent; width:100%; color:#7a7783; font-size:14px; padding:14px; margin-top:6px;">← Back to summary</button>' +
    '</div>';
  }

  function stepCalendar() {
    var list = '';
    if (S.slotsLoading) list = '<div style="text-align:center; padding:36px 0; color:#7a7783; font-size:14px;">Loading available times…</div>';
    else if (S.slotsError) list = '<div style="background:#fff5f5; border:1px solid #feb2b2; border-radius:10px; padding:14px; color:#c53030; font-size:13px;">' + esc(S.slotsError) + ' — Please close and try again.</div>';
    else S.slots.forEach(function (s, i) {
      list += '<button type="button" data-tjsco="slot" data-i="' + i + '" style="cursor:pointer; background:#fff; border:2px solid #17152B; border-radius:13px; padding:15px 18px; display:flex; align-items:center; justify-content:space-between; text-align:left; width:100%;">' +
        '<div><div style="font-family:' + FONT_H + '; font-weight:700; font-size:15px; color:#17152B;">' + esc(s.date) + '</div><div style="font-size:13px; color:#7a7783;">' + esc(s.time) + '</div></div>' +
        '<span style="font-family:' + FONT_H + '; font-weight:700; font-size:14px; color:#2F6BFF;">Select →</span></button>';
    });
    return '<div>' +
      '<div style="background:#1FC77D; color:#0f3d28; font-weight:700; font-size:13px; border-radius:10px; padding:11px 14px; margin-bottom:20px; display:flex; align-items:center; gap:8px;"><span style="font-weight:800;">✓</span> Payment confirmed. Now let\'s schedule your call.</div>' +
      '<h3 style="' + H3 + '">Book your intake call</h3><p style="font-size:14px; color:#7a7783; margin:0 0 22px;">Pick a 30-minute slot that works for you. A calendar invite is sent automatically.</p>' +
      '<div style="display:flex; flex-direction:column; gap:10px;">' + list + '</div></div>';
  }

  function stepDone() {
    var row = function (html, last) { return '<div style="display:flex; gap:10px;' + (last ? '' : ' margin-bottom:14px;') + '"><span style="color:#1FC77D; font-weight:800;">✓</span><span style="font-size:14.5px; color:#3a3845;">' + html + '</span></div>'; };
    return '<div style="text-align:center; padding-top:14px;">' +
      '<div style="width:74px; height:74px; border-radius:50%; background:#1FC77D; color:#fff; font-size:38px; display:flex; align-items:center; justify-content:center; margin:0 auto 22px;">✓</div>' +
      '<h3 style="font-family:' + FONT_H + '; font-weight:800; font-size:26px; color:#17152B; margin:0 0 10px;">You\'re on the calendar.</h3>' +
      '<p style="font-size:15px; color:#7a7783; margin:0 0 26px;">A confirmation email and calendar invite are on their way.</p>' +
      '<div style="background:#fff; border:2px solid #17152B; border-radius:16px; padding:22px; text-align:left; margin-bottom:22px;">' +
        row('Payment of <strong>' + dueToday() + '</strong> confirmed — ' + plan().name + ' plan') + row('Intake call scheduled: <strong>' + esc(S.slot) + '</strong>') + row('Calendar invite and receipt sent to your email', true) + '</div>' +
      '<div style="text-align:left; background:#FBF8F2; border-radius:14px; padding:18px; margin-bottom:22px;"><div style="font-family:' + FONT_H + '; font-weight:700; font-size:14px; color:#17152B; margin-bottom:10px;">What happens next</div><div style="font-size:14px; line-height:1.55; color:#55525f;">You\'ll get a confirmation email, I\'ll review your info before the call, and your site build begins immediately after we talk.</div></div>' +
      '<button type="button" data-tjsco="close" style="' + BTN_DARK + '">Done</button></div>';
  }

  function render() {
    renderProgress();
    var body = document.getElementById('tjsco-body');
    var keep = body.getAttribute('data-step') === String(S.step) ? body.scrollTop : 0;
    body.innerHTML = [null, stepSummary, stepPayment, stepCalendar, stepDone][S.step]();
    body.setAttribute('data-step', S.step);
    body.scrollTop = keep;
    if (S.step === 2) mountPayment();
  }

  // ---------- open / close ----------
  function open(opts) {
    opts = opts || {};
    ensureRoot();
    if (!S.open || S.step === 4) { S.step = 1; S.slot = ''; }
    if (opts.plan && PLANS[opts.plan]) S.plan = opts.plan;
    S.open = true;
    root.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    render();
    loadStripe(function () {});  // warm up Stripe while they review the summary
    var closeBtn = root.querySelector('button[data-tjsco="close"]');
    if (closeBtn) closeBtn.focus();
    if (window.gtag) try { window.gtag('event', 'begin_checkout', { value: dueCents() / 100, currency: 'USD', items: [{ item_id: S.plan, item_name: plan().name }] }); } catch (e) {}
  }
  function close() {
    if (paying) return; // don't let a mid-payment click dismiss the drawer
    S.open = false;
    if (root) root.style.display = 'none';
    document.body.style.overflow = '';
    elements = null; payEl = null;
  }

  // ---------- payment ----------
  function mountPayment() {
    elements = null; payEl = null;
    loadStripe(function () {
      var mount = document.getElementById('tjsco-payment-element');
      if (!mount || S.step !== 2) return;
      elements = stripe.elements({
        mode: 'subscription', currency: 'usd', amount: dueCents(),
        appearance: { theme: 'stripe', variables: { colorPrimary: '#2F6BFF', colorBackground: '#ffffff', colorText: '#17152B', colorDanger: '#e53e3e', fontFamily: 'DM Sans, sans-serif', borderRadius: '8px' } }
      });
      payEl = elements.create('payment');
      payEl.mount(mount);
    });
  }
  function showError(msg) {
    var el = document.getElementById('tjsco-error');
    if (!el) return;
    el.textContent = msg; el.style.display = msg ? 'block' : 'none';
  }
  function setLoading(on) {
    paying = on;
    var btn = document.getElementById('tjsco-pay');
    if (!btn) return;
    btn.disabled = on; btn.style.opacity = on ? '0.65' : '1'; btn.style.cursor = on ? 'wait' : 'pointer';
    btn.textContent = on ? 'Processing…' : 'Pay ' + dueToday() + ' →';
  }
  async function pay() {
    var nameEl = document.getElementById('tjsco-name'), emailEl = document.getElementById('tjsco-email');
    if (!nameEl || !emailEl) return;
    if (!elements || !payEl) { showError('The payment form is still loading — one moment.'); return; }
    var name = nameEl.value.trim(), email = emailEl.value.trim();
    if (!name) { showError('Please enter your full name.'); nameEl.focus(); return; }
    if (!email || email.indexOf('@') === -1) { showError('Please enter a valid email.'); emailEl.focus(); return; }
    setLoading(true); showError('');
    try {
      var submit = await elements.submit();
      if (submit.error) throw new Error(submit.error.message);
      var res = await fetch(WORKER + '/create-payment-intent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, plan: S.plan, agreed: S.agreed === true })
      });
      var data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Payment setup failed.');
      var confirm = await stripe.confirmPayment({
        elements: elements, clientSecret: data.clientSecret,
        confirmParams: { payment_method_data: { billing_details: { name: name, email: email } }, return_url: window.location.href },
        redirect: 'if_required'
      });
      if (confirm.error) throw new Error(confirm.error.message);
      customer = { name: name, email: email };
      // Best-effort notification to Trevor — never blocks the customer.
      fetch(WORKER + '/payment-confirmed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name, email: email, plan: S.plan, subscriptionId: data.subscriptionId || null })
      }).catch(function (e) { console.error('Payment notification failed (non-blocking):', e); });
      if (window.gtag) try { window.gtag('event', 'purchase', { value: dueCents() / 100, currency: 'USD', items: [{ item_id: S.plan, item_name: plan().name }] }); } catch (e) {}
      paying = false;
      S.step = 3; render(); loadSlots();
    } catch (err) {
      showError(err.message || 'Payment failed. Please try again.');
      setLoading(false);
    }
  }

  // ---------- calendar ----------
  async function loadSlots() {
    S.slotsLoading = true; S.slotsError = ''; S.slots = []; render();
    try {
      var res = await fetch(WORKER + '/calendar/slots');
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load slots');
      S.slots = (data.slots || []).slice(0, 10).map(function (s) {
        var start = new Date(s.start), end = new Date(start.getTime() + 30 * 60 * 1000);
        var tz = 'America/Denver';
        var date = start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: tz });
        var st = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
        var et = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' });
        return { start: s.start, date: date, startTime: st, time: st + ' – ' + et };
      });
    } catch (err) {
      S.slotsError = err.message || 'Could not load available times.';
    }
    S.slotsLoading = false;
    if (S.step === 3) render();
  }
  async function pickSlot(i) {
    var s = S.slots[i]; if (!s) return;
    var c = customer || {};
    try {
      await fetch(WORKER + '/calendar/book', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: c.name || 'Customer', email: c.email || '', slot: s.start })
      });
    } catch (e) { console.error('Book error:', e); }
    S.slot = s.date + ' at ' + s.startTime; S.step = 4; render();
  }

  // ---------- events ----------
  function onRootClick(e) {
    var t = e.target.closest('[data-tjsco]');
    if (!t) return;
    var act = t.getAttribute('data-tjsco');
    if (act === 'close') return close();
    if (act === 'plan') { S.plan = t.getAttribute('data-plan'); return render(); }
    if (act === 'agree') { S.agreed = t.checked; return render(); }
    if (act === 'to-payment') { if (!S.agreed) return; S.step = 2; return render(); }
    if (act === 'back') { S.step = 1; return render(); }
    if (act === 'pay') { e.preventDefault(); return pay(); }
    if (act === 'slot') return pickSlot(+t.getAttribute('data-i'));
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.open) close(); });

  // Any "Get My Website" link or button on the page opens the drawer.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = e.target.closest('[data-tjs-checkout], a, button');
    if (!el || (root && root.contains(el))) return;
    var flag = el.getAttribute('data-tjs-checkout');
    if (flag === null && !/^\s*Get My Website/i.test(el.textContent || '')) return;
    e.preventDefault();
    if (el.closest('.nav')) { var nav = el.closest('.nav'); nav.classList.remove('open'); }
    open({ plan: flag });
  });

  window.tjsOpenCheckout = open;
  window.tjsCloseCheckout = close;
  if (/[?&]checkout=1\b/.test(location.search)) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { open(); });
    else open();
  }
})();
