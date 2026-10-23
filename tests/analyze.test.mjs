import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { durationSeconds, normalizeKeyword, keywords, filterVideos, extractTrends, goldenTime, enforceHashtags, fallbackIdea, normalizeIdea, collectVideos, buildMasterPrompt, localizeIdeas, ensurePromptLength, PROMPT_MIN, PROMPT_MAX, CAPTION_MAX, LANGUAGES } from '../api/analyze.js';
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
  const ai=normalizeIdea({...i,title:'گ'.repeat(100),duration:19,script:[{...i.script[0],t:'0–2'},{...i.script[1],t:'2–10'},{...i.script[4],t:'10–15'}]},t);
  assert.equal(ai.duration,15);assert.equal(ai.title.length,59);assert.equal(ai.source,'gemini');
  assert.equal(normalizeIdea({...i,script:[...i.script.slice(1)]},t).source,'template');
});
test('collection: 2 #shorts searches, dedup and 50-item hydration, quota ceiling 202',async t=>{
  const calls=[];
  t.mock.method(globalThis,'fetch',async url=>{
    const u=new URL(url);calls.push(u);const q=u.searchParams;
    if(u.pathname.endsWith('/search')){
      assert.equal(q.get('publishedAfter'),'2026-10-16T12:00:00.000Z');assert.equal(q.get('videoDuration'),'short');assert.equal(q.get('order'),'viewCount');
      const start=q.get('q')==='#shorts'?200:250;
      return makeResponse({items:Array.from({length:50},(_,i)=>({id:{videoId:id(start+i)}}))});
    }
    assert.equal(q.get('part'),'snippet,statistics,contentDetails');assert.ok(q.get('id').split(',').length<=50);
    return makeResponse({items:q.get('id').split(',').map(id=>({id}))});
  });
  const result=await collectVideos({region:'US',lang:'fa',key:'test',now:NOW,signal:new AbortController().signal});
  assert.equal(result.items.length,100);assert.equal(result.requestCount,4);assert.equal(result.estimatedQuota,202);assert.equal(calls.length,4);
});
test('collection deduplicates across queries and stops pagination without token',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{const u=new URL(url);return makeResponse({items:u.pathname.endsWith('/search')?[{id:{videoId:id(0)}}]:[video(0)]});});
  const r=await collectVideos({region:'US',lang:'fa',key:'x',now:NOW,signal:new AbortController().signal});assert.equal(r.candidateCount,1);assert.equal(r.requestCount,3);assert.equal(r.estimatedQuota,201);
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
test('trend cap is five with distinct evidence sets',()=>{
  const v=Array.from({length:8},(_,group)=>Array.from({length:3},(_,n)=>({id:id(group*3+n),all:[`topic_${group}`],hashtags:[],channelId:`channel${n}`,ageH:10,vph:100,score:10-group/10,title:'title',channel:'channel',views:1000}))).flat();
  const trends=extractTrends(v);assert.equal(trends.length,5);assert.equal(trends[0].topic,'topic_0');assert.equal(trends.at(-1).topic,'topic_4');
});

test('all five languages have native captions, dialogue and complete master prompts without AI',()=>{
  const trend=extractTrends(filterVideos(Array.from({length:12},(_,n)=>video(n)),NOW))[0];
  const localized=localizeIdeas([trend]);
  assert.deepEqual(Object.keys(localized),LANGUAGES);
  const expected={fa:'تو چه تغییری می‌دادی؟',en:'What would you change?',ar:'ما الذي كنت ستغيّره؟',tr:'Sen neyi değiştirirdin?',de:'Was würdest du verändern?'};
  for(const lang of LANGUAGES){
    const idea=localized[lang][0];assert.equal(idea.lang,lang);assert.ok(idea.caption.includes(expected[lang]));assert.ok(idea.hashtags.includes('#shorts'));assert.equal(idea.script.length,5);assert.ok(idea.masterPrompt.includes(idea.title));
    for(const word of ['1080×1920','30fps','9:16','MP4','SRT','0–2','10–12'])assert.ok(idea.masterPrompt.includes(word));
    assert.ok(idea.masterPrompt.includes(idea.script[0].voice));assert.ok(idea.masterPrompt.includes(`(${lang})`));
    if(['en','tr','de'].includes(lang))assert.ok(!/\p{Script=Arabic}/u.test(idea.caption));
  }
});
test('neighbouring funny/comedy/fun trends produce different executable stories',()=>{
  const base={hashtags:[],videoCount:3,channelCount:3,recentCount:1,medianVph:100};
  const prompts=['funny','comedy','fun','minivlog'].map(topic=>buildMasterPrompt(fallbackIdea({...base,topic},'en'),{...base,topic},'en'));
  assert.equal(new Set(prompts).size,4);
  const scenes=['funny','comedy','fun','minivlog'].map(topic=>fallbackIdea({...base,topic},'en').script[0].visual);
  assert.equal(new Set(scenes).size,4);
});
test('wrong-language AI output falls back in the requested language',()=>{
  const t={topic:'funny',hashtags:[],videoCount:3,channelCount:3,recentCount:1,medianVph:100};
  const wrong=fallbackIdea(t,'fa');assert.equal(normalizeIdea(wrong,t,'en').source,'template');assert.match(normalizeIdea(wrong,t,'en').caption,/What would you change/);
  const native=fallbackIdea(t,'de');assert.equal(normalizeIdea({...native,caption:'Ein kreativer Moment.'},t,'de').source,'gemini');assert.match(normalizeIdea({...native,caption:'Ein kreativer Moment.'},t,'de').caption,/Was würdest du verändern/);
});
test('API emits v2 localized output and max five ideas with master prompts',async t=>{
  setEnv(t,'YOUTUBE_API_KEY','test');setEnv(t,'APP_PASSWORD',undefined);setEnv(t,'GEMINI_API_KEY',undefined);youtubeMock(t);
  const r=await call('/api/analyze?lang=en');assert.equal(r.status,200);assert.equal(r.body.version,2);assert.equal(r.body.ideas[0].lang,'en');assert.ok(r.body.ideas[0].masterPrompt);assert.match(r.body.ideas[0].caption,/What would you change/);
  for(const lang of LANGUAGES)assert.equal(r.body.localizedIdeas[lang].length,r.body.trends.length);
});

test('golden minute is weighted median of actual publication minutes, not a random fixed number',()=>{
  const videos=[{publishedAt:'2026-10-23T12:05:00Z',score:1,duration:12},{publishedAt:'2026-10-23T12:35:00Z',score:4,duration:12},{publishedAt:'2026-10-23T12:55:00Z',score:1,duration:12}];
  const g=goldenTime(videos,'UTC');assert.equal(g.bestHour,12);assert.equal(g.bestMinute,35);assert.equal(g.minuteMethod,'weighted-median-publication');assert.ok(g.secondMinute>=0&&g.secondMinute<60);
  const tehran=goldenTime(videos,'Asia/Tehran');assert.equal(tehran.bestHour,16);assert.equal(tehran.bestMinute,5);
});
test('minute conversion respects midnight and local day-of-week',()=>{
  const g=goldenTime([{publishedAt:'2026-10-23T20:47:00Z',score:2,duration:12}],'Asia/Tehran');assert.equal(g.bestHour,0);assert.equal(g.bestMinute,17);assert.equal(g.topDays[0],6);
});


test('English production packages contain English-only directions, voice, overlay text and SRT lock for every concept',()=>{
  for(const topic of ['funny','food','craft','tech','sport','pet','travel','comedy','fun','minivlog','طنز']){
    const trend={topic,videoCount:3,channelCount:3,recentCount:1,medianVph:20};
    const idea=localizeIdeas([trend]).en[0];
    assert.doesNotMatch(idea.masterPrompt,/\p{Script=Arabic}/u);
    assert.match(idea.masterPrompt,/American English/);
    assert.match(idea.masterPrompt,/SRT subtitle file/);
    assert.match(idea.masterPrompt,/No Persian\/Farsi, no bilingual subtitles/);
    for(const beat of idea.script) for(const key of ['visual','voice','text']){
      assert.doesNotMatch(beat[key],/\p{Script=Arabic}/u);
      assert.ok(idea.masterPrompt.includes(beat[key]));
    }
    assert.doesNotMatch(idea.caption+idea.hashtags.join(' '),/\p{Script=Arabic}/u);
  }
});
test('English caption cannot hide Persian title, hook, narration or overlays in AI output',()=>{
  const trend={topic:'funny',videoCount:3,channelCount:3,recentCount:1,medianVph:20};
  const good=localizeIdeas([trend]).en[0];
  assert.equal(normalizeIdea(good,trend,'en').source,'gemini');
  for(const key of ['title','hook']) assert.equal(normalizeIdea({...good,[key]:'متن فارسی'},trend,'en').source,'template');
  for(const key of ['voice','text']){
    const mixed=structuredClone(good);mixed.script[2][key]='متن فارسی';
    assert.equal(normalizeIdea(mixed,trend,'en').source,'template');
  }
});
test('master prompt length is strictly 2400-2450 chars across all languages, topics, CRLF and Gemini extremes while caption+hashtags stays under 100',()=>{
  const topics=['funny','food','craft','tech','sport','pet','travel','comedy','fun','minivlog','طنز','ai','a'.repeat(64)];
  for(const lang of LANGUAGES){
    for(const topic of topics){
      const trend={topic,videoCount:4,channelCount:4,recentCount:2,medianVph:150};
      const idea=localizeIdeas([trend])[lang][0];
      assert.ok(idea.masterPrompt.length>=PROMPT_MIN&&idea.masterPrompt.length<=PROMPT_MAX,`${lang}/${topic} UTF-16=${idea.masterPrompt.length}`);
      const codePoints=[...idea.masterPrompt].length;
      assert.ok(codePoints>=PROMPT_MIN&&codePoints<=PROMPT_MAX,`${lang}/${topic} codePoints=${codePoints}`);
      const crlf=idea.masterPrompt.replace(/\n/g,'\r\n').length;
      assert.ok(crlf>=PROMPT_MIN&&crlf<=PROMPT_MAX,`${lang}/${topic} CRLF=${crlf}`);
      assert.ok(`${idea.caption}\n\n${idea.hashtags.join(' ')}`.length<=CAPTION_MAX);
      for(const beat of idea.script)for(const key of ['visual','voice','text'])assert.ok(idea.masterPrompt.includes(beat[key]));
    }
    const baseTrend={topic:'funny',videoCount:3,channelCount:3,recentCount:1,medianVph:50};
    const sample=fallbackIdea(baseTrend,lang);
    const hugeRaw={
      ...sample,
      duration:15,
      script:Array.from({length:8},(_,i)=>({
        t:['0–2','2–4','4–6','6–8','8–10','10–12','12–14','14–15'][i],
        visual:(lang==='fa'||lang==='ar'?'نمای نزدیک استودیویی با حرکت آرام دوربین روی سوژه اصلی ':'Detailed studio shot with smooth controlled camera motion ').repeat(7).trim(),
        voice:sample.script[0].voice,
        text:sample.script[0].text
      }))
    };
    const normalizedHuge=normalizeIdea(hugeRaw,baseTrend,lang);
    const hugeLocalized=localizeIdeas([baseTrend],[normalizedHuge],lang)[lang][0];
    assert.equal(hugeLocalized.source,'gemini');
    assert.ok(hugeLocalized.masterPrompt.length>=PROMPT_MIN&&hugeLocalized.masterPrompt.length<=PROMPT_MAX);
    assert.ok([...hugeLocalized.masterPrompt].length>=PROMPT_MIN&&[...hugeLocalized.masterPrompt].length<=PROMPT_MAX);
    for(const beat of hugeLocalized.script)for(const key of ['visual','voice','text'])assert.ok(hugeLocalized.masterPrompt.includes(beat[key]));
  }
  for(const n of [0,50,1500,2399,2400,2425,2450,3400]){
    for(const lang of ['en','fa']){
      const out=ensurePromptLength('x'.repeat(n),lang);
      assert.ok(out.length>=PROMPT_MIN&&out.length<=PROMPT_MAX);
    }
  }
});
