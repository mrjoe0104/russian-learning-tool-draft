const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const NO_INFO = '정보 없음';
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

const CASES = [
  ['именительный', '주격'], ['родительный', '생격'], ['дательный', '여격'],
  ['винительный', '대격'], ['творительный', '조격'], ['предложный', '전치격']
];
const PERSONS = [
  ['Я', '1인칭 단수'], ['Ты', '2인칭 단수'], ['Он', '3인칭 단수'],
  ['Мы', '1인칭 복수'], ['Вы', '2인칭 복수'], ['Они', '3인칭 복수']
];
const PERSON_MAP = { Я: '1인칭 단수', Ты: '2인칭 단수', Он: '3인칭 단수', Она: '3인칭 단수', Оно: '3인칭 단수', Мы: '1인칭 복수', Вы: '2인칭 복수', Они: '3인칭 복수' };
const POS = {
  'Существительное': 'noun', 'Глагол': 'verb', 'Прилагательное': 'adjective', 'Наречие': 'adverb',
  'Местоимение': 'pronoun', 'Союз': 'conjunction', 'Частица': 'particle', 'Междометие': 'interjection',
  'Числительное': 'numeral', 'Предлог': 'preposition'
};
const POS_LABEL = {
  noun: 'Существительное', verb: 'Глагол', adjective: 'Прилагательное', adverb: 'Наречие',
  pronoun: 'Местоимение', conjunction: 'Союз', particle: 'Частица', interjection: 'Междометие',
  numeral: 'Числительное', preposition: 'Предлог', unknown: '판별 불가'
};
const NOUN_LIKE = new Set(['noun', 'pronoun', 'numeral']);
const SIMPLE_MEANING = new Set(['adverb', 'conjunction', 'particle', 'interjection', 'preposition']);
const PAST_MAP = {
  'мужской': '남성', 'мужской род': '남성', 'женский': '여성', 'женский род': '여성',
  'средний': '중성', 'средний род': '중성', 'множественное': '복수', 'множественное число': '복수'
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function decodeEntities(s = '') {
  return s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}
function stripHtml(html = '') {
  return decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|table|section|article|h[1-6])\s*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, '\t')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00a0/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function normalizeText(s = '') { return String(s).replace(/[\u00ad\u200b]/g, '').replace(/\s+/g, ' ').trim(); }
function normalizeForMatch(s = '') { return normalizeText(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function cleanMarkdownLine(s = '') {
  return String(s).replace(/^\s*#+\s*/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '').trim();
}
function linesOf(raw = '') {
  return stripHtml(String(raw).replace(/\r/g, ''))
    .split(/\n+/).map(cleanMarkdownLine).filter(Boolean);
}
function posLabel(pos) { return POS_LABEL[pos] || POS_LABEL.unknown; }

// 품사는 Gramota 검색 결과에 실제로 표시된 품사명을 1차 기준으로 사용한다.
function extractHeading(raw = '') {
  const html = String(raw).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (html) return normalizeText(stripHtml(html[1]));
  const md = String(raw).match(/^\s*#\s+(.+?)\s*$/m);
  return md ? cleanMarkdownLine(md[1]) : '';
}

const POS_PATTERNS = [
  ['Существительное', 'noun'], ['сущ.', 'noun'],
  ['Глагол', 'verb'], ['глаг.', 'verb'],
  ['Прилагательное', 'adjective'], ['прил.', 'adjective'],
  ['Наречие', 'adverb'], ['нареч.', 'adverb'],
  ['Местоимение', 'pronoun'], ['местоим.', 'pronoun'], ['мест.', 'pronoun'],
  ['Союз', 'conjunction'], ['союз', 'conjunction'],
  ['Частица', 'particle'], ['част.', 'particle'],
  ['Междометие', 'interjection'], ['межд.', 'interjection'], ['междом.', 'interjection'],
  ['Числительное', 'numeral'], ['числ.', 'numeral'],
  ['Предлог', 'preposition'], ['предл.', 'preposition']
];

function posMatches(text = '') {
  const normalized = normalizeText(stripHtml(text));
  const out = [];
  for (const [label, pos] of POS_PATTERNS) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(?:^|[\\s,;·|(/])' + escaped + '(?=$|[\\s,.;:|/)])', 'i');
    const m = re.exec(normalized);
    if (m) out.push({ label, pos, index: m.index + m[0].length - label.length });
  }
  return out.sort((a, b) => a.index - b.index);
}

function detectDeclaredPos(text = '') {
  return posMatches(text)[0]?.pos || 'unknown';
}

function extractSearchPos(searchHtml = '', query = '') {
  const text = stripHtml(String(searchHtml).replace(/\r/g, ''));
  const rawLines = text.split(/\\n+/).map(normalizeText).filter(Boolean);
  const q = normalizeForMatch(query);
  const startIndex = Math.max(0, rawLines.findIndex(line => /^(?:Точное соответствие|Словари)$/i.test(line)));
  const lines = startIndex > 0 ? rawLines.slice(startIndex) : rawLines;
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    if (normalizeForMatch(lines[i]) !== q) continue;
    for (let j = i + 1; j < Math.min(lines.length, i + 81); j++) {
      const matches = posMatches(lines[j]);
      for (const match of matches) {
        const distance = j - i;
        candidates.push({
          pos: match.pos,
          label: lines[i],
          score: 1000 - distance * 8 - match.index / 100,
          distance,
          line: lines[j]
        });
      }
      // A new exact result starts; do not let its POS contaminate the current result.
      if (j > i + 1 && normalizeForMatch(lines[j]) === q) break;
    }
  }

  // HTML 검색 결과에 /meta/ 링크가 있으면 같은 검색 결과에서 원문 URL도 보존한다.
  const links = extractMetaLinks(searchHtml, query);
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const exactLink = links.find(x => normalizeForMatch(x.label) === q) || links[0] || null;
    return {
      href: exactLink?.url || null,
      label: best.label,
      pos: best.pos,
      score: best.score
    };
  }

  // 검색 결과가 한 줄짜리 Markdown 등으로 압축된 경우의 보조 판정.
  const compact = rawLines.join(' ');
  const pos = detectDeclaredPos(compact);
  return pos === 'unknown' ? null : { href: links[0]?.url || null, label: query, pos, score: 0 };
}

// 메타 페이지는 품사 판정의 기준이 아니라, 해당 품사의 세부 활용/변화 정보를 얻기 위한 보조 원문이다.
function detectMetaPos(raw = '') {
  const lines = linesOf(raw);
  const heading = extractHeading(raw);
  const headingIndex = heading ? lines.findIndex(line => normalizeForMatch(line) === normalizeForMatch(heading)) : -1;
  const region = headingIndex >= 0 ? lines.slice(headingIndex + 1, headingIndex + 40).join(' ') : lines.slice(0, 80).join(' ');
  return detectDeclaredPos(region);
}

function parseHtmlTables(raw = '') {
  const tables = [];
  const tableRe = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(raw))) {
    const rows = [];
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    while ((rm = rowRe.exec(tm[1]))) {
      const cells = [];
      const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let cm;
      while ((cm = cellRe.exec(rm[1]))) cells.push(normalizeText(stripHtml(cm[1])));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

function parseMarkdownTables(raw = '') {
  const lines = String(raw).replace(/\r/g, '').split('\n').map(cleanMarkdownLine);
  const tables = [];
  const isSeparator = line => /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].includes('|') || !isSeparator(lines[i + 1])) continue;
    const headers = lines[i].split('|').map(x => x.trim()).filter((_, idx, a) => !(idx === 0 && a[0] === ''));
    const rows = [];
    let pendingLabel = '';
    for (let j = i + 2; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim()) break;
      if (isSeparator(line)) continue;
      if (!line.includes('|')) { pendingLabel = line.trim(); continue; }
      const cells = line.split('|').map(x => cleanMarkdownLine(x.trim()));
      if (pendingLabel) { cells[0] = pendingLabel; pendingLabel = ''; }
      if (cells.length < headers.length) break;
      rows.push(cells.slice(0, headers.length));
    }
    if (rows.length) tables.push({ headers, rows, index: i });
  }
  return tables;
}

function sectionRange(raw, title) {
  const lines = String(raw).replace(/\r/g, '').split('\n');
  const clean = lines.map(cleanMarkdownLine);
  const start = clean.findIndex(x => x.toLowerCase() === title.toLowerCase());
  if (start < 0) return null;
  const end = clean.findIndex((x, i) => i > start && /^#{1,6}\s+/.test(lines[i]));
  return { lines, clean, start, end: end < 0 ? lines.length : end };
}

function findTable(raw, headerTests) {
  const mdTables = parseMarkdownTables(raw);
  const table = mdTables.find(t => t.headers.length === headerTests.length && headerTests.every((test, i) => test.test(t.headers[i] || '')));
  if (table) return table;

  for (const rows of parseHtmlTables(raw)) {
    const headers = rows[0] || [];
    if (headerTests.length && (headers.length !== headerTests.length || !headerTests.every((test, i) => test.test(headers[i] || '')))) continue;
    return { headers, rows: rows.slice(1) };
  }
  return null;
}

function extractSectionHtmlTable(raw, sectionTitle) {
  const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let hm;
  while ((hm = headingRe.exec(raw))) {
    if (normalizeForMatch(stripHtml(hm[1])) !== normalizeForMatch(sectionTitle)) continue;
    const rest = raw.slice(hm.index + hm[0].length);
    const nextHeading = rest.search(/<h[1-6]\b/i);
    const region = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
    const table = parseHtmlTables(region)[0];
    if (table?.length) return { headers: table[0], rows: table.slice(1) };
  }
  return null;
}

function sectionTable(raw, title) {
  const range = sectionRange(raw, title);
  if (range) {
    const table = parseMarkdownTables(range.lines.slice(range.start, range.end).join('\n'))[0];
    if (table) return table;
  }
  return extractSectionHtmlTable(raw, title);
}

function extractMetaLinks(html, query) {
  const links = [], seen = new Set();
  const add = (href, label = '') => {
    href = decodeEntities(String(href || '')).trim();
    if (!/\/meta\//i.test(href)) return;
    const url = absoluteGramotaUrl(href);
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ url, label: normalizeText(stripHtml(label)) });
  };
  let m;
  const htmlRe = /<a\b[^>]*href=["']([^"']*\/meta\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = htmlRe.exec(html))) add(m[1], m[2]);
  const mdRe = /\[([^\]\n]+)\]\(([^)]*\/meta\/[^)]+)\)/gi;
  while ((m = mdRe.exec(html))) add(m[2], m[1]);
  for (const url of html.match(/(?:https?:\/\/gramota\.ru)?\/meta\/[A-Za-zА-Яа-яЁё0-9_-]+/gi) || []) add(url);

  const q = normalizeForMatch(query);
  return links.sort((a, b) => metaLinkScore(b, q) - metaLinkScore(a, q));
}
function metaLinkScore(link, q) {
  const label = normalizeForMatch(link.label);
  let score = 0;
  if (label === q) score += 100;
  if (label.replace(/\s+/g, '') === q.replace(/\s+/g, '')) score += 20;
  if (label.includes(q) || q.includes(label)) score += 10;
  return score;
}
function absoluteGramotaUrl(href) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  return 'https://gramota.ru' + (href.startsWith('/') ? href : '/' + href);
}

function extractLemma(raw, fallback = NO_INFO) {
  const heading = extractHeading(raw);
  if (heading && /^[А-ЯЁа-яё][А-ЯЁа-яё́-]*$/.test(heading)) return heading;
  if (fallback && fallback !== NO_INFO) return normalizeText(fallback);
  return NO_INFO;
}
function declarationText(raw) {
  const lines = linesOf(raw);
  const heading = extractHeading(raw);
  const i = heading ? lines.findIndex(line => normalizeForMatch(line) === normalizeForMatch(heading)) : -1;
  return (i >= 0 ? lines.slice(i + 1, i + 40) : lines.slice(0, 80)).join(' ');
}
function extractGender(raw) {
  const match = declarationText(raw).match(/(?:Существительное|Местоимение|Числительное)?\s*,?\s*(мужской|женский|средний)\s+род/i);
  return match ? match[1] : NO_INFO;
}
function extractDeclension(raw) {
  const match = declarationText(raw).match(/([1-3]-е)\s+склонение/i);
  return match ? match[1] + ' склонение' : NO_INFO;
}
function extractAspect(raw) {
  const match = declarationText(raw).match(/(несовершенный|совершенный)\s+вид/i);
  return match ? match[1] : NO_INFO;
}
function extractConjugationType(raw) {
  const match = declarationText(raw).match(/([1-2]-е)\s+спряжение/i);
  return match ? match[1] + ' спряжение' : NO_INFO;
}
function extractMotionType(raw) {
  const match = declarationText(raw).match(/(однонаправленный|разнонаправленный|однократный|многократный)/i);
  if (!match) return NO_INFO;
  return /разнонаправленный|многократный/i.test(match[1]) ? '비정향' : '정향';
}

function extractMeaning(raw) {
  const lines = linesOf(raw);
  const index = lines.findIndex(x => /^толкование$/i.test(x));
  if (index < 0) return NO_INFO;
  const out = [];
  for (const line of lines.slice(index + 1)) {
    if (/^(?:Синонимы|Однокоренные слова|Рядом в словаре|Метасловарь|Подробнее)$/i.test(line)) break;
    if (/^(?:Большой |Русский |Современный |Словарь|Орфографический|Толковый)/i.test(line)) continue;
    if (/https?:\/\/|VKontakte|Telegram|поделиться|share|изображение|image/i.test(line)) continue;
    if (!line || /^\d+[.)]?$/.test(line)) continue;
    if (/^(?:Падеж|Единственное число|Множественное число|ед\.\s*число|мн\.\s*число|именительный|родительный|дательный|винительный|творительный|предложный)$/i.test(line)) continue;
    if (/^[А-ЯЁа-яё][А-ЯЁа-яё\s-]{0,90}$/.test(line) && line.length < 90) continue;
    out.push(line);
    if (out.join(' ').length > 700) break;
  }
  return out.join(' ').trim() || NO_INFO;
}

function tableRowsAround(raw, headerPattern) {
  const lines = String(raw).replace(/\r/g, '').split('\n').map(cleanMarkdownLine);
  const i = lines.findIndex(x => headerPattern.test(x));
  if (i < 0) return null;
  const rows = [];
  for (let j = i + 1; j < lines.length && rows.length < 20; j++) {
    const line = lines[j];
    if (!line.trim()) break;
    if (/^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)) continue;
    if (!line.includes('|')) continue;
    rows.push(line.split('|').map(x => cleanMarkdownLine(x.trim())));
  }
  return rows.length ? rows : null;
}

function parseNounCases(raw) {
  const table = findTable(raw, [/^Падеж$/i, /^Единственное число$/i, /^Множественное число$/i]);
  if (!table) return {};
  const out = {};
  for (const row of table.rows) {
    const key = normalizeText(row[0]).toLowerCase();
    if (CASES.some(([ru]) => ru === key) && row.length >= 3) out[key] = { singular: row[1] || NO_INFO, plural: row[2] || NO_INFO };
  }
  return out;
}

function parseAdjectiveCases(raw) {
  const markdownRows = tableRowsAround(raw, /^Падеж\s*\|/i) || [];
  const htmlRows = parseHtmlTables(raw).find(table => table.some(row => CASES.some(([ru]) => normalizeText(row[0]).toLowerCase() === ru) && row.length >= 5)) || [];
  const rows = markdownRows.length ? markdownRows : htmlRows;
  const out = {};
  for (const row of rows) {
    const key = normalizeText(row[0]).toLowerCase();
    if (CASES.some(([ru]) => ru === key) && row.length >= 5) {
      out[key] = { masculine: row[1] || NO_INFO, feminine: row[2] || NO_INFO, neuter: row[3] || NO_INFO, plural: row[4] || NO_INFO };
    }
  }
  return out;
}
function formatNounCases(cases) {
  return CASES.map(([ru, ko]) => ({ case: ko, singular: cases[ru]?.singular || NO_INFO, plural: cases[ru]?.plural || NO_INFO }));
}
function formatAdjectiveCases(cases) {
  return CASES.map(([ru, ko]) => ({ case: ko, masculine: cases[ru]?.masculine || NO_INFO, feminine: cases[ru]?.feminine || NO_INFO, neuter: cases[ru]?.neuter || NO_INFO, plural: cases[ru]?.plural || NO_INFO }));
}

function normalizePerson(value = '') {
  const s = normalizeText(value).replace(/^\|+|\|+$/g, '');
  if (/^(Он|Она|Оно)$/i.test(s)) return 'Он';
  return s;
}
function parseVerbTables(raw) {
  const out = { current: null, future: null, past: null, imperative: null };
  const personal = findTable(raw, [/^Лицо$/i, /^Настоящее время$/i, /^Будущее время$/i]);
  if (personal) out.current = personal;

  const futureOnly = findTable(raw, [/^Лицо$/i, /^Будущее время$/i]);
  if (futureOnly && !personal) out.future = futureOnly;
  if (personal) out.future = personal;

  out.past = sectionTable(raw, 'Формы прошедшего времени');
  out.imperative = sectionTable(raw, 'Повелительное наклонение');
  return out;
}
function verbForms(raw) {
  const tables = parseVerbTables(raw);
  const current = Object.fromEntries(PERSONS.map(([, ko]) => [ko, NO_INFO]));
  const future = Object.fromEntries(PERSONS.map(([, ko]) => [ko, NO_INFO]));
  for (const row of tables.current?.rows || []) {
    const person = normalizePerson(row[0]);
    const key = PERSON_MAP[person];
    if (key) { current[key] = row[1] || NO_INFO; future[key] = row[2] || NO_INFO; }
  }
  if (!tables.current) {
    for (const row of tables.future?.rows || []) {
      const key = PERSON_MAP[normalizePerson(row[0])];
      if (key) future[key] = row[1] || NO_INFO;
    }
  }

  const past = { '남성': NO_INFO, '여성': NO_INFO, '중성': NO_INFO, '복수': NO_INFO };
  for (const row of tables.past?.rows || []) {
    const key = PAST_MAP[normalizeText(row[0] || '').toLowerCase()];
    if (key) past[key] = row[1] || NO_INFO;
  }

  const imperative = { '2인칭 단수': NO_INFO, '2인칭 복수': NO_INFO };
  for (const row of tables.imperative?.rows || []) {
    const person = normalizePerson(row[0]);
    if (person === 'Ты') imperative['2인칭 단수'] = row[1] || NO_INFO;
    if (person === 'Вы') imperative['2인칭 복수'] = row[1] || NO_INFO;
  }
  return { current, future, past, imperative };
}

function extractFields(raw, pos) {
  const lemma = extractLemma(raw);
  const meaningRu = extractMeaning(raw);
  if (NOUN_LIKE.has(pos)) return {
    lemma, meaningRu, gender: extractGender(raw), declension: extractDeclension(raw), cases: formatNounCases(parseNounCases(raw))
  };
  if (pos === 'verb') {
    const forms = verbForms(raw);
    return {
      lemma, meaningRu, conjugationType: extractConjugationType(raw), aspect: extractAspect(raw),
      motionType: extractMotionType(raw), conjugation: forms.current, future: forms.future, past: forms.past, imperative: forms.imperative
    };
  }
  if (pos === 'adjective') return { lemma, meaningRu, cases: formatAdjectiveCases(parseAdjectiveCases(raw)) };
  return { lemma, meaningRu };
}

async function translateToKorean(russian) {
  if (!russian || russian === NO_INFO) return NO_INFO;
  const key = normalizeText(russian);
  const cached = cacheGet('tr:' + key);
  if (cached) return cached;
  const q = key.slice(0, 500);
  try {
    const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=ru|ko';
    const r = await fetch(url, { headers: { 'User-Agent': 'Russian-Learning-Tool/3.4', Accept: 'application/json' } });
    if (r.ok) {
      const translated = String((await r.json())?.responseData?.translatedText || '').trim();
      if (/[가-힣]/.test(translated)) return cacheSet('tr:' + key, translated);
    }
  } catch {}
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=ko&dt=t&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { 'User-Agent': 'Russian-Learning-Tool/3.4', Accept: 'application/json,text/plain,*/*' } });
    if (r.ok) {
      const data = await r.json();
      const translated = Array.isArray(data?.[0]) ? data[0].map(x => Array.isArray(x) ? x[0] : '').join('').trim() : '';
      if (/[가-힣]/.test(translated)) return cacheSet('tr:' + key, translated);
    }
  } catch {}
  return NO_INFO;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_TTL) { cache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return value;
}

async function fetchDirect(url) {
  return fetch(url, { headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.5', Referer: 'https://gramota.ru/'
  }});
}
async function fetchViaJina(url) {
  const get = await fetch('https://r.jina.ai/' + url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/plain,text/html;q=0.9,*/*;q=0.8' } });
  if (get.ok) return { html: await get.text(), via: 'jina-reader' };
  const post = await fetch('https://r.jina.ai/', { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/plain,text/html;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0'
  }, body: 'url=' + encodeURIComponent(url) });
  if (post.ok) return { html: await post.text(), via: 'jina-reader-post' };
  throw new Error('Gramota 중계 접속 실패 (HTTP ' + post.status + ')');
}
async function fetchGramotaPage(url) {
  const cached = cacheGet('page:' + url);
  if (cached) return cached;
  try {
    const direct = await fetchDirect(url);
    if (direct.ok) return cacheSet('page:' + url, { html: await direct.text(), via: 'direct' });
  } catch {}
  return cacheSet('page:' + url, await fetchViaJina(url));
}

async function resolveMetaPage(searchHtml, query, expectedPos = 'unknown') {
  const candidates = extractMetaLinks(searchHtml, query);
  if (!candidates.length) return null;
  let best = null;
  for (const candidate of candidates) {
    try {
      const page = await fetchGramotaPage(candidate.url);
      const pos = detectMetaPos(page.html);
      if (expectedPos !== 'unknown' && pos !== expectedPos) continue;
      if (pos === 'unknown') continue;
      const lemma = extractLemma(page.html, NO_INFO);
      const score = metaLinkScore(candidate, normalizeForMatch(query)) + (normalizeForMatch(lemma) === normalizeForMatch(query) ? 100 : 0);
      const result = { ...candidate, ...page, pos, lemma, score };
      if (!best || result.score > best.score) best = result;
      if (normalizeForMatch(lemma) === normalizeForMatch(query)) return result;
    } catch {}
  }
  return best;
}

async function gramota(query) {
  const searchUrl = 'https://gramota.ru/poisk?mode=slovari&query=' + encodeURIComponent(query);
  const search = await fetchGramotaPage(searchUrl);
  const searchPos = extractSearchPos(search.html, query);
  const expectedPos = searchPos?.pos || 'unknown';
  const meta = expectedPos !== 'unknown' ? await resolveMetaPage(search.html, query, expectedPos) : null;

  if (!searchPos || expectedPos === 'unknown') {
    return { ok: true, query, pos: 'unknown', posLabel: POS_LABEL.unknown, fields: { meaning: NO_INFO }, metaUrl: meta?.url || searchPos?.href || searchUrl };
  }

  // 검색 결과에서 품사를 확정하고, 메타 페이지는 그 품사의 세부 변화형을 얻을 때만 사용한다.
  if (!meta) {
    const meaning = await translateToKorean(query);
    return {
      ok: true, query, lemma: searchPos.label || query, pos: expectedPos, posLabel: posLabel(expectedPos),
      fields: { meaning }, metaUrl: searchPos.href || searchUrl
    };
  }

  const fields = extractFields(meta.html, expectedPos);
  fields.lemma = fields.lemma === NO_INFO ? (searchPos.label || query) : fields.lemma;
  fields.meaning = await translateToKorean(fields.lemma);
  delete fields.meaningRu;
  return {
    ok: true, query, lemma: fields.lemma, pos: expectedPos, posLabel: posLabel(expectedPos),
    fields, metaUrl: meta.url
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/gramota') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 400, JSON.stringify({ ok: false, error: '검색어가 없습니다.' }), 'application/json; charset=utf-8');
      return send(res, 200, JSON.stringify(await gramota(q)), 'application/json; charset=utf-8');
    }
    if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, version: '3.4.0', source: 'Gramota' }), 'application/json; charset=utf-8');
    if (url.pathname === '/' || url.pathname === '/index.html') return send(res, 200, fs.readFileSync(path.join(ROOT, 'index.html')), 'text/html; charset=utf-8');
    return send(res, 404, 'Not found');
  } catch (e) {
    return send(res, 502, JSON.stringify({ ok: false, error: e.message || '검색 실패' }), 'application/json; charset=utf-8');
  }
});

if (require.main === module) server.listen(PORT, HOST, () => console.log(`Russian Learning Tool V3.4: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}`));

module.exports = {
  NO_INFO, decodeEntities, stripHtml, normalizeText, normalizeForMatch, posLabel, detectDeclaredPos, extractSearchPos, detectMetaPos,
  extractMetaLinks, extractLemma, extractGender, extractDeclension, extractAspect,
  extractConjugationType, extractMotionType, parseNounCases, parseAdjectiveCases,
  parseVerbTables, verbForms, extractFields, extractNoun: raw => extractFields(raw, 'noun'),
  extractVerb: raw => extractFields(raw, 'verb'), extractAdjective: raw => extractFields(raw, 'adjective'),
  extractAdverb: raw => extractFields(raw, 'adverb'), gramota
};
