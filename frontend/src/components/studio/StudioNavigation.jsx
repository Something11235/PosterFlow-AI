import { displayCredits } from "../../lib/credits";
import React, {useEffect,useState} from "react";
import PromptReferences from "../PromptReferences";
import { Aperture, ArrowUpRight, BookOpen, ChartNoAxesCombined, ChevronRight, Grid2X2, History, Image, Layers3, LayoutGrid, Music2, PanelLeftClose, PanelLeftOpen, UserRound, Users, Video } from "lucide-react";

const NAV = [
  { id: "home", label: "创作总览", icon: LayoutGrid },
  { id: "image", label: "图像创作", icon: Image },
  { id: "music", label: "音乐创作", icon: Music2 },
  { id: "video", label: "视频创作", icon: Video },
];

export default function StudioNavigation({ area, onAreaChange, session, account, accountLoading, onOpenAuth, onOpenAccount, onOpenMetrics, onOpenRecharge, onOpenHistory, onOpenCommunity }) {
  const [collapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('posterflow.sidebar.collapsed.v1')==='1';}catch{return false;}});
  useEffect(()=>{try{localStorage.setItem('posterflow.sidebar.collapsed.v1',collapsed?'1':'0');}catch{}},[collapsed]);
  const accountName = account?.profile?.username || session?.user?.email || "登录 / 注册";
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
        <button type="button" title="模型一览" aria-label="模型一览" aria-current={area === "models" ? "page" : undefined} onClick={() => onAreaChange("models")}><Grid2X2 size={18} />模型一览</button>
        <button type="button" title="历史记录" aria-label="历史记录" onClick={onOpenHistory}><History size={18} />历史记录</button>
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
