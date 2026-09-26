const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const NO_INFO = '정보 없음';

function send(res, status, body, type='text/plain; charset=utf-8') {
  res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
  res.end(body);
}

function decodeEntities(s='') {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function stripHtml(html) {
  return decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/td>|<\/th>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeText(s='') {
  return s.replace(/[\u00ad\u200b]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(s='') {
  return normalizeText(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function detectPos(text) {
  if (/(^|[\s,])Существительное(?:[,.\s]|$)/i.test(text)) return 'noun';
  if (/(^|[\s,])Глагол(?:[,.\s]|$)/i.test(text)) return 'verb';
  if (/(^|[\s,])Прилагательное(?:[,.\s]|$)/i.test(text)) return 'adjective';
  if (/(^|[\s,])Наречие(?:[,.\s]|$)/i.test(text)) return 'adverb';
  return 'unknown';
}

function posLabel(pos) {
  return ({noun:'명사',verb:'동사',adjective:'형용사',adverb:'부사',unknown:'판별 불가'})[pos] || '판별 불가';
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return normalizeText(m[1]);
  }
  return NO_INFO;
}

function isWordLine(line) {
  // A conservative candidate for Gramota's standalone headword line.
  // Keep accents and hyphens; reject navigation/metadata sentences.
  return /^[А-ЯЁа-яё][А-ЯЁа-яё́-]{1,}(?:\s+[А-ЯЁа-яё́-]{1,})?$/.test(line.trim());
}

function findPosEntries(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const pos = detectPos(lines[i]);
    if (pos !== 'unknown') entries.push({pos, posIndex:i});
  }
  return entries;
}

function findRelevantBlock(text, query) {
  const q = normalizeForMatch(query);
  const lines = text.split(/\n+/).map(normalizeText).filter(Boolean);
  const entries = findPosEntries(lines);
  if (!entries.length) {
    return {text:'', pos:'unknown', queryMatched:false, formLine:NO_INFO, confidence:'none'};
  }

  // Only accept a result when the searched form is explicitly present in the
  // Gramota result text. Never fall back to the first dictionary entry.
  const occurrences = [];
  for (let i=0; i<lines.length; i++) {
    const normalizedLine = normalizeForMatch(lines[i]);
    if (normalizedLine === q || normalizedLine.split(/[^a-zа-яё0-9́-]+/i).includes(q)) {
      occurrences.push(i);
    }
  }

  if (!occurrences.length) {
    return {text:'', pos:'unknown', queryMatched:false, formLine:NO_INFO, confidence:'none'};
  }

  const candidates = [];
  for (const entry of entries) {
    const distances = occurrences.map(oi => Math.abs(entry.posIndex - oi));
    const distance = Math.min(...distances);
    if (distance <= 12) candidates.push({entry, distance});
  }

  if (!candidates.length) {
    return {text:'', pos:'unknown', queryMatched:true, formLine:lines[occurrences[0]], confidence:'low'};
  }

  candidates.sort((a,b)=>a.distance-b.distance);
  const bestDistance = candidates[0].distance;
  const tied = candidates.filter(c=>c.distance === bestDistance);
  if (tied.length > 1) {
    return {text:'', pos:'unknown', queryMatched:true, formLine:lines[occurrences[0]], confidence:'ambiguous'};
  }

  const chosen = candidates[0].entry;
  const start = Math.max(0, chosen.posIndex - 6);
  const end = Math.min(lines.length, chosen.posIndex + 24);
  return {
    text: lines.slice(start, end).join('\n'),
    pos: chosen.pos,
    queryMatched: true,
    formLine: lines[occurrences[0]],
    confidence: bestDistance <= 4 ? 'high' : 'medium'
  };
}

function extractLemmaFromBlock(blockText, pos) {
  const lines = blockText.split(/\n+/).map(normalizeText).filter(Boolean);
  const posIndex = lines.findIndex(line => detectPos(line) === pos);
  if (posIndex < 0) return NO_INFO;

  // Prefer a standalone headword immediately before the POS line.
  for (let i = posIndex - 1; i >= Math.max(0, posIndex - 4); i--) {
    const candidate = lines[i].replace(/^[•·*-]\s*/, '').trim();
    if (isWordLine(candidate)) return candidate;
  }

  // Fallback: headword may be on the same line as the POS marker.
  const sameLine = lines[posIndex].match(/^([А-ЯЁа-яё][А-ЯЁа-яё́-]{1,})\s+Существительное\b/i)
    || lines[posIndex].match(/^([А-ЯЁа-яё][А-ЯЁа-яё́-]{1,})\s+Глагол\b/i)
    || lines[posIndex].match(/^([А-ЯЁа-яё][А-ЯЁа-яё́-]{1,})\s+Прилагательное\b/i)
    || lines[posIndex].match(/^([А-ЯЁа-яё][А-ЯЁа-яё́-]{1,})\s+Наречие\b/i);
  return sameLine?.[1] ? normalizeText(sameLine[1]) : NO_INFO;
}

function extractDefinition(text, pos) {
  const lines = text.split(/\n+/).map(normalizeText).filter(Boolean);
  const posIndex = lines.findIndex(line => detectPos(line) === pos);
  if (posIndex < 0) return NO_INFO;
  const tail = lines.slice(posIndex + 1);
  const stop = tail.findIndex(line => /^(?:Всё об этом слове|Метасловарь|Найдено \d+ словар)/i.test(line));
  const candidateLines = (stop >= 0 ? tail.slice(0, stop) : tail).filter(line =>
    !/^(?:ед\.|мн\.)\s+число|^Словари$|^Везде$|^Точное соответствие$|^Все формы слова$/i.test(line)
  );
  const candidate = candidateLines.join(' ').trim();
  return candidate.length >= 2 ? candidate.slice(0, 500) : NO_INFO;
}

function extractNoun(text) {
  return {
    lemma: extractLemmaFromBlock(text, 'noun'),
    gender: firstMatch(text, [/(?:Существительное,\s*)(мужской|женский|средний) род/i]),
    declension: firstMatch(text, [/(\d-е склонение)/i]),
    stress: firstMatch(text, [/([А-ЯЁа-яё]+[́])(?:\s|,|$)/i]),
  };
}

function extractVerb(text) {
  return {
    lemma: extractLemmaFromBlock(text, 'verb'),
    aspect: firstMatch(text, [/Глагол,\s*([^,.;]{1,80}?вид)/i]),
    transitivity: firstMatch(text, [/(переходный|непереходный)/i]),
  };
}

function extractAdjective(text) {
  return {
    lemma: extractLemmaFromBlock(text, 'adjective'),
    type: firstMatch(text, [/Прилагательное,\s*([^.;]{1,100})/i]),
    stress: firstMatch(text, [/([А-ЯЁа-яё]+[́])(?:\s|,|$)/i]),
  };
}

function extractAdverb(text) {
  return {
    lemma: extractLemmaFromBlock(text, 'adverb'),
    stress: firstMatch(text, [/([А-ЯЁа-яё]+[́])(?:\s|,|$)/i]),
  };
}

function extractFields(text, pos, query) {
  let fields = {};
  if (pos === 'noun') fields = extractNoun(text);
  if (pos === 'verb') fields = extractVerb(text);
  if (pos === 'adjective') fields = extractAdjective(text);
  if (pos === 'adverb') fields = extractAdverb(text);
  if (!fields.lemma || fields.lemma === NO_INFO) fields.lemma = NO_INFO;
  fields.meaning = extractDefinition(text, pos);
  fields.query = query;
  fields.pos = pos;
  return fields;
}

async function gramota(q) {
  const target = 'https://gramota.ru/poisk?mode=all&query=' + encodeURIComponent(q);
  const response = await fetch(target, {headers:{'User-Agent':'Mozilla/5.0 Russian-Learning-Tool/1.9'}});
  if (!response.ok) throw new Error('Gramota 응답 오류: HTTP ' + response.status);
  const html = await response.text();
  const text = stripHtml(html);
  const selected = findRelevantBlock(text, q);
  const block = selected.text;
  const pos = selected.pos;
  const fields = (selected.queryMatched && pos !== 'unknown')
    ? extractFields(block, pos, q)
    : {lemma:NO_INFO, meaning:NO_INFO, query:q, pos:'unknown'};

  return {
    ok:true,
    query:q,
    lemma:fields.lemma || NO_INFO,
    pos,
    posLabel:posLabel(pos),
    confidence:selected.confidence,
    inflected: selected.queryMatched && pos !== 'unknown' && fields.lemma !== NO_INFO && normalizeForMatch(fields.lemma) !== normalizeForMatch(q),
    queryMatched: selected.queryMatched,
    matchedForm: selected.formLine,
    fields,
    pipeline:{
      input:q,
      gramotaSearch:true,
      queryMatched:selected.queryMatched,
      posDetected:pos !== 'unknown',
      lemmaResolved:fields.lemma !== NO_INFO,
      fieldsExtracted:Object.fromEntries(Object.entries(fields).filter(([k,v]) => !['query','pos'].includes(k)).map(([k,v]) => [k, v !== NO_INFO])),
      completed:true
    },
    snippet:block ? block.slice(0, 2200) : NO_INFO,
    source:target
  };
}

const server = http.createServer(async (req,res)=>{
  try {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/api/gramota') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return send(res,400,JSON.stringify({ok:false,error:'검색어가 없습니다.'}),'application/json; charset=utf-8');
      const data = await gramota(q);
      return send(res,200,JSON.stringify(data),'application/json; charset=utf-8');
    }
    if (u.pathname === '/api/health') {
      return send(res,200,JSON.stringify({ok:true,version:'1.9.0',source:'Gramota'}),'application/json; charset=utf-8');
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(ROOT,'index.html'));
      return send(res,200,html,'text/html; charset=utf-8');
    }
    return send(res,404,'Not found');
  } catch (e) {
    return send(res,502,JSON.stringify({ok:false,error:e.message || 'Gramota 연결 실패'}),'application/json; charset=utf-8');
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, ()=>console.log(`Russian Learning Tool V1.9: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
}

module.exports = {
  NO_INFO, decodeEntities, stripHtml, normalizeText, normalizeForMatch, detectPos, posLabel,
  firstMatch, isWordLine, findPosEntries, findRelevantBlock, extractLemmaFromBlock,
  extractDefinition, extractNoun, extractVerb, extractAdjective, extractAdverb, extractFields, gramota
};
