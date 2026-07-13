// Автооновлення пошуку: качає фід Horoshop і заливає товари в Meilisearch.
// На Railway запускається командою `npm start` (node indexer.js) — за розкладом (Cron).
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');

// --- Налаштування (значення вже вписані; за потреби можна перевизначити через Variables) ---
const DEFAULT_FEED = 'https://www.lartek.com.ua/content/export/def50f4a67a9cdf49099014837c8ba76.xml';
const DEFAULT_HOST = 'https://getmeilimeilisearchv190-production-7c60.up.railway.app';

const FEED       = process.argv[2] || process.env.FEED_URL || DEFAULT_FEED;
const MEILI_HOST = (process.env.MEILI_HOST || DEFAULT_HOST).replace(/\/+$/, '');
const MEILI_KEY  = process.env.MEILI_KEY || '';
const INDEX      = process.env.MEILI_INDEX || 'products';
// Сумісні моделі беремо з models-api (щоб пошук по сайту знаходив товар за номером
// техніки, хоча списку вже нема в описі). Приховане поле: шукається, але не показується.
const MODELS_API_URL = (process.env.MODELS_API_URL || '').replace(/\/+$/, '');
const MODELS_API_KEY = process.env.MODELS_API_KEY || '';

function clean(s){ return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

// Канонічний розмір: групу «число (× число){1..3}» зводимо до ВПОРЯДКОВАНОГО набору
// чисел через 'x', десятковий роздільник -> 'p'. Порядок і символ множення неважливі:
//   12,5*5*32  =  5*12,5*32  =  5x12,5x32  ->  5x12p5x32
//   30*52*10   =  10x52x30              ->  10x30x52
// Парт-номер 305210 (без роздільника) не чіпається; списки кодів через кому/плюс — теж.
function normDims(s){
  s = String(s == null ? '' : s);
  return s.replace(/(\d+(?:[.,]\d+)?)((?:[ \t]*[*x×хХ·∙•⋅✕✖⨯][ \t]*\d+(?:[.,]\d+)?){1,3})/gi, function(full){
    var nums = full.split(/[ \t]*[*x×хХ·∙•⋅✕✖⨯][ \t]*/i)
      .map(function(t){ return parseFloat(t.replace(',', '.')); })
      .filter(function(v){ return !isNaN(v); });
    if (nums.length < 2) return full;
    nums.sort(function(a, b){ return a - b; });
    return nums.map(function(v){ return String(v).replace('.', 'p'); }).join('x');
  });
}
// Усі впорядковані підкомбінації (розміру 2..n) набору чисел -> канонічні токени.
// Це дає пошук за ЧАСТИНОЮ розміру: 37*66*9,5 -> "37x66", "9p5x37", "9p5x66", "9p5x37x66".
function dimCombos(nums){
  var res = [], n = nums.length, idx = [];
  function rec(start, k){
    if (idx.length === k) {
      res.push(idx.map(function(i){ return nums[i]; }).sort(function(a, b){ return a - b; })
                  .map(function(v){ return String(v).replace('.', 'p'); }).join('x'));
      return;
    }
    for (var i = start; i < n; i++) { idx.push(i); rec(i + 1, k); idx.pop(); }
  }
  for (var k = 2; k <= n; k++) rec(0, k);
  return res;
}
// Витягує токени розмірів (повний + усі підкомбінації) з назви.
function dimsOf(text){
  var s = String(text == null ? '' : text).toLowerCase();
  var seen = {}, out = [], re = /(\d+(?:[.,]\d+)?)((?:[ \t]*[*x×хХ·∙•⋅✕✖⨯][ \t]*\d+(?:[.,]\d+)?){1,3})/gi, m;
  while ((m = re.exec(s))) {
    var nums = m[0].split(/[ \t]*[*x×хХ·∙•⋅✕✖⨯][ \t]*/i)
      .map(function(t){ return parseFloat(t.replace(',', '.')); })
      .filter(function(v){ return !isNaN(v); });
    if (nums.length < 2) continue;
    dimCombos(nums).forEach(function(tok){ if (!seen[tok]) { seen[tok] = 1; out.push(tok); } });
  }
  return out.join(' ');
}

async function readSource(src){
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': 'application/xml,text/xml,*/*'
    }});
    if (!r.ok) throw new Error('HTTP ' + r.status + ' при завантаженні фіда (можливо, Horoshop заблокував сервер)');
    return await r.text();
  }
  return fs.readFileSync(src, 'utf8');
}

// будує мапу id -> {name, parent} з блоку <categories>
function buildCategoryMap(shop){
  let cats = (shop.categories && shop.categories.category) || [];
  if (!Array.isArray(cats)) cats = [cats];
  const map = {};
  for (const c of cats){
    if (c == null) continue;
    if (typeof c !== 'object'){ continue; }
    const id = String(c['@_id'] != null ? c['@_id'] : '');
    const name = clean(c['#text'] != null ? c['#text'] : (c.__cdata != null ? c.__cdata : ''));
    if (id) map[id] = { name: name, parent: (c['@_parentId'] != null ? String(c['@_parentId']) : null) };
  }
  return map;
}

// Тягне сумісні моделі з models-api: Map(sku -> "MODEL1 MODEL2 …").
// Fail-safe: якщо URL не заданий або сервіс недоступний — повертає порожню мапу
// і індексація йде далі (пошук за моделлю просто не оновиться цього разу).
async function fetchModelsMap(){
  if (!MODELS_API_URL) { console.log('MODELS_API_URL не заданий — поле моделей пропускаю.'); return new Map(); }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(function(){ ctrl.abort(); }, 60000);
    const r = await fetch(MODELS_API_URL + '/api/export', {
      headers: { 'X-Import-Key': MODELS_API_KEY, 'Accept': 'application/json' },
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const map = new Map();
    for (const it of (d.items || [])) {
      if (it && it.sku) map.set(String(it.sku).trim(), (it.models || []).join(' '));
    }
    console.log('Сумісність з models-api: товарів', map.size, '| рядків', d.count || '?');
    return map;
  } catch (e) {
    console.error('models-api недоступний (' + e.message + ') — поле моделей не оновлюю цього разу.');
    return new Map();
  }
}

// XML -> масив документів для Meilisearch
function toDocs(xml, modelsMap){
  const models = modelsMap || new Map();
  const parser = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:'@_', cdataPropName:'__cdata', parseTagValue:false });
  const data = parser.parse(xml);
  const shop = (data && (data.yml_catalog?.shop || data.shop)) || {};
  const catMap = buildCategoryMap(shop);

  let offers = shop.offers?.offer || [];
  if (!Array.isArray(offers)) offers = [offers];

  return offers.map(function(o){
    const name = clean(o.name && (o.name.__cdata ?? o.name));
    const desc = clean(o.description && (o.description.__cdata ?? o.description));
    let pic = o.picture;
    if (Array.isArray(pic)) pic = pic[0];

    let cid = o.categoryId;
    if (Array.isArray(cid)) cid = cid[0];
    cid = (cid != null ? String(cid).trim() : '');
    const cat = catMap[cid] ? catMap[cid].name : '';
    // батьківська категорія (для майбутнього групування), якщо є
    let parentName = '';
    if (catMap[cid] && catMap[cid].parent && catMap[catMap[cid].parent]) {
      parentName = catMap[catMap[cid].parent].name;
    }

    const skuKey = clean(o.vendorCode);
    return {
      id:          String(o['@_id']),
      sku:         skuKey,
      name:        name,
      models:      models.get(skuKey) || '',   // приховане пошукове поле (не показується)
      dims:        dimsOf(name),
      vendor:      clean(o.vendor),
      category:    cat,
      categoryParent: parentName,
      price:       Number(o.price) || 0,
      url:         clean(o.url),
      picture:     clean(pic),
      available:   String(o['@_available']) === 'true',
      instock:     String(o['@_available']) === 'true' ? 1 : 0,  // числове дублювання для правила ранжування
      description: desc
    };
  }).filter(function(d){ return d.id && d.name; });
}

const SETTINGS = {
  // sku, models і dims — перші: пріоритет пошуку за артикулом, сумісною моделлю і розміром.
  // 'models' — приховане поле (є в searchable, немає в displayed): знаходить товар за
  // номером техніки, але список НЕ віддається в браузер і ніде не показується.
  searchableAttributes: ['sku','models','dims','name','vendor','category','description'],
  filterableAttributes: ['vendor','available','category','categoryParent'],
  sortableAttributes:   ['price','available','instock'],
  // Наявність — ПЕРШЕ правило: товари «в наявності» завжди зверху, а релевантність
  // (words/typo/…) упорядковує вже всередині кожної групи. Товари «немає» — нижче.
  rankingRules:         ['instock:desc','words','typo','proximity','attribute','sort','exactness'],
  displayedAttributes:  ['id','sku','name','vendor','category','categoryParent','price','url','picture','available'],
  // без одруківок на кодах/розмірах/моделях; знято ліміт 1000
  typoTolerance:        { enabled:true, disableOnAttributes:['sku','models','dims','description'], minWordSizeForTypos:{ oneTypo:5, twoTypos:9 } },
  pagination:           { maxTotalHits: 100000 }
};

// ── ГАРД: не дати битому/анти-бот фіду затерти пошук ──
// Фід має бути XML з товарами; інакше — не чіпаємо індекс.
function assertFeedSane(xml){
  if (typeof xml !== 'string' || xml.indexOf('<offer') === -1) {
    throw new Error('Фід не містить <offer> — віддано не XML (анти-бот заглушка або збій експорту). Індекс НЕ змінено.');
  }
}
// Кількість товарів має бути адекватна (абсолютний мінімум + без різкого падіння).
function assertCountsSane(newCount, currentCount, minDocs, maxDrop){
  if (newCount < minDocs) {
    throw new Error('Замало товарів (' + newCount + ' < ' + minDocs + ') — фід підозрілий. Індекс НЕ змінено.');
  }
  if (currentCount && newCount < currentCount * (1 - maxDrop)) {
    throw new Error('Різке падіння кількості (' + currentCount + ' → ' + newCount + ', більше ' +
      Math.round(maxDrop*100) + '%) — фід підозрілий. Індекс НЕ змінено.');
  }
}

// Telegram-сповіщення (heartbeat). Токен і chat_id — у Railway → Variables.
// Якщо не задані — тихо нічого не робить. Помилка сповіщення НІКОЛИ не ламає індексацію.
async function notify(text){
  const token = process.env.TG_BOT_TOKEN || process.env.TG_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(function(){ ctrl.abort(); }, 8000);
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text, disable_web_page_preview: true }),
      signal: ctrl.signal
    });
    clearTimeout(t);
  } catch (e) { console.error('Telegram: не вдалось надіслати —', e.message); }
}

async function meili(method, path, body){
  const r = await fetch(MEILI_HOST + path, {
    method,
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + MEILI_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text(); const d = t ? JSON.parse(t) : {};
  if (!r.ok) { const e = new Error(d.message || ('HTTP ' + r.status)); e.status = r.status; throw e; }
  return d;
}
async function waitTask(uid){
  if (uid == null) return;
  for (let i=0;i<600;i++){
    const t = await meili('GET','/tasks/'+uid);
    if (t.status === 'succeeded') return;
    if (t.status === 'failed') throw new Error('Завдання не виконалось: ' + JSON.stringify(t.error));
    await new Promise(function(res){ setTimeout(res, 800); });
  }
  throw new Error('Завдання ' + uid + ' не завершилось вчасно');
}
async function docCount(uid){
  try { const s = await meili('GET','/indexes/'+uid+'/stats'); return s.numberOfDocuments || 0; }
  catch(e){ if (e.status === 404) return null; throw e; }
}
async function ensureIndex(uid){
  try { const r = await meili('POST','/indexes', { uid: uid, primaryKey: 'id' }); await waitTask(r.taskUid); }
  catch(e){ if (!/already exists|index_already_exists/i.test(e.message)) { /* ігноруємо «вже існує» */ } }
}
async function deleteIndex(uid){
  try { const r = await meili('DELETE','/indexes/'+uid); await waitTask(r.taskUid); } catch(e){}
}
async function uploadDocs(uid, docs){
  const BATCH = 1000;
  for (let i=0;i<docs.length;i+=BATCH){
    const part = docs.slice(i, i+BATCH);
    const r = await meili('POST','/indexes/'+uid+'/documents', part);
    await waitTask(r.taskUid);
    console.log('  залито', Math.min(i+BATCH, docs.length), '/', docs.length);
  }
}

async function main(){
  if (!MEILI_KEY) { console.error('Постав змінну MEILI_KEY (майстер-ключ Meilisearch).'); process.exit(1); }
  console.log('Meilisearch:', MEILI_HOST, '| індекс:', INDEX);
  console.log('Фід:', FEED);

  console.log('Читаю фід…');
  const xml = await readSource(FEED);
  assertFeedSane(xml);                      // гард #1: це справді фід?
  const modelsMap = await fetchModelsMap(); // сумісні моделі з models-api (fail-safe)
  const docs = toDocs(xml, modelsMap);
  const withModels = docs.filter(function(d){ return d.models; }).length;
  console.log('Товарів у фіді:', docs.length, '| з сумісними моделями:', withModels);

  const catset = new Set(docs.map(function(d){ return d.category; }).filter(Boolean));
  console.log('Категорій знайдено:', catset.size, '| напр.:', Array.from(catset).slice(0,5).join(' | '));

  // гард #2: кількість адекватна і без різкого падіння?
  const current = await docCount(INDEX);    // null якщо індексу ще нема
  const MIN_DOCS = parseInt(process.env.MIN_DOCS || '1500', 10);
  const MAX_DROP = parseFloat(process.env.MAX_DROP_RATIO || '0.4');
  assertCountsSane(docs.length, current, MIN_DOCS, MAX_DROP);
  console.log('Гард пройдено (було ' + (current == null ? '—' : current) + ', стане ' + docs.length + ').');

  // ── Будуємо у тимчасовий індекс і атомарно підміняємо ──
  // Це робить оновлення атомарним (пошук не бачить напів-стану) І прибирає зняті товари.
  const TMP = INDEX + '_build';
  await ensureIndex(INDEX);                 // щоб swap завжди мав обидва індекси
  await deleteIndex(TMP);                   // прибрати недобудований з попереднього разу
  await ensureIndex(TMP);
  console.log('Налаштовую пошукові поля…');
  await waitTask((await meili('PATCH','/indexes/'+TMP+'/settings', SETTINGS)).taskUid);
  console.log('Заливаю у тимчасовий індекс…');
  await uploadDocs(TMP, docs);

  const built = await docCount(TMP);
  if (built == null || built < docs.length * 0.95) {
    throw new Error('Тимчасовий індекс наповнився не повністю (' + built + '/' + docs.length + ') — підміну скасовано, живий пошук не чіпаємо.');
  }

  console.log('Атомарна підміна індексу…');
  await waitTask((await meili('POST','/swap-indexes', [{ indexes: [INDEX, TMP] }])).taskUid);
  await deleteIndex(TMP);                   // у TMP тепер старі дані — прибираємо
  console.log('Готово ✔ Пошук оновлено:', docs.length, 'товарів (застарілі/зняті прибрано).');
  await notify('✅ lartek: пошук оновлено\nТоварів: ' + docs.length +
    (current == null ? '' : ' (було ' + current + ')') + '\nКатегорій: ' + catset.size);
}

module.exports = { toDocs, buildCategoryMap, normDims, dimsOf, assertFeedSane, assertCountsSane, SETTINGS };
if (require.main === module) main().catch(async function(e){
  console.error('Помилка:', e.message);
  await notify('❌ lartek: індексатор НЕ оновив пошук\n' + e.message + '\n(живий пошук лишився старим)');
  process.exit(1);
});
