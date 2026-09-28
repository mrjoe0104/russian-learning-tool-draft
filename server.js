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
  const noise=/^(?:Словари|Все формы слова|Падеж|Единственное число|Множественное число|ед\.\s*число|мн\.\s*число|именительный|родительный|дательный|винительный|творительный|предложный|1-е лицо|2-е лицо|3-е лицо|настоящее время|прошедшее время|будущее время)/i;
  const junk=/(https?:\/\/|\[!?[^\]]*\]\(|\]\(|VKontakte|телеграм|Telegram|поделиться|share|изображение|image|соцсет|bookmarks)/i;
  const out=[];
  let inDefinitions=false;
  for(const line of lines.slice(pi+1)){
    if(stopRx.test(line))break;
    if(junk.test(line))continue;
    if(/^\d+[.)]\s*/.test(line)){
      inDefinitions=true;
      const clean=cleanRussianDefinition(line);
      if(clean.length>2)out.push(clean);
      continue;
    }
    if(noise.test(line))continue;
    if(isWordLine(line))continue;
    if(/^(?:мужской|женский|средний) род|^\d-е склонение|^Глагол,|^Прилагательное,|^Наречие/i.test(line))continue;
    if(inDefinitions && line.length>2)out.push(cleanRussianDefinition(line));
    if(out.join(' ').length>700)break;
  }
  return out.join(' ').slice(0,700)||NO_INFO;
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

function cleanMarkdownLine(s=''){
  return String(s).replace(/^\s*#+\s*/,'').replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*_`]/g,'').trim();
}

function parseMarkdownCaseTable(raw=''){
  const out={};
  const lines=String(raw).split(/\r?\n/).map(x=>cleanMarkdownLine(x)).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    if(!/^Падеж\s*\|/i.test(lines[i])) continue;
    for(let j=i+1;j<lines.length;j++){
      const line=lines[j];
      if(/^[-|:\s]+$/.test(line)) continue;
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


function extractCompactCaseForms(text=''){
  const out={};
  const lines=splitLines(stripHtml(String(text)));
  let number=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    let content=line;
    if(/^ед\.\s*число\s+/i.test(content)){number='singular'; content=content.replace(/^ед\.\s*число\s+/i,'');}
    else if(/^мн\.\s*число\s+/i.test(content)){number='plural'; content=content.replace(/^мн\.\s*число\s+/i,'');}
    else if(/^ед\.\s*число$/i.test(content)){number='singular'; continue;}
    else if(/^мн\.\s*число$/i.test(content)){number='plural'; continue;}
    if(!number) continue;
    const m=content.match(/^(именительный|родительный|дательный|винительный|творительный|предложный)(?:\s*\/\s*(именительный|родительный|дательный|винительный|творительный|предложный))*\s+(.+)$/i);
    if(!m) continue;
    const cases=content.match(/^(?:именительный|родительный|дательный|винительный|творительный|предложный)(?:\s*\/\s*(?:именительный|родительный|дательный|винительный|творительный|предложный))*/i);
    const names=cases?cases[0].split('/').map(x=>x.trim().toLowerCase()):[];
    let value=content.slice(cases?cases[0].length:0).trim();
    value=value.replace(/^(?:\/\s*)+/,'').trim();
    if(!value || isGrammarNoise(value)) continue;
    for(const ru of names){
      if(!out[ru]) out[ru]={singular:NO_INFO,plural:NO_INFO};
      out[ru][number]=value;
    }
  }
  return out;
}

function mergeCaseTables(primary={}, secondary={}){
  const out={...secondary};
  for(const [ru,v] of Object.entries(primary)) out[ru]={...(out[ru]||{}),...v};
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

function extractMetaStructured(text, fallbackLemma=NO_INFO){
  const raw=String(text||'');
  const cleanedRaw=raw.replace(/\r/g,'');
  const lines=splitLines(stripHtml(cleanedRaw).split('\n').map(x=>cleanMarkdownLine(x)).join('\n'));
  const out={lemma:NO_INFO,gender:NO_INFO,cases:{},adjectiveCases:{},meaning:NO_INFO};

  const headingMd=cleanedRaw.match(/(?:^|\n)#+\s*(?:\[([^\]]+)\]\([^)]*\)|([^\n]+))/);
  if(headingMd) out.lemma=normalizeText(stripHtml(headingMd[1]||headingMd[2]||''));
  if(/^(?:Справочная|Справочник|Словари|Метасловарь)$/i.test(out.lemma)) out.lemma=NO_INFO;
  if(out.lemma===NO_INFO && fallbackLemma && fallbackLemma!==NO_INFO){
    out.lemma=normalizeText(fallbackLemma);
  }
  if(out.lemma===NO_INFO){
    const first=lines.find(x=>/^[А-ЯЁа-яё][А-ЯЁа-яё́-]{1,}$/.test(x) && !/^(?:Справочная|Справочник|Словари|Метасловарь)$/i.test(x));
    if(first) out.lemma=first;
  }

  const gm=cleanedRaw.match(/Существительное,\s*(мужской|женский|средний) род/i);
  if(gm) out.gender=gm[1];
  out.cases=extractMetaCaseTable(cleanedRaw);
  out.adjectiveCases=extractMetaAdjectiveTable(cleanedRaw);

  const ti=lines.findIndex(x=>/^#{0,3}\s*толкование$/i.test(x));
  if(ti>=0){
    const vals=[];
    for(let i=ti+1;i<lines.length;i++){
      let l=cleanMarkdownLine(lines[i]);
      if(/^(?:Синонимы|Однокоренные слова|это слово|рядом в словаре|Метасловарь|Подробнее)$/i.test(l)) break;
      if(/^(?:Большой |Русский |Современный |Словарь|Орфографический|Толковый)/i.test(l)) continue;
      if(!l || /^\d+[.)]?$/.test(l)) continue;
      if(/^(?:Падеж|Единственное число|Множественное число|ед\.\s*число|мн\.\s*число|именительный|родительный|дательный|винительный|творительный|предложный)$/i.test(l)) continue;
      if(/https?:\/\/|VKontakte|Telegram|поделиться|share|изображение|image/i.test(l)) continue;
      if(/^[А-ЯЁа-яё][А-ЯЁа-яё\s-]{0,90}$/.test(l)&&l.length<90) continue;
      vals.push(l);
      if(vals.join(' ').length>700) break;
    }
    out.meaning=vals.join(' ').trim()||NO_INFO;
  }
  return out;
}
function extractNoun(text, metaRaw='', fallbackLemma=NO_INFO){
  const meta=metaRaw?extractMetaStructured(metaRaw,fallbackLemma):{lemma:NO_INFO,gender:NO_INFO,cases:{},meaning:NO_INFO};
  const compact=extractCompactCaseForms(text);
  const parsed=parseCaseForms(text);
  const metaCases=meta.cases||{};
  const merged=mergeCaseTables(compact,mergeCaseTables(metaCases,parsed));
  const lemma=meta.lemma!==NO_INFO?meta.lemma:extractLemmaFromBlock(text,'noun');
  if(lemma!==NO_INFO){
    if(!merged['именительный']) merged['именительный']={singular:NO_INFO,plural:NO_INFO};
    if(merged['именительный'].singular===NO_INFO) merged['именительный'].singular=lemma;
  }
  const cases=formatCaseTable(merged);
  return {lemma,meaningRu:extractDefinition(text,'noun'),gender:meta.gender!==NO_INFO?meta.gender:firstMatch(text,[/(?:Существительное,\s*)(мужской|женский|средний) род/i]),declension:firstMatch(text,[/(\d-е склонение)/i]),cases};
}
function parseMarkdownTable(raw, headerMatchers) {
  const lines=String(raw||'').split(/\r?\n/).map(x=>cleanMarkdownLine(x)).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    if(!lines[i].includes('|')) continue;
    const headers=lines[i].split('|').map(x=>x.trim());
    if(headers.length<headerMatchers.length) continue;
    if(!headerMatchers.every((m,idx)=>m.test(headers[idx]||''))) continue;
    const rows=[];
    let pendingLabel='';
    for(let j=i+1;j<lines.length;j++){
      if(/^[-|:\s]+$/.test(lines[j])) continue;
      if(!lines[j].includes('|')){ pendingLabel=lines[j]; continue; }
      const cells=lines[j].split('|').map(x=>cleanMarkdownLine(x.trim()));
      if(pendingLabel && !cells[0]) cells[0]=pendingLabel;
      if(pendingLabel && cells[0]!==pendingLabel && /^$/.test(cells[0])) cells[0]=pendingLabel;
      pendingLabel='';
      if(cells.length<headers.length) break;
      rows.push(cells.slice(0,headers.length));
    }
    if(rows.length) return {headers,rows};
  }
  return null;
}

function extractHtmlTables(raw=''){
  const tables=[];
  const re=/<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while((tm=re.exec(String(raw)))){
    const rows=[]; const rr=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi; let rm;
    while((rm=rr.exec(tm[1]))){
      const cells=[]; const cr=/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi; let cm;
      while((cm=cr.exec(rm[1]))) cells.push(stripHtml(cm[1]).trim());
      if(cells.length) rows.push(cells);
    }
    if(rows.length) tables.push(rows);
  }
  return tables;
}

function extractSectionMarkdownTable(raw, sectionTitle){
  const lines=String(raw||'').split(/\r?\n/).map(x=>cleanMarkdownLine(x)).filter(Boolean);
  for(let i=0;i<lines.length;i++){
    if(lines[i].toLowerCase()!==sectionTitle.toLowerCase()) continue;
    for(let j=i+1;j<Math.min(lines.length,i+20);j++){
      if(!lines[j].includes('|')) continue;
      const headers=lines[j].split('|').map(x=>x.trim());
      if(j+1<lines.length && /^[-|:\s]+$/.test(lines[j+1])){
        const rows=[];
        let pendingLabel='';
        for(let k=j+2;k<lines.length;k++){
          if(!lines[k].includes('|')){ pendingLabel=lines[k]; continue; }
          const cells=lines[k].split('|').map(x=>cleanMarkdownLine(x.trim()));
          if(pendingLabel && !cells[0]) cells[0]=pendingLabel;
          pendingLabel='';
          if(cells.length<headers.length) break;
          rows.push(cells.slice(0,headers.length));
        }
        if(rows.length)return {headers,rows};
      }
    }
  }
  return null;
}

function findVerbTables(raw=''){
  const out={present:null,future:null,past:null,imperative:null};
  const tables=extractHtmlTables(raw);
  const mdPresent=parseMarkdownTable(raw,[/^(Лицо|лицо)$/i,/^Настоящее время$/i,/^Будущее время$/i]);
  if(mdPresent) out.present=mdPresent;

  const useRows=(rows)=>{
    if(!rows?.length)return;
    const h=rows[0].map(x=>normalizeText(x));
    const joined=h.join(' | ');
    if(/Лицо/i.test(joined)&&/Настоящее время/i.test(joined)&&/Будущее время/i.test(joined)) out.present={headers:h,rows:rows.slice(1)};
    else if(/Лицо/i.test(joined)&&/Будущее время/i.test(joined)) out.future={headers:h,rows:rows.slice(1)};
  };
  for(const rows of tables) useRows(rows);

  out.past=extractSectionMarkdownTable(raw,'Формы прошедшего времени')||out.past;
  out.imperative=extractSectionMarkdownTable(raw,'Повелительное наклонение')||out.imperative;
  return out;
}

function extractVerbConjugation(text=''){
  const t=findVerbTables(text), out={
    '1인칭 단수':NO_INFO,'2인칭 단수':NO_INFO,'3인칭 단수':NO_INFO,
    '1인칭 복수':NO_INFO,'2인칭 복수':NO_INFO,'3인칭 복수':NO_INFO
  };
  if(t.present){
    for(const row of t.present.rows){
      const person=normalizeText(row[0]||'');
      const current=row[1]||NO_INFO;
      const key=person.match(/^([ЯТтОоМмВвОо][^ ]*)/i) ? null : null;
      const map={
        'Я':'1인칭 단수','Ты':'2인칭 단수','Он':'3인칭 단수','Она':'3인칭 단수','Оно':'3인칭 단수',
        'Мы':'1인칭 복수','Вы':'2인칭 복수','Они':'3인칭 복수'
      };
      if(map[person]) out[map[person]]=current;
    }
  }
  return {present:out, future:extractVerbFuture(text,t), past:extractVerbPast(text,t), imperative:extractVerbImperative(text,t)};
}

function extractVerbFuture(text,t=findVerbTables(text)){
  const out={'1인칭 단수':NO_INFO,'2인칭 단수':NO_INFO,'3인칭 단수':NO_INFO,'1인칭 복수':NO_INFO,'2인칭 복수':NO_INFO,'3인칭 복수':NO_INFO};
  if(t.present){
    const map={'Я':'1인칭 단수','Ты':'2인칭 단수','Он':'3인칭 단수','Она':'3인칭 단수','Оно':'3인칭 단수','Мы':'1인칭 복수','Вы':'2인칭 복수','Они':'3인칭 복수'};
    for(const row of t.present.rows) if(map[row[0]]) out[map[row[0]]]=row[2]||NO_INFO;
  }
  if(t.future && !t.present){
    const map={'Я':'1인칭 단수','Ты':'2인칭 단수','Он':'3인칭 단수','Она':'3인칭 단수','Оно':'3인칭 단수','Мы':'1인칭 복수','Вы':'2인칭 복수','Они':'3인칭 복수'};
    for(const row of t.future.rows) if(map[row[0]]) out[map[row[0]]]=row[1]||NO_INFO;
  }
  return out;
}

function extractVerbPast(text,t=findVerbTables(text)){
  const out={'남성':NO_INFO,'여성':NO_INFO,'중성':NO_INFO,'복수':NO_INFO};
  if(!t.past)return out;
  const rows=t.past.rows||[];
  const map={'мужской':'남성','мужской род':'남성','женский':'여성','женский род':'여성','средний':'중성','средний род':'중성','множественное число':'복수','множественное':'복수'};
  for(const row of rows){
    const k=map[normalizeText(row[0]||'').toLowerCase()];
    if(k) out[k]=row[1]||NO_INFO;
  }
  return out;
}

function extractVerbImperative(text,t=findVerbTables(text)){
  const out={'2인칭 단수':NO_INFO,'2인칭 복수':NO_INFO};
  if(!t.imperative)return out;
  for(const row of t.imperative.rows||[]){
    const person=normalizeText(row[0]||'');
    const value=row[1]||NO_INFO;
    if(person==='Ты') out['2인칭 단수']=value;
    else if(person==='Вы') out['2인칭 복수']=value;
  }
  return out;
}

function extractVerb(text, metaRaw='', fallbackLemma=NO_INFO){
  const source=String(metaRaw||text);
  const meta=metaRaw?extractMetaStructured(metaRaw,fallbackLemma):{lemma:NO_INFO};
  const blockLemma=extractLemmaFromBlock(text,'verb');
  const lemma=meta.lemma!==NO_INFO?meta.lemma:(blockLemma!==NO_INFO?blockLemma:fallbackLemma);
  const aspect=firstMatch(source,[/(совершенный|несовершенный) вид/i]);
  const tables=extractVerbConjugation(source);
  const movement=firstMatch(source,[/(однонаправленн(?:ый|ое)|разнонаправленн(?:ый|ое)|однократн(?:ое|ая)|многократн(?:ое|ая))/i]);
  return {
    lemma:lemma||NO_INFO,
    meaningRu:extractDefinition(text,'verb'),
    conjugationType:firstMatch(source,[/(\d-е спряжение)/i]),
    conjugation:tables.present,
    future:tables.future,
    past:tables.past,
    imperative:tables.imperative,
    aspect,
    motionType:movement!==NO_INFO?( /разнонаправ|многократ/i.test(movement)?'비정향':'정향'):NO_INFO
  };
}
function formatAdjectiveTable(t){
  return CASES.map(([ru,ko])=>({case:ko,masculine:t[ru]?.masculine||NO_INFO,feminine:t[ru]?.feminine||NO_INFO,neuter:t[ru]?.neuter||NO_INFO,plural:t[ru]?.plural||NO_INFO}));
}
function extractAdjective(text, metaRaw='', fallbackLemma=NO_INFO){
  const meta=metaRaw?extractMetaStructured(metaRaw,fallbackLemma):{lemma:NO_INFO,meaning:NO_INFO,cases:{},adjectiveCases:{}};
  const cases=Object.keys(meta.adjectiveCases||{}).length?formatAdjectiveTable(meta.adjectiveCases):formatCaseTable(parseCaseForms(text,{adjective:true}));
  return {lemma:meta.lemma!==NO_INFO?meta.lemma:extractLemmaFromBlock(text,'adjective'),meaningRu:meta.meaning!==NO_INFO?meta.meaning:extractDefinition(text,'adjective'),cases};
}
function extractAdverb(text){return {lemma:extractLemmaFromBlock(text,'adverb'),meaningRu:extractDefinition(text,'adverb')};}

async function translateToKorean(russian){
  if(!russian||russian===NO_INFO)return NO_INFO;
  const q=String(russian).trim().slice(0,500);
  try{
    const url='https://api.mymemory.translated.net/get?q='+encodeURIComponent(q)+'&langpair=ru|ko';
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 Russian-Learning-Tool/2.9','Accept':'application/json'}});
    if(r.ok){
      const j=await r.json();
      const translated=String(j?.responseData?.translatedText||'').trim();
      if(/[가-힣]/.test(translated)) return translated;
    }
  }catch{}
  try{
    const url='https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl=ko&dt=t&q='+encodeURIComponent(q);
    const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 Russian-Learning-Tool/2.9','Accept':'application/json,text/plain,*/*'}});
    if(r.ok){
      const j=await r.json();
      const translated=Array.isArray(j?.[0])?j[0].map(x=>Array.isArray(x)?x[0]:'').join('').trim():'';
      if(/[가-힣]/.test(translated)) return translated;
    }
  }catch{}
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
  // Morphology is parsed from the Gramota search result first; the meta page is kept
  // for the original link and as a secondary source only.
  const text=stripHtml(searchFetched.html);
  const selected=findRelevantBlock(text,q);
  const metaText=meta?.html?stripHtml(meta.html):'';
  const metaPos=metaText?detectPos(metaText):'unknown';
  const pos=(metaPos!=='unknown')?metaPos:selected.pos;
  const selectedText=(pos===selected.pos&&selected.text)?selected.text:text;
  if(!meta && (!selected.queryMatched||selected.pos==='unknown')){
    return {ok:true,query:q,pos:'unknown',posLabel:'판별 불가',fields:{meaning:NO_INFO},metaUrl:null};
  }
  if(pos==='unknown'){
    return {ok:true,query:q,pos:'unknown',posLabel:'판별 불가',fields:{meaning:NO_INFO},metaUrl:meta?.url||null};
  }
  let fields;
  if(pos==='noun')fields=extractNoun(selectedText, meta?.html||'', meta?.linkLabel||NO_INFO);
  else if(pos==='verb')fields=extractVerb(selectedText, meta?.html||'', meta?.linkLabel||NO_INFO);
  else if(pos==='adjective')fields=extractAdjective(selectedText, meta?.html||'', meta?.linkLabel||NO_INFO);
  else fields=extractAdverb(selectedText);
  fields.meaning=await translateToKorean(fields.lemma!==NO_INFO?fields.lemma:fields.meaningRu);
  delete fields.meaningRu;
  return {ok:true,query:q,lemma:fields.lemma,pos,posLabel:posLabel(pos),fields,metaUrl:meta?.url||null,transport:meta?.via||searchFetched.via};
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,'http://localhost');
    if(u.pathname==='/api/gramota'){
      const q=(u.searchParams.get('q')||'').trim(); if(!q)return send(res,400,JSON.stringify({ok:false,error:'검색어가 없습니다.'}),'application/json; charset=utf-8');
      const data=await gramota(q); return send(res,200,JSON.stringify(data),'application/json; charset=utf-8');
    }
    if(u.pathname==='/api/health')return send(res,200,JSON.stringify({ok:true,version:'3.0.0',source:'Gramota'}),'application/json; charset=utf-8');
    if(u.pathname==='/'||u.pathname==='/index.html')return send(res,200,fs.readFileSync(path.join(ROOT,'index.html')),'text/html; charset=utf-8');
    return send(res,404,'Not found');
  }catch(e){return send(res,502,JSON.stringify({ok:false,error:e.message||'검색 실패'}),'application/json; charset=utf-8');}
});
if(require.main===module)server.listen(PORT,HOST,()=>console.log(`Russian Learning Tool V3.0: http://${HOST==='0.0.0.0'?'localhost':HOST}:${PORT}`));
module.exports={NO_INFO,decodeEntities,stripHtml,normalizeText,normalizeForMatch,detectPos,posLabel,isWordLine,splitLines,findGramotaDictionaryBlock,findRelevantBlock,extractMetaLinks,extractLemmaFromBlock,extractDefinition,parseCaseForms,extractNoun,extractVerb,extractAdjective,extractAdverb,translateToKorean,gramota};
