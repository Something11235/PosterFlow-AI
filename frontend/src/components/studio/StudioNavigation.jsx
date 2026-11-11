import { displayCredits } from "../../lib/credits";
import React, {useEffect,useRef,useState} from "react";
import PromptReferences from "../PromptReferences";
import { Aperture, ArrowUpRight, BookOpen, ChartNoAxesCombined, ChevronDown, ChevronRight, ExternalLink, Globe2, Grid2X2, History, Image, Layers3, LayoutGrid, LibraryBig, MessagesSquare, Music2, PanelLeftClose, PanelLeftOpen, UserRound, Users, Video } from "lucide-react";

const NAV = [
  { id: "home", label: "创作总览", icon: LayoutGrid },
  { id: "image", label: "图像创作", icon: Image },
  { id: "music", label: "音乐创作", icon: Music2 },
  { id: "video", label: "视频创作", icon: Video },
  { id: "tavern", label: "AI 酒馆", icon: MessagesSquare },
];

const TAVERN_RESOURCES = [
  { label: "Chub 热门广场", href: "https://chub.ai/home?segment=trending&page=1" },
  { label: "Chub 世界书", href: "https://chub.ai/lorebooks?excludetopics=&first=20&page=1&namespace=*&search=&include_forks=true&nsfw=false&nsfw_only=false&require_custom_prompt=false&require_example_dialogues=false&require_images=false&require_expressions=false&nsfl=false&asc=false&min_ai_rating=0&min_tokens=50&max_tokens=100000&chub=true&require_lore=false&exclude_mine=true&require_lore_embedded=false&require_lore_linked=false&language=&sort=trending&min_tags=2&topics=&special_mode=&name_like=&only_mine=&inclusive_or=false&recommended_verified=false&require_alternate_greetings=false&max_days_ago=&min_users_chatted=" },
  { label: "JanitorAI", href: "https://janitorai.com/zh/" },
  { label: "AI Character Cards", href: "https://aicharactercards.com/" },
  { label: "Pygmalion", href: "https://pygmalion.chat/explore" },
];

function TavernResources({ detailsRef }) {
  return <details ref={detailsRef} className="studio-prompt-library studio-tavern-resources">
    <summary><LibraryBig size={18} aria-hidden="true" /><span>酒馆资源</span><ChevronDown size={14} className="studio-prompt-chevron" aria-hidden="true" /></summary>
    <div id="studio-tavern-resource-links">
      <p className="studio-resource-note"><Globe2 size={13} aria-hidden="true" /><span>部分网站需要代理访问</span></p>
      {TAVERN_RESOURCES.map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"><span>{link.label}</span><ExternalLink size={14} aria-hidden="true" /></a>)}
    </div>
  </details>;
}

export default function StudioNavigation({ area, onAreaChange, session, account, accountLoading, onOpenAuth, onOpenAccount, onOpenMetrics, onOpenRecharge, onOpenHistory, onOpenImageTasks, onOpenCommunity }) {
  const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('posterflow.sidebar.collapsed.v1')==='1';}catch{return false;}});
  const tavernResources = useRef(null);
  useEffect(()=>{try{localStorage.setItem('posterflow.sidebar.collapsed.v1',collapsed?'1':'0');}catch{}},[collapsed]);
  const accountName = account?.profile?.username || session?.user?.email || "登录 / 注册";
  function openTavernResources() {
    setCollapsed(false);
    if (tavernResources.current) tavernResources.current.open = true;
    requestAnimationFrame(() => tavernResources.current?.querySelector("summary")?.focus());
  }
  return (
    <aside className={`studio-nav${collapsed?' is-collapsed':''}`}>
      <div className="studio-brand"><span className="studio-brand-mark"><Aperture size={26} strokeWidth={1.4} /></span><div><strong>PosterFlow<span>AI</span></strong><small>THE CREATIVE STUDIO</small></div></div>
      <button type="button" className="studio-nav-toggle" onClick={()=>setCollapsed(value=>!value)} aria-label={collapsed?'展开侧栏':'折叠侧栏'} title={collapsed?'展开侧栏':'折叠侧栏'} aria-expanded={!collapsed} aria-controls="studio-primary-navigation studio-secondary-navigation">{collapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button>
      <div className="studio-mobile-account"><button type="button" onClick={session ? onOpenAccount : onOpenAuth} aria-label={session ? "账户中心" : "登录或注册"}><UserRound size={19} /></button>{session && account?.is_admin && <button type="button" onClick={onOpenMetrics} aria-label="管理员控制台"><ChartNoAxesCombined size={19} /></button>}</div>
      <p className="studio-nav-caption">工作空间 <span>01 —</span></p>
      <nav id="studio-primary-navigation" className="studio-primary-nav" aria-label="创作工作区">
        {NAV.map(item => <button type="button" key={item.id} title={collapsed?item.label:undefined} aria-label={item.label} aria-current={area === item.id ? "page" : undefined} onClick={() => onAreaChange(item.id)}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}{area === item.id && <span className="studio-nav-dot" />}</button>)}
      </nav>
      <p className="studio-nav-caption studio-library-caption">资料与工具 <span>02 —</span></p>
      <nav id="studio-secondary-navigation" className="studio-secondary-nav" aria-label="资料与工具">
        <button type="button" title="创作素材" aria-label="创作素材" aria-current={area === "materials" ? "page" : undefined} onClick={() => onAreaChange("materials")}><Layers3 size={18} />创作素材</button>
        <PromptReferences />
        <button type="button" className="studio-collapse-inspiration" title="创作灵感" aria-label="展开创作灵感" onClick={()=>setCollapsed(false)}><BookOpen size={18}/></button>
        <TavernResources detailsRef={tavernResources} />
        <button type="button" className="studio-collapse-resources" title="酒馆资源" aria-label="展开酒馆资源" aria-controls="studio-tavern-resource-links" onClick={openTavernResources}><LibraryBig size={18} aria-hidden="true" /></button>
        <button type="button" title="模型一览" aria-label="模型一览" aria-current={area === "models" ? "page" : undefined} onClick={() => onAreaChange("models")}><Grid2X2 size={18} />模型一览</button>
        <button type="button" title="历史记录" aria-label="历史记录" onClick={onOpenHistory}><History size={18} />历史记录</button>
        <button type="button" title="生图任务" aria-label="生图任务" onClick={onOpenImageTasks}><Image size={18} />生图任务</button>
        <button type="button" title="QQ交流群" aria-label="QQ交流群" onClick={onOpenCommunity}><Users size={18} />QQ交流群</button>
        <button type="button" title="购买积分" aria-label="购买积分" className="studio-mobile-tool" onClick={onOpenRecharge}><ArrowUpRight size={18} />购买积分</button>
      </nav>
      <div className="studio-nav-bottom">
        <div className="studio-credit-card"><span>平台积分 <Aperture size={14} /></span><strong>{session ? (accountLoading ? "同步中…" : displayCredits(account?.credits?.balance)) : "从灵感开始"}</strong><button type="button" onClick={onOpenRecharge}>购买积分 <ArrowUpRight size={15} /></button></div>
        {session && account?.is_admin && <button type="button" title="管理员控制台" aria-label="管理员控制台" className="studio-admin-link" onClick={onOpenMetrics}><ChartNoAxesCombined size={17} />管理员控制台<ChevronRight size={14} /></button>}
        <button type="button" className="studio-account-link" onClick={session ? onOpenAccount : onOpenAuth} aria-label={session ? "账户中心" : "登录或注册"}><span className="studio-avatar">{session ? accountName.slice(0, 1).toUpperCase() : <UserRound size={16} />}</span><span>{accountName}<small>{session ? "管理你的账户" : "继续你的创作"}</small></span><ChevronRight size={15} /></button>
      </div>
    </aside>
  );
}
