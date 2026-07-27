// Проставляє «Джерело замовлення» у SalesDrive за дзвінками Binotel.
// Ідея: різні номери компанії розміщені на різних майданчиках (OLX, Prom, сайт…),
// тож джерело заявки = номер, НА який подзвонив клієнт. Скрипт бере заявки з
// порожнім джерелом, знаходить у журналі Binotel останній дзвінок клієнта перед
// створенням заявки і за мапою «номер компанії → джерело» оновлює поле в CRM.
//
// Запуск:  node source-tracker.js [--dry-run] [--days=7]
//   --dry-run  показує, що БУЛО Б оновлено (плюс довідкові дані для налаштування),
//              нічого не змінює в CRM. Прогоняй перший запуск саме так.
//   --days=N   за скільки днів брати заявки (типово LOOKBACK_DAYS або 3).
//
// Fail-safe: скрипт лише ЗАПОВНЮЄ порожнє поле і ніколи не перезаписує вже
// проставлене джерело. Будь-яка помилка на одній заявці не зупиняє решту.

process.env.TZ = process.env.TZ || 'Europe/Kyiv'; // час заявок SalesDrive — київський

const fs = require('fs');
const path = require('path');

// --- Налаштування (Railway → Variables) ---
const SD_DOMAIN   = (process.env.SD_DOMAIN || 'komplektom.salesdrive.me').replace(/^https?:\/\//, '').replace(/\/+$/, '');
const SD_API_KEY  = process.env.SD_API_KEY || '';          // SalesDrive → Налаштування → Форми/API (ключ форми)
const SOURCE_FIELD = process.env.SOURCE_FIELD || 'dzereloZamovlenna'; // машинна назва поля «Джерело замовлення»
const BINOTEL_KEY    = process.env.BINOTEL_KEY || '';      // видає менеджер Binotel або support@binotel.com (у кабінеті ключів немає)
const BINOTEL_SECRET = process.env.BINOTEL_SECRET || '';
const GRACE_MIN = parseInt(process.env.MATCH_GRACE_MIN || '30', 10); // дзвінок, що почався до заявки + стільки хвилин після, ще зараховується

const DRY  = process.argv.includes('--dry-run');
const daysArg = process.argv.find(function(a){ return a.indexOf('--days=') === 0; });
const DAYS = Math.max(1, parseInt((daysArg ? daysArg.slice(7) : '') || process.env.LOOKBACK_DAYS || '3', 10));

// Мапа «номер компанії → джерело»: env NUMBER_SOURCE_MAP (JSON) або файл source-map.json поряд.
// Значення — ТЕКСТ опції поля (напр. "OLX") або одразу id опції (число).
function loadSourceMap(){
  let raw = process.env.NUMBER_SOURCE_MAP || '';
  if (!raw) {
    const f = path.join(__dirname, 'source-map.json');
    if (fs.existsSync(f)) raw = fs.readFileSync(f, 'utf8');
  }
  if (!raw) throw new Error('Немає мапи номерів: задай NUMBER_SOURCE_MAP (JSON) або поклади source-map.json (див. source-map.example.json).');
  const m = JSON.parse(raw);
  const out = {};
  Object.keys(m).forEach(function(k){ const nk = normPhone(k); if (nk) out[nk] = m[k]; });
  if (!Object.keys(out).length) throw new Error('Мапа номерів порожня або номери не розпізнано.');
  return out;
}

// Нормалізація номера: лише цифри, останні 9 (0671234567 = 380671234567 = +38 067 123 45 67).
function normPhone(s){
  const d = String(s == null ? '' : s).replace(/\D+/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}
function sleep(ms){ return new Promise(function(res){ setTimeout(res, ms); }); }
function fmt(ts){ return new Date(ts * 1000).toLocaleString('uk-UA'); }

async function fetchJson(url, opts, timeoutMs){
  const ctrl = new AbortController();
  const t = setTimeout(function(){ ctrl.abort(); }, timeoutMs || 60000);
  try {
    const r = await fetch(url, Object.assign({}, opts, { signal: ctrl.signal }));
    const text = await r.text();
    let d; try { d = text ? JSON.parse(text) : {}; } catch(e){ throw new Error('Не-JSON відповідь (HTTP ' + r.status + '): ' + text.slice(0, 200)); }
    if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + (d.message || text.slice(0, 200)));
    return d;
  } finally { clearTimeout(t); }
}

// --- SalesDrive ---
function sdUrl(p){ return 'https://' + SD_DOMAIN + p; }

// Список заявок за період. Порожнє джерело фільтруємо на своєму боці —
// так не залежимо від підтримки __EMPTY__ у конкретній версії API.
async function sdOrders(fromDate){
  const all = [];
  let lastResponse = null;
  for (let page = 1; page <= 50; page++) {
    const qs = 'page=' + page + '&limit=100'
      + '&filter[orderTime][from]=' + encodeURIComponent(fromDate + ' 00:00:00')
      + '&filter[statusId]=' + encodeURIComponent('__NOTDELETED__');
    const d = await fetchJson(sdUrl('/api/order/list/?' + qs), {
      headers: { 'Form-Api-Key': SD_API_KEY, 'Accept': 'application/json' }
    });
    lastResponse = d;
    const list = Array.isArray(d.data) ? d.data : (Array.isArray(d.orders) ? d.orders : []);
    all.push.apply(all, list);
    if (list.length < 100) break;
    await sleep(300);
  }
  return { orders: all, lastResponse: lastResponse };
}

// Всі телефони заявки (контакти + можливі плоскі поля), нормалізовані.
function orderPhones(o){
  const out = [];
  function add(v){ const n = normPhone(v); if (n && out.indexOf(n) < 0) out.push(n); }
  let cs = o && o.contacts; if (cs && !Array.isArray(cs)) cs = [cs];
  (cs || []).forEach(function(c){
    let ph = c && c.phone; if (ph == null) return;
    (Array.isArray(ph) ? ph : [ph]).forEach(add);
  });
  if (o && o.phone != null) (Array.isArray(o.phone) ? o.phone : [o.phone]).forEach(add);
  return out;
}

function isEmptySource(v){
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

// Час заявки -> epoch (сек). orderTime у форматі "YYYY-MM-DD HH:MM:SS" (київський час).
function orderEpoch(o){
  const s = String(o.orderTime || o.createdAt || '').trim();
  const t = Date.parse(s.replace(' ', 'T'));
  return isNaN(t) ? null : Math.floor(t / 1000);
}

// Шукає у відповіді order/list довідник опцій поля (щоб текст "OLX" -> id опції).
// Структура meta відрізняється між версіями — тому шукаємо рекурсивно будь-який
// вузол, що описує наше поле і має options: [{value, text}].
function findFieldOptions(root, field){
  const seen = new Set();
  function walk(node){
    if (!node || typeof node !== 'object' || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const it of node) { const r = walk(it); if (r) return r; }
      return null;
    }
    const isOurs = node.name === field || node.code === field || node.alias === field || node.uuid === field;
    if (isOurs && Array.isArray(node.options)) return node.options;
    if (node[field] && typeof node[field] === 'object' && Array.isArray(node[field].options)) return node[field].options;
    for (const k of Object.keys(node)) { const r = walk(node[k]); if (r) return r; }
    return null;
  }
  return walk(root);
}

// Значення мапи -> значення для API: число/числовий рядок шлемо як є (id опції),
// текст пробуємо знайти серед опцій поля.
function resolveSourceValue(confValue, options){
  if (typeof confValue === 'number') return confValue;
  const s = String(confValue).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const low = s.toLowerCase();
  for (const op of (options || [])) {
    const text = String(op.text != null ? op.text : (op.label != null ? op.label : '')).trim().toLowerCase();
    if (text === low) return op.value != null ? op.value : op.id;
  }
  return null;
}

async function sdUpdateSource(orderId, value){
  const body = { id: orderId, data: {} };
  body.data[SOURCE_FIELD] = value;
  return fetchJson(sdUrl('/api/order/update/'), {
    method: 'POST',
    headers: { 'Form-Api-Key': SD_API_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
}

// --- Binotel ---
// Журнал дзвінків за період; Binotel віддає максимум 24 години за запит — ріжемо добами.
async function binotelCalls(fromEpoch, toEpoch){
  const calls = [];
  for (let t = fromEpoch; t < toEpoch; t += 86400) {
    const stop = Math.min(t + 86400 - 1, toEpoch);
    const d = await fetchJson('https://api.binotel.com/api/4.0/stats/list-of-calls-for-period.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: BINOTEL_KEY, secret: BINOTEL_SECRET, startTime: t, stopTime: stop })
    });
    if (String(d.status).toLowerCase() !== 'success') throw new Error('Binotel: ' + (d.message || JSON.stringify(d).slice(0, 200)));
    const det = d.callDetails || {};
    const arr = Array.isArray(det) ? det : Object.keys(det).map(function(k){ return det[k]; });
    calls.push.apply(calls, arr);
    await sleep(300);
  }
  return calls;
}

// Номер компанії, на який подзвонив клієнт (назва поля відрізняється залежно від
// налаштувань акаунта — перевіряємо відомі варіанти).
function companyNumberOf(call){
  return normPhone(call.trunkNumber || call.pbxNumber || call.companyNumber || call.didNumber || '');
}
function isIncoming(call){
  if (call.callType == null) return true; // немає поля — не відсіюємо
  return String(call.callType) === '0';   // 0 = вхідний
}

async function notify(text){
  const token = process.env.TG_BOT_TOKEN || process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetchJson('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true })
    }, 8000);
  } catch (e) { console.error('Telegram: не вдалось надіслати —', e.message); }
}

async function main(){
  if (!SD_API_KEY) throw new Error('Постав SD_API_KEY (ключ API форми в SalesDrive).');
  if (!BINOTEL_KEY || !BINOTEL_SECRET) throw new Error('Постав BINOTEL_KEY і BINOTEL_SECRET (кабінет Binotel → API).');
  const srcMap = loadSourceMap();
  console.log((DRY ? '[dry-run] ' : '') + 'SalesDrive:', SD_DOMAIN, '| поле:', SOURCE_FIELD, '| заявки за', DAYS, 'дн.');
  console.log('Номерів у мапі:', Object.keys(srcMap).length);

  const now = Math.floor(Date.now() / 1000);
  const fromOrders = new Date((now - DAYS * 86400) * 1000);
  const fromDate = fromOrders.getFullYear() + '-' + String(fromOrders.getMonth() + 1).padStart(2, '0') + '-' + String(fromOrders.getDate()).padStart(2, '0');

  const { orders, lastResponse } = await sdOrders(fromDate);
  const empty = orders.filter(function(o){ return isEmptySource(o[SOURCE_FIELD]); });
  console.log('Заявок за період:', orders.length, '| з порожнім джерелом:', empty.length);
  if (!empty.length) { console.log('Нема чого проставляти ✔'); return; }

  // Дзвінки беремо з запасом у 2 доби ДО вікна заявок: дзвінок міг бути раніше за заявку.
  const calls = await binotelCalls(now - (DAYS + 2) * 86400, now);
  const incoming = calls.filter(isIncoming);
  console.log('Дзвінків у Binotel за період:', calls.length, '| вхідних:', incoming.length);
  if (DRY && incoming.length) console.log('Приклад запису дзвінка (для звірки полів):', JSON.stringify(incoming[0]));

  // Мапа: номер клієнта -> [{час, номер компанії}]
  const byClient = new Map();
  const unmappedCompanyNums = {};
  for (const c of incoming) {
    const client = normPhone(c.externalNumber);
    const company = companyNumberOf(c);
    const t = parseInt(c.startTime, 10);
    if (!client || !company || isNaN(t)) continue;
    if (!srcMap[company]) { unmappedCompanyNums[company] = (unmappedCompanyNums[company] || 0) + 1; continue; }
    if (!byClient.has(client)) byClient.set(client, []);
    byClient.get(client).push({ t: t, company: company });
  }

  // Довідник опцій поля-джерела (текст -> id), якщо API віддає meta.
  const options = findFieldOptions(lastResponse, SOURCE_FIELD);
  if (DRY) console.log('Опції поля «' + SOURCE_FIELD + '»:', options ? JSON.stringify(options) : 'не знайдено у відповіді API (використовуй id опцій у мапі)');

  let updated = 0, noCall = 0, failed = 0, unresolved = 0;
  for (const o of empty) {
    const oid = o.id || o.orderId;
    const oe = orderEpoch(o);
    const phones = orderPhones(o);
    if (oid == null || oe == null || !phones.length) { noCall++; continue; }

    // останній дзвінок клієнта, що почався до створення заявки (+ невеликий запас)
    let best = null;
    for (const p of phones) {
      for (const c of (byClient.get(p) || [])) {
        if (c.t <= oe + GRACE_MIN * 60 && (!best || c.t > best.t)) best = c;
      }
    }
    if (!best) { noCall++; continue; }

    const conf = srcMap[best.company];
    const value = resolveSourceValue(conf, options);
    if (value == null) {
      unresolved++;
      console.log('  ⚠ заявка #' + oid + ': джерело "' + conf + '" не знайдено серед опцій поля — пропускаю (впиши точний текст опції або її id у мапу).');
      continue;
    }
    if (DRY) {
      console.log('  [dry-run] #' + oid + ' (' + (o.orderTime || '') + '): дзвінок ' + fmt(best.t) + ' на ' + best.company + ' → «' + conf + '» (значення ' + value + ')');
      updated++;
      continue;
    }
    try {
      await sdUpdateSource(oid, value);
      updated++;
      console.log('  ✔ #' + oid + ': джерело → «' + conf + '» (дзвінок ' + fmt(best.t) + ' на ' + best.company + ')');
    } catch (e) {
      if (/429/.test(e.message)) { await sleep(5000); try { await sdUpdateSource(oid, value); updated++; continue; } catch (e2) { e = e2; } }
      failed++;
      console.error('  ✖ #' + oid + ':', e.message);
    }
    await sleep(350);
  }

  const un = Object.keys(unmappedCompanyNums);
  if (un.length) console.log('Дзвінки на номери ПОЗА мапою (додай у source-map, якщо треба): ' + un.map(function(n){ return n + ' (' + unmappedCompanyNums[n] + ')'; }).join(', '));

  const sum = (DRY ? '[dry-run] ' : '') + 'Джерела: оновлено ' + updated + ' із ' + empty.length +
    ' | без дзвінка: ' + noCall + (unresolved ? ' | не розпізнано джерело: ' + unresolved : '') + (failed ? ' | помилок: ' + failed : '');
  console.log(sum);
  if (!DRY && (updated || failed)) await notify((failed ? '⚠' : '✅') + ' source-tracker: ' + sum);
}

module.exports = { normPhone, orderPhones, isEmptySource, orderEpoch, findFieldOptions, resolveSourceValue, companyNumberOf };
if (require.main === module) main().catch(async function(e){
  console.error('Помилка:', e.message);
  await notify('❌ source-tracker: ' + e.message);
  process.exit(1);
});
