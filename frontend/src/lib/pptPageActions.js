function slidePosition(project, page) {
  if (project.pending || project.generation?.status === "paused") throw new Error("请等当前任务结束后再更改页面。");
  const slides = project.deck?.slides || [];
  if (!slides.length && !page) return -1;
  const index = slides.findIndex(slide => slide.id === page?.id);
  if (index < 0 || JSON.stringify(slides[index]) !== JSON.stringify(page)) {
    throw new Error("这一页已在其他窗口更新，请重新选择后操作。");
  }
  return index;
}

function textColor(background) {
  const rgb = background.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  const [r, g, b] = rgb.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.18 ? "#FFFFFF" : "#101820";
}

export function insertPptPage(project, afterPage, { id, title, body }, maxPages = 16) {
  const index = slidePosition(project, afterPage);
  const slides = project.deck?.slides || [];
  if (slides.length >= maxPages) throw new Error(`每份演示稿最多支持 ${maxPages} 页。`);
  const template = project.template?.template;
  const base = afterPage?.background || template?.background;
  const background = /^#[0-9a-f]{6}$/i.test(base) ? base : "#FFFFFF";
  const color = textColor(background);
  const heading = title.trim() || "新幻灯片";
  const elements = [
    { id: "heading", type: "text", x: 80, y: 74, w: 1120, h: 120, text: heading, fontSize: 48, color, bold: true },
  ];
  if (body.trim()) {
    elements.push({ id: "body", type: "text", x: 80, y: 220, w: 1120, h: 430, text: body.trim(), fontSize: 30, color });
  }
  const page = { id, title: heading, background, elements };
  const deck = project.deck || { title: project.topic?.trim().slice(0, 240) || heading };
  return {
    ...project,
    deck: { ...deck, slides: [...slides.slice(0, index + 1), page, ...slides.slice(index + 1)] },
    deckFont: project.deck ? project.deckFont : template?.font || null,
    deckTemplate: project.deck ? project.deckTemplate : project.template?.file || project.template?.template || null,
  };
}

export function removePptPage(project, page) {
  const index = slidePosition(project, page);
  if (index < 0) throw new Error("当前演示稿中没有可删除的页面。");
  const slides = project.deck.slides.filter(slide => slide.id !== page.id);
  if (!slides.length) return { ...project, deck: null, deckFont: null, deckTemplate: null };
  return { ...project, deck: { ...project.deck, slides } };
}
