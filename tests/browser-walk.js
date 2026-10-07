(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { errors: [], views: {} };
  window.addEventListener('unhandledrejection', (e) =>
    out.errors.push('REJECT: ' + ((e.reason && e.reason.message) || e.reason)));
  window.addEventListener('error', (e) => out.errors.push('ERROR: ' + e.message));

  const views = ['dashboard', 'orders', 'shipments', 'receivables', 'customers', 'products', 'suppliers', 'reports', 'admin'];
  for (const v of views) {
    location.hash = '#/' + v;
    await sleep(1300);
    const c = document.getElementById('content');
    const txt = (c && c.innerText) || '';
    out.views[v] = { len: txt.length, fail: /載入失敗/.test(txt), empty: /沒有資料|尚無/.test(txt) };
  }
  // 開一張訂單的新增 Modal，檢查表單與即時計算是否可用
  location.hash = '#/orders';
  await sleep(1200);
  document.getElementById('btn-new').click();
  await sleep(1200);
  const modal = document.querySelector('.modal');
  out.modal = { open: !!modal, title: modal ? modal.querySelector('header span').innerText : '' };
  if (modal) {
    const body = modal.querySelector('.body');
    // 填入模擬資料
    const set = (sel, val) => { const el = body.querySelector(sel); if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } };
    set('[name="order_date"]', '2026-08-10');
    // 選第一個客戶
    const cust = body.querySelector('[name="customer_id"]');
    if (cust && cust.options.length > 1) { cust.value = cust.options[1].value; cust.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(600);
    const rows = body.querySelectorAll('#items-tbl tbody tr');
    out.items = { rows: rows.length };
    if (rows.length) {
      const qty = rows[0].querySelector('[data-f="qty"]');
      const price = rows[0].querySelector('[data-f="unit_price"]');
      const cost = rows[0].querySelector('[data-f="cost_unit"]');
      qty.value = '1000'; qty.dispatchEvent(new Event('input', { bubbles: true }));
      price.value = '10'; price.dispatchEvent(new Event('input', { bubbles: true }));
      cost.value = '100'; cost.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(400);
      out.calc = {
        amount: rows[0].querySelector('[data-d="amount"]').innerText,
        total: rows[0].querySelector('[data-d="total"]').innerText,
        totalBase: rows[0].querySelector('[data-d="totalBase"]').innerText,
        profit: rows[0].querySelector('[data-d="profit"]').innerText,
        margin: rows[0].querySelector('[data-d="margin"]').innerText,
        sumBase: body.querySelector('#s-totalBase').innerText,
      };
    }
  }
  return JSON.stringify(out, null, 1);
})()
