import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { durationSeconds, normalizeKeyword, keywords, filterVideos, extractTrends, goldenTime, enforceHashtags, fallbackIdea, normalizeIdea, collectVideos } from '../api/analyze.js';
const NOW = Date.parse('2026-10-23T12:00:00Z');
const id = n => `v${String(n).padStart(10,'0')}`;
function video(n, overrides={}) {
  return {id:id(n), snippet:{title:'#آشپزی #recipe',description:'#غذا #food',tags:['آشپزی','recipe'],publishedAt:new Date(NOW-(n+1)*3600000).toISOString(),channelId:`c${n%4}`,channelTitle:`Channel ${n%4}`},statistics:{viewCount:'12000',likeCount:'500',commentCount:'25'},contentDetails:{duration:'PT12S'},...overrides};
}
const makeResponse = (data,status=200) => new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function call(url='/api/analyze',headers={},method='GET') {
  const out={headers:{}};
  const res={setHeader:(k,v)=>out.headers[k]=v,status(n){out.status=n;return this;},json(body){out.body=body;return this;}};
  return handler({url,headers,method},res).then(()=>out);
}
test('ISO 8601 duration and invalid formats',()=>{
  assert.equal(durationSeconds('PT1H2M3S'),3723);assert.equal(durationSeconds('PT2M59S'),179);assert.equal(durationSeconds('PT0.5S'),.5);assert.equal(durationSeconds('bad'),0);
});
test('Unicode keywords, Persian normalization, noise and years',()=>{
  assert.equal(normalizeKeyword('يک كيك'),'کیک');assert.equal(normalizeKeyword('ASMR'),'asmr');assert.equal(normalizeKeyword('2026'),'');assert.equal(normalizeKeyword('۲۰۲۶'),'');assert.equal(normalizeKeyword('shorts'),'');assert.equal(normalizeKeyword('and'),'');
  const k=keywords({title:'#آشپزی #غذای_سالم #Shorts',description:'#ASMR #2026',tags:['آشپزی','recipe']});
  assert.deepEqual(k.all,['آشپزی','recipe','غذای_سالم','asmr']);
});
test('duration, views and age filters including missing likes and duplicate IDs',()=>{
  const items=[video(0),video(1,{contentDetails:{duration:'PT181S'}}),video(2,{statistics:{viewCount:'999'}}),video(3,{snippet:{...video(3).snippet,publishedAt:new Date(NOW-337*3600000).toISOString()}}),video(4,{contentDetails:{duration:'PT0S'}}),video(5,{statistics:{viewCount:'1000'}}),video(0),video(7,{snippet:{...video(7).snippet,publishedAt:new Date(NOW+1).toISOString()}})];
  const v=filterVideos(items,NOW);assert.equal(v.length,2);assert.equal(v.find(x=>x.id===id(5)).eng,0);
  assert.equal(v[0].score,Math.log10(v[0].vph+1)*(1+Math.min(v[0].eng,.2)*5));
});
test('age has minimum one hour, boundaries 180 seconds and 14 days included',()=>{
  const v=filterVideos([video(0,{snippet:{...video(0).snippet,publishedAt:new Date(NOW-1).toISOString()},contentDetails:{duration:'PT3M'}}),video(1,{snippet:{...video(1).snippet,publishedAt:new Date(NOW-336*3600000).toISOString()}})],NOW);
  assert.equal(v.length,2);assert.equal(v.find(v=>v.id===id(0)).ageH,1);
});
test('engagement score caps engagement at 0.2',()=>{
  const v=filterVideos([video(0,{statistics:{viewCount:'1000',likeCount:'100000',commentCount:'10000'}})],NOW)[0];assert.equal(v.score,Math.log10(v.vph+1)*2);
});
test('trend requires three distinct channels and fresh evidence; duplicate proofs removed',()=>{
  const v=filterVideos(Array.from({length:12},(_,n)=>video(n)),NOW);
  const trends=extractTrends(v);assert.equal(trends.length,1);assert.equal(trends[0].channelCount,4);assert.equal(trends[0].status,'در اوج');assert.equal(trends[0].recentCount,12);assert.equal(trends[0].evidence.length,3);
  assert.ok(trends[0].evidence[0].url.startsWith('https://www.youtube.com/shorts/'));
  assert.equal(extractTrends(v.map(x=>({...x,channelId:'one'}))).length,0);
  assert.equal(extractTrends(v.map(x=>({...x,ageH:73}))).length,0);
});
test('trend status below forty percent is still alive; median and evidence are numeric',()=>{
  const v=filterVideos(Array.from({length:10},(_,n)=>video(n)),NOW).map((x,n)=>({...x,ageH:n<3?10:100,vph:n+1}));
  const [t]=extractTrends(v);assert.equal(t.status,'هنوز زنده');assert.equal(t.medianVph,6);assert.equal(t.recentCount,3);
  assert.equal(extractTrends(v.map((x,n)=>({...x,ageH:n<4?10:100})))[0].status,'در اوج');
});
test('golden time is timezone aware, circular smoothing and second hour gap',()=>{
  const v=filterVideos(Array.from({length:20},(_,n)=>video(n,{snippet:{...video(n).snippet,publishedAt:'2026-10-23T12:00:00Z'}})),NOW);
  const g=goldenTime(v,'Asia/Tehran');assert.equal(g.bestHour,15);assert.equal(g.histogram[14],g.histogram[15]/2);assert.equal(g.histogram[16],g.histogram[15]/2);assert.equal(g.sampleSize,15);assert.equal(g.confidence,'پایین');assert.equal(g.averageDuration,12);
  const gap=Math.abs(g.bestHour-g.secondHour);assert.ok(Math.min(gap,24-gap)>=4);assert.equal(g.topDays[0],5);
});
test('golden confidence uses selected top sample size, not whole pool',()=>{
  const base=filterVideos(Array.from({length:10},(_,n)=>video(n)),NOW)[0];
  const make=n=>Array.from({length:n},()=>base);
  assert.equal(goldenTime(make(149),'UTC').confidence,'بالا');assert.equal(goldenTime(make(74),'UTC').confidence,'متوسط');assert.equal(goldenTime(make(20),'UTC').confidence,'پایین');
  assert.equal(goldenTime(make(10),'UTC').sampleSize,10);
});
test('hashtag and fallback invariants',()=>{
  const t=extractTrends(filterVideos(Array.from({length:12},(_,n)=>video(n)),NOW))[0];
  const tags=enforceHashtags(['#shorts','#Shorts','bad tag','#سلام دنیا','#one','#two','#three','#four'],t.topic);
  assert.equal(tags[0],'#shorts');assert.ok(tags.length<=5);assert.ok(tags.every(t=>!/[\s<>]/.test(t)));
  const i=fallbackIdea(t);assert.equal(i.duration,12);assert.equal(i.script.length,5);assert.equal(i.script[0].t,'0–2');assert.equal(i.script.at(-1).t,'10–12');assert.ok(i.caption.includes('؟'));
  assert.deepEqual(normalizeIdea({},t),i);
  const ai=normalizeIdea({...i,title:'x'.repeat(100),duration:19,script:[{...i.script[0],t:'0–2'},{...i.script[1],t:'2–10'},{...i.script[4],t:'10–15'}]},t);
  assert.equal(ai.duration,15);assert.equal(ai.title.length,59);assert.equal(ai.source,'gemini');
  assert.equal(normalizeIdea({...i,script:[...i.script.slice(1)]},t).source,'template');
});
test('collection: 4 popular pages, 2 searches, dedup and 50-item hydration, quota ceiling 210',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async url=>{
    const u=new URL(url);calls.push(u);const q=u.searchParams;
    if(u.pathname.endsWith('/search')){
      assert.equal(q.get('publishedAfter'),'2026-10-16T12:00:00.000Z');assert.equal(q.get('videoDuration'),'short');assert.equal(q.get('order'),'viewCount');
      const start=q.get('q')==='#shorts'?200:250;
      return makeResponse({items:Array.from({length:50},(_,i)=>({id:{videoId:id(start+i)}}))});
    }
    if(q.get('chart')){const page=Number(q.get('pageToken')||0);return makeResponse({items:Array.from({length:50},(_,i)=>({id:id(page*50+i)})),...(page<3?{nextPageToken:String(page+1)}:{})});}
    assert.equal(q.get('part'),'snippet,statistics,contentDetails');assert.ok(q.get('id').split(',').length<=50);
    return makeResponse({items:q.get('id').split(',').map(id=>({id}))});
  });
  const result=await collectVideos({region:'US',lang:'fa',key:'test',now:NOW,signal:new AbortController().signal});
  assert.equal(result.items.length,300);assert.equal(result.requestCount,12);assert.equal(result.estimatedQuota,210);assert.equal(calls.length,12);
});
test('collection deduplicates across queries and stops pagination without token',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{const u=new URL(url);return makeResponse({items:u.pathname.endsWith('/search')?[{id:{videoId:id(0)}}]:u.searchParams.has('chart')?[{id:id(0)}]:[video(0)]});});
  const r=await collectVideos({region:'US',lang:'fa',key:'x',now:NOW,signal:new AbortController().signal});assert.equal(r.candidateCount,1);assert.equal(r.requestCount,4);assert.equal(r.estimatedQuota,202);
});
function setEnv(t,key,value){const old=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old;});}
function youtubeMock(t,count=12,ai){
  const vids=Array.from({length:count},(_,n)=>{const v=video(n);v.snippet.publishedAt=new Date(Date.now()-(n+1)*3600000).toISOString();return v;});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const u=new URL(url);
    if(u.hostname==='generativelanguage.googleapis.com'){if(ai)return ai(url,options);throw new Error('offline');}
    if(u.pathname.endsWith('/search'))return makeResponse({items:vids.map(v=>({id:{videoId:v.id}}))});
    return makeResponse({items:u.searchParams.has('chart')?vids.map(v=>({id:v.id})):vids});
  });
}
test('handler rejects methods, missing key, password and invalid inputs in Persian with no-store',async t=>{
  setEnv(t,'YOUTUBE_API_KEY',undefined);setEnv(t,'APP_PASSWORD',undefined);
  assert.equal((await call()).body.code,'MISSING_KEY');assert.equal((await call()).headers['Cache-Control'],'no-store');
  assert.equal((await call('/api/analyze',{},'POST')).status,405);
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'APP_PASSWORD','secret');
  assert.equal((await call()).status,401);assert.equal((await call('/api/analyze?pass=secret&region=XX')).status,400);
  assert.equal((await call('/api/analyze?pass=secret&tz=bad')).status,400);
});
test('full success with evidence, public caching and template fallback',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'APP_PASSWORD',undefined);setEnv(t,'GEMINI_API_KEY',undefined);youtubeMock(t);
  const r=await call('/api/analyze?region=US&lang=fa&tz=Asia/Tehran');assert.equal(r.status,200);assert.equal(r.body.stats.qualified,12);assert.equal(r.body.ideas.length,1);assert.equal(r.body.ideas[0].duration,12);assert.equal(r.headers['Cache-Control'],'s-maxage=1800, stale-while-revalidate=3600');
});
test('protected responses are never cached; header and query auth both accepted',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'APP_PASSWORD','secret');setEnv(t,'GEMINI_API_KEY',undefined);youtubeMock(t);
  assert.equal((await call('/api/analyze',{'x-app-password':'secret'})).headers['Cache-Control'],'private, no-store');assert.equal((await call('/api/analyze?pass=secret')).status,200);
});
test('fewer than 10 videos returns Persian insufficient data and no ideas',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'APP_PASSWORD',undefined);youtubeMock(t,9);
  const r=await call();assert.equal(r.status,422);assert.equal(r.body.code,'INSUFFICIENT_DATA');assert.match(r.body.error,/داده کافی نیست/);assert.equal(r.body.ideas,undefined);
});
test('YouTube HTTP and transport failures return safe errors, not upstream secrets',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','secret-key');setEnv(t,'APP_PASSWORD',undefined);
  const mock=t.mock.method(globalThis,'fetch',async()=>makeResponse({error:{message:'secret-key'}},403));
  let r=await call();assert.equal(r.status,502);assert.equal(r.body.code,'YOUTUBE_API_ERROR');assert.ok(!JSON.stringify(r).includes('secret-key'));
  mock.mock.mockImplementation(async()=>{throw new Error('private-details');});r=await call();assert.equal(r.body.code,'CONNECTION_ERROR');
});
test('AI failure falls back without failing analysis',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'GEMINI_API_KEY','test');setEnv(t,'APP_PASSWORD',undefined);youtubeMock(t);
  const r=await call();assert.equal(r.status,200);assert.equal(r.body.ideaMode,'template');assert.equal(r.body.ideas[0].script.length,5);
});
test('AI JSON mode requested, model default, invalid JSON gracefully falls back',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'GEMINI_API_KEY','test');setEnv(t,'GEMINI_MODEL',undefined);setEnv(t,'APP_PASSWORD',undefined);
  youtubeMock(t,12,(url,options)=>{assert.match(url,/gemini-2\.0-flash/);const body=JSON.parse(options.body);assert.equal(body.generationConfig.responseMimeType,'application/json');assert.match(body.contents[0].parts[0].text,/هیچ ادعای خبری یا شایعه ننویس/);return makeResponse({candidates:[{content:{parts:[{text:'not json'}]}}]});});
  assert.equal((await call()).body.ideaMode,'template');
});
test('zero qualifying topics returns golden time but never manufactures ideas',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'APP_PASSWORD',undefined);setEnv(t,'GEMINI_API_KEY',undefined);
  const vids=Array.from({length:12},(_,n)=>{const v=video(n);v.snippet={...v.snippet,tags:[],title:'بدون هشتگ',description:'',publishedAt:new Date(Date.now()-(n+1)*3600000).toISOString()};return v;});
  t.mock.method(globalThis,'fetch',async url=>{const u=new URL(url);return makeResponse({items:u.pathname.endsWith('/search')?vids.map(v=>({id:{videoId:v.id}})):u.searchParams.has('chart')?vids.map(v=>({id:v.id})):vids});});
  const r=await call();assert.equal(r.status,200);assert.deepEqual(r.body.trends,[]);assert.deepEqual(r.body.ideas,[]);assert.ok(r.body.golden);assert.match(r.body.message,/ایده‌ای ساخته نشد/);
});
test('valid Gemini output accepted but metrics, sound and hashtag limits are server controlled',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'GEMINI_API_KEY','test');setEnv(t,'APP_PASSWORD',undefined);
  youtubeMock(t,12,(_url,options)=>{
    const prompt=JSON.parse(options.body).contents[0].parts[0].text;
    const trends=JSON.parse(prompt.split('داده: ')[1]);
    return makeResponse({candidates:[{content:{parts:[{text:JSON.stringify({ideas:trends.map(t=>({...fallbackIdea(t),why:'99999999 guaranteed views',sound:'copyright song',hashtags:['#one','#two','#three','#four','#five','#six']}))})}]}}]});
  });
  const r=await call();assert.equal(r.body.ideaMode,'gemini');assert.equal(r.body.ideas[0].source,'gemini');assert.ok(!r.body.ideas[0].why.includes('99999999'));assert.ok(!r.body.ideas[0].sound.includes('copyright song'));assert.equal(r.body.ideas[0].hashtags.length,5);assert.equal(r.body.ideas[0].hashtags[0],'#shorts');
});
test('trend cap is six with distinct evidence sets',()=>{
  const v=Array.from({length:8},(_,group)=>Array.from({length:3},(_,n)=>({id:id(group*3+n),all:[`topic_${group}`],hashtags:[],channelId:`channel${n}`,ageH:10,vph:100,score:10-group/10,title:'title',channel:'channel',views:1000}))).flat();
  const trends=extractTrends(v);assert.equal(trends.length,6);assert.equal(trends[0].topic,'topic_0');assert.equal(trends.at(-1).topic,'topic_5');
});
