(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { errors: [], steps: {} };
  window.addEventListener('unhandledrejection', (e) => out.errors.push('REJECT: ' + ((e.reason && e.reason.stack) || e.reason)));
  window.addEventListener('error', (e) => out.errors.push('ERROR: ' + e.message + '\n' + ((e.error && e.error.stack) || '')));

  const clickSave = async (waitMs = 2200) => {
    document.querySelector('.modal footer [data-act="save"]').click();
    await sleep(waitMs);
    return (document.querySelector('#toast-root .toast') || {}).innerText || '';
  };

  /* ---- 1. 出貨登錄 ---- */
  location.hash = '#/shipments';
  await sleep(1600);
  document.getElementById('btn-new').click();
  await sleep(1500);
  let body = document.querySelector('.modal .body');
  const osel = body.querySelector('[name="order_id"]');
  osel.value = osel.options[0].value;
  let el = body.querySelector('[name="ship_date"]'); el.value = '2026-09-20'; el.dispatchEvent(new Event('input', { bubbles: true }));
  el = body.querySelector('[name="declaration_no"]'); el.value = 'DECL-WALK-01'; el.dispatchEvent(new Event('input', { bubbles: true }));
  el = body.querySelector('[name="invoice_no"]'); el.value = 'INV-WALK-01'; el.dispatchEvent(new Event('input', { bubbles: true }));
  out.steps.shipToast = await clickSave(2600);

  /* ---- 2. 產生應收 ---- */
  location.hash = '#/receivables';
  await sleep(1800);
  document.getElementById('btn-gen').click();
  await sleep(1500);
  body = document.querySelector('.modal .body');
  const gsel = body.querySelector('[name="order_id"]');
  gsel.value = gsel.options[0].value;
  out.steps.arToast = await clickSave(2800);

  const ars = await MJ.api.get('/receivables');
  out.steps.ar = ars.map((a) => ({
    no: a.receivable_no, billing: a.billing_month, recv: a.receivable_month,
    due: a.due_date, amount: a.amount_base, status: a.status, aging: a.aging,
  }));

  /* ---- 3. 收款 ---- */
  location.hash = '#/receivables';
  await sleep(1800);
  const recBtn = document.querySelector('#list [data-rec]');
  out.steps.hasRecvBtn = !!recBtn;
  if (recBtn) {
    recBtn.click();
    await sleep(1500);
    body = document.querySelector('.modal .body');
    out.steps.recvAmountPrefill = body.querySelector('[name="amount"]').value;
    const rd = body.querySelector('[name="received_date"]'); rd.value = '2026-11-29'; rd.dispatchEvent(new Event('input', { bubbles: true }));
    out.steps.payToast = await clickSave(2800);
  }

  const ars2 = await MJ.api.get('/receivables');
  out.steps.arAfter = ars2.map((a) => ({ no: a.receivable_no, status: a.status, received: a.received_amount, confirmed: a.confirmed }));
  const orders = await MJ.api.get('/orders');
  out.steps.orderStatus = orders.map((o) => o.order_no + '=' + o.status);
  return JSON.stringify(out, null, 1);
})()
