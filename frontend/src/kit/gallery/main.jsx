// Dev-only entry for the kit gallery at /__kit (see index.html next to it). OWNER: WS-KIT.
import React from "react";
import ReactDOM from "react-dom/client";

import "../../styles/fonts.css";
import "../../index.css";
import KitGallery from "./KitGallery";

const params = new URLSearchParams(window.location.search);
if (params.get("motion") === "reduce") document.documentElement.dataset.motion = "reduce";
document.body.style.background = "#000";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <KitGallery section={params.get("section")} />
  </React.StrictMode>
);
