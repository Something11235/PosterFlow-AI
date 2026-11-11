import assert from 'node:assert/strict';
import test from 'node:test';
import { TAVERN_IMAGE_TEMPLATES, buildTavernImagePrompt, normalizeTavernImageTemplates } from '../src/lib/tavernImageTemplates.js';
import { buildTavernBackgroundPrompt } from '../src/lib/tavernBackgroundPrompt.js';
import { normalizeTavernState } from '../src/lib/tavernStorage.js';
import { normalizeTavernAppearance, tavernBackgroundStyle, removeTavernBackground, TAVERN_BACKGROUND_FITS } from '../src/lib/tavernAppearance.js';

const character={name:'小舟',description:'银色头发，蓝色披风。',personality:'温和',scenario:'旧场景',loreEntries:[]};
const session={scenario:'灯塔旁的黄昏',persona:'USER_PERSONA_青色外套',memory:'MEMORY_一起看海',messages:[{content:'OLDER_EXCLUDED'},...Array.from({length:4},(_,i)=>({content:`海边剧情${i}`}))],loreEntries:[]};

test('eight Chinese image presets render bounded prompts without paid helper calls or mutating the story', t=>{
  const fetch=t.mock.method(globalThis,'fetch',()=>{throw new Error('No paid helper');}), original=structuredClone(session);
  assert.equal(TAVERN_IMAGE_TEMPLATES.length,8);
  for(const preset of TAVERN_IMAGE_TEMPLATES){assert.match(preset.text,/[\u4e00-\u9fff]/);const prompt=buildTavernImagePrompt(preset.id,character,session,{subject:'月色下的船坞'});assert.ok(prompt.length<=6000);assert.ok(!prompt.includes('OLDER_EXCLUDED'));assert.match(prompt,/画面不出现文字/);}
  assert.deepEqual(session,original);assert.equal(fetch.mock.callCount(),0);
});
test('template types reference only requested user and story material, and selected message wins over the latest',()=>{
  const bg=buildTavernImagePrompt('background',character,session), portrait=buildTavernImagePrompt('portrait',character,session);
  for(const prompt of [bg,portrait])assert.ok(!prompt.includes('USER_PERSONA'));
  assert.ok(!bg.includes('银色头发'));assert.match(portrait,/银色头发/);
  assert.match(buildTavernImagePrompt('user',character,session),/USER_PERSONA/);
  const last=buildTavernImagePrompt('last',character,session,{message:'SELECTED_雪中的石桥'});assert.match(last,/SELECTED_雪中的石桥/);assert.ok(!last.includes('海边剧情3'));
  assert.throws(()=>buildTavernImagePrompt('custom',character,session),/主题/);
});
test('user templates persist only whitelisted text and macros expand once without evaluating imported role content',()=>{
  const templates={portrait:'为{{char}}画肖像。参考：{{character}}'};
  const prompt=buildTavernImagePrompt('portrait',{...character,description:'INERT_{{persona}}'},session,{templates});
  assert.match(prompt,/INERT_\{\{persona\}\}/);assert.ok(!prompt.includes('USER_PERSONA'));
  const saved=normalizeTavernState({characters:[],sessions:[],favorites:[],imageTemplates:templates});assert.deepEqual(saved.imageTemplates,templates);
  const defaults=Object.fromEntries(TAVERN_IMAGE_TEMPLATES.map(item=>[item.id,item.text]));assert.deepEqual(normalizeTavernImageTemplates(defaults),{});
  for(const overrides of [{portrait:''},{portrait:'A'.repeat(4001)},{portrait:'{{apiKey}}'},{apiKey:'never-store'},{portrait:'bad\0template'}]) assert.throws(()=>normalizeTavernImageTemplates(overrides));
});
test('quick backgrounds share the saved background template and escaped huge references remain under the prompt limit',()=>{
  const templates={background:'绘制纯环境：{{scenario}}，无人物。'};assert.equal(buildTavernBackgroundPrompt(character,session,templates),buildTavernImagePrompt('background',character,session,{templates}));
  const huge={...session,scenario:'\\'.repeat(3000),persona:'\\'.repeat(3000),memory:'\\'.repeat(6000),messages:Array.from({length:4},()=>({content:'\\'.repeat(5000)}))};
  for(const preset of TAVERN_IMAGE_TEMPLATES)assert.ok(buildTavernImagePrompt(preset.id,{...character,description:'\\'.repeat(16000)},huge,{subject:'\\'.repeat(1000)}).length<=6000);
  assert.throws(()=>buildTavernImagePrompt('portrait',{...character,name:'长'.repeat(80)},session,{templates:{portrait:'{{char}}'.repeat(500)}}),/6000/);
});
test('all five background fits preserve full-area dimming, disable tiling and retain saved image dimensions for centering',()=>{
  const image='data:image/jpeg;base64,QQ==',backgrounds=[{id:'bg',image}];
  for(const fit of TAVERN_BACKGROUND_FITS){const a=normalizeTavernAppearance({preset:'library',backgroundId:'bg',surface:'glass',dim:60,fit:fit.id});const style=tavernBackgroundStyle(a,backgrounds);assert.equal(style.backgroundSize,`100% 100%, ${fit.size}`);assert.equal(style.backgroundPosition,`center, ${fit.position}`);assert.equal(style.backgroundRepeat,'no-repeat');assert.match(style.backgroundImage,/0.6/);assert.equal(removeTavernBackground({backgrounds,appearance:a},'bg').appearance.fit,fit.id);}
  assert.equal(tavernBackgroundStyle({preset:'image',image}).backgroundPosition,'center, center');
  assert.throws(()=>normalizeTavernAppearance({fit:'url(https://untrusted.invalid)'}));
});
