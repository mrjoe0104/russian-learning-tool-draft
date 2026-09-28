const assert = require('assert');
const p = require('./server');

const noun = `# [обе́д](https://gramota.ru/meta/obed)

Существительное, мужской род, 2-е склонение

Падеж | Единственное число | Множественное число
--- | --- | ---
именительный | обе́д | обе́ды
родительный | обе́да | обе́дов
дательный | обе́ду | обе́дам
винительный | обе́д | обе́ды
творительный | обе́дом | обе́дами
предложный | обе́де | обе́дах`;
assert.equal(p.detectMetaPos(noun), 'noun');
const n = p.extractNoun(noun);
assert.equal(n.lemma, 'обе́д');
assert.equal(n.gender, 'мужской');
assert.equal(n.cases[0].singular, 'обе́д');
assert.equal(n.cases[5].plural, 'обе́дах');

const verb = `# [говори́ть](https://gramota.ru/meta/govorit)

Глагол, несовершенный вид, переходный

### Личные формы

Лицо | Настоящее время | Будущее время
--- | --- | ---
Я | говорю́ | буду говори́ть
Ты | говори́шь | будешь говори́ть
Он
Она
Оно | говори́т | будет говори́ть
Мы | говори́м | будем говори́ть
Вы | говори́те | будете говори́ть
Они | говоря́т | будут говори́ть

### Формы прошедшего времени

Число и род | Прошедшее время
--- | ---
Мужской род | говори́л
Женский род | говори́ла
Средний род | говори́ло
Множественное число | говори́ли

### Повелительное наклонение

Лицо |
--- | ---
Ты | говори́
Вы | говори́те`;
assert.equal(p.detectMetaPos(verb), 'verb');
const v = p.extractVerb(verb);
assert.equal(v.lemma, 'говори́ть');
assert.equal(v.aspect, 'несовершенный');
assert.equal(v.conjugation['3인칭 단수'], 'говори́т');
assert.equal(v.future['3인칭 복수'], 'будут говори́ть');
assert.equal(v.past['남성'], 'говори́л');
assert.equal(v.past['복수'], 'говори́ли');
assert.equal(v.imperative['2인칭 단수'], 'говори́');
assert.equal(v.imperative['2인칭 복수'], 'говори́те');

const perfect = `# [проговори́ть](https://gramota.ru/meta/progovorit)

Глагол, совершенный вид

Лицо | Будущее время
--- | ---
Я | проговорю́
Ты | проговори́шь
Он | проговори́т
Мы | проговори́м
Вы | проговори́те
Они | проговоря́т`;
const pv = p.extractVerb(perfect);
assert.equal(pv.aspect, 'совершенный');
assert.equal(pv.future['3인칭 복수'], 'проговоря́т');
assert.equal(pv.conjugation['1인칭 단수'], '정보 없음');

const adjective = `# [но́вый](https://gramota.ru/meta/novyi)

Прилагательное, качественное

### Склонение (полная форма)

Падеж | Единственное число | Множественное число
--- | --- | ---
мужской род | женский род | средний род
--- | --- | ---
именительный | но́вый | но́вая | но́вое | но́вые
родительный | но́вого | но́вой | но́вого | но́вых`;
assert.equal(p.detectMetaPos(adjective), 'adjective');
assert.equal(p.extractAdjective(adjective).cases[0].masculine, 'но́вый');
assert.equal(p.extractAdjective(adjective).cases[0].feminine, 'но́вая');
assert.equal(p.extractAdjective(adjective).cases[1].plural, 'но́вых');

assert.equal(p.detectMetaPos('Страница ответа\n검색 결과 설명'), 'unknown');
assert.equal(p.detectMetaPos('# [ма́ло](https://gramota.ru/meta/malo)\n\nПроизношение\n\nРусский орфографический словарь\n\nНаречие меры и степени'), 'adverb');
assert.equal(p.detectMetaPos('검색 결과의 설명에 Глагол이 포함됨'), 'unknown');
assert.equal(p.extractMetaLinks('<a href="https://gramota.ru/meta/kniga">кни́га</a>', 'книга')[0].url, 'https://gramota.ru/meta/kniga');


const htmlVerb = `<html><body><h1>говори́ть</h1><div>Произношение</div><div>Большой толковый словарь</div><div>Глагол, несовершенный вид, переходный</div><h3>Личные формы</h3><table><tr><th>Лицо</th><th>Настоящее время</th><th>Будущее время</th></tr><tr><td>Я</td><td>говорю́</td><td>буду говори́ть</td></tr><tr><td>Ты</td><td>говори́шь</td><td>будешь говори́ть</td></tr><tr><td>Он<br>Она<br>Оно</td><td>говори́т</td><td>будет говори́ть</td></tr></table><h3>Формы прошедшего времени</h3><table><tr><th>Число и род</th><th>Прошедшее время</th></tr><tr><td>Мужской род</td><td>говори́л</td></tr><tr><td>Женский род</td><td>говори́ла</td></tr></table><h3>Повелительное наклонение</h3><table><tr><th>Лицо</th><th></th></tr><tr><td>Ты</td><td>говори́</td></tr><tr><td>Вы</td><td>говори́те</td></tr></table></body></html>`;
assert.equal(p.detectMetaPos(htmlVerb), 'verb');
const hv = p.extractVerb(htmlVerb);
assert.equal(hv.conjugation['1인칭 단수'], 'говорю́');
assert.equal(hv.past['남성'], 'говори́л');
assert.equal(hv.imperative['2인칭 복수'], 'говори́те');


const htmlAdjective = `<h1>по́лный</h1><div>Прилагательное, качественное</div><h3>Склонение (полная форма)</h3><table><tr><th>Падеж</th><th colspan="2">Единственное число</th><th>Множественное число</th></tr><tr><th>мужской род</th><th>женский род</th><th>средний род</th><th></th></tr><tr><td>именительный</td><td>по́лный</td><td>по́лная</td><td>по́лное</td><td>по́лные</td></tr></table>`;
const ha = p.extractAdjective(htmlAdjective);
assert.equal(ha.cases[0].masculine, 'по́лный');
assert.equal(ha.cases[0].plural, 'по́лные');

console.log('all parser tests passed');

// Gramota 실제 Meta HTML 형태 회귀 테스트
const htmlNoun = `<h1>обе́д</h1><div>Произношение:</div><div>Русский орфографический словарь</div><div>Написание:</div><div>Русский орфографический словарь</div><div>Существительное, мужской род, 2-е склонение</div><table><tr><th>Падеж</th><th>Единственное число</th><th>Множественное число</th></tr><tr><td>именительный</td><td>обе́д</td><td>обе́ды</td></tr><tr><td>родительный</td><td>обе́да</td><td>обе́дов</td></tr><tr><td>дательный</td><td>обе́ду</td><td>обе́дам</td></tr><tr><td>винительный</td><td>обе́д</td><td>обе́ды</td></tr><tr><td>творительный</td><td>обе́дом</td><td>обе́дами</td></tr><tr><td>предложный</td><td>обе́де</td><td>обе́дах</td></tr></table><h2>толкование</h2><p>Период времени, предназначенный для основного приема пищи.</p>`;
assert.equal(p.detectMetaPos(htmlNoun), 'noun');
assert.equal(p.extractLemma(htmlNoun), 'обе́д');
assert.equal(p.extractGender(htmlNoun), 'мужской');
assert.equal(p.parseNounCases(htmlNoun)['родительный'].singular, 'обе́да');

const unknown = `<h1>неизвестно</h1><div>Страница ответа</div><div>검색 결과 설명</div>`;
assert.equal(p.detectMetaPos(unknown), 'unknown');

// 검색 결과 자체의 품사 표기를 1차 기준으로 사용한다.
const searchResult = `<div class="result"><a href="/meta/govorit">говори́ть</a><span>Глагол, несовершенный вид, переходный</span></div>`;
const sp = p.extractSearchPos(searchResult, 'говорить');
assert.equal(sp.pos, 'verb');
assert.equal(sp.label, 'говорить');

const pronoun = `# [я́](https://gramota.ru/meta/ya)

Местоимение, личное

Падеж | Единственное число | Множественное число
--- | --- | ---
именительный | я́ | мы́
родительный | меня́ | на́с
дательный | мне́ | на́м
винительный | меня́ | на́с
творительный | мно́й | на́ми
предложный | обо мне́ | о на́с`;
assert.equal(p.detectMetaPos(pronoun), 'pronoun');
const pr = p.extractFields(pronoun, 'pronoun');
assert.equal(pr.cases[0].singular, 'я́');

const spacedGender = `<h1>ребёнок</h1><div>Существительное , мужской род , 2-е склонение</div>`;
assert.equal(p.extractGender(spacedGender), 'мужской');

assert.equal(p.posLabel('pronoun'), 'Местоимение');
assert.equal(p.posLabel('conjunction'), 'Союз');
assert.equal(p.posLabel('particle'), 'Частица');
assert.equal(p.posLabel('interjection'), 'Междометие');
assert.equal(p.posLabel('numeral'), 'Числительное');
assert.equal(p.posLabel('preposition'), 'Предлог');

const searchMnogо = `Точное соответствие
много
Русский орфографический словарь
мн о́го, нареч. и в знач. числит.
много
Большой универсальный словарь русского языка
МН О́ГО^{3}, числ. неопред.-колич.
МНОГО^{1}, нареч.`;
assert.equal(p.extractSearchPos(searchMnogо, 'много').pos, 'adverb');

const searchPreposition = `Точное соответствие
в
Русский орфографический словарь
в, предл. с род. и вин.`;
assert.equal(p.extractSearchPos(searchPreposition, 'в').pos, 'preposition');

const searchMetaSummary = `## Словари
приложи́ть
Глагол, совершенный вид, переходный
1.
Приблизить вплотную к чему-либо.
Всё об этом слове`;
assert.equal(p.extractSearchPos(searchMetaSummary, 'приложить').pos, 'verb');

console.log('search POS tests passed');
