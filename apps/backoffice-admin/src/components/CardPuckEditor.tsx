"use client";

import "@puckeditor/core/puck.css";
import React, { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Puck, createUsePuck, useGetPuck } from "@puckeditor/core";
import { ActionProvider, StateProvider } from "@json-render/react";
import { tokensToCssVars, type CardType, type ThemeTokens } from "@journeyax/ui-cards";
import { CardRenderer } from "@journeyax/ui-cards/react";
import type { Spec } from "@json-render/core";
import { puckConfig } from "../lib/cardPuck/config";
import { restoreElement, schemaElements, type SchemaElement } from "../lib/cardPuck/dropInsert";
import { puckDataToSpec, type PuckData } from "../lib/cardPuck/specAdapter";
import { sampleStateFor } from "../lib/cardSampleState";

const usePuckSelector = createUsePuck();

type EditorMode = "components" | "paint";
type DragSession = { key: string; label: string; homeKey: string; x: number; y: number } | null;
const EditorModeContext = React.createContext<{
  mode: EditorMode;
  setMode: (mode: EditorMode) => void;
  elements: SchemaElement[];
  drag: DragSession;
  setDrag: (drag: DragSession) => void;
}>({ mode: "paint", setMode: () => {}, elements: [], drag: null, setDrag: () => {} });

/** True when the pointer is inside the schema container this element belongs to. */
function pointerInHome(x: number, y: number, stage: HTMLElement, homeKey: string): boolean {
  const el = document.elementFromPoint(x, y);
  if (!(el instanceof Element) || !stage.contains(el)) return false;
  let node: Element | null = el;
  while (node && node !== stage) {
    if (node.getAttribute("data-jx-id") === homeKey) return true;
    node = node.parentElement;
  }
  return false;
}

function SidebarTabs({ children }: { children: React.ReactNode }) {
  const { mode, setMode, elements, drag, setDrag } = useContext(EditorModeContext);

  function beginDrag(element: SchemaElement, event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const session = { key: element.key, label: element.label, homeKey: element.homeKey };
    const move = (e: PointerEvent) => setDrag({ ...session, x: e.clientX, y: e.clientY });
    const up = (e: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      window.dispatchEvent(new CustomEvent("jx-card-drop", { detail: { ...session, x: e.clientX, y: e.clientY } }));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    setDrag({ ...session, x: event.clientX, y: event.clientY });
  }

  return (
    <div className="cards-theme-side">
      <div className="cards-theme-side-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "components"} className={mode === "components" ? "on" : ""} onClick={() => setMode("components")}>Components</button>
        <button type="button" role="tab" aria-selected={mode === "paint"} className={mode === "paint" ? "on" : ""} onClick={() => setMode("paint")}>Paint</button>
      </div>
      {mode === "components" ? (
        <div className="cards-theme-side-blocks" data-testid="editor-components-tab">
          {elements.map((element) => (
            <button key={element.key} type="button" className="cards-theme-drag-item" data-testid={`editor-drag-${element.key}`} onPointerDown={(e) => beginDrag(element, e)}>
              {element.label}
            </button>
          ))}
        </div>
      ) : (
        <div data-testid="editor-paint-tab">{children}</div>
      )}
      {drag && typeof document !== "undefined"
        ? createPortal(<div className="cards-theme-drag-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>{drag.label}</div>, document.body)
        : null}
    </div>
  );
}

/** Puck auto-fits a wide viewport, so the menu opens at 75%. Keep 100% until the user changes zoom. */
function useDefaultZoom() {
  useEffect(() => {
    const host = document.querySelector<HTMLElement>(".cards-theme-puck-host");
    if (!host) return;
    host.setAttribute("data-zoom-lock", "");
    let locked = true;
    let selectObs: MutationObserver | null = null;
    const showHundred = () => {
      if (!locked) return;
      const select = host.querySelector<HTMLSelectElement>("select[class*='zoomSelect']");
      if (!select) return;
      if (![...select.options].some((o) => o.value === "1")) select.add(new Option("100%", "1"));
      if (select.value !== "1") select.value = "1";
      if (!selectObs) {
        selectObs = new MutationObserver(showHundred);
        selectObs.observe(select, { attributes: true, childList: true });
      }
    };
    const unlock = (e: Event) => {
      const t = e.target as Element | null;
      if (!t?.closest("select[class*='zoomSelect'], button[title^='Zoom']")) return;
      locked = false;
      host.removeAttribute("data-zoom-lock");
      selectObs?.disconnect();
    };
    host.addEventListener("pointerdown", unlock, true);
    showHundred();
    const wait = window.setInterval(showHundred, 200);
    const stop = window.setTimeout(() => window.clearInterval(wait), 2000);
    return () => {
      host.removeEventListener("pointerdown", unlock, true);
      selectObs?.disconnect();
      window.clearInterval(wait);
      window.clearTimeout(stop);
    };
  }, []);
}

/** Copy of the spec with a stable id on each element so a click can select it in Puck. Never saved. */
function specForGallery(data: PuckData): Spec {
  const spec = puckDataToSpec(data);
  const elements: Spec["elements"] = {};
  for (const [key, el] of Object.entries(spec.elements)) {
    elements[key] = { ...el, props: { ...(el.props || {}), __jxId: key } };
  }
  return { ...spec, elements };
}

function EditorPreview({
  cardType, tokens, settings,
}: {
  cardType: CardType;
  tokens: ThemeTokens;
  settings?: Record<string, unknown>;
  children?: React.ReactNode;
}) {
  return (
    <div className="cards-theme-preview-stack">
      <GalleryCanvas cardType={cardType} tokens={tokens} settings={settings} />
    </div>
  );
}

function GalleryCanvas({
  cardType, tokens, settings,
}: {
  cardType: CardType;
  tokens: ThemeTokens;
  settings?: Record<string, unknown>;
}) {
  const { mode, drag, elements } = useContext(EditorModeContext);
  const data = usePuckSelector((s) => s.appState.data);
  const selectedItem = usePuckSelector((s) => s.selectedItem);
  const getPuck = useGetPuck();
  const stageRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const [removeAt, setRemoveAt] = useState<{ key: string; top: number; left: number } | null>(null);
  const spec = useMemo(() => specForGallery(data as PuckData), [data]);
  const selectedKey = (selectedItem as { props?: { jxId?: string } } | null)?.props?.jxId;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.querySelectorAll("[data-jx-drop-home]").forEach((el) => el.removeAttribute("data-jx-drop-home"));
    if (!drag) return;
    stage.querySelectorAll(`[data-jx-id="${CSS.escape(drag.homeKey)}"]`).forEach((el) => el.setAttribute("data-jx-drop-home", "true"));
  }, [drag]);

  useEffect(() => {
    const onDrop = (event: Event) => {
      const detail = (event as CustomEvent<DragSession>).detail;
      const stage = stageRef.current;
      if (!detail || !stage) return;
      if (!pointerInHome(detail.x, detail.y, stage, detail.homeKey)) return;
      const element = elementsRef.current.find((el) => el.key === detail.key);
      if (!element) return;
      const next = restoreElement(dataRef.current as PuckData, element);
      if (!next) return;
      getPuck().dispatch({ type: "setData", data: () => next });
      setRemoveAt(null);
    };
    window.addEventListener("jx-card-drop", onDrop);
    return () => window.removeEventListener("jx-card-drop", onDrop);
  }, [getPuck]);

  useLayoutEffect(() => {
    const root = stageRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>("[data-jx-id]").forEach((el) => {
      if (selectedKey && el.getAttribute("data-jx-id") === selectedKey) el.setAttribute("data-jx-selected", "true");
      else el.removeAttribute("data-jx-selected");
    });
  }, [selectedKey, spec]);

  function markHover(target: EventTarget | null) {
    const root = stageRef.current;
    if (!root) return;
    if (target instanceof Element && target.closest("[data-jx-remove]")) return;
    root.querySelectorAll("[data-jx-hover]").forEach((el) => el.removeAttribute("data-jx-hover"));
    const hit = target instanceof Element && root.contains(target) ? target.closest("[data-jx-id]") : null;
    if (!hit) {
      setRemoveAt(null);
      return;
    }
    hit.setAttribute("data-jx-hover", "true");
    const key = hit.getAttribute("data-jx-id");
    if (mode !== "components" || drag || !key) {
      setRemoveAt(null);
      return;
    }
    const box = (hit.firstElementChild || hit).getBoundingClientRect();
    const host = root.getBoundingClientRect();
    setRemoveAt((prev) => prev?.key === key ? prev : { key, top: box.top - host.top + 6, left: box.right - host.left - 6 });
  }

  function removeHovered() {
    if (!removeAt) return;
    const { dispatch, getSelectorForId } = getPuck();
    const selector = getSelectorForId(`jx-${removeAt.key}`);
    if (selector) dispatch({ type: "remove", index: selector.index, zone: selector.zone });
    setRemoveAt(null);
  }

  return (
    <div
      ref={stageRef}
      className="jx-root cards-theme-puck-stage"
      data-testid="editor-gallery-canvas"
      style={{ ...(tokensToCssVars(tokens) as unknown as React.CSSProperties), background: "var(--jx-color-bg)" }}
      onMouseOver={(e) => markHover(e.target)}
      onMouseLeave={(e) => {
        const next = e.relatedTarget;
        if (next instanceof Element && next.closest("[data-jx-remove]")) return;
        markHover(null);
      }}
      onClick={(e) => {
        const hit = (e.target as HTMLElement).closest("[data-jx-id]");
        if (!hit) return;
        const key = hit.getAttribute("data-jx-id");
        if (!key) return;
        const { dispatch, getSelectorForId } = getPuck();
        const selector = getSelectorForId(`jx-${key}`);
        if (selector) dispatch({ type: "setUi", ui: { itemSelector: selector } });
        e.stopPropagation();
      }}
    >
      <CardRenderer template={spec} state={sampleStateFor(cardType)} settings={settings} stateKey={cardType} onAction={() => {}} />
      {removeAt && !drag ? (
        <button
          type="button"
          data-jx-remove
          className="cards-theme-remove"
          style={{ top: removeAt.top, left: removeAt.left }}
          aria-label="Delete"
          title="Delete"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); removeHovered(); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm-2.2 6h1.2l.7 11h6.6l.7-11h1.2l-.8 12.1a1 1 0 0 1-1 .9H8.6a1 1 0 0 1-1-.9L6.8 9z" />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

export function CardPuckEditor({
  cardType, data, onChange, tokens, settings,
}: {
  cardType: CardType;
  data: PuckData;
  onChange: (data: PuckData) => void;
  tokens: ThemeTokens;
  settings?: Record<string, unknown>;
}) {
  const sampleState = { ...sampleStateFor(cardType), settings: settings || {} };
  const [mode, setMode] = useState<EditorMode>("paint");
  const [elements] = useState(() => schemaElements(data.content));
  const [drag, setDrag] = useState<DragSession>(null);
  useDefaultZoom();
  return (
    <EditorModeContext.Provider value={{ mode, setMode, elements, drag, setDrag }}>
      <StateProvider initialState={sampleState}>
        <ActionProvider>
          <div className="cards-theme-puck-host" data-editor-mode={mode} data-testid="editor-puck-canvas" style={{ height: "100%", minHeight: 0 }}>
            <Puck
              config={puckConfig}
              data={data}
              onChange={(d) => onChange(d as PuckData)}
              iframe={{ enabled: true, waitForStyles: false }}
              metadata={{ sampleState, cardType }}
              ui={{
                leftSideBarVisible: false,
                viewports: {
                  current: { width: "100%", height: "auto" },
                  options: [],
                  controlsVisible: true,
                },
              }}
              permissions={{ insert: true, duplicate: false, delete: false }}
              overrides={{
                header: () => <div className="cards-theme-puck-header-stub" />,
                preview: ({ children }) => (
                  <EditorPreview cardType={cardType} tokens={tokens} settings={settings}>{children}</EditorPreview>
                ),
                fields: ({ children }) => <SidebarTabs>{children}</SidebarTabs>,
              }}
            />
          </div>
        </ActionProvider>
      </StateProvider>
    </EditorModeContext.Provider>
  );
}
