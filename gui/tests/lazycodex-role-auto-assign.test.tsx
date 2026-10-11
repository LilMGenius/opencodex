import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;

let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let mountCount = 0;
let apiBase = "";
let requests: Array<{ method: string; url: string; body: unknown }> = [];
let roleRows: Array<{ role: string; model: string | null; effort: string | null; omoJsoncModel: null }>;
let omoWriteStatus = "written";
let rolesHold: Promise<void> | null = null;
let rolesFailure = false;

const PROPOSALS = {
  sizingModel: "gpt-5.5",
  sizingError: null,
  proposals: [
    { role: "explorer", model: "gpt-5.5", effort: "high", status: "proposed", tier: "fast", effortIntent: "glance", rationale: "Read-only search.", moveUpIf: "It edits.", moveDownIf: "Never.", proposedModel: "a/small", proposedEffort: "low", reason: null },
    { role: "worker", model: null, effort: null, status: "proposed", tier: "standard", effortIntent: "measured", rationale: "Writes code.", moveUpIf: "Cross-module.", moveDownIf: "Renames only.", proposedModel: "a/mid", proposedEffort: null, reason: null },
    { role: "vague", model: null, effort: null, status: "unsized", reason: "the sizing model did not answer with JSON" },
  ],
  candidates: [],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#integrations/codex" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    sessionStorage: { configurable: true, value: testWindow.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountCount += 1;
  apiBase = `http://ocx-lazycodex-auto-${mountCount}.invalid`;
  requests = [];
  omoWriteStatus = "written";
  rolesHold = null;
  rolesFailure = false;
  roleRows = [
    { role: "explorer", model: "gpt-5.5", effort: "high", omoJsoncModel: null },
    { role: "vague", model: null, effort: null, omoJsoncModel: null },
    { role: "worker", model: null, effort: null, omoJsoncModel: null },
  ];
  const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (method !== "GET") requests.push({ method, url, body: JSON.parse(String(init?.body)) });
    if (url.endsWith("/auto-assign")) return json(PROPOSALS);
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body));
      const role = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      roleRows = roleRows.map(row => row.role === role ? {
        ...row, model: body.model, effort: Object.hasOwn(body, "effort") ? body.effort : row.effort,
      } : row);
      return json({ ok: true, toml: { status: "written" }, omoJsonc: { status: omoWriteStatus } });
    }
    if (url.endsWith("/api/subagent-models")) return json({ available: ["gpt-5.5", "a/small", "a/mid"] });
    if (url.endsWith("/api/injection-model")) return json({ efforts: ["low", "high"] });
    if (rolesFailure) return json({ error: "unavailable" }, 500);
    if (rolesHold) await rolesHold;
    return json({
      lazycodex: { detected: true, pluginEnabled: true, pluginInstalled: true },
      omoJsonc: { state: "present" },
      roles: roleRows,
    });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mockFetch });
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

async function settle(): Promise<void> {
  await act(async () => { await new Promise<void>(resolve => testWindow.setTimeout(resolve, 30)); });
}

async function mount(): Promise<void> {
  const [{ createRoot }, { LanguageProvider }, { default: LazyCodexRoleModels }] = await Promise.all([
    import("react-dom/client"),
    import("../src/i18n/provider"),
    import("../src/pages/integrations/LazyCodexRoleModels"),
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<LanguageProvider><LazyCodexRoleModels apiBase={apiBase} active /></LanguageProvider>);
  });
  await settle();
}

function button(label: string, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(node => node.textContent === label);
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

function proposal(role: string): HTMLElement {
  return container.querySelector(`[aria-label="Proposal for ${role}"]`) as HTMLElement;
}

async function click(node: HTMLButtonElement): Promise<void> {
  await act(async () => { node.click(); });
  await settle();
}

test("auto-assign shows proposals for review and writes nothing until a row is applied", async () => {
  await mount();
  await click(button("Auto-assign"));
  expect(requests).toEqual([{ method: "POST", url: `${apiBase}/api/codex-agent-roles/auto-assign`, body: {} }]);
  expect(container.textContent).toContain("Sized with gpt-5.5");
  expect(proposal("explorer").textContent).toContain("a/small · low");
  expect(proposal("explorer").textContent).toContain("Fast tier, glance effort");
  expect(proposal("explorer").textContent).toContain("Move up if: It edits.");
  expect(proposal("vague").textContent).toContain("Not sized: the sizing model did not answer with JSON");
  expect(proposal("vague").querySelector("button")).toBeNull();

  await click(button("Apply", proposal("explorer")));
  expect(requests.slice(1)).toEqual([
    { method: "PUT", url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "a/small", effort: "low" } },
  ]);
  expect(proposal("explorer").textContent).toContain("Applied");
});

test("apply all writes each remaining proposal once and skips unsized roles", async () => {
  await mount();
  await click(button("Auto-assign"));
  await click(button("Apply all"));
  expect(requests.slice(1)).toEqual([
    { method: "PUT", url: `${apiBase}/api/codex-agent-roles/explorer`, body: { model: "a/small", effort: "low" } },
    { method: "PUT", url: `${apiBase}/api/codex-agent-roles/worker`, body: { model: "a/mid" } },
  ]);
  expect(container.textContent).toContain("Applied 2 of 2 proposals.");
  expect(button("Apply all").disabled).toBe(true);
});

test("applying an empty-ladder proposal omits effort and preserves the existing role pin", async () => {
  roleRows = roleRows.map(row => row.role === "worker" ? { ...row, model: "gpt-5.5", effort: "high" } : row);
  const previous = PROPOSALS.proposals[1]!;
  PROPOSALS.proposals[1] = { ...previous, model: "gpt-5.5", effort: "high" };
  try {
    await mount();
    await click(button("Auto-assign"));
    expect(proposal("worker").textContent).toContain("a/mid");
    const apply = [...proposal("worker").querySelectorAll("button")].find(node => node.textContent === "Apply")!;
    await click(apply as HTMLButtonElement);
    expect(requests.filter(request => request.method === "PUT")).toEqual([
      { method: "PUT", url: `${apiBase}/api/codex-agent-roles/worker`, body: { model: "a/mid" } },
    ]);
    expect(roleRows.find(row => row.role === "worker")).toEqual({ role: "worker", model: "a/mid", effort: "high", omoJsoncModel: null });
    expect(container.textContent).toContain("a/mid · high");
  } finally {
    PROPOSALS.proposals[1] = previous;
  }
});

for (const reload of ["pending", "failed"] as const) {
  test(`an empty-ladder proposal keeps the pinned effort on mirror retry after a ${reload} reload`, async () => {
    roleRows = roleRows.map(row => row.role === "worker" ? { ...row, model: "gpt-5.5", effort: "high" } : row);
    const previous = PROPOSALS.proposals[1]!;
    PROPOSALS.proposals[1] = { ...previous, model: "gpt-5.5", effort: "high" };
    let release = () => {};
    try {
      await mount();
      await click(button("Auto-assign"));
      omoWriteStatus = "write_failed";
      if (reload === "pending") rolesHold = new Promise<void>(resolve => { release = resolve; });
      else rolesFailure = true;
      await click(button("Apply", proposal("worker")));
      const effortPicker = container.querySelector('[aria-label="Reasoning effort (worker)"]')!;
      expect(effortPicker.textContent).toContain("high");
      expect(container.textContent).toContain("worker now runs on a/mid · high");
      const retry = button("Retry omo.jsonc", effortPicker.closest("tr")!);
      expect(retry.disabled).toBe(false);
      omoWriteStatus = "written";
      await click(retry);
      expect(requests.filter(request => request.method === "PUT").map(request => request.body)).toEqual([
        { model: "a/mid" }, { model: "a/mid" },
      ]);
      expect(roleRows.find(row => row.role === "worker")?.effort).toBe("high");
    } finally {
      rolesFailure = false;
      await act(async () => { release(); });
      await settle();
      PROPOSALS.proposals[1] = previous;
    }
  });
}

test("a proposal that matches the role's current model and effort is shown as already set", async () => {
  PROPOSALS.proposals[0] = { ...PROPOSALS.proposals[0]!, model: "a/small", effort: "low" };
  try {
    await mount();
    await click(button("Auto-assign"));
    expect(proposal("explorer").textContent).toContain("Already set");
    expect(proposal("explorer").querySelector("button")).toBeNull();
    await click(button("Apply all"));
    expect(requests.slice(1).map(r => r.url)).toEqual([`${apiBase}/api/codex-agent-roles/worker`]);
  } finally {
    PROPOSALS.proposals[0] = { ...PROPOSALS.proposals[0]!, model: "gpt-5.5", effort: "high" };
  }
});
