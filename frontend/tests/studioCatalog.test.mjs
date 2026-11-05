import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStudioDraft,
  defaultMusic,
  IMAGE_MODELS, MODEL_CATALOG, MUSIC_MODELS, STUDIO_AREAS, VIDEO_MODELS,
} from "../src/lib/studioCatalog.js";

test("catalog follows the selected 10 image, 2 music and 9 video models in that order", () => {
  assert.deepEqual(STUDIO_AREAS.map(x => x.id), ["image", "music", "video"]);
  assert.deepEqual(IMAGE_MODELS.map(x => x.name), ["GPT Image 2.6 Flare", "GPT Image 2.6 Sunburst", "GPT Image 2.5 Flare", "GPT Image 2.5 Sunburst", "Nano Banana 2.1", "Grok Imagine Image 2.0", "Grok Imagine 2.0 Ext", "（即梦）Seedream 5.0 Pro", "（即梦）Seedream 5.0 Lite", "（即梦）Seedream 5.0 Flash"]);
  assert.deepEqual(MUSIC_MODELS.map(x => x.name), ["suno", "flowmusic"]);
  assert.deepEqual(VIDEO_MODELS.map(x => x.name), ["Seedance 2.5", "Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini", "Gemini Omni 1.1 Flash", "MiniMax H3", "MiniMax H3 Max", "Wan 3.0", "FLUX 3 Video"]);
  assert.equal(MODEL_CATALOG.length, 21);
  assert.deepEqual(MODEL_CATALOG.map(x => x.area), [...Array(10).fill("image"), ...Array(2).fill("music"), ...Array(9).fill("video")]);
  assert.equal(MODEL_CATALOG.some(x => x.docs || x.url), false);
});
test("video previews and unknown music models cannot produce request drafts", () => {
  for (const model of VIDEO_MODELS.filter(x=>!x.available)) assert.throws(() => buildStudioDraft("video", { model: model.id, prompt: "海浪" }), /暂未开放/);
  const flow = buildStudioDraft("music", { model: "flowmusic", sound_prompt: "海浪" });
  assert.equal(flow.body.model, "flowmusic");
  assert.throws(() => buildStudioDraft("music", { ...defaultMusic(), model: "unknown", prompt: "海浪" }), /不支持/);
});

test("Suno requires a description in inspiration mode and lyrics only for custom vocals", () => {
  assert.throws(() => buildStudioDraft("music", defaultMusic()), /描述/);
  assert.throws(() => buildStudioDraft("music", { ...defaultMusic(), custom: true, instrumental: false }), /歌词/);
  const instrumental = buildStudioDraft("music", { ...defaultMusic(), custom: true });
  assert.equal(instrumental.endpoint, "/v1/music/generations");
  assert.deepEqual(instrumental.body, { model: "suno", version: "v6", custom: true, instrumental: true });
  const vocals = buildStudioDraft("music", { ...defaultMusic(), custom: true, instrumental: false, prompt: "  [Verse]\n今天出发  " });
  assert.equal(vocals.body.prompt, "[Verse]\n今天出发");
  assert.equal(vocals.body.instrumental, false);
});

test("Suno mode changes do not leak custom-only fields into inspiration drafts", () => {
  const values = { ...defaultMusic(), prompt: "温暖的爵士乐", title: "只属于歌词模式", style: "jazz", negative_tags: "metal", persona_id: "not-sent" };
  const inspiration = buildStudioDraft("music", values);
  assert.deepEqual(inspiration.body, { model: "suno", version: "v6", custom: false, instrumental: true, prompt: "温暖的爵士乐" });
  assert.equal(inspiration.title, "温暖的爵士乐");
  const custom = buildStudioDraft("music", { ...values, custom: true });
  assert.equal(custom.body.title, values.title);
  assert.equal(custom.body.style, "jazz");
});

test("Suno description and lyric limits count Unicode characters rather than UTF-16 units", () => {
  const inspiration = { ...defaultMusic(), prompt: "🎵".repeat(3000) };
  assert.equal(buildStudioDraft("music", inspiration).body.prompt, inspiration.prompt);
  assert.throws(() => buildStudioDraft("music", { ...inspiration, prompt: inspiration.prompt + "曲" }), /3000/);
  const custom = { ...defaultMusic(), custom: true, instrumental: false, prompt: "🎶".repeat(5000) };
  assert.equal(buildStudioDraft("music", custom).body.prompt, custom.prompt);
  assert.throws(() => buildStudioDraft("music", { ...custom, prompt: custom.prompt + "曲" }), /5000/);
});

test("custom song title and style accept their limits and reject oversize values", () => {
  const values = { ...defaultMusic(), custom: true, title: "🎼".repeat(80), style: "🎷".repeat(1000) };
  const draft = buildStudioDraft("music", values);
  assert.equal(draft.body.title, values.title);
  assert.equal(draft.body.style, values.style);
  assert.throws(() => buildStudioDraft("music", { ...values, title: values.title + "a" }), /80/);
  assert.throws(() => buildStudioDraft("music", { ...values, style: values.style + "a" }), /1000/);
});

test("all draft builders whitelist fields without mutating the caller or leaking credentials and attachments", () => {
  const file = { name: "private-reference.png", size: 42, content: "SENTINEL_ATTACHMENT" };
  const extras = {
    apiKey: "SENTINEL_PRIVATE_KEY",
    authorization: "SENTINEL_AUTHORIZATION",
    url: "https://private.example/SENTINEL_URL",
    audio_url: "https://private.example/SENTINEL_AUDIO_URL",
    image_urls: ["https://private.example/SENTINEL_IMAGE_URL"],
    referenceImages: [{ bytes: "SENTINEL_REFERENCE" }],
    nested: { secret: "SENTINEL_NESTED" },
    file,
  };
  const cases = [
    ["music", { ...defaultMusic(), prompt: "钢琴" }, ["model", "version", "custom", "instrumental", "prompt"]],
  ];
  for (const [kind, values, expectedKeys] of cases) {
    const input = Object.freeze({ ...values, ...extras });
    const draft = buildStudioDraft(kind, input);
    assert.deepEqual(Object.keys(draft.body).sort(), expectedKeys.sort(), kind);
    assert.equal(JSON.stringify(draft).includes("SENTINEL_"), false, kind);
    assert.equal(input.file, file, "input attachment must not be replaced");
    assert.equal(input.apiKey, extras.apiKey, "input credentials must not be changed");
    assert.equal(Object.hasOwn(draft, "file"), false, kind);
  }
  for (const kind of ["unsupported", "speech", "transcript"])
    assert.throws(() => buildStudioDraft(kind, {}), /不支持/);
});

test("draft titles truncate by characters without breaking surrogate pairs", () => {
  const draft = buildStudioDraft("music", { ...defaultMusic(), prompt: "🎹".repeat(100) });
  assert.equal(draft.title, "🎹".repeat(72));
  assert.equal(draft.body.prompt, "🎹".repeat(100));
});
