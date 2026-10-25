import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {localizeIdeas,englishProductionIdea,ensurePromptLength,PROMPT_MIN,PROMPT_MAX,CAPTION_MAX} from '../api/analyze.js';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({Intl,Date,console});new vm.Script(script).runInContext(context);
const run=expr=>vm.runInContext(expr,context);
const trend={topic:'funny',hashtags:['#comedy'],videoCount:3,channelCount:3,recentCount:1,medianVph:100,score:10,evidence:[]};
const fixture={version:2,qualityVersion:2,region:'US',generatedAt:'2026-10-23T10:00:00Z',trends:[trend],localizedIdeas:localizeIdeas([trend])};
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
test('main UI has no legacy chart or long policy blocks',()=>{
  assert.ok(!html.includes('id="golden"'));assert.ok(!html.includes('id="stats"'));assert.ok(!html.includes('id="rules"'));assert.ok(html.includes('زبان ویدیو و کپشن'));assert.ok(html.includes("v:'8'"));
});

const golden={timezone:'Asia/Tehran',bestHour:18,bestMinute:37,secondHour:10,secondMinute:12,topDays:[5,6,0],histogram:Array(24).fill(1)};
test('schedule uses real estimated minutes, preferred days, chronological 4h spacing and <=3/day',()=>{
  context.g=golden;
  const slots=run("scheduleIdeas(5,g,Date.parse('2026-10-23T08:00:00Z'))");assert.equal(slots.length,5);
  const counts={};
  for(let i=0;i<slots.length;i++){
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:golden.timezone,hourCycle:'h23',hour:'2-digit',minute:'2-digit',weekday:'short',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(slots[i])).map(p=>[p.type,p.value]));
    assert.equal(+parts.hour,i%2===0?18:10);assert.equal(+parts.minute,i%2===0?37:12);assert.ok(['Fri','Sat','Sun'].includes(parts.weekday));assert.ok(Date.parse(slots[i])>Date.parse('2026-10-23T08:05:00Z'));
    if(i)assert.ok(Date.parse(slots[i])-Date.parse(slots[i-1])>=4*3600000);
    const date=[parts.year,parts.month,parts.day].join('-');counts[date]=(counts[date]||0)+1;
  }
  assert.ok(Object.values(counts).every(n=>n<=3));
});
test('minutes that reduce a nominal 4-hour window below four hours are never scheduled too close',()=>{
  context.g={...golden,bestHour:18,bestMinute:55,secondHour:22,secondMinute:5,topDays:[0,1,2,3,4,5,6]};
  const slots=run("scheduleIdeas(5,g,Date.parse('2026-10-23T08:00:00Z'))");assert.equal(slots.length,5);
  for(let i=1;i<slots.length;i++)assert.ok(Date.parse(slots[i])-Date.parse(slots[i-1])>=4*3600000);
});
test('wall-clock minute conversion supports half-hour zones and skips DST gaps',()=>{
  assert.equal(new Date(run("zonedInstant(2026,10,23,18,37,'Asia/Tehran')")).toISOString(),'2026-10-23T15:07:00.000Z');
  assert.equal(run("zonedInstant(2026,3,29,2,30,'Europe/Amsterdam')"),null);
  for(const tz of ['Europe/Amsterdam','America/New_York','Australia/Sydney']){
    context.g={...golden,timezone:tz,bestHour:23,bestMinute:50,secondHour:3,secondMinute:15};
    const slots=run("scheduleIdeas(5,g,Date.parse('2026-10-24T20:00:00Z'))");assert.equal(slots.length,5);
    for(let i=1;i<slots.length;i++)assert.ok(Date.parse(slots[i])-Date.parse(slots[i-1])>=4*3600000);
  }
});
test('saved upload times survive language changes and are renewed once outdated',()=>{
  context.r={...fixture,golden};
  const now=Date.parse('2026-10-23T08:00:00Z');context.now=now;
  const schedule=run('uploadSchedule(r,now)');assert.equal(schedule.times.length,1);
  context.r.uploadSchedule=schedule;assert.equal(run('uploadSchedule(r,now)'),schedule);
  for(const lang of ['fa','en','ar','tr','de']){context.lang=lang;run('getIdeas(r,lang)');assert.equal(run('uploadSchedule(r,now)'),schedule);}
  context.now=Date.parse(schedule.times[0])+1000;const renewed=run('uploadSchedule(r,now)');assert.ok(Date.parse(renewed.times[0])>context.now);
});
test('invalid timing data does not invent upload recommendations',()=>{
  context.r={...fixture,golden:{...golden,timezone:'not/a/zone'}};assert.equal(run('uploadSchedule(r)'),null);
  context.r={...fixture,golden:{...golden,bestMinute:99}};assert.equal(run('uploadSchedule(r)'),null);
  context.r={...fixture};assert.equal(run('uploadSchedule(r)'),null);
});
test('card displays Persian calendar HH:mm and timezone above its master prompt',()=>{
  const idea=fixture.localizedIdeas.en[0];const rendered=run('renderCard')(idea,trend,0,'en',{at:'2026-10-23T15:07:00.000Z',timezone:'Asia/Tehran'});
  assert.match(rendered,/۱۸:۳۷/);assert.match(rendered,/جمعه/);assert.match(rendered,/۱۴۰۵/);assert.match(rendered,/Asia\/Tehran/);assert.ok(rendered.indexOf('زمان پیشنهادی بارگذاری')<rendered.indexOf('مسترپرامپت ساخت ویدیو'));assert.equal((rendered.match(/<textarea /g)||[]).length,2);
});
test('no evidence for a second hour uses the primary hour rather than a made-up secondary window',()=>{
  context.g={...golden,histogram:Array(24).fill(0)};context.g.histogram[18]=2;
  const slots=run("scheduleIdeas(5,g,Date.parse('2026-10-23T08:00:00Z'))");
  for(const slot of slots){const p=new Intl.DateTimeFormat('en-GB',{timeZone:golden.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(slot));assert.equal(p,'18:37');}
});

test('restored hourly-only results show an honest hour range instead of hiding upload times',()=>{
  context.r={...fixture,golden:{...golden,bestMinute:undefined,secondMinute:undefined}};
  context.now=Date.parse('2026-10-23T08:00:00Z');
  const schedule=run('uploadSchedule(r,now)');assert.equal(schedule.precision,'hour');assert.equal(schedule.times.length,1);
  context.upload={at:schedule.times[0],timezone:schedule.timezone,precision:schedule.precision};
  const card=run('renderUpload(upload)');assert.match(card,/بازهٔ پیشنهادی بارگذاری/);assert.match(card,/۱۸:۰۰–۱۸:۵۹/);assert.ok(!card.includes('دوباره تحلیل کن'));
  assert.equal(run('needsTimingRefresh(r)'),true);
});
test('legacy timing refresh is automatic, throttled for 30 minutes, and not retriggered for upgraded results',()=>{
  const now=Date.now();context.now=now;
  context.r={...fixture,golden:{...golden,bestMinute:undefined}};assert.equal(run('shouldRefreshTiming(r,now)'),true);
  context.r.timingRefreshAttemptAt=now;assert.equal(run('shouldRefreshTiming(r,now+1000)'),false);assert.equal(run('shouldRefreshTiming(r,now+30*60000)'),true);
  context.r={...fixture,golden};assert.equal(run('shouldRefreshTiming(r,now)'),false);
  context.r={...fixture,trends:[]};assert.equal(run('shouldRefreshTiming(r,now)'),false);
});
test('old saved prompt results refresh once for the stricter quality rules and throttle failures',()=>{
  const now=Date.now();context.now=now;
  context.r={...fixture};delete context.r.qualityVersion;
  assert.equal(run('shouldRefreshQuality(r,now)'),true);
  context.r.qualityRefreshAttemptAt=now;assert.equal(run('shouldRefreshQuality(r,now+1000)'),false);assert.equal(run('shouldRefreshQuality(r,now+30*60000)'),true);
  context.r={...fixture,qualityVersion:2};assert.equal(run('shouldRefreshQuality(r,now)'),false);
});
test('minute-level estimates stay minute-level and use a clearly named upload heading',()=>{
  context.r={...fixture,golden};const schedule=run('uploadSchedule(r)');assert.equal(schedule.precision,'minute');
  context.upload={at:schedule.times[0],timezone:schedule.timezone,precision:schedule.precision};const card=run('renderUpload(upload)');assert.match(card,/زمان پیشنهادی بارگذاری/);assert.ok(!card.includes('بازهٔ'));
});
test('HTML routes require cache revalidation without disabling API quota caching',async()=>{
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));
  for(const path of ['/','/index.html'])assert.ok(config.headers.some(rule=>rule.source===path&&rule.headers.some(h=>h.key==='Cache-Control'&&h.value.includes('must-revalidate'))));
  assert.ok(!config.headers.some(rule=>rule.source==='/api/analyze'&&rule.headers.some(h=>h.key==='Cache-Control')));
});


test('API and inline English prompt upgrades stay identical without a new framework or request',()=>{
  assert.equal(run('englishProductionIdea.toString()'),englishProductionIdea.toString());
});
test('old cached Persian directions are upgraded locally for English display and copying',()=>{
  const old=structuredClone(fixture);
  old.localizedIdeas.en[0].masterPrompt='این پرامپت قدیمی فارسی است';
  old.localizedIdeas.en[0].script[0].visual='نمای نزدیک فارسی';
  old.localizedIdeas.en[0].script[1].voice='گفتار فارسی';
  old.localizedIdeas.en[0].script[2].text='زیرنویس فارسی';
  context.old=old;
  const upgraded=run('getIdeas(old,"en")[0]');
  assert.doesNotMatch(upgraded.masterPrompt,/\p{Script=Arabic}/u);
  assert.match(upgraded.masterPrompt,/English-only SRT/);
  assert.equal(upgraded.caption,old.localizedIdeas.en[0].caption);
  assert.equal(run('getIdeas(old,"fa")[0].masterPrompt'),old.localizedIdeas.fa[0].masterPrompt);
  assert.equal(run('getIdeas(old,"en")[0].masterPrompt'),upgraded.masterPrompt);
  const markup=run('renderCard')(upgraded,trend,0,'en');
  assert.match(markup,/class="content prompt"[^>]*dir="ltr"[^>]*lang="en"/);
});
test('legacy over-3000-char stored prompts across ALL languages upgrade locally to 2400-2450 chars on load and copy',()=>{
  assert.equal(run('ensurePromptLength.toString()'),ensurePromptLength.toString().replace(/^export /,''));
  const stale=structuredClone(fixture);
  for(const lang of ['fa','en','ar','tr','de']){
    stale.localizedIdeas[lang][0].masterPrompt='X'.repeat(3363);
    stale.localizedIdeas[lang][0].caption='C'.repeat(2435);
  }
  context.stale=stale;
  for(const lang of ['fa','en','ar','tr','de']){
    context.lang=lang;
    const idea=run('getIdeas(stale,lang)[0]');
    assert.ok(idea.masterPrompt.length>=PROMPT_MIN&&idea.masterPrompt.length<=PROMPT_MAX,`${lang} upgraded len=${idea.masterPrompt.length}`);
    assert.ok(run('captionText(idea)').length<=CAPTION_MAX,`${lang} caption+tags len=${run('captionText(idea)').length}`);
    const card=run('renderCard')(idea,trend,0,lang);
    assert.match(card,/حرف<\/small>/);
  }
});
