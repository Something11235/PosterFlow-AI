import React from "react";
import { BarChart3, BookOpen, Clock3, CodeXml, ExternalLink, KeyRound, PanelRightOpen, Settings2, Sparkles, UserRound } from "lucide-react";

const GITHUB_REPOSITORY_URL = "https://github.com/Something11235/PosterFlow-AI";
const PROMPT_REFERENCE_LINKS = [
  { label: "GPT Image 2 提示词库", href: "https://gpt-image2.canghe.ai/" },
  { label: "GPT Image 2 灵感社区", href: "https://awesome.gptimage2.asia/" },
];

export default function Sidebar({
  mode,
  modes,
  onModeChange,
  showHistory,
  onToggleHistory,
  providerConfigured,
  providerName,
  onOpenProvider,
  session,
  account,
  isAdmin,
  accountLoading,
  onOpenAuth,
  onOpenAccount,
  onOpenMetrics,
}) {
  const accountLabel = account?.profile?.username || session?.user?.email || "登录 / 注册";
  return (
    <aside className="border-b border-border-subtle bg-bg-secondary/96 px-4 py-3 lg:flex lg:w-64 lg:flex-col lg:border-b-0 lg:border-r lg:px-3 lg:py-4">
      <div className="flex items-center justify-between gap-3 lg:block">
        <div className="flex min-w-0 items-center gap-3 px-1">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-white shadow-lg shadow-accent/20">
            <Sparkles size={20} strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">PosterFlow AI</p>
            <p className="truncate text-xs text-text-muted">多类型图片生成工作台</p>
          </div>
        </div>

        <div className="flex items-center gap-2 lg:hidden">
          <button type="button" onClick={session ? onOpenAccount : onOpenAuth} className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border-subtle bg-bg-tertiary text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary" aria-label={session ? "账户中心" : "登录或注册"} title={accountLabel}><UserRound size={17} /></button>
          <a
            href={GITHUB_REPOSITORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-border-subtle bg-bg-tertiary text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary"
            aria-label="在 GitHub 查看项目源码"
            title="GitHub 项目源码"
          >
            <CodeXml size={17} />
          </a>
          <button
            type="button"
            onClick={onOpenProvider}
            className={`flex min-h-11 min-w-11 items-center justify-center rounded-lg border transition ${
              providerConfigured
                ? "border-mint/35 bg-mint/10 text-mint"
                : "border-gold/35 bg-gold/10 text-gold"
            }`}
            aria-label="图片服务配置"
            title="图片服务配置"
          >
            <Settings2 size={17} />
          </button>
          <button
            type="button"
            onClick={onToggleHistory}
            className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm transition ${
              showHistory
                ? "border-accent/40 bg-accent/12 text-accent"
                : "border-border-subtle bg-bg-tertiary text-text-secondary"
            }`}
          >
            <Clock3 size={16} />
            历史
          </button>
        </div>
      </div>

      <nav className="mt-4 grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:flex-col" aria-label="功能模式">
        {Object.entries(modes).map(([key, item]) => {
          const Icon = item.icon;
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onModeChange(key)}
              className={`group flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-lg border px-2 text-xs font-medium transition lg:min-h-11 lg:justify-start lg:px-3 lg:text-sm ${
                active
                  ? "border-accent/45 bg-accent/14 text-accent"
                  : "border-border-subtle bg-bg-tertiary/65 text-text-secondary hover:border-border-default hover:bg-bg-elevated hover:text-text-primary"
              }`}
              aria-pressed={active}
            >
              <Icon size={16} strokeWidth={1.8} className="lg:hidden" />
              <Icon size={17} strokeWidth={1.8} className="hidden lg:block" />
              <span className="min-w-0 break-words text-center leading-tight lg:text-left">{item.label}</span>
            </button>
          );
        })}
        <div className="col-span-2 mt-1 rounded-lg border border-border-subtle bg-bg-tertiary/45 p-2 sm:col-span-4 lg:col-span-1" aria-labelledby="prompt-reference-title">
          <div className="flex items-center gap-2 px-1 py-1 text-xs font-medium text-text-secondary">
            <BookOpen size={15} className="text-accent" aria-hidden="true" />
            <span id="prompt-reference-title">提示词参考</span>
          </div>
          <div className="mt-1 grid gap-1">
            {PROMPT_REFERENCE_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-10 items-center justify-between gap-2 rounded-md px-2 text-xs text-text-muted transition hover:bg-bg-elevated hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              >
                <span className="min-w-0 truncate">{link.label}</span>
                <ExternalLink size={13} className="flex-none" aria-hidden="true" />
              </a>
            ))}
          </div>
        </div>
      </nav>

      <div className="mt-auto hidden space-y-3 pt-6 lg:block">
        <button type="button" onClick={session ? onOpenAccount : onOpenAuth} className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-tertiary px-3 text-left text-sm text-text-secondary transition hover:bg-bg-elevated hover:text-text-primary"><UserRound size={16} /><span className="min-w-0 flex-1 truncate">{accountLabel}</span>{session && <span className={`text-xs ${accountLoading ? "animate-pulse text-text-muted" : "text-accent"}`}>{accountLoading ? "积分同步中…" : `${account?.credits?.balance ?? "--"} 积分`}</span>}</button>
        {session && isAdmin && <button type="button" onClick={onOpenMetrics} className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-accent/25 bg-accent/8 px-3 text-sm text-accent transition hover:bg-accent/12"><BarChart3 size={16} />管理员控制台</button>}
        <button
          type="button"
          onClick={onOpenProvider}
          aria-label="图片服务配置"
          title="图片服务配置"
          className={`w-full rounded-lg border p-3 text-left transition ${
            providerConfigured
              ? "border-mint/25 bg-mint/8 hover:bg-mint/12"
              : "border-gold/30 bg-gold/8 hover:bg-gold/12"
          }`}
        >
          <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
            <KeyRound size={15} className={providerConfigured ? "text-mint" : "text-gold"} />
            图片服务
          </div>
          <p className={`mt-2 truncate text-sm font-medium ${providerConfigured ? "text-mint" : "text-gold"}`}>
            {providerName}
          </p>
          <p className="mt-1 text-xs text-text-muted">{providerConfigured ? "已就绪，点击可更换" : "点击配置 Key 与中转站"}</p>
        </button>

        <button
          type="button"
          onClick={onToggleHistory}
          className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 text-sm transition ${
            showHistory
              ? "border-accent/45 bg-accent/14 text-accent"
              : "border-border-subtle bg-bg-tertiary text-text-secondary hover:bg-bg-elevated hover:text-text-primary"
          }`}
        >
          <PanelRightOpen size={16} />
          历史与复用
        </button>

        <a
          href={GITHUB_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-border-subtle bg-bg-tertiary px-3 text-sm text-text-secondary transition hover:border-border-default hover:bg-bg-elevated hover:text-text-primary"
          aria-label="在 GitHub 查看项目源码"
        >
          <CodeXml size={16} />
          <span>GitHub 项目</span>
          <ExternalLink size={14} className="ml-auto text-text-muted" />
        </a>

      </div>
    </aside>
  );
}
