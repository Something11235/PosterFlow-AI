import assert from 'node:assert/strict';
import test from 'node:test';
import { characterForExport, embedCharacterPng } from '../src/lib/tavernExport.js';
import { exportCharacter, exportLorebook, normalizeCharacter, parseCharacterFile, parseLorebookFile } from '../src/lib/tavern.js';

const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),char => char.charCodeAt(0));
const card=() => normalizeCharacter({ name:'小舟🐋', description:' 中文设定\n保留空白 ',personality:'温和',scenario:'旧场景',firstMessage:'你好！',
  exampleMessages:'User: 你好',alternateGreetings:['','另一段开场'],tags:['中文','日常'],creator:'作者',characterVersion:'1.2',creatorNotes:'作者备注',
  systemPrompt:'只作为角色资料',postHistoryInstructions:'尾注',depthPrompt:{prompt:'深度提示',depth:3,role:'system'},
  loreEntries:[{id:'place',name:'海湾',keys:['海湾'],content:'有一座灯塔。',constant:false,enabled:true}] });

test('new PNG character cards round-trip all supported V2 fields and embedded lore including Unicode',async () => {
  const original=card(), snapshot=structuredClone(original), bytes=embedCharacterPng(png,original);
  const imported=await parseCharacterFile(new Blob([bytes],{type:'image/png'}));
  assert.deepEqual(exportCharacter(imported),exportCharacter(original));
  assert.deepEqual(original,snapshot); assert.equal(png.length,68);
  const lore=await parseLorebookFile(new Blob([bytes],{type:'image/png'}));
  assert.equal(lore.entries[0].content,'有一座灯塔。');
});

test('PNG re-export replaces prior character metadata so edited cards never re-import stale fields',async () => {
  const old=embedCharacterPng(png,{...card(),name:'旧名字'}), updated=embedCharacterPng(old,{...card(),name:'新名字'});
  const imported=await parseCharacterFile(new Blob([updated],{type:'image/png'}));
  assert.equal(imported.name,'新名字'); assert.ok(!imported.warnings.some(value => /重复/.test(value)));
  let offset=8, metadata=0; const view=new DataView(updated.buffer);
  while(offset+12<=updated.length) { const size=view.getUint32(offset); if(new TextDecoder().decode(updated.subarray(offset+4,offset+8))==='tEXt') metadata++; offset+=size+12; }
  assert.equal(metadata,1);
});

test('current story exports the edited scenario and lore without user persona, memory, messages or credentials',async () => {
  const original=card(), session={ scenario:'新的故事起点',persona:'PRIVATE_PERSONA',memory:'PRIVATE_MEMORY',summary:{text:'PRIVATE_SUMMARY'},
    apiKey:'PRIVATE_KEY',messages:[{content:'PRIVATE_CHAT'}],loreEntries:[{id:'new-place',name:'新地点',keys:['新'],content:'此刻的世界',constant:true,enabled:false}] };
  const snapshot=characterForExport(original,session), json=JSON.stringify(exportCharacter(snapshot));
  assert.equal(snapshot.scenario,'新的故事起点'); assert.equal(snapshot.loreEntries[0].content,'此刻的世界'); assert.equal(original.scenario,'旧场景');
  for(const value of ['PRIVATE_PERSONA','PRIVATE_MEMORY','PRIVATE_SUMMARY','PRIVATE_KEY','PRIVATE_CHAT']) assert.ok(!json.includes(value));
  const world=await parseLorebookFile(new Blob([JSON.stringify(exportLorebook(snapshot.loreEntries))],{type:'application/json'}));
  assert.equal(world.entries[0].constant,true); assert.equal(world.entries[0].enabled,false);
});

test('PNG export refuses corrupt headers, truncated files and invalid role data', () => {
  for(const bytes of [new Uint8Array(),png.subarray(0,24),new Uint8Array(16)]) assert.throws(() => embedCharacterPng(bytes,card()));
  const corrupted=png.slice(); corrupted[12]=0;
  assert.throws(() => embedCharacterPng(corrupted,card()));
  assert.throws(() => embedCharacterPng(png,{...card(),avatar:'https://remote.invalid/private.png'}));
});
