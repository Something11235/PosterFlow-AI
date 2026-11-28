# PPT Master 6.10.0 · PowerPoint 动效规划

依据 Hugo He 的 PPT Master（MIT）中 references/animations.md 和 workflows/stages/customize-animations.md 的语义分组与转场规则。

先判断这一页要让听众理解什么，再安排注意力。流程按讲解顺序揭示；对照项如果需要同时比较，就在同一组出现。把标签和它解释的图、数值和单位放在一起。背景、装饰、重复页眉和用于定位的标题通常保持静态。不要为凑效果数量让每个元素轮流飞入。

按实际对象 id 编组。groups 的先后就是播放顺序，组内同时出现。讲者需要停下来解释的环节选 on-click，连续展示同一个观点时可用 after-previous。常规入场选 fade，逐步揭示流程或变化趋势时可选 wipe，有明确移动方向时才用 fly。

选择切入本页时的转场。通常用平稳的 fade，前后页有明确推进关系或章节转换时可用 push 或 wipe。若用对象入场已经足够，可将 transition 设为 none；若无需分步揭示，可只用转场。用户选择了添加动效，每个需处理的页面至少提供一组入场或一种可添加的转场。

motion 的结构严格为 {"transition":"fade","groups":[{"ids":["actual-object-id"],"effect":"fade","trigger":"on-click"}]}。transition 只允许 none、fade、push、wipe；effect 只允许 fade、wipe、fly；trigger 只允许 on-click、after-previous。同一对象整页最多出现一次，静态对象不列入 groups。不要输出声音、自动翻页、脚本、XML 或任何想象出来的对象。
