const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function app(storage = new Map()) {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\binit\(\);\s*$/, '');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'reserveRatio' ? '10' : '', textContent: '', innerHTML: '',
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  let downloaded = '';
  const document = {
    getElementById: element,
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() { return { click() { downloaded = context.__blob.parts.join(''); } }; },
    body: { appendChild() {}, removeChild() {} },
  };
  const context = vm.createContext({
    document, localStorage: { setItem(key, value) { storage.set(key, value); }, getItem(key) { return storage.get(key) ?? null; } },
    Blob: class { constructor(parts) { this.parts = parts; context.__blob = this; } },
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() {}, confirm() { return true; }, Date,
  });
  vm.runInContext(script, context);
  return { context, element, document, csv: () => downloaded.replace(/^\uFEFF/, '') };
}

test('editing quantity immediately refreshes the visible row subtotal', () => {
  const a = app();
  a.context.rows = [{ id: 1, name: '午餐', category: '餐饮', qty: 2, price: 10 }];
  const subtotal = { textContent: '20.00' };
  a.document.querySelector = selector => selector === '[data-id="1"][data-subtotal]' ? subtotal : null;
  a.context.updRow(1, 'qty', '3');
  assert.equal(subtotal.textContent, '30.00');
});

test('category subtotals are visible and reflect interleaved categories', () => {
  const a = app();
  a.context.rows = [
    { id: 1, name: '午餐', category: '餐饮', qty: 2, price: 10 },
    { id: 2, name: '海报', category: '宣传', qty: 1, price: 5 },
    { id: 3, name: '晚餐', category: '餐饮', qty: 3, price: 10 },
  ];
  a.context.renderSummary();
  assert.match(a.element('categorySummary').innerHTML, /餐饮[\s\S]*?50\.00/);
  assert.match(a.element('categorySummary').innerHTML, /宣传[\s\S]*?5\.00/);
  assert.equal(a.element('baseTotal').textContent, '¥55.00');
});

test('CSV category and grand totals refer to the actual spreadsheet rows', () => {
  const a = app();
  a.context.rows = [
    { id: 1, name: '午餐', category: '餐饮', qty: 2, price: 10 },
    { id: 2, name: '海报', category: '宣传', qty: 1, price: 5 },
    { id: 3, name: '晚餐', category: '餐饮', qty: 3, price: 10 },
  ];
  a.context.exportCSV();
  const lines = a.csv().split('\r\n');
  const row = label => lines.findIndex(line => line.startsWith(label + ',')) + 1;
  assert.match(lines[row('餐饮小计') - 1], /=E2\+E4$/);
  const base = row('基础合计'), ratio = row('备用金比例(%)'), reserve = row('备用金金额');
  assert.match(lines[base - 1], /^基础合计,,,,=SUM\(E2:E4\)$/);
  assert.match(lines[reserve - 1], new RegExp('=E' + ratio + '/100\\*E' + base + '$'));
  assert.match(lines[row('预算总额') - 1], new RegExp('=E' + base + '\\+E' + reserve + '$'));
});

test('CSV treats user-entered formula-like names as text', () => {
  const a = app();
  a.context.rows = [{ id: 1, name: '=1+2', category: '餐饮', qty: 1, price: 1 }];
  a.context.exportCSV();
  assert.match(a.csv().split('\r\n')[1], /^'=1\+2,餐饮,1,1\.00,=C2\*D2$/);
});

test('invalid numeric input remains blocked after restoring local storage', () => {
  const storage = new Map();
  const first = app(storage);
  first.context.rows = [{ id: 1, name: '午餐', category: '餐饮', qty: 2, price: 10 }];
  first.context.updRow(1, 'qty', '-2');
  const reopened = app(storage);
  assert.equal(reopened.context.restore(), true);
  assert.equal(reopened.context.hasErr(), true);
  reopened.context.exportCSV();
  assert.equal(reopened.csv(), '');
});
