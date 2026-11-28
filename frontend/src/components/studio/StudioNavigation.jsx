import { displayCredits } from "../../lib/credits";
import React, {useEffect,useLayoutEffect,useRef,useState} from "react";
import PromptReferences from "../PromptReferences";
import { Aperture, ArrowUpRight, BookOpen, ChartNoAxesCombined, ChevronDown, ChevronRight, Download, ExternalLink, Gift, Globe2, Grid2X2, History, House, Image, Layers3, LayoutGrid, LibraryBig, ListChecks, Menu, MessagesSquare, Music2, PanelLeftClose, PanelLeftOpen, Presentation, UserRound, Users, Video, Workflow, X } from "lucide-react";
import "./studio-mobile-navigation.css";

const NAV = [
  { id: "home", label: "创作总览", icon: LayoutGrid },
  { id: "canvas", label: "创作画布", icon: Workflow },
  { id: "image", label: "图像创作", icon: Image },
  { id: "music", label: "音乐创作", icon: Music2 },
  { id: "video", label: "视频创作", icon: Video },
  { id: "tavern", label: "AI 酒馆", icon: MessagesSquare },
  { id: "ppt", label: "一键 PPT", icon: Presentation },
];

const TAVERN_RESOURCES = [
  { label: "Chub 热门广场", href: "https://chub.ai/home?segment=trending&page=1" },
  { label: "Chub 世界书", href: "https://chub.ai/lorebooks?excludetopics=&first=20&page=1&namespace=*&search=&include_forks=true&nsfw=false&nsfw_only=false&require_custom_prompt=false&require_example_dialogues=false&require_images=false&require_expressions=false&nsfl=false&asc=false&min_ai_rating=0&min_tokens=50&max_tokens=100000&chub=true&require_lore=false&exclude_mine=true&require_lore_embedded=false&require_lore_linked=false&language=&sort=trending&min_tags=2&topics=&special_mode=&name_like=&only_mine=&inclusive_or=false&recommended_verified=false&require_alternate_greetings=false&max_days_ago=&min_users_chatted=" },
  { label: "JanitorAI", href: "https://jani.com/" },
  { label: "AI Character Cards", href: "https://aicharactercards.com/" },
  { label: "Pygmalion", href: "https://pygmalion.chat/explore" },
];

function TavernResources({ detailsRef, guideTarget = true }) {
  return <details ref={detailsRef} className="studio-prompt-library studio-tavern-resources">
    <summary data-tavern-guide={guideTarget ? "resources" : undefined}><LibraryBig size={18} aria-hidden="true" /><span>酒馆资源</span><ChevronDown size={14} className="studio-prompt-chevron" aria-hidden="true" /></summary>
    <div id={guideTarget ? "studio-tavern-resource-links" : undefined} data-tavern-guide={guideTarget ? "sites" : undefined}>
      <p className="studio-resource-note"><Globe2 size={13} aria-hidden="true" /><span>部分网站需要代理访问</span></p>
      {TAVERN_RESOURCES.map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer"><span>{link.label}</span><ExternalLink size={14} aria-hidden="true" /></a>)}
    </div>
  </details>;
}

const MOBILE_TABS = [
  { id: "home", label: "首页", icon: House },
  { id: "create", label: "创作", icon: LayoutGrid },
  { id: "tasks", label: "任务", icon: ListChecks },
  { id: "mine", label: "我的", icon: UserRound },
];

const openInstall = () => window.dispatchEvent(new Event("posterflow:install"));

function MobileDock({ area, onAreaChange, accountName, session, account, accountLoading, onOpenAuth, onOpenAccount, onOpenMetrics, onOpenRecharge, onOpenReferrals, onOpenHistory, onOpenImageTasks, onOpenCommunity }) {
  const [sheet, setSheet] = useState(null);
  const dialog = useRef(null);
  const mobile = useRef(null);
  useEffect(() => {
    mobile.current = window.matchMedia("(max-width: 767px)");
    const onResize = () => { if (!mobile.current.matches) dialog.current?.close(); };
    mobile.current.addEventListener("change", onResize);
    return () => mobile.current.removeEventListener("change", onResize);
  }, []);
  useLayoutEffect(() => {
    if (sheet && !dialog.current.open) dialog.current.showModal();
  }, [sheet]);
  function run(action) {
    dialog.current.close();
    action();
  }
  const destinations = sheet === "create"
    ? NAV.slice(1).map(item => ({ ...item, action: () => onAreaChange(item.id) }))
    : sheet === "tasks"
      ? [{ label: "创作历史", icon: History, action: onOpenHistory }, { label: "生图任务", icon: Image, action: onOpenImageTasks }]
      : [
          { label: "创作素材", icon: Layers3, action: () => onAreaChange("materials") },
          { label: "模型一览", icon: Grid2X2, action: () => onAreaChange("models") },
          { label: "购买积分", icon: ArrowUpRight, action: onOpenRecharge },
          { label: "邀请奖励", icon: Gift, action: onOpenReferrals },
          { label: "QQ 交流群", icon: Users, action: onOpenCommunity },
          ...(session && account?.is_admin ? [{ label: "管理员控制台", icon: ChartNoAxesCombined, action: onOpenMetrics }] : []),
        ];
  const activeTab = sheet || (area === "home" ? "home" : NAV.some(item => item.id === area) ? "create" : "mine");
  return <>
    <nav className="studio-phone-dock" aria-label="手机主导航">
      {MOBILE_TABS.map(tab => <button type="button" key={tab.id} className={activeTab === tab.id ? "is-active" : undefined}
        aria-current={tab.id === "home" && area === "home" ? "page" : undefined}
        aria-haspopup={tab.id === "home" ? undefined : "dialog"}
        onClick={() => tab.id === "home" ? onAreaChange("home") : setSheet(tab.id)}>
        <span><tab.icon size={20} strokeWidth={1.75} aria-hidden="true" /></span>{tab.label}
      </button>)}
    </nav>
    <dialog ref={dialog} className="studio-phone-sheet" aria-labelledby="studio-phone-sheet-title"
      onClose={() => setSheet(null)} onClick={event => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      {sheet && <section>
        <header><h2 id="studio-phone-sheet-title">{MOBILE_TABS.find(tab => tab.id === sheet)?.label}</h2>
          <button type="button" aria-label="关闭菜单" onClick={() => dialog.current.close()}><X size={20} /></button></header>
        {sheet === "mine" && <button type="button" className="studio-phone-profile" onClick={() => run(session ? onOpenAccount : onOpenAuth)}>
          <UserRound size={22} /><span><strong>{accountName}</strong>{session && <small>平台积分 · {accountLoading ? "同步中…" : displayCredits(account?.credits?.balance)}</small>}</span><ChevronRight size={17} />
        </button>}
        <div className="studio-phone-links">{destinations.map(item => <button type="button" key={item.label} onClick={() => run(item.action)}>
          <item.icon size={19} aria-hidden="true" />{item.label}</button>)}</div>
        {sheet === "mine" && <>
          <PromptReferences /><TavernResources guideTarget={false} />
          <button type="button" className="studio-phone-install" onClick={() => run(openInstall)}><Download size={17} />添加到手机桌面</button>
        </>}
      </section>}
    </dialog>
  </>;
}

export default function StudioNavigation({ area, guideResourcesOpen, onAreaChange, session, account, accountLoading, onOpenAuth, onOpenAccount, onOpenMetrics, onOpenRecharge, onOpenReferrals, onOpenHistory, onOpenImageTasks, onOpenCommunity }) {
  const [savedCollapsed,setCollapsed]=useState(()=>{try{return localStorage.getItem('posterflow.sidebar.collapsed.v1')==='1';}catch{return false;}});
  const collapsed = savedCollapsed && !guideResourcesOpen;
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const compactMobile = ["home", "canvas", "ppt"].includes(area);
  const tavernResources = useRef(null);
  useLayoutEffect(() => {
    if (!guideResourcesOpen) return;
    const details = tavernResources.current;
    const previouslyOpen = details.open;
    details.open = true;
    return () => { details.open = previouslyOpen; };
  }, [guideResourcesOpen]);
  const primaryNav = useRef(null);
  useEffect(() => {
    const nav = primaryNav.current;
    if (!nav || nav.scrollWidth <= nav.clientWidth) return;
    const active = nav.querySelector('[aria-current="page"]')?.getBoundingClientRect();
    if (!active) return;
    const bounds = nav.getBoundingClientRect();
    if (active.left < bounds.left) nav.scrollLeft += active.left - bounds.left;
    else if (active.right > bounds.right) nav.scrollLeft += active.right - bounds.right;
  }, [area]);
  useEffect(()=>{try{localStorage.setItem('posterflow.sidebar.collapsed.v1',savedCollapsed?'1':'0');}catch{}},[savedCollapsed]);
  const accountName = account?.profile?.username || session?.user?.email || "登录 / 注册";
  function openTavernResources() {
    setCollapsed(false);
    if (tavernResources.current) tavernResources.current.open = true;
    requestAnimationFrame(() => tavernResources.current?.querySelector("summary")?.focus());
  }
  return (
    <aside className={`studio-nav studio-with-mobile-dock${collapsed?' is-collapsed':''}${compactMobile ? ' has-compact-tools' : ''}${mobileToolsOpen ? ' tools-open' : ''}${guideResourcesOpen ? ' showing-resource-guide' : ''}`}>
      <div className="studio-brand"><span className="studio-brand-mark"><Aperture size={26} strokeWidth={1.4} /></span><div><strong>PosterFlow<span>AI</span></strong><small>THE CREATIVE STUDIO</small></div></div>
      {area === "home" && <button type="button" className="studio-phone-install studio-phone-home-install" onClick={openInstall}><Download size={16} />添加到桌面</button>}
      <button type="button" className="studio-nav-toggle" onClick={()=>setCollapsed(value=>!value)} aria-label={collapsed?'展开侧栏':'折叠侧栏'} title={collapsed?'展开侧栏':'折叠侧栏'} aria-expanded={!collapsed} aria-controls="studio-primary-navigation studio-secondary-navigation">{collapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button>
      <div className="studio-mobile-account">{compactMobile && <button type="button" onClick={() => setMobileToolsOpen(open => !open)} aria-label="资料与工具" title="资料与工具" aria-expanded={mobileToolsOpen} aria-controls="studio-secondary-navigation"><Menu size={19} /></button>}<button type="button" onClick={session ? onOpenAccount : onOpenAuth} aria-label={session ? "账户中心" : "登录或注册"}><UserRound size={19} /></button>{session && account?.is_admin && <button type="button" onClick={onOpenMetrics} aria-label="管理员控制台"><ChartNoAxesCombined size={19} /></button>}</div>
      <p className="studio-nav-caption">工作空间 <span>01 —</span></p>
      <nav ref={primaryNav} id="studio-primary-navigation" className="studio-primary-nav" aria-label="创作工作区">
        {NAV.map(item => <button type="button" key={item.id} title={collapsed?item.label:undefined} aria-label={item.label} aria-current={area === item.id ? "page" : undefined} onClick={() => onAreaChange(item.id)}><item.icon size={18} strokeWidth={1.7} /><span>{item.label}</span>{item.hint && <small>{item.hint}</small>}{area === item.id && <span className="studio-nav-dot" />}</button>)}
      </nav>
      <p className="studio-nav-caption studio-library-caption">资料与工具 <span>02 —</span></p>
      <nav id="studio-secondary-navigation" className="studio-secondary-nav" aria-label="资料与工具">
        <button type="button" title="创作素材" aria-label="创作素材" aria-current={area === "materials" ? "page" : undefined} onClick={() => onAreaChange("materials")}><Layers3 size={18} />创作素材</button>
        <PromptReferences />
        <button type="button" className="studio-collapse-inspiration" title="创作灵感" aria-label="展开创作灵感" onClick={()=>setCollapsed(false)}><BookOpen size={18}/></button>
        <TavernResources detailsRef={tavernResources} />
        <button type="button" data-tavern-guide="resources" className="studio-collapse-resources" title="酒馆资源" aria-label="展开酒馆资源" aria-controls="studio-tavern-resource-links" onClick={openTavernResources}><LibraryBig size={18} aria-hidden="true" /></button>
        <button type="button" title="模型一览" aria-label="模型一览" aria-current={area === "models" ? "page" : undefined} onClick={() => onAreaChange("models")}><Grid2X2 size={18} />模型一览</button>
        <button type="button" title="历史记录" aria-label="历史记录" onClick={onOpenHistory}><History size={18} />历史记录</button>
        <button type="button" title="生图任务" aria-label="生图任务" onClick={onOpenImageTasks}><Image size={18} />生图任务</button>
        <button type="button" title="QQ交流群" aria-label="QQ交流群" onClick={onOpenCommunity}><Users size={18} />QQ交流群</button>
        <button type="button" title="邀请奖励" aria-label="邀请奖励" onClick={onOpenReferrals}><Gift size={18} />邀请奖励</button>
        <button type="button" title="购买积分" aria-label="购买积分" className="studio-mobile-tool" onClick={onOpenRecharge}><ArrowUpRight size={18} />购买积分</button>
      </nav>
      <div className="studio-nav-bottom">
        <div className="studio-credit-card"><span>平台积分 <Aperture size={14} /></span><strong>{session ? (accountLoading ? "同步中…" : displayCredits(account?.credits?.balance)) : "从灵感开始"}</strong><button type="button" onClick={onOpenRecharge}>购买积分 <ArrowUpRight size={15} /></button></div>
        {session && account?.is_admin && <button type="button" title="管理员控制台" aria-label="管理员控制台" className="studio-admin-link" onClick={onOpenMetrics}><ChartNoAxesCombined size={17} />管理员控制台<ChevronRight size={14} /></button>}
        <button type="button" className="studio-account-link" onClick={session ? onOpenAccount : onOpenAuth} aria-label={session ? "账户中心" : "登录或注册"}><span className="studio-avatar">{session ? accountName.slice(0, 1).toUpperCase() : <UserRound size={16} />}</span><span>{accountName}<small>{session ? "管理你的账户" : "继续你的创作"}</small></span><ChevronRight size={15} /></button>
      </div>
      <MobileDock {...{area, onAreaChange, accountName, session, account, accountLoading, onOpenAuth, onOpenAccount, onOpenMetrics, onOpenRecharge, onOpenReferrals, onOpenHistory, onOpenImageTasks, onOpenCommunity}} />
    </aside>
  );
}
