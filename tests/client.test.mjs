import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const context=vm.createContext({Intl,Date,console});new vm.Script(script).runInContext(context);
const run=expr=>vm.runInContext(expr,context);
test('client JavaScript parses without a bundler',()=>{assert.equal(typeof run('scheduleIdeas'),'function');});
test('XSS escaping handles every HTML metacharacter',()=>{
  context.input='<img src=x onerror="alert(1)">&\'test';
  assert.equal(run('esc(input)'),'&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;test');
});
test('wall-clock conversion supports fractional offset and DST',()=>{
  assert.equal(new Date(run("zonedInstant(2026,10,23,18,'Asia/Tehran')")).toISOString(),'2026-10-23T14:30:00.000Z');
  assert.equal(new Date(run("zonedInstant(2026,7,1,18,'Europe/Amsterdam')")).toISOString(),'2026-07-01T16:00:00.000Z');
  assert.equal(run("zonedInstant(2026,3,29,2,'Europe/Amsterdam')"),null);
  assert.equal(new Date(run("zonedInstant(2026,10,25,2,'Europe/Amsterdam')")).toISOString().slice(11,16),'01:00');
});
test('scheduling alternates hours, prefers top days, only future and >=4h gap, <=3/day',()=>{
  const tz='Asia/Tehran';
  const slots=run("scheduleIdeas(Array(6).fill({}),{timezone:'Asia/Tehran',bestHour:18,secondHour:10,topDays:[5,6,0]},Date.parse('2026-10-23T08:00:00Z'))");
  assert.equal(slots.length,6);
  for(let i=0;i<slots.length;i++){
    const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',hour:'numeric',weekday:'short'}).formatToParts(new Date(slots[i])).map(p=>[p.type,p.value]));
    assert.equal(+p.hour,i%2===0?18:10);assert.ok(['Fri','Sat','Sun'].includes(p.weekday));if(i)assert.ok(Date.parse(slots[i])-Date.parse(slots[i-1])>=4*3600000);
  }
  const counts={};slots.forEach(s=>{const date=new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(new Date(s));counts[date]=(counts[date]||0)+1;});assert.ok(Object.values(counts).every(n=>n<=3));
});
test('schedules around DST and circularly separated hours',()=>{
  for (const tz of ['America/New_York','Europe/Amsterdam','Asia/Tehran','Australia/Sydney']) {
    context.tz=tz;
    const slots=run("scheduleIdeas(Array(6).fill({}),{timezone:tz,bestHour:23,secondHour:3,topDays:[0,1,2]},Date.parse('2026-10-24T21:00:00Z'))");
    assert.equal(slots.length,6);for(let i=1;i<slots.length;i++)assert.ok(Date.parse(slots[i])-Date.parse(slots[i-1])>=4*3600000);
  }
});
test('Persian calendar upload date is displayed',()=>{
  const s=run("formatSlot('2026-10-23T14:30:00Z','Asia/Tehran')");assert.match(s,/جمعه/);assert.match(s,/۱۴۰۵/);assert.match(s,/۱۸:۰۰/);
});
test('untrusted video URL cannot become a javascript link',()=>{
  const fn=run('renderIdea');const idea={duration:12,title:'<img src=x onerror=alert(1)>',script:[],hashtags:[],source:'template'};
  const trend={topic:'<svg onload=alert(1)>',evidence:[{url:'javascript:alert(1)',title:'<script>alert(1)</script>'}],hashtags:[]};
  const rendered=fn(idea,trend,0,null,'UTC');assert.ok(!rendered.includes('href="javascript:'));assert.ok(!rendered.includes('<img'));assert.ok(!rendered.includes('<script'));assert.ok(rendered.includes('&lt;img'));
});
