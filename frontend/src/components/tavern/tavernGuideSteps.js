const resourceSteps = [
  {
    target: '[data-tavern-guide="resources"]',
    title: '从「酒馆资源」找卡',
    description: '在「资料与工具」里展开「酒馆资源」。这里收录了几个角色卡社区，可以按角色名或题材找卡。',
  },
  {
    target: '[data-tavern-guide="sites"]',
    title: '把喜欢的角色带回来',
    description: '打开「Chub 热门广场」，找到角色后复制详情页链接。如果网站提供下载，也可以保存角色 JSON 或带有角色设定的原始 PNG 卡片。',
  },
];

export const tavernLobbyGuide = [
  ...resourceSteps,
  {
    target: '[data-tavern-guide="import"]',
    title: '在大厅导入角色卡',
    description: '点「导入角色卡」。下载好的卡选「本地文件」，Chub 角色详情页或公开下载直链选「公开链接」。弹窗里也有可以随时打开的导入指引。',
  },
  {
    target: '[data-tavern-guide="mine"]',
    title: '确认导入，在这里找到角色',
    description: '先点「读取并预览」，核对角色名称和设定，再点「确认导入」。角色会出现在「我的角色」，点「开始对话」就能开聊。导入的卡保存在当前浏览器。',
  },
];

export const tavernChatGuide = [
  ...resourceSteps,
  {
    target: '[data-tavern-guide="lobby"]',
    title: '回大厅，导入自己的角色',
    description: '回到角色大厅后，点「导入角色卡」选择文件或粘贴公开链接。核对预览并确认后，角色会出现在「我的角色」。这段聊天可以从「最近对话」继续。',
  },
];

export const tavernImportGuide = [
  {
    target: '[data-tavern-import-guide="file"]',
    title: '导入下载好的文件',
    description: '选「本地文件」，再选含有角色设定的 PNG 卡片或角色 JSON。PNG 最大 8 MB，JSON 最大 1 MB。请保留下载的原文件。',
  },
  {
    target: '[data-tavern-import-guide="url"]',
    title: '也可以粘贴角色链接',
    description: '选「公开链接」，粘贴 Chub 角色详情页，或无需登录就能下载 JSON、PNG 的 HTTPS 直链。站点首页和搜索页无法导入。',
  },
  {
    target: '[data-tavern-import-guide="submit"]',
    title: '先预览，再确认导入',
    description: '点「读取并预览」核对角色名、设定和世界书。确认是想要的卡，再点同一位置的「确认导入」。回到大厅，就能从「我的角色」开始对话。',
  },
];
