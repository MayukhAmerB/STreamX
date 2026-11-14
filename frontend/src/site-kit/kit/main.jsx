// Dev-only entry for the component gallery (see index.html next to it).
import React from "react";
import ReactDOM from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import "../../styles/fonts.css";
import "../../styles/tokens.css";
import KitGallery from "./KitGallery";

const params = new URLSearchParams(window.location.search);
if (params.get("motion") === "reduce") document.documentElement.dataset.motion = "reduce";
if (params.get("radius")) document.documentElement.style.setProperty("--sc-radius-surface", `${Number(params.get("radius")) || 0}px`);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <MemoryRouter>
      <KitGallery section={params.get("section")} />
    </MemoryRouter>
  </React.StrictMode>
);
