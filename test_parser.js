const assert = require('assert');
const {
  NO_INFO, stripHtml, normalizeForMatch, findRelevantBlock,
  extractFields
} = require('./server');

const fixtures = {
  nounExact: `кни́га\nСуществительное, женский род, 1-е склонение\nкни́ги, кни́ге, кни́гу, кни́гой, кни́гою, кни́ге, кни́ги, книг, кни́гам, кни́гами, кни́гах\n1. Печатное произведение...`,
  nounInflected: `кни́га\nСуществительное, женский род, 1-е склонение\nВсе формы слова\nкни́ги, кни́ге, кни́гу, кни́гой, кни́гою, кни́ге, кни́ги, книг, кни́гам, кни́гами, кни́гах\n1. Печатное произведение...`,
  verbExact: `говори́ть\nГлагол, несовершенный вид, непереходный\nговорю́, го́воришь, говоря́т\n1. Владеть речью...`,
  verbInflected: `говори́ть\nГлагол, несовершенный вид, непереходный\nВсе формы слова\nговори́л, говори́ли, говори́ло\n1. Владеть речью...`,
  adjective: `но́вый\nПрилагательное, качественное\nно́в, нова́, но́во\n1. Недавно появившийся...`,
  adverb: `бы́стро\nНаречие\n1. С высокой скоростью...`
};

function run(name, text, query, expectedPos, expectedLemma) {
  const selected = findRelevantBlock(text, query);
  assert.strictEqual(selected.queryMatched, true, `${name}: query must match`);
  assert.strictEqual(selected.pos, expectedPos, `${name}: POS`);
  const fields = extractFields(selected.text, selected.pos, query);
  assert.strictEqual(normalizeForMatch(fields.lemma), normalizeForMatch(expectedLemma), `${name}: lemma`);
  assert.notStrictEqual(fields.meaning, NO_INFO, `${name}: meaning should be extracted`);
  return {name, pos:selected.pos, lemma:fields.lemma};
}

const results = [];
results.push(run('noun exact', fixtures.nounExact, 'книга', 'noun', 'кни́га'));
results.push(run('noun inflected', fixtures.nounInflected, 'книгами', 'noun', 'кни́га'));
results.push(run('verb exact', fixtures.verbExact, 'говорить', 'verb', 'говори́ть'));
results.push(run('verb inflected', fixtures.verbInflected, 'говорили', 'verb', 'говори́ть'));
results.push(run('adjective', fixtures.adjective, 'новый', 'adjective', 'но́вый'));
results.push(run('adverb', fixtures.adverb, 'быстро', 'adverb', 'бы́стро'));

const missing = findRelevantBlock('Найдено 0 словарных статей.\nПопробуйте другой запрос.', 'несуществующееслово');
assert.strictEqual(missing.queryMatched, false, 'missing word must not be guessed');
assert.strictEqual(missing.pos, 'unknown', 'missing word POS must be unknown');
assert.strictEqual(missing.confidence, 'none', 'missing word confidence must be none');

const ambiguous = findRelevantBlock(`слово\nСуществительное, мужской род, 2-е склонение\n\nслово\nПрилагательное, качественное`, 'слово');
assert.strictEqual(ambiguous.confidence, 'ambiguous', 'ambiguous result must remain ambiguous');
assert.strictEqual(ambiguous.pos, 'unknown', 'ambiguous POS must not be guessed');

const html = stripHtml('<div>кни́га</div><div>Существительное, женский род, 1-е склонение</div>');
assert.ok(html.includes('кни́га') && html.includes('Существительное'), 'HTML stripping');

console.log(JSON.stringify({ok:true, tests:results.length + 4, results}, null, 2));
