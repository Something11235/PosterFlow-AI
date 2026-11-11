import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, ChevronRight, Image, Layers3, MessagesSquare, Music2, Search, Video } from "lucide-react";
import StudioArt from "./StudioArt";
import ModelBadge from "../ModelBadge";
import CreativeMaterials from "./CreativeMaterials";
import VideoWorkspace from "./VideoWorkspace";
import { restoreVideoHistory } from "../../lib/video";
import { defaultSeedance25 } from "../../lib/seedance25";
import MusicWorkspace from "./MusicWorkspace";
import { defaultSuno } from "../../lib/music";
import { restoreMusicHistory } from "../../lib/musicHistory";
import { defaultMusic, MODEL_CATALOG, STUDIO_AREAS } from "../../lib/studioCatalog";

const ICONS = { image: Image, video: Video, music: Music2, tavern: MessagesSquare };
const HOME_AREAS = [...STUDIO_AREAS, { id: "tavern", en: "AI TAVERN", label: "AI 酒馆", description: "角色对话 · 角色卡导入 · 世界书", status: "全新空间" }];
const TavernWorkspace = lazy(() => import("../tavern/TavernWorkspace"));
const PAGE_TITLES = { home: "创作总览", video: "视频创作", music: "音乐创作", materials: "创作素材", models: "模型一览", tavern: "AI 酒馆" };
export default function StudioWorkspace({ area, onAreaChange, onStartImage, backgroundImport, onBackgroundImportHandled, username, identity, authHeaders, session, account, accountLoading, onLogin, onAccountRefresh, onTaskActivity, onVideoTaskActivity, musicHistoryRestore, videoHistoryRestore, presetLibrary, onImportCompanion }) {
  const [idea, setIdea] = useState("");
  const [tavernVisited, setTavernVisited] = useState(area === "tavern");
  useEffect(() => { if (area === "tavern") setTavernVisited(true); }, [area]);
  const [ideaArea, setIdeaArea] = useState("image");
  const [music, setMusic] = useState(defaultMusic);
  const [video, setVideo] = useState(defaultSeedance25);
  useEffect(() => { if (videoHistoryRestore?.identity === identity) setVideo(restoreVideoHistory(videoHistoryRestore.entry)); }, [videoHistoryRestore, identity]);
  useEffect(() => {
    if (musicHistoryRestore?.identity === identity) setMusic(restoreMusicHistory(musicHistoryRestore.entry));
  }, [musicHistoryRestore, identity]);
  const [modelFilter, setModelFilter] = useState("all");
  const [modelSearch, setModelSearch] = useState("");
  const scrollRef = useRef(null);
  const navigate = next => onAreaChange(next);
  const filteredModels = MODEL_CATALOG.filter(model => (modelFilter === "all" || model.area === modelFilter) && `${model.name} ${model.id} ${model.maker}`.toLowerCase().includes(modelSearch.trim().toLowerCase()));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
    if (window.matchMedia("(max-width: 1023px)").matches) window.scrollTo({ top: 0, behavior: "instant" });
  }, [area]);

  function start(kind, text) {
    if (kind === "image") { onStartImage(text); return; }
    if (kind === "video" && text) setVideo({ ...defaultSeedance25(), prompt: text });
    if (kind === "music" && text) setMusic({ ...defaultSuno(), prompt: text });
    onAreaChange(kind);
  }
  return <div className="studio-workspace" data-studio-area={area}>
    {area !== "tavern" && <header className={`studio-topbar${area === "home" ? " has-github-support" : ""}`}>
      <div><span className="studio-breadcrumb">{['materials','models'].includes(area)?'资料与工具':'工作空间'}</span><ChevronRight size={13} /><strong>{PAGE_TITLES[area]}</strong></div>
      {area === "home" && <a className="studio-github-support" href="https://github.com/Something11235/PosterFlow-AI" target="_blank" rel="noopener noreferrer"><span>AI全功能生成工作台已完全开源至GitHub，如果帮到了你，请点一颗小小的Star，这对我们意义重大</span><ArrowUpRight size={16} aria-hidden="true" /></a>}
      <div><button type="button" className="studio-top-drafts" onClick={() => navigate("materials")}><Layers3 size={15} />创作素材</button></div>
    </header>}
    <div ref={scrollRef} className="studio-scroll">
      {area === "home" && <div className="studio-page studio-home">
        <section className="studio-intro"><div><p className="studio-eyebrow">YOUR NEXT IDEA STARTS HERE <span>↗</span></p><h1>让想象，<span>拥有更多表达。</span></h1><p className="studio-intro-copy">{username ? `${username}，欢迎回来。` : "欢迎来到你的创作空间。"}从一段文字出发，探索图像、音乐、视频与角色故事。</p></div><div className="studio-edition"><span>POSTERFLOW STUDIO</span><strong>One idea.<br /><em>More possibilities.</em></strong><small>创作，由你定义。 / 2026</small></div></section>
        <section className="studio-media-grid has-tavern" aria-label="选择创作类型">{HOME_AREAS.map((item, index) => { const Icon = ICONS[item.id]; return <button type="button" key={item.id} className={`studio-media-card studio-tone-${item.id}`} onClick={() => start(item.id, "")}><div className="studio-card-top"><span>0{index + 1} / {item.en}</span><span className={item.id === "image" ? "studio-card-live" : ""}>{item.status}</span></div><div className="studio-card-art"><>{item.id === "tavern" ? <span className="studio-tavern-card-portraits" aria-hidden="true"><img src="/ai-companions/claude-01.jpg" alt="" /><img src="/ai-companions/deepseek-01-clean.png" alt="" /><img src="/ai-companions/gemini-01.jpg" alt="" /></span> : <StudioArt kind={item.id} />}</><span className="studio-art-caption">{item.id === "tavern" ? "CHARACTERS & STORIES / 角色与故事" : "CONCEPT ART / 示意设计"}</span></div><div className="studio-card-bottom"><div><h2><Icon size={18} strokeWidth={1.7} />{item.label}</h2><p>{item.description}</p></div><span className="studio-card-arrow"><ArrowUpRight size={20} /></span></div></button>; })}</section>
        <section className="studio-idea-box" aria-labelledby="studio-idea-heading"><div className="studio-section-heading"><div><span className="studio-section-number">01</span><h2 id="studio-idea-heading">从一个想法开始</h2></div><span>把脑海里的那一幕，写下来。</span></div><div className="studio-idea-input"><textarea aria-label="你的创作灵感" placeholder="如果现在能创造任何东西，你想做什么？" value={idea} onChange={event => setIdea(event.target.value)} rows={2} /><div className="studio-idea-bottom"><div className="studio-idea-tabs">{STUDIO_AREAS.map(item => { const Icon = ICONS[item.id]; return <button type="button" key={item.id} aria-pressed={ideaArea === item.id} onClick={() => setIdeaArea(item.id)}><Icon size={14} />{item.short}</button>; })}</div><button type="button" className="studio-primary" onClick={() => start(ideaArea, idea)}>进入创作<ArrowRight size={16} /></button></div></div></section>
        <div className="studio-home-bottom"><section className="studio-recent"><div className="studio-section-heading"><div><span className="studio-section-number">02</span><h2>常用创作素材</h2></div><button type="button" onClick={() => navigate("materials")}>打开素材库<ArrowUpRight size={14} /></button></div><div className="studio-empty-inline"><Layers3 size={23} /><div><strong>角色与预设，随时开始创作</strong><p>AI娘专区和你的提示词预设，集中放在创作素材里。</p></div></div></section><section className="studio-route-card"><div><Layers3 size={18} /><span>新版进展</span><small>WORK IN PROGRESS</small></div><h3>先找到表达方式，<br />再连接创作能力。</h3><p>图像沿用现有服务。音乐支持生成、试听与下载。视频支持文字、多种参考素材与首尾帧创作。</p><button type="button" onClick={() => navigate("models")}>探索首批模型<ArrowRight size={15} /></button></section></div>
        <footer className="studio-footer"><span>POSTERFLOW — A SPACE FOR YOUR IDEAS.</span><span>图像 · 音乐 · 视频 · AI 酒馆</span></footer>
      </div>}

      <MusicWorkspace active={area === "music"} identity={identity} authHeaders={authHeaders} session={session} account={account} accountLoading={accountLoading} onLogin={onLogin} onAccountRefresh={onAccountRefresh} values={music} onChange={setMusic} onTaskActivity={onTaskActivity} />

      <VideoWorkspace active={area === "video"} identity={identity} authHeaders={authHeaders} session={session} account={account} onLogin={onLogin} onAccountRefresh={onAccountRefresh} values={video} onChange={setVideo} onTaskActivity={onVideoTaskActivity} />

      {(area === "tavern" || tavernVisited || backgroundImport) && <Suspense fallback={<div className="studio-page" role="status">正在打开 AI 酒馆…</div>}><TavernWorkspace key={identity} active={area === "tavern"} identity={identity} authHeaders={authHeaders} onStartImage={onStartImage} backgroundImport={backgroundImport} onBackgroundImportHandled={onBackgroundImportHandled} session={session} account={account} accountLoading={accountLoading} onLogin={onLogin} onAccountRefresh={onAccountRefresh} /></Suspense>}

      {area === "materials" && <CreativeMaterials identity={identity} presetLibrary={presetLibrary} onImportCompanion={onImportCompanion} onUseStylePrompt={onStartImage} />}

      {area === "models" && <div className="studio-page">
        <div className="studio-page-title"><div><p className="studio-eyebrow">A CURATED STARTING POINT</p><h1>选对工具，让灵感更进一步。</h1><p>图像、音乐与视频，按创作类型查看。预览模型尚未接通生成。</p></div><span className="studio-outline-badge">{MODEL_CATALOG.length} 个模型 · 分阶段接入</span></div>
        <div className="studio-model-toolbar"><div className="studio-model-filters">{[{ id: "all", short: "全部" }, ...STUDIO_AREAS].map(item => <button type="button" key={item.id} aria-pressed={modelFilter === item.id} onClick={() => setModelFilter(item.id)}>{item.short}</button>)}</div><label className="studio-model-search"><Search size={16} /><input aria-label="搜索候选模型" placeholder="搜索模型名称" value={modelSearch} onChange={event => setModelSearch(event.target.value)} /></label></div>
        <div className="studio-model-grid">{filteredModels.map(model => {
          const Icon = ICONS[model.area];
          return <article className={`studio-model-card studio-tone-${model.area}`} key={model.id}>
            <div><span className="studio-model-icon"><Icon size={21} /></span><small>{STUDIO_AREAS.find(item => item.id === model.area).short} / {model.maker}</small></div><h2>{model.name}<ModelBadge model={model.id === "nano-banana-2.1" ? "gemini-nano-banana-2.1" : model.id}/></h2><p>{model.summary}</p><footer><span>{model.area === "image" ? <>{model.capability}<span className="mt-1 block leading-relaxed">{model.pricing}</span></> : model.area === "music" ? "音乐创作 · 2 积分 / 次" : model.available ? ["seedance-2.5","seedance-2.0","seedance-2.0-fast","gemini-omni-1.1-flash","MiniMax-H3","MiniMax-H3-Max","wan3.0-video","flux-3-video"].includes(model.id) ? "按实际用量结算 · 0.5 积分为档 · 提交先预留" : "480P 0.5 积分/秒 · 720P 1 积分/秒（参考视频＋生成时长）" : "模型预览 · 规划接入"}</span></footer>
          </article>;
        })}</div>
        {!filteredModels.length && <div className="studio-empty-state"><Search size={28} /><h2>没有找到匹配的模型</h2><p>试试其他名称，或选择全部创作类型。</p><button type="button" className="studio-secondary" onClick={() => { setModelSearch(""); setModelFilter("all"); }}>清除筛选</button></div>}
        <p className="studio-help">现有图像工作区继续使用原图片服务配置。模型预览不会替换已配置模型。</p>
      </div>}

    </div>
  </div>;
}
