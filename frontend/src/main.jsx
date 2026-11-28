import React from "react";
import ReactDOM from "react-dom/client";
import { Analytics } from "@vercel/analytics/react";
import App from "./App";
import PwaInstallDialog from "./components/PwaInstallDialog";
import "./index.css";

if (import.meta.env.PROD && window.isSecureContext && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Installation is optional; the online workspace can still open normally.
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
    <PwaInstallDialog />
    <Analytics />
  </React.StrictMode>
);
