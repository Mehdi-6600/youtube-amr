import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {localizeIdeas} from '../api/analyze.js';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({Intl,Date,console});new vm.Script(script).runInContext(context);
const run=expr=>vm.runInContext(expr,context);
const trend={topic:'funny',hashtags:['#comedy'],videoCount:3,channelCount:3,recentCount:1,medianVph:100,score:10,evidence:[]};
const fixture={version:2,region:'US',generatedAt:'2026-10-23T10:00:00Z',trends:[trend],localizedIdeas:localizeIdeas([trend])};
test('client script parses without a bundler',()=>{assert.equal(typeof run('getIdeas'),'function');});
test('XSS escaping handles HTML and textarea boundaries',()=>{
  context.input='</textarea><img src=x onerror="alert(1)">&\'test';
  assert.equal(run('esc(input)'),'&lt;/textarea&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;test');
});
test('switching language selects the actual native caption and master prompt, without fetch',()=>{
  context.result=fixture;
  for(const lang of ['fa','en','ar','tr','de']){
    context.lang=lang;const idea=run('getIdeas(result,lang)[0]');assert.equal(idea.lang,lang);assert.ok(idea.masterPrompt.includes(`(${lang})`));assert.equal(idea.caption,fixture.localizedIdeas[lang][0].caption);
  }
  assert.equal(run('getIdeas(result,"zz").length'),0);
});
test('copied caption always includes hashtags',()=>{
  context.idea=fixture.localizedIdeas.en[0];assert.equal(run('captionText(idea)'),`${context.idea.caption}\n\n${context.idea.hashtags.join(' ')}`);assert.match(run('captionText(idea)'),/#shorts/);
});
test('legacy, oversized and incomplete language bundles are rejected',()=>{
  context.r=fixture;assert.equal(run('validResult(r)'),true);
  context.r={...fixture,version:1};assert.equal(run('validResult(r)'),false);
  context.r={...fixture,trends:Array(6).fill(trend)};assert.equal(run('validResult(r)'),false);
  context.r={...fixture,localizedIdeas:{fa:fixture.localizedIdeas.fa}};assert.equal(run('validResult(r)'),false);
  const wrong=structuredClone(fixture);wrong.localizedIdeas.en[0].lang='fa';context.r=wrong;assert.equal(run('validResult(r)'),false);
});
test('card has exactly two copyable boxes and safe evidence links',()=>{
  const fn=run('renderCard'),idea={...fixture.localizedIdeas.en[0],title:'<img src=x>',masterPrompt:'</textarea><script>alert(1)</script>',caption:'<svg onload=alert(1)>'};
  const rendered=fn(idea,{...trend,evidence:[{url:'javascript:alert(1)',title:'bad'}]},0,'en');
  assert.equal((rendered.match(/<textarea /g)||[]).length,2);assert.equal((rendered.match(/data-copy=/g)||[]).length,2);
  assert.ok(!rendered.includes('href="javascript:'));assert.ok(!rendered.includes('<img'));assert.ok(!rendered.includes('<script>'));assert.ok(rendered.includes('&lt;script&gt;'));assert.ok(rendered.includes('lang="en"'));assert.ok(rendered.includes('dir="ltr"'));
});
test('main UI has no legacy chart, timing or long policy blocks',()=>{
  assert.ok(!html.includes('id="golden"'));assert.ok(!html.includes('id="stats"'));assert.ok(!html.includes('id="rules"'));assert.ok(html.includes('زبان ویدیو و کپشن'));assert.ok(html.includes("v:'2'"));
});
