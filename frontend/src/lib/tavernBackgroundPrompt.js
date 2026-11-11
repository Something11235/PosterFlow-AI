import { buildTavernImagePrompt } from './tavernImageTemplates.js';

// Quick background creation uses the same saved Chinese template as the editor.
export function buildTavernBackgroundPrompt(character, session, templates = {}) {
  return buildTavernImagePrompt('background', character, session, { templates });
}
