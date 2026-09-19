import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./themes.css";
import "./index.css";
import "./play/play.css";
import "./start/start.css";
import { App } from "./app/App";

const apiUrl =
  (import.meta.env.VITE_API_URL as string | undefined) || undefined;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App apiUrl={apiUrl} />
  </StrictMode>,
);
