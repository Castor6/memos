import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { readEditorSource } from "@/lib/editor-page";
import { initializeLocalePreference, localizeDocument } from "@/lib/i18n";
import "@/index.css";
import "./editor.css";
import { App } from "./App";

async function renderPopup(): Promise<void> {
  await initializeLocalePreference();
  localizeDocument("popupDocumentTitle");

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <App source={readEditorSource(window.location.search)} />
      </ThemeProvider>
    </StrictMode>,
  );
}

void renderPopup();
