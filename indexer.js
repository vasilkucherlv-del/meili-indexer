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

// XML -> масив документів для Meilisearch
function toDocs(xml){
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

    return {
      id:          String(o['@_id']),
      sku:         clean(o.vendorCode),
      name:        name,
      dims:        dimsOf(name),
      vendor:      clean(o.vendor),
      category:    cat,
      categoryParent: parentName,
      price:       Number(o.price) || 0,
      url:         clean(o.url),
      picture:     clean(pic),
      available:   String(o['@_available']) === 'true',
      description: desc
    };
  }).filter(function(d){ return d.id && d.name; });
}

async function meili(method, path, body){
  const r = await fetch(MEILI_HOST + path, {
    method,
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer ' + MEILI_KEY },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text(); const d = t ? JSON.parse(t) : {};
  if (!r.ok) throw new Error(d.message || ('HTTP ' + r.status));
  return d;
}
async function waitTask(uid){
  for (let i=0;i<600;i++){
    const t = await meili('GET','/tasks/'+uid);
    if (t.status === 'succeeded') return;
    if (t.status === 'failed') throw new Error('Завдання не виконалось: ' + JSON.stringify(t.error));
    await new Promise(function(res){ setTimeout(res, 800); });
  }
}

async function main(){
  if (!MEILI_KEY) { console.error('Постав змінну MEILI_KEY (майстер-ключ Meilisearch).'); process.exit(1); }
  console.log('Meilisearch:', MEILI_HOST, '| індекс:', INDEX);
  console.log('Фід:', FEED);

  console.log('Читаю фід…');
  const xml = await readSource(FEED);
  const docs = toDocs(xml);
  console.log('Товарів у фіді:', docs.length);

  const catset = new Set(docs.map(function(d){ return d.category; }).filter(Boolean));
  console.log('Категорій знайдено:', catset.size, '| напр.:', Array.from(catset).slice(0,5).join(' | '));

  if (!docs.length) { console.error('У фіді не знайдено товарів — перевір формат.'); process.exit(1); }

  try { await meili('POST','/indexes', { uid: INDEX, primaryKey: 'id' }); } catch(e) {}

  console.log('Налаштовую пошукові поля…');
  const s = await meili('PATCH','/indexes/'+INDEX+'/settings', {
    // sku і dims — перші: пріоритет пошуку за артикулом і розміром
    searchableAttributes: ['sku','dims','name','vendor','category','description'],
    filterableAttributes: ['vendor','available','category','categoryParent'],
    sortableAttributes:   ['price','available'],
    // релевантність веде; наявність — як сортування нижчого пріоритету (тай-брейк)
    rankingRules:         ['words','typo','proximity','attribute','sort','exactness'],
    displayedAttributes:  ['id','sku','name','vendor','category','categoryParent','price','url','picture','available'],
    // без одруківок на кодах/розмірах; знято ліміт 1000
    typoTolerance:        { enabled:true, disableOnAttributes:['sku','dims','description'], minWordSizeForTypos:{ oneTypo:5, twoTypos:9 } },
    pagination:           { maxTotalHits: 100000 }
  });
  await waitTask(s.taskUid);

  const BATCH = 1000;
  for (let i=0;i<docs.length;i+=BATCH){
    const part = docs.slice(i, i+BATCH);
    const r = await meili('POST','/indexes/'+INDEX+'/documents', part);
    await waitTask(r.taskUid);
    console.log('Завантажено', Math.min(i+BATCH, docs.length), '/', docs.length);
  }
  console.log('Готово ✔ Оновлено товарів:', docs.length);
}

module.exports = { toDocs, buildCategoryMap, normDims, dimsOf };
if (require.main === module) main().catch(function(e){ console.error('Помилка:', e.message); process.exit(1); });
