import assert from 'node:assert/strict';
import test from 'node:test';
import {buildTavernBgmPrompt,tavernBgmTrack,TAVERN_BGM_MOODS} from '../src/lib/tavernMusic.js';
test('story BGM uses bounded current scene and recent events without private settings',()=>{
 const prompt=buildTavernBgmPrompt({name:'深深',scenario:'旧场景',description:'private character setup'},
  {title:'雨夜',scenario:'雨中的海边',summary:{text:'一同等候天亮'},messages:[{content:'omitted old'},{content:'new 1'},{content:'new 2'},{content:'new 3'},{content:'new 4'}],apiKey:'never include',persona:'private persona'},'calm');
 assert.match(prompt,/雨中的海边/);assert.match(prompt,/一同等候天亮/);assert.match(prompt,/无人声、无歌词/);assert.match(prompt,/new 4/);
 assert.ok(!/omitted old|旧场景|private|never include/.test(prompt));
 assert.equal(TAVERN_BGM_MOODS.length,6);
 const bounded=buildTavernBgmPrompt({name:'x',scenario:'x'.repeat(9000)},{memory:'y'.repeat(9000),messages:Array.from({length:100},()=>({content:'z'.repeat(9000)}))});
 assert.ok(Array.from(bounded).length<3000);assert.throws(()=>buildTavernBgmPrompt({}, {},'unknown'));
});
test('BGM player accepts HTTPS audio only and strips all unrelated provider fields',()=>{
 assert.deepEqual(tavernBgmTrack({audio_url:'https://audio.example.invalid/track.mp3',title:'雨夜',apiKey:'secret',owner:'other'}),{audio_url:'https://audio.example.invalid/track.mp3',title:'雨夜'});
 for(const audio_url of ['javascript:alert(1)','http://localhost/private','https://user:pass@example.invalid/a','data:audio/mp3;base64,x'])assert.equal(tavernBgmTrack({audio_url}),null);
});
