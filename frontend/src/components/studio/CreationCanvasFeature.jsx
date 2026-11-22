import React from "react";
import { ArrowUpRight } from "lucide-react";
import CanvasRibbon from "./CanvasRibbon";
import "./creation-canvas-feature.css";

export default function CreationCanvasFeature({ onOpen }) {
  return <section className="studio-canvas-feature" aria-labelledby="canvas-feature-title">
    <div className="studio-canvas-feature-copy">
      <h2 id="canvas-feature-title"><button className="studio-canvas-feature-open" type="button" onClick={onOpen}>AI 创作画布</button></h2>
      <p>连接参考图与提示词，生成分镜和视频。<br />提取尾帧，接着拍下一镜。</p>
    </div>
    <CanvasRibbon />
    <span className="studio-card-arrow" aria-hidden="true"><ArrowUpRight size={18} /></span>
  </section>;
}
