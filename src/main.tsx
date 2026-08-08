import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./site.css";
import "./play/play.css";
import PlayApp from "./play/PlayApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PlayApp />
  </StrictMode>,
);
