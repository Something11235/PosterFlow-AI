import {IMAGE_MODEL_OPTIONS} from './provider.js';
import {MUSIC_MODELS,VIDEO_MODELS} from './studioCatalog.js';

export const MODEL_BADGE_GROUPS=[
  {value:'image',label:'图片模型',options:IMAGE_MODEL_OPTIONS},
  {value:'music',label:'音乐模型',options:MUSIC_MODELS.map(model=>({value:model.id,label:({suno:'Suno',flowmusic:'Flow Music'})[model.id] || model.name}))},
  {value:'video',label:'视频模型',options:VIDEO_MODELS.filter(model=>model.available).map(model=>({value:model.id,label:model.name}))},
];
export const MODEL_BADGE_OPTIONS=MODEL_BADGE_GROUPS.flatMap(group=>group.options);
