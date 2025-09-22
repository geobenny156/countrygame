/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// Output to: <project>/public/topics
const OUT_DIR = path.join(__dirname, '..', 'topics');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function get(url) {
  // For Node <18, install node-fetch@2 and change to: const fetch = require('node-fetch');
  const res = await fetch(url, { headers: { 'User-Agent': 'naming-game-data-builder/1.0' } });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return await res.text();
}

function writeJSON(file, data) {
  fs.writeFileSync(path.join(OUT_DIR, file), JSON.stringify(data, null, 2), 'utf-8');
  console.log('✓ wrote', file, Array.isArray(data) ? `(${data.length} items)` : '');
}

function norm(t) { return t.replace(/\[[^\]]*\]/g, '').trim(); }

(async () => {
  // -------- CURRENCIES (ISO 4217) --------
  try {
    const html = await get('https://en.wikipedia.org/wiki/ISO_4217');
    const $ = cheerio.load(html);
    const rows = [];
    $('table.wikitable').each((_, t) => {
      const headers = $(t).find('th').map((i, th) => $(th).text().trim().toLowerCase()).get();
      if (headers.some(h => h.includes('code')) && headers.some(h => h.includes('currency'))) {
        $(t).find('tbody tr').each((i, tr) => {
          const cells = $(tr).find('td');
          if (cells.length >= 4) {
            const code = norm($(cells[0]).text()).toUpperCase();
            const currency = norm($(cells[3]).text());
            if (/^[A-Z]{3}$/.test(code) && currency) {
              rows.push({ code, name: currency });
            }
          }
        });
      }
    });

    const byCode = new Map();
    for (const r of rows) if (!byCode.has(r.code)) byCode.set(r.code, r);

    const withAliases = Array.from(byCode.values()).map(x => {
      const aliases = [];
      if (x.code === 'USD') aliases.push('US dollar', 'U.S. dollar');
      if (x.code === 'GBP') aliases.push('British pound', 'Pound sterling');
      if (x.code === 'CNY') aliases.push('Renminbi', 'Chinese yuan', 'Yuan');
      if (x.code === 'EUR') aliases.push('Euro');
      return { code: x.code, name: x.name, ...(aliases.length ? { aliases } : {}) };
    });

    writeJSON('currencies.json', withAliases);
  } catch (e) {
    console.error('Currencies build failed:', e.message);
  }

  // -------- DOG BREEDS (AKC) --------
  try {
    const html = await get('https://www.akc.org/dog-breeds/');
    const $ = cheerio.load(html);
    const names = new Set();
    $('.breed-type-card__title, .breed-card__title, .breed-type-card a, .breed-card a').each((i, el) => {
      const t = $(el).text().trim();
      if (t && /\w/.test(t) && t.length<80) names.add(t);
    });
    const list = Array.from(names).sort((a,b)=>a.localeCompare(b));
    writeJSON('dog_breeds.json', list);
  } catch (e) {
    console.error('Dog breeds build failed:', e.message);
  }

  // -------- CAPITALS (national) --------
  try {
    const html = await get('https://en.wikipedia.org/wiki/List_of_national_capitals');
    const $ = cheerio.load(html);
    const capitals = new Set();
    $('table.wikitable tbody tr').each((i, tr) => {
      const tds = $(tr).find('td');
      if (tds.length >= 2) {
        let cap = norm($(tds[0]).text());
        cap = cap.replace(/\s+/g, ' ');
        if (cap && cap !== '—' && !cap.toLowerCase().includes('de facto')) {
          cap = cap.split(' (')[0].trim();
          capitals.add(cap);
        }
      }
    });
    writeJSON('capitals.json', Array.from(capitals).sort((a,b)=>a.localeCompare(b)));
  } catch (e) {
    console.error('Capitals build failed:', e.message);
  }

  console.log('Done.');
})();
