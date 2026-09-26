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
  return s.replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');
}

function stripHtml(html) {
  return decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<(br|hr)\s*\/?>/gi,'\n')
    .replace(/<\/(p|div|li|tr|table|section|article|h[1-6])\s*>/gi,'\n')
    .replace(/<\/(td|th)\s*>/gi,'\t')
    .replace(/<[^>]+>/g,' '))
    .replace(/\u00a0/g,' ')
    .replace(/[ \t]+/g,' ')
    .replace(/\n[ \t]+/g,'\n')
    .replace(/\n{3,}/g,'\n\n').trim();
}

function normalizeText(s='') { return s.replace(/[\u00ad\u200b]/g,'').replace(/\s+/g,' ').trim(); }
function normalizeForMatch(s='') { return normalizeText(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
function posLabel(pos) { return ({noun:'명사',verb:'동사',adjective:'형용사',adverb:'부사',unknown:'판별 불가'})[pos] || '판별 불가'; }
function detectPos(text) {
  if (/(^|[\s,])Существительное(?:[,\.\s]|$)/i.test(text)) return 'noun';
  if (/(^|[\s,])Глагол(?:[,\.\s]|$)/i.test(text)) return 'verb';
  if (/(^|[\s,])Прилагательное(?:[,\.\s]|$)/i.test(text)) return 'adjective';
  if (/(^|[\s,])Наречие(?:[,\.\s]|$)/i.test(text)) return 'adverb';
  return 'unknown';
}
function isWordLine(line) { return /^[А-ЯЁа-яё][А-ЯЁа-яё́-]{1,}(?:\s+[А-ЯЁа-яё́-]{1,})?$/.test(line.trim()); }
function splitLines(text) { return text.split(/\n+/).map(normalizeText).filter(Boolean); }
function lineContainsQuery(line, query) {
  const q=normalizeForMatch(query), n=normalizeForMatch(line); if(!q||!n)return false;
  return n===q || n.split(/[^a-zа-яё0-9-]+/i).includes(q);
}

function findGramotaDictionaryBlock(lines, query) {
  const di=lines.findIndex(x=>/^Словари$/i.test(x)); if(di<0)return null;
  const ei=lines.findIndex((x,i)=>i>di && /^(?:Метасловарь|Справочники|Ответы справочной службы|Журнал)$/i.test(x));
  const end=ei>=0?ei:lines.length, section=lines.slice(di+1,end);
  for(let i=0;i<section.length;i++){
    const pos=detectPos(section[i]); if(pos==='unknown')continue;
    let hi=i-1; while(hi>=0 && !isWordLine(section[hi]))hi--;
    if(hi<0)continue;
    const stopRel=section.findIndex((x,j)=>j>i && /^Всё об этом слове$/i.test(x));
    const stop=stopRel>=0?stopRel:Math.min(section.length,i+80);
    const blockLines=section.slice(hi,stop+1), blockText=blockLines.join('\n');
    if(lineContainsQuery(section[hi],query)||blockLines.some(x=>lineContainsQuery(x,query)))
      return {text:blockText,pos,queryMatched:true,formLine:blockLines.find(x=>lineContainsQuery(x,query))||section[hi],confidence:'high'};
  }
  return null;
}

function findRelevantBlock(text,query){
  const lines=splitLines(text), primary=findGramotaDictionaryBlock(lines,query); if(primary)return primary;
  const posEntries=[];
  for(let i=0;i<lines.length;i++){const p=detectPos(lines[i]);if(p!=='unknown')posEntries.push({pos:p,posIndex:i});}
  const occ=lines.map((x,i)=>lineContainsQuery(x,query)?i:-1).filter(i=>i>=0);
  if(!occ.length||!posEntries.length)return {text:'',pos:'unknown',queryMatched:false,formLine:NO_INFO,confidence:'none'};
  const cand=posEntries.map(e=>({...e,distance:Math.min(...occ.map(o=>Math.abs(e.posIndex-o)))})).filter(x=>x.distance<=15).sort((a,b)=>a.distance-b.distance);
  if(!cand.length)return {text:'',pos:'unknown',queryMatched:true,formLine:lines[occ[0]],confidence:'low'};
  const c=cand[0], start=Math.max(0,c.posIndex-8), end=Math.min(lines.length,c.posIndex+70);
  return {text:lines.slice(start,end).join('\n'),pos:c.pos,queryMatched:true,formLine:lines[occ[0]],confidence:c.distance<=5?'high':'medium'};
}

function extractLemmaFromBlock(blockText,pos){
  const lines=splitLines(blockText), pi=lines.findIndex(x=>detectPos(x)===pos); if(pi<0)return NO_INFO;
  for(let i=pi-1;i>=Math.max(0,pi-5);i--){const c=lines[i].replace(/^[•·*-]\s*/,'').trim();if(isWordLine(c))return c;}
  const m=lines[pi].match(/^([А-ЯЁа-яё][А-ЯЁа-яё́-]{1,})\s+(?:Существительное|Глагол|Прилагательное|Наречие)\b/i);
  return m?m[1]:NO_INFO;
}

function firstMatch(text,patterns){for(const re of patterns){const m=text.match(re);if(m&&m[1])return normalizeText(m[1]);}return NO_INFO;}
function cleanRussianDefinition(s){return normalizeText(s).replace(/^[0-9]+[.)]\s*/,'').replace(/\s+/g,' ').trim();}
function extractDefinition(text,pos){
  const lines=splitLines(text), pi=lines.findIndex(x=>detectPos(x)===pos); if(pi<0)return NO_INFO;
  const stopRx=/^(?:Всё об этом слове|Метасловарь|Справочники|Ответы справочной службы|Журнал)$/i;
  const bad=/^(?:Словари|Все формы слова|ед\.\s*число|мн\.\s*число|единственное число|множественное число|именительный|родительный|дательный|винительный|творительный|предложный|1-е лицо|2-е лицо|3-е лицо|настоящее время|прошедшее время|будущее время)/i;
  const out=[];
  for(const line of lines.slice(pi+1)){
    if(stopRx.test(line))break;
    if(bad.test(line)||/^\d+[-–]\w+/.test(line))continue;
    if(isWordLine(line))continue;
    if(/^(?:мужской|женский|средний) род|^\d-е склонение|^Глагол,|^Прилагательное,|^Наречие/i.test(line))continue;
    if(line.length>2)out.push(cleanRussianDefinition(line));
    if(out.join(' ').length>500)break;
  }
  return out.join(' ').slice(0,500)||NO_INFO;
}

const CASES=[
  ['именительный','주격'],['родительный','생격'],['дательный','여격'],['винительный','대격'],['творительный','조격'],['предложный','전치격']
];
const CASE_RE=new RegExp('^(?:'+CASES.map(x=>x[0]).join('|')+')(?:\\s+падеж)?$','i');
function isCaseLine(x){return CASE_RE.test(normalizeText(x));}
function isNumberLine(x){return /^(?:ед\.?\s*число|единственное число|ед\. число|мн\.?\s*число|множественное число)$/i.test(x);}
function isGrammarNoise(x){return /^(?:Существительное|Прилагательное|Глагол|Наречие|Словари|Все формы слова|Всё об этом слове|мужской род|женский род|средний род|1-е склонение|2-е склонение|3-е склонение)$/i.test(x);}
function parseCaseForms(text, {adjective=false}={}){
  const lines=splitLines(text), out={}; let number='singular', current=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^мн\.?\s*число|^множественное число/i.test(line)){number='plural';continue;}
    if(/^ед\.?\s*число|^единственное число/i.test(line)){number='singular';continue;}
    const cm=CASES.find(c=>new RegExp('^'+c[0]+'(?:\\s+падеж)?$','i').test(line));
    if(cm){current=cm[0]; if(!out[current])out[current]={singular:NO_INFO,plural:NO_INFO}; continue;}
    if(!current||isGrammarNoise(line)||/^\d/.test(line)||/^(?:разговорное|книжное|устарелое)/i.test(line))continue;
    if(isWordLine(line) && !line.includes(' ')){
      if(out[current][number]===NO_INFO)out[current][number]=line;
    }
  }
  return out;
}
function formatCaseTable(t){return CASES.map(([ru,ko])=>({case:ko,singular:t[ru]?.singular||NO_INFO,plural:t[ru]?.plural||NO_INFO}));}

function accentWord(s){return s||NO_INFO;}
function extractHtmlTableForms(html){
  const out={};
  const tableRe=/<table\b[^>]*>([\s\S]*?)<\/table>/gi; let tm;
  while((tm=tableRe.exec(html))){
    const table=tm[1];
    if(!/Падеж/i.test(stripHtml(table)) || !/Единственное число/i.test(stripHtml(table)))continue;
    const rowRe=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
    while((rm=rowRe.exec(table))){
      const cells=[]; const cellRe=/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi; let cm;
      while((cm=cellRe.exec(rm[1])))cells.push(stripHtml(cm[1]).trim());
      if(cells.length>=3){
        const ru=cells[0].toLowerCase();
        if(CASES.some(c=>c[0]===ru))out[ru]={singular:cells[1]||NO_INFO,plural:cells[2]||NO_INFO};
      }
    }
    if(Object.keys(out).length)break;
  }
  return out;
}

function parseMarkdownCaseTable(raw=''){
  const out={};
  const lines=String(raw).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    if(!/^Падеж\s*\|/i.test(lines[i])) continue;
    for(let j=i+1;j<lines.length;j++){
      const line=lines[j];
      if(/^[-|\s]+$/.test(line)) continue;
      const parts=line.split('|').map(x=>x.trim());
      if(parts.length<3) break;
      const ru=parts[0].toLowerCase();
      if(!CASES.some(c=>c[0]===ru)) break;
      out[ru]={singular:parts[1]||NO_INFO,plural:parts[2]||NO_INFO};
    }
    if(Object.keys(out).length) break;
  }
  return out;
}

function parsePlainCaseTable(raw=''){
  const lines=splitLines(stripHtml(String(raw))).map(x=>x.replace(/^\|+|\|+$/g,'').trim()).filter(Boolean);
  const out={};
  // Pipe-free text may still preserve the six case names followed by two forms.
  for(let i=0;i<lines.length;i++){
    const ru=lines[i].toLowerCase();
    if(!CASES.some(c=>c[0]===ru)) continue;
    const vals=[];
    for(let j=i+1;j<lines.length && vals.length<2;j++){
      const x=lines[j];
      if(CASES.some(c=>c[0]===x.toLowerCase())) break;
      if(!isGrammarNoise(x) && !/^Падеж$/i.test(x) && !/^Единственное число|^Множественное число/i.test(x)) vals.push(x);
    }
    if(vals.length>=2) out[ru]={singular:vals[0],plural:vals[1]};
  }
  return out;
}

function extractMetaCaseTable(raw=''){
  const html=extractHtmlTableForms(raw);
  if(Object.keys(html).length>=4) return html;
  const md=parseMarkdownCaseTable(raw);
  if(Object.keys(md).length>=4) return md;
  const plain=parsePlainCaseTable(raw);
  return Object.keys(plain).length?plain:{};
}

function extractMetaAdjectiveTable(raw=''){
  const out={};
  const html=String(raw||'');
  const tableRe=/<table\b[^>]*>([\s\S]*?)<\/table>/gi; let tm;
  while((tm=tableRe.exec(html))){
    const table=tm[1];
    const plain=stripHtml(table);
    if(!/Падеж/i.test(plain)||!/мужской род/i.test(plain)||!/средний род/i.test(plain)) continue;
    const rowRe=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
    while((rm=rowRe.exec(table))){
      const cells=[]; const cellRe=/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi; let cm;
      while((cm=cellRe.exec(rm[1]))) cells.push(stripHtml(cm[1]).trim());
      if(cells.length>=5 && CASES.some(c=>c[0]===cells[0].toLowerCase())){
        out[cells[0].toLowerCase()]={masculine:cells[1]||NO_INFO,feminine:cells[2]||NO_INFO,neuter:cells[3]||NO_INFO,plural:cells[4]||NO_INFO};
      }
    }
    if(Object.keys(out).length>=4) break;
  }
  // Markdown version of the same table.
  if(Object.keys(out).length<4){
    const lines=String(raw).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    for(let i=0;i<lines.length;i++){
      if(!/^Падеж\s*\|/i.test(lines[i])) continue;
      for(let j=i+1;j<lines.length;j++){
        if(/^[-|\s]+$/.test(lines[j])) continue;
        const parts=lines[j].split('|').map(x=>x.trim());
        if(parts.length<5) break;
        const ru=parts[0].toLowerCase();
        if(!CASES.some(c=>c[0]===ru)) break;
        out[ru]={masculine:parts[1]||NO_INFO,feminine:parts[2]||NO_INFO,neuter:parts[3]||NO_INFO,plural:parts[4]||NO_INFO};
      }
      if(Object.keys(out).length) break;
    }
  }
  return out;
}

function extractMetaStructured(text){
  const raw=String(text||'');
  const lines=splitLines(stripHtml(raw));
  const out={lemma:NO_INFO,gender:NO_INFO,cases:{},adjectiveCases:{},meaning:NO_INFO};
  const heading=raw.match(/(?:^|\n)#\s*([^\n]+)/);
  if(heading) out.lemma=normalizeText(stripHtml(heading[1]));
  if(out.lemma===NO_INFO){
    const first=lines.find(x=>/^[А-ЯЁа-яё][А-ЯЁа-яё́-]{1,}$/.test(x));
    if(first) out.lemma=first;
  }
  const gm=raw.match(/Существительное,\s*(мужской|женский|средний) род/i);
  if(gm) out.gender=gm[1];
  out.cases=extractMetaCaseTable(raw);
  out.adjectiveCases=extractMetaAdjectiveTable(raw);
  const ti=lines.findIndex(x=>/^толкование$/i.test(x));
  if(ti>=0){
    const vals=[];
    for(let i=ti+1;i<lines.length;i++){
      const l=lines[i];
      if(/^(?:Синонимы|Однокоренные слова|это слово|рядом в словаре|Метасловарь|Подробнее)$/i.test(l)) break;
      if(/^(?:Большой |Русский |Современный |Словарь|Орфографический|Толковый)/i.test(l)) continue;
      if(!l || /^\d+[.)]?$/.test(l)) continue;
      if(/^[А-ЯЁа-яё][А-ЯЁа-яё\s-]{0,90}$/.test(l)&&l.length<90) continue;
      vals.push(l);
      if(vals.join(' ').length>700) break;
    }
    out.meaning=vals.join(' ').trim()||NO_INFO;
  }
  return out;
}

function extractNoun(text, metaRaw=''){
  const meta=metaRaw?extractMetaStructured(metaRaw):{lemma:NO_INFO,gender:NO_INFO,cases:{},meaning:NO_INFO};
  const cases=Object.keys(meta.cases).length?formatCaseTable(meta.cases):formatCaseTable(parseCaseForms(text));
  return {lemma:meta.lemma!==NO_INFO?meta.lemma:extractLemmaFromBlock(text,'noun'),meaningRu:meta.meaning!==NO_INFO?meta.meaning:extractDefinition(text,'noun'),gender:meta.gender!==NO_INFO?meta.gender:firstMatch(text,[/(?:Существительное,\s*)(мужской|женский|средний) род/i]),declension:firstMatch(text,[/(\d-е склонение)/i]),cases};
}
function extractVerbConjugation(text){
  const lines=splitLines(text), out={
    '1인칭 단수':NO_INFO,'2인칭 단수':NO_INFO,'3인칭 단수':NO_INFO,
    '1인칭 복수':NO_INFO,'2인칭 복수':NO_INFO,'3인칭 복수':NO_INFO
  };
  let person=null, number='singular';
  const pmap={'1-е лицо':'1','2-е лицо':'2','3-е лицо':'3'};
  for(let i=0;i<lines.length;i++){
    const l=lines[i]; if(/^мн\.?\s*число|^множественное число/i.test(l)){number='plural';continue;} if(/^ед\.?\s*число|^единственное число/i.test(l)){number='singular';continue;}
    const pm=l.match(/^(1-е|2-е|3-е) лицо/i); if(pm){person=pmap[pm[1]];continue;}
    if(person&&isWordLine(l)&&!isGrammarNoise(l)){
      const key=person+'인칭 '+(number==='singular'?'단수':'복수'); if(out[key]===NO_INFO)out[key]=l;
    }
  }
  return out;
}
function extractVerb(text){
  const aspect=firstMatch(text,[/(совершенный|несовершенный) вид/i]);
  const mobility=/\b(?:идти|ходить|ехать|ездить|бежать|бегать|нести|носить|вести|водить|лететь|летать|плыть|плавать|ползти|полза́ть)\b/i.test(text);
  return {lemma:extractLemmaFromBlock(text,'verb'),meaningRu:extractDefinition(text,'verb'),conjugationType:firstMatch(text,[/(\d-е спряжение)/i]),conjugation:extractVerbConjugation(text),aspect,aspectPair:extractAspectPair(text),motionType:mobility?extractMotionType(text):NO_INFO};
}
function extractAspectPair(text){
  const m=text.match(/(?:видовая пара|видовая корреляция|пара)\s*[:—-]?\s*([А-ЯЁа-яё́-]+)/i); return m?m[1]:NO_INFO;
}
function extractMotionType(text){
  const m=text.match(/\b(однонаправленн(?:ый|ое)|разнонаправленн(?:ый|ое)|однократн(?:ое|ая)|многократн(?:ое|ая))\b/i);
  if(!m)return NO_INFO;
  return /разнонаправ|многократ/i.test(m[1])?'부정태':'정태';
}
function formatAdjectiveTable(t){
  return CASES.map(([ru,ko])=>({case:ko,masculine:t[ru]?.masculine||NO_INFO,feminine:t[ru]?.feminine||NO_INFO,neuter:t[ru]?.neuter||NO_INFO,plural:t[ru]?.plural||NO_INFO}));
}
function extractAdjective(text, metaRaw=''){
  const meta=metaRaw?extractMetaStructured(metaRaw):{lemma:NO_INFO,meaning:NO_INFO,cases:{},adjectiveCases:{}};
  const cases=Object.keys(meta.adjectiveCases||{}).length?formatAdjectiveTable(meta.adjectiveCases):formatCaseTable(parseCaseForms(text,{adjective:true}));
  return {lemma:meta.lemma!==NO_INFO?meta.lemma:extractLemmaFromBlock(text,'adjective'),meaningRu:meta.meaning!==NO_INFO?meta.meaning:extractDefinition(text,'adjective'),cases};
}
function extractAdverb(text){return {lemma:extractLemmaFromBlock(text,'adverb'),meaningRu:extractDefinition(text,'adverb')};}

async function translateToKorean(russian){
  if(!russian||russian===NO_INFO)return NO_INFO;
  const text=russian.slice(0,500);
  const endpoints=[
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=ko&dt=t&q='+encodeURIComponent(text),
    'https://api.mymemory.translated.net/get?q='+encodeURIComponent(text)+'&langpair=ru|ko'
  ];
  for(const u of endpoints){
    try{
      const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json,text/plain,*/*'}});
      if(!r.ok)continue;
      const j=await r.json();
      let translated='';
      if(Array.isArray(j)) translated=(j?.[0]||[]).map(x=>x?.[0]||'').join('').trim();
      else translated=(j?.responseData?.translatedText||'').trim();
      if(translated && /[가-힣]/.test(translated))return translated;
    }catch{}
  }
  return NO_INFO;
}

async function fetchDirect(target){
  const r=await fetch(target,{headers:{
    'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36',
    'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language':'ru-RU,ru;q=0.9,en-US;q=0.7,en;q=0.5',
    'Referer':'https://gramota.ru/'
  }});
  return r;
}

async function fetchViaJina(target){
  const jinaUrl='https://r.jina.ai/'+target;
  let r=await fetch(jinaUrl,{headers:{'User-Agent':'Mozilla/5.0','Accept':'text/plain,text/html;q=0.9,*/*;q=0.8'}});
  if(r.ok)return {html:await r.text(),via:'jina-reader'};
  // Fallback for Reader deployments that require POST.
  r=await fetch('https://r.jina.ai/',{method:'POST',headers:{
    'Content-Type':'application/x-www-form-urlencoded',
    'Accept':'text/plain,text/html;q=0.9,*/*;q=0.8',
    'User-Agent':'Mozilla/5.0'
  },body:'url='+encodeURIComponent(target)});
  if(r.ok)return {html:await r.text(),via:'jina-reader-post'};
  throw new Error('Gramota 중계 접속 실패 (HTTP '+r.status+')');
}

async function fetchGramotaPage(target){
  try{
    const direct=await fetchDirect(target);
    if(direct.ok)return {html:await direct.text(),via:'direct'};
    if(direct.status!==429)throw new Error('Gramota 응답 오류: HTTP '+direct.status);
  }catch(e){
    if(!String(e.message||'').includes('429')) throw e;
  }
  return fetchViaJina(target);
}

function extractMetaLinks(html, query){
  const links=[];
  const re=/<a\b[^>]*href=["']([^"']*\/meta\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while((m=re.exec(html))){
    const href=decodeEntities(m[1]);
    const label=stripHtml(m[2]);
    if(!/\/meta\//i.test(href))continue;
    links.push({href,label});
  }
  // Jina Reader normally returns Markdown links instead of raw HTML anchors.
  const md=/\[([^\]\n]+)\]\((https?:\/\/gramota\.ru\/meta\/[^)]+)\)/gi;
  while((m=md.exec(html))){
    links.push({href:decodeEntities(m[2]),label:stripHtml(m[1])});
  }
  const nq=normalizeForMatch(query);
  const score=x=>{
    const nl=normalizeForMatch(x.label);
    let s=0;
    if(nl===nq)s+=100;
    if(nl.replace(/\s+/g,'')===nq.replace(/\s+/g,''))s+=50;
    if(nl.includes(nq)||nq.includes(nl))s+=20;
    return s;
  };
  return links.sort((a,b)=>score(b)-score(a));
}

function absoluteGramotaUrl(href){
  if(/^https?:\/\//i.test(href))return href;
  if(href.startsWith('//'))return 'https:'+href;
  return 'https://gramota.ru'+(href.startsWith('/')?href:'/ '+href).replace('/ ','/');
}

async function resolveMetaPage(searchHtml, query){
  const candidates=extractMetaLinks(searchHtml,query);
  if(!candidates.length)return null;
  for(const c of candidates.slice(0,5)){
    const url=absoluteGramotaUrl(c.href);
    try{
      const page=await fetchGramotaPage(url);
      return {url,html:page.html,via:page.via,linkLabel:c.label};
    }catch{}
  }
  return null;
}

async function gramota(q){
  const searchTarget='https://gramota.ru/poisk?query='+encodeURIComponent(q)+'&mode=all';
  const searchFetched=await fetchGramotaPage(searchTarget);
  // Important: follow the actual /meta/... link from the Gramota search result.
  // We do not manufacture /meta/<word> because inflected inputs can resolve to another lemma.
  const meta=await resolveMetaPage(searchFetched.html,q);
  const selectedSource=meta||searchFetched;
  const text=stripHtml(selectedSource.html);
  const selected=findRelevantBlock(text,q);
  if(!selected.queryMatched||selected.pos==='unknown'){
    return {ok:true,query:q,pos:'unknown',posLabel:'판별 불가',fields:{meaning:NO_INFO},metaUrl:meta?.url||null};
  }
  let fields;
  if(selected.pos==='noun')fields=extractNoun(selected.text, meta?.html||'');
  else if(selected.pos==='verb')fields=extractVerb(selected.text);
  else if(selected.pos==='adjective')fields=extractAdjective(selected.text, meta?.html||'');
  else fields=extractAdverb(selected.text);
  fields.meaning=await translateToKorean(fields.meaningRu);
  delete fields.meaningRu;
  return {ok:true,query:q,lemma:fields.lemma,pos:selected.pos,posLabel:posLabel(selected.pos),fields,metaUrl:meta?.url||null,transport:meta?.via||searchFetched.via};
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(u.pathname==='/api/gramota'){
      const q=(u.searchParams.get('q')||'').trim(); if(!q)return send(res,400,JSON.stringify({ok:false,error:'검색어가 없습니다.'}),'application/json; charset=utf-8');
      const data=await gramota(q); return send(res,200,JSON.stringify(data),'application/json; charset=utf-8');
    }
    if(u.pathname==='/api/health')return send(res,200,JSON.stringify({ok:true,version:'2.6.0',source:'Gramota'}),'application/json; charset=utf-8');
    if(u.pathname==='/'||u.pathname==='/index.html')return send(res,200,fs.readFileSync(path.join(ROOT,'index.html')),'text/html; charset=utf-8');
    return send(res,404,'Not found');
  }catch(e){return send(res,502,JSON.stringify({ok:false,error:e.message||'검색 실패'}),'application/json; charset=utf-8');}
});
if(require.main===module)server.listen(PORT,HOST,()=>console.log(`Russian Learning Tool V2.6: http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`));
module.exports={NO_INFO,decodeEntities,stripHtml,normalizeText,normalizeForMatch,detectPos,posLabel,isWordLine,splitLines,findGramotaDictionaryBlock,findRelevantBlock,extractMetaLinks,extractLemmaFromBlock,extractDefinition,parseCaseForms,extractNoun,extractVerb,extractAdjective,extractAdverb,translateToKorean,gramota};
