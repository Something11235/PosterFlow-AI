import assert from "node:assert/strict";
import test from "node:test";
import { buildAudioOperationParameters, isRejectedMusicSelection, musicAudioFile, musicReferenceSelection, uploadMusicReference, musicFailedBeforeSubmission } from "../src/lib/musicReferences.js";
import { defaultSuno } from "../src/lib/music.js";
import { musicHistorySnapshot, restoreMusicHistory } from "../src/lib/musicHistory.js";
import { buildStudioDraft } from "../src/lib/studioCatalog.js";

test("audio reference creation uses its own whitelist and preserves zero weights", () => {
  const body=buildAudioOperationParameters({...defaultSuno(),custom:true,prompt:"歌词",style:"jazz",duration:120,instrumental:true,style_weight:0,audio_weight:"0",persona_id:"secret",audio_url:"private"},"inspo");
  assert.equal(body.style_weight,0);assert.equal(body.audio_weight,0);
  for(const key of ["duration","custom","instrumental","persona_id","audio_url"]) assert.equal(Object.hasOwn(body,key),false);
});
test("source signing failures never become unknown paid tasks; accepted or ambiguous submissions stay recoverable", () => {
  assert.equal(musicFailedBeforeSubmission({code:"MUSIC_REFERENCE_STORAGE",status:503}),true);
  assert.equal(musicFailedBeforeSubmission({code:"MUSIC_REFERENCE_EXPIRED",status:400}),true);
  assert.equal(musicFailedBeforeSubmission({code:"AUTH_REQUIRED",status:401}),true);
  assert.equal(musicFailedBeforeSubmission({code:"MUSIC_DATABASE_UNAVAILABLE",status:503}),false);
  assert.equal(musicFailedBeforeSubmission({code:"MUSIC_SUBMISSION_UNKNOWN",status:503,submission_unknown:true}),false);
  assert.equal(musicFailedBeforeSubmission({code:"MUSIC_PROVIDER_REJECTED",status:422,reason_code:"MUSIC_AUDIO_POLICY_REJECTED"}),false);
});
test("an explicit audio rejection stops repeat submission of the same selection and operation only", () => {
  const first = { id: "first", reference: { receipt: "private" } }, second = { id: "second" };
  for (const operation of ["flow_cover", "upload_cover", "inspo"]) {
    const items = operation === "inspo" ? [first, second] : [first];
    const selection = musicReferenceSelection(operation, items);
    assert.equal(selection.includes("private"), false);
    for (const code of ["MUSIC_AUDIO_POLICY_REJECTED", "MUSIC_AUDIO_MATCH", "MUSIC_AUDIO_COPYRIGHT"]) {
      const jobs = [{ referenceSelection: selection, status: "failed", error_code: code }];
      assert.equal(isRejectedMusicSelection(jobs, musicReferenceSelection(operation, [...items].reverse())), true);
      assert.equal(isRejectedMusicSelection(jobs, musicReferenceSelection(operation, [second])), false);
      assert.equal(isRejectedMusicSelection(jobs, musicReferenceSelection("generate", items)), false);
    }
    for (const code of ["MUSIC_CONTENT_REJECTED", "MUSIC_PROVIDER_TIMEOUT", "MUSIC_TASK_FAILED"]) {
      assert.equal(isRejectedMusicSelection([{ referenceSelection: selection, status: "failed", error_code: code }], selection), false);
    }
  }
});
test("cover description and custom lyrics send only fields for their selected mode", () => {
  const input={...defaultSuno(),prompt:"轻快爵士",style:"stale",duration:120,style_weight:0};
  assert.deepEqual(buildAudioOperationParameters(input,"upload_cover"),{model:"suno",version:"v6",prompt:"轻快爵士",custom:false,instrumental:true});
  const custom=buildAudioOperationParameters({...input,custom:true},"upload_cover");
  assert.equal(custom.duration,120);assert.equal(custom.style,"stale");
  assert.throws(()=>buildAudioOperationParameters(defaultSuno(),"upload_cover"),/描述/);
  assert.throws(()=>buildAudioOperationParameters({...defaultSuno(),custom:true,instrumental:false},"upload_cover"),/改编歌词/);
  assert.equal(Object.hasOwn(buildAudioOperationParameters({...defaultSuno(),custom:true,instrumental:true},"upload_cover"),"prompt"),false);
  for(const audio_weight of [NaN,Infinity,-1,1.1])assert.throws(()=>buildAudioOperationParameters({...input,custom:true,audio_weight},"inspo"),/0–1/);
});
test("audio history and drafts keep creation method and text but never assets or upload receipts", () => {
  const values={...defaultSuno(),operation:"inspo",prompt:"原创旋律",api_key:"SENTINEL_KEY",references:["SENTINEL_RECEIPT"],audio_url:"SENTINEL_URL",files:["SENTINEL_FILE"]};
  const history=musicHistorySnapshot(values),draft=buildStudioDraft("music",values);
  assert.match(history.prompt,/参考音频创作/);
  assert.equal(restoreMusicHistory(history).operation,"inspo");
  assert.equal(draft.body.operation,"inspo");assert.match(draft.note,/重新添加音频/);
  assert.equal(JSON.stringify([history,draft]).includes("SENTINEL"),false);
});
test("file selection enforces the website limit without mistaking image size for audio size", () => {
  assert.equal(musicAudioFile({name:"my.wav",size:20*1024*1024}).content_type,"audio/wav");
  assert.equal(musicAudioFile({name:"MY.MP3",size:100}).content_type,"audio/mpeg");
  for(const file of [{name:"a.png",size:10},{name:"a.wav",size:0},{name:"a.wav",size:20*1024*1024+1}])assert.throws(()=>musicAudioFile(file));
});
test("direct signed upload carries no account or provider credentials; completion uses only its ticket", async () => {
  const original=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});
    const json=String(url).endsWith("/references/uploads")?{signed_url:"https://fixture.supabase.co/storage/v1/object/upload/sign/bucket/audio?token=offline",content_type:"audio/wav",upload_ticket:"test-ticket"}:{reference:{receipt:"verified",duration:2}};
    return new Response(JSON.stringify(json),{status:200,headers:{"Content-Type":"application/json"}});
  };
  try {
    const file=new File([new Uint8Array(100)],"a.wav",{type:"audio/wav"});
    await uploadMusicReference(file,{mode:"own_key",key:"test-provider-key",authHeaders:{Authorization:"Bearer test-account"}});
    assert.equal(calls.length,3);
    assert.deepEqual(calls[1].options.headers,{"Content-Type":"audio/wav","x-upsert":"false"});
    assert.equal(calls[1].options.credentials,"omit");assert.equal(calls[1].options.redirect,"error");
    assert.equal(calls[1].options.referrerPolicy,"no-referrer");
    assert.equal(JSON.parse(calls[2].options.body).upload_ticket,"test-ticket");
    assert.equal(calls[1].options.body,file);
  } finally { globalThis.fetch=original; }
});
test("invalid signed upload URL and rejected upload stop before completion", async () => {
  const original=globalThis.fetch;
  try {
    const file=new File(["bytes"],"a.mp3");let calls=0;
    globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({signed_url:"http://unsafe.invalid/upload",upload_ticket:"test"}));};
    await assert.rejects(uploadMusicReference(file,{}),/上传地址无效/);assert.equal(calls,1);
    calls=0;
    globalThis.fetch=async()=>{calls++;return calls===1?new Response(JSON.stringify({signed_url:"https://fixture.supabase.co/storage/v1/object/upload/sign/bucket/a",upload_ticket:"test"})):new Response("rejected",{status:413});};
    await assert.rejects(uploadMusicReference(file,{}),/上传未完成/);assert.equal(calls,2);
  } finally { globalThis.fetch=original; }
});
