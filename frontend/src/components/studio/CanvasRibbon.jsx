import { useId } from "react";

// Project a twisted strip onto the screen. Both sets of lines share the same surface.
function ribbonPoint(u, v) {
  const envelope = Math.sin(Math.PI * u) ** 0.75;
  const angle = u * Math.PI * 2.85 - 0.54;
  const width = envelope * (45 + 12 * Math.sin(Math.PI * u));
  const fold = (1 - v * v) * Math.sin(angle) * 0.54;
  const center = 124 - 25 * u + 19 * Math.sin(2.75 * Math.PI * u + 0.45);
  const x = 80 + 539 * u + width * v * Math.sin(angle) * 0.47;
  const y = center + width * (v * Math.cos(angle) + fold);
  return `${x.toFixed(1)} ${y.toFixed(1)}`;
}

function curve(count, point) {
  return Array.from({ length: count }, (_, i) => (i ? "L" : "M") + point(i / (count - 1))).join(" ");
}

const threads = Array.from({ length: 31 }, (_, i) => curve(85, u => ribbonPoint(u, i / 15 - 1)));
const crossLines = Array.from({ length: 65 }, (_, i) => curve(13, t => ribbonPoint((i + 1) / 66, t * 2 - 1)));
const ribbonEdge = threads[0] + " " + curve(85, u => ribbonPoint(1 - u, 1)).replace(/^M/, "L") + " Z";
const frames = [
  { x: 124, y: 72, width: 93, height: 104, label: "分镜", color: "#6edeeb" },
  { x: 305, y: 49, width: 110, height: 120, label: "视频", color: "#a9baff" },
  { x: 491, y: 33, width: 103, height: 117, label: "尾帧续镜", color: "#f7b597" },
];
const projectFrame = ({ x, y }) => `matrix(0.91 -0.22 0.12 1 ${x} ${y})`;

export default function CanvasRibbon() {
  const id = useId();
  const paint = name => `url(#${id}-${name})`;
  return <svg className="studio-canvas-ribbon" viewBox="0 0 660 226" fill="none" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={id + "-spectrum"} gradientUnits="userSpaceOnUse" x1="72" x2="620" y1="125" y2="89">
        <stop stopColor="#4b96c6" /><stop offset=".21" stopColor="#80fff0" /><stop offset=".41" stopColor="#64a8ff" />
        <stop offset=".55" stopColor="#a5a3ff" /><stop offset=".71" stopColor="#eac0e2" />
        <stop offset=".86" stopColor="#ffb694" /><stop offset="1" stopColor="#ffdab2" />
      </linearGradient>
      <radialGradient id={id + "-light"}>
        <stop stopColor="#6298ff" stopOpacity=".13" /><stop offset=".66" stopColor="#4776ba" stopOpacity=".04" /><stop offset="1" stopColor="#4776ba" stopOpacity="0" />
      </radialGradient>
      <pattern id={id + "-dots"} width="16" height="16" patternUnits="userSpaceOnUse">
        <circle cx="1" cy="1" r=".9" fill="#708ba7" />
      </pattern>
      <radialGradient id={id + "-falloff"}><stop offset=".38" stopColor="white" /><stop offset="1" stopColor="black" /></radialGradient>
      <mask id={id + "-dot-mask"}><ellipse cx="333" cy="115" rx="327" ry="107" fill={paint("falloff")} /></mask>
      <g id={id + "-threads"}>{threads.map((d, i) => <path key={i} d={d} opacity={0.50 + 0.43 * Math.abs(Math.cos(i * 0.15))} />)}</g>
      <linearGradient id={id + "-glint"}>
        <stop stopColor="#edffff" stopOpacity="0" /><stop offset=".6" stopColor="#edffff" stopOpacity=".96" /><stop offset="1" stopColor="#edffff" stopOpacity="0" />
      </linearGradient>
      <mask id={id + "-thread-mask"} maskUnits="userSpaceOnUse" x="65" y="0" width="570" height="190">
        <use href={"#" + id + "-threads"} fill="none" stroke="white" strokeWidth="1.8" />
      </mask>
    </defs>
    <ellipse cx="339" cy="112" rx="309" ry="108" fill={paint("light")} />
    <rect width="660" height="226" opacity=".32" fill={paint("dots")} mask={paint("dot-mask")} />

    <g stroke="#86a2bc" strokeWidth="1.25" strokeLinejoin="round">
      <path d="M38 91H51Q57 91 60 98L72 124Q75 131 83 131M38 166H49Q55 166 59 158L70 138Q73 132 83 132" opacity=".68" />
      <rect x="13.5" y="79.5" width="25" height="23" rx="5" fill="#121f2e" />
      <path d="M19 95.5l4-5 3 3 3.5-4 4 6" /><circle cx="22" cy="86" r="1.3" fill="#9bbdd1" stroke="none" />
      <rect x="13.5" y="154.5" width="25" height="23" rx="5" fill="#121f2e" />
      <path d="M20.5 162.5h11m-5.5 0v8m-3 0h6" />
    </g>

    {frames.map(frame => <g key={frame.label} transform={projectFrame(frame)} stroke={frame.color}>
      <rect x="-4" y="4" width={frame.width} height={frame.height} rx="5" strokeOpacity=".19" fill="#111b2a" />
      <rect width={frame.width} height={frame.height} rx="5" strokeOpacity=".57" fill={frame.color} fillOpacity=".065" />
      <path d={`M0 12h${frame.width} M0 ${frame.height-9}h${frame.width}`} strokeOpacity=".24" />
      {[8, 15, 22].map(x => <rect key={x} x={x} y="5" width="3.5" height="2" fill={frame.color} fillOpacity=".78" stroke="none" />)}
    </g>)}

    <g strokeLinejoin="round" strokeLinecap="round">
      <path d={ribbonEdge} fill={paint("spectrum")} fillOpacity=".20" />
      <g stroke={paint("spectrum")} strokeWidth=".65" opacity=".38">{crossLines.map((d, i) => <path key={i} d={d} />)}</g>
      <use href={"#" + id + "-threads"} stroke={paint("spectrum")} strokeWidth="1.08" />
      <path d={threads[0]} stroke={paint("spectrum")} strokeWidth="1.65" />
      <path d={threads[30]} stroke={paint("spectrum")} strokeWidth="1.65" />
      <g mask={paint("thread-mask")} fill={paint("glint")}>
        <rect className="studio-canvas-glint" width="158" height="190" />
        <rect className="studio-canvas-glint studio-canvas-glint-replay" width="158" height="190" />
      </g>
    </g>

    {frames.map(({ x, y, height, width, label, color }) => <g key={label}>
      <g transform={projectFrame({ x, y })} stroke={color}>
        <path d={`M${width-14} 0h9q5 0 5 5v10 M0 ${height-14}v9q0 5 5 5h9`} strokeWidth="1.8" />
      </g>
      <circle cx={x + width / 2} cy="195" r="2.4" fill={color} />
      <text x={x + width / 2} y="215" textAnchor="middle" className="studio-canvas-stage-label">{label}</text>
    </g>)}
    <path d="M619 105h18m-4-4 4 4-4 4" stroke="#e8ccb5" strokeWidth="1.1" />
    <path d="M179 195H351m19 0h161" stroke="#68768a" strokeOpacity=".6" strokeDasharray="2 5" />
  </svg>;
}
