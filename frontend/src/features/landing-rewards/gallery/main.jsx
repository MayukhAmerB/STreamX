// Dev-only entry for the insignia gallery at /__insignia (see index.html next to it). OWNER: WS-LEARN.
import React from "react";
import ReactDOM from "react-dom/client";

import "../../../styles/fonts.css";
import "../../../index.css";
import InsigniaGallery from "./InsigniaGallery";

const params = new URLSearchParams(window.location.search);
if (params.get("motion") === "reduce") document.documentElement.dataset.motion = "reduce";
document.body.style.background = "#000";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <InsigniaGallery section={params.get("section")} />
  </React.StrictMode>
);
