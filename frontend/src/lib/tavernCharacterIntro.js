const instructionLine = /^(?:[#<>{}[【`]|\/\/|system\b|assistant\s*:|you (?:must|should|are (?:to|an? (?:ai|assistant|language model)))\b|(?:always|never|ignore|output|respond)\b|(?:系统提示|角色指令|以下规则|请扮演|你必须|禁止输出|输出格式))/iu;
const scriptSyntax = /\{\{[^}]+\}\}|javascript\s*:|=>|\b(?:function|const|let|var)\s+\w+\s*[=(]|\b(?:alert|eval|fetch|document\.\w+|window\.\w+)\s*\(|\b[\w.-]+\([^)]*\)\s*;|&(?:lt|gt|#\d+);/iu;

// Work on strings only. Parsing untrusted biographies into browser DOM nodes
// could fetch images that were included by the card's author.
export function introProse(value, characterName, limit) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const text = value.slice(0, 6000)
    .replace(/```[\s\S]*?(?:```|$)/g, '\n')
    .replace(/<(script|style|iframe|svg|template|system(?:_prompt)?|instructions)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<\/?(?:p|div|br|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]*\)/gi, '$1')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/{{\s*char\s*}}/gi, () => characterName)
    .replace(/{{\s*user\s*}}/gi, '你');
  const lines = text.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !instructionLine.test(line) && !scriptSyntax.test(line));
  const readable = lines.join(' ').replace(/\*{1,3}|_{2,3}/g, '').replace(/\s+/g, ' ').trim();
  if (readable.length <= limit) return readable;
  const prefix = Array.from(readable).slice(0, limit).join('');
  const fullSentences = prefix.match(/^[\s\S]*[。！？.!?](?=\s|$|[\p{Script=Han}])/u)?.[0];
  return fullSentences?.length >= limit / 2 ? fullSentences : prefix.trimEnd() + '…';
}

export function characterOverview(character, limit = 260) {
  const name = character.name;
  return introProse(character.introduction?.overview, name, limit)
    || introProse(character.description, name, limit)
    || introProse(character.scenario, name, limit)
    || '这张角色卡暂无简短介绍。';
}
