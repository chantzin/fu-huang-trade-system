(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { errors: [], steps: {} };
  window.addEventListener('unhandledrejection', (e) => out.errors.push('REJECT: ' + ((e.reason && e.reason.stack) || e.reason)));
  window.addEventListener('error', (e) => out.errors.push('ERROR: ' + e.message + '\n' + ((e.error && e.error.stack) || '')));

  location.hash = '#/orders';
  await sleep(1600);
  document.getElementById('btn-new').click();
  await sleep(1600);

  const body = document.querySelector('.modal .body');
  if (!body) { out.steps.modal = 'NOT OPEN'; return JSON.stringify(out, null, 1); }

  const set = (sel, v) => {
    const el = body.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set('[name="order_date"]', '2026-08-10');
  const cust = body.querySelector('[name="customer_id"]');
  cust.value = cust.options[1].value;
  cust.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1600);
  out.steps.currency = body.querySelector('[name="currency"]').value;
  out.steps.rate = body.querySelector('[name="exchange_rate"]').value;
  out.steps.terms = body.querySelector('[name="payment_terms"]').value;

  const rows = body.querySelectorAll('#items-tbl tbody tr');
  const setRow = (i, f, v) => {
    const el = rows[i].querySelector('[data-f="' + f + '"]');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  setRow(0, 'part_no', 'PWALK001');
  setRow(0, 'qty', '1000');
  setRow(0, 'unit_price', '10');
  setRow(0, 'cost_unit', '100');
  setRow(0, 'other_fee', '500');
  setRow(0, 'freight_cn', '3000');
  setRow(0, 'freight_tw', '1500');
  await sleep(600);
  const r0 = rows[0];
  out.steps.calc = {
    amount: r0.querySelector('[data-d="amount"]').innerText,
    total: r0.querySelector('[data-d="total"]').innerText,
    totalBase: r0.querySelector('[data-d="totalBase"]').innerText,
    costTotal: r0.querySelector('[data-d="costTotal"]').innerText,
    profit: r0.querySelector('[data-d="profit"]').innerText,
    margin: r0.querySelector('[data-d="margin"]').innerText,
  };

  document.querySelector('.modal footer [data-act="save"]').click();
  await sleep(1400);
  out.steps.toast = (document.querySelector('#toast-root .toast') || {}).innerText || '';
  await sleep(1800);

  const list = await MJ.api.get('/orders?with_items=1');
  out.steps.orders = list.map((o) => ({
    no: o.order_no, month: o.month, status: o.status,
    total_base: o.totals && o.totals.total_base,
    profit: o.totals && o.totals.profit,
  }));
  return JSON.stringify(out, null, 1);
})()
