"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type {
  KnowledgeBasePayload,
  KnowledgeDocument,
  KnowledgeDocumentStatus,
  KnowledgeReport,
  KnowledgeReportCategory,
  KnowledgeReportSeverity,
  KnowledgeReportStatus,
} from "@/shared/knowledgeBase";
import { AlertIcon, CheckIcon, ChevronRightIcon, DocIcon, PlusIcon } from "./icons";

const EMPTY: KnowledgeBasePayload = { documents: [], reports: [], stats: { documentCount: 0, publishedCount: 0, newIssuesToday: 0, observationsToday: 0 } };
type PortalTab = "knowledge-base" | "issues";
type IssueTypeFilter = "auto" | "all" | KnowledgeReportCategory;
type IssuePriorityFilter = "all" | KnowledgeReportSeverity;
type IssueStatusFilter = "all" | KnowledgeReportStatus;

const ISSUE_TYPE_LABELS: Record<KnowledgeReportCategory, string> = {
  readiness: "Readiness",
  "knowledge-gap": "Knowledge gap",
  manual: "Manual",
  irrelevant: "Irrelevant",
};

function announcePortalChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("nimbus-knowledge-base");
  channel.postMessage({ type: "knowledge-base-updated" });
  channel.close();
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function localDateValue(value: string): string {
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function todayInputValue(): string {
  return localDateValue(new Date().toISOString());
}

export function KnowledgeBasePortal() {
  const [data, setData] = useState<KnowledgeBasePayload>(EMPTY);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [documentProduct, setDocumentProduct] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<KnowledgeDocumentStatus>("published");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [reportTitle, setReportTitle] = useState("");
  const [reportSummary, setReportSummary] = useState("");
  const [reportProduct, setReportProduct] = useState("");
  const [reportCategory, setReportCategory] = useState<KnowledgeReportCategory>("manual");
  const [reportSeverity, setReportSeverity] = useState<KnowledgeReportSeverity>("medium");
  const [activeTab, setActiveTab] = useState<PortalTab>("issues");
  const [issueType, setIssueType] = useState<IssueTypeFilter>("auto");
  const [issuePriority, setIssuePriority] = useState<IssuePriorityFilter>("all");
  const [issueStatus, setIssueStatus] = useState<IssueStatusFilter>("all");
  const [issueProduct, setIssueProduct] = useState("all");
  const [issueDateFrom, setIssueDateFrom] = useState(todayInputValue);
  const [issueDateTo, setIssueDateTo] = useState(todayInputValue);

  async function refresh(preferredId?: string) {
    const response = await fetch("/api/dev/knowledge-base", { cache: "no-store" });
    if (!response.ok) return;
    const next = (await response.json()) as KnowledgeBasePayload;
    setData(next);
    const id = preferredId ?? selectedId ?? next.documents[0]?.id ?? "";
    const selected = next.documents.find((document) => document.id === id) ?? next.documents[0];
    if (selected) {
      setSelectedId(selected.id);
      setTitle(selected.title);
      setDocumentProduct(selected.product ?? "");
      setContent(selected.content);
      setStatus(selected.status);
    } else {
      setSelectedId("");
      setTitle("");
      setDocumentProduct("");
      setContent("");
      setStatus("draft");
    }
  }

  useEffect(() => {
    void fetch("/api/dev/knowledge-base", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<KnowledgeBasePayload>) : null))
      .then((next) => {
        if (!next) return;
        setData(next);
        const first = next.documents[0];
        if (first) {
          setSelectedId(first.id);
          setTitle(first.title);
          setDocumentProduct(first.product ?? "");
          setContent(first.content);
          setStatus(first.status);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const refreshCounters = () => {
      void fetch("/api/dev/knowledge-base", { cache: "no-store" })
        .then((response) => (response.ok ? (response.json() as Promise<KnowledgeBasePayload>) : null))
        .then((next) => {
          if (next) setData(next);
        })
        .catch(() => undefined);
    };
    const interval = window.setInterval(refreshCounters, 5000);
    window.addEventListener("focus", refreshCounters);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshCounters);
    };
  }, []);

  const selected = useMemo(() => data.documents.find((document) => document.id === selectedId), [data.documents, selectedId]);

  const issueTypeCounts = useMemo(() => ({
    all: data.reports.length,
    readiness: data.reports.filter((report) => report.category === "readiness").length,
    "knowledge-gap": data.reports.filter((report) => report.category === "knowledge-gap").length,
    manual: data.reports.filter((report) => report.category === "manual").length,
    irrelevant: data.reports.filter((report) => report.category === "irrelevant").length,
  }), [data.reports]);

  const visibleIssueTypes = useMemo(
    () => (Object.keys(ISSUE_TYPE_LABELS) as KnowledgeReportCategory[]).filter((type) => issueTypeCounts[type] > 0),
    [issueTypeCounts],
  );
  const selectedIssueType: IssueTypeFilter =
    issueType === "auto" || (issueType !== "all" && issueTypeCounts[issueType] === 0) ? visibleIssueTypes[0] ?? "all" : issueType;

  const filteredReports = useMemo(() => {
    const priorityOrder: Record<KnowledgeReportSeverity, number> = { high: 0, medium: 1, low: 2 };
    return data.reports
      .filter((report) => selectedIssueType === "all" || report.category === selectedIssueType)
      .filter((report) => issuePriority === "all" || report.severity === issuePriority)
      .filter((report) => issueStatus === "all" || report.status === issueStatus)
      .filter((report) => issueProduct === "all" || report.product === issueProduct)
      .filter((report) => {
        const detectedDate = localDateValue(report.detectedAt);
        return (!issueDateFrom || detectedDate >= issueDateFrom) && (!issueDateTo || detectedDate <= issueDateTo);
      })
      .sort((a, b) => priorityOrder[a.severity] - priorityOrder[b.severity] || new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
  }, [data.reports, issueDateFrom, issueDateTo, issuePriority, issueProduct, issueStatus, selectedIssueType]);

  function selectDocument(document: KnowledgeDocument) {
    setSelectedId(document.id);
    setTitle(document.title);
    setDocumentProduct(document.product ?? "");
    setContent(document.content);
    setStatus(document.status);
    setMessage("");
  }

  async function saveDocument(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    const response = await fetch(selected ? `/api/dev/knowledge-base/documents/${selected.id}` : "/api/dev/knowledge-base/documents", {
      method: selected ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, product: documentProduct || null, content, status }),
    });
    setSaving(false);
    if (!response.ok) {
      setMessage(selected ? "We couldn't save this document. Please try again." : "We couldn't create this document. Please try again.");
      return;
    }
    const saved = (await response.json()) as KnowledgeDocument;
    setMessage(selected ? "Saved to the dev database." : "Created in the dev database.");
    announcePortalChange();
    await refresh(saved.id);
  }

  function startNewDocument() {
    setSelectedId("");
    setTitle("");
    setDocumentProduct("");
    setContent("");
    setStatus("draft");
    setMessage("New document");
  }

  async function removeDocument() {
    if (!selected || !window.confirm(`Delete “${selected.title}”? This cannot be undone.`)) return;
    const response = await fetch(`/api/dev/knowledge-base/documents/${selected.id}`, { method: "DELETE" });
    if (!response.ok) {
      setMessage("We couldn't delete this document. Please try again.");
      return;
    }
    setMessage("Document deleted.");
    announcePortalChange();
    await refresh();
  }

  async function createReport(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/dev/knowledge-base", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: reportTitle, summary: reportSummary, product: reportProduct || null, category: reportCategory, severity: reportSeverity }),
    });
    if (!response.ok) {
      setMessage("We couldn't add that report. Please try again.");
      return;
    }
    setReportTitle("");
    setReportSummary("");
    setReportProduct("");
    setReportCategory("manual");
    setReportSeverity("medium");
    announcePortalChange();
    await refresh();
  }

  async function updateReport(report: KnowledgeReport, changes: Partial<Pick<KnowledgeReport, "category" | "severity" | "status" | "product">>) {
    const response = await fetch(`/api/dev/knowledge-base/reports/${report.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: report.status, severity: report.severity, category: report.category, product: report.product, ...changes }),
    });
    if (response.ok) {
      announcePortalChange();
      await refresh();
    }
  }

  return (
    <div className="min-h-dvh bg-canvas text-text">
      <header className="brand-glow flex min-h-16 items-center justify-between gap-4 border-b border-navy-3 bg-navy px-4 text-on-navy sm:px-8">
        <div className="flex items-center gap-3">
          <Link href="/" className="rounded-lg p-1 text-on-navy-muted transition hover:text-orange" aria-label="Back to assistant">
            <ChevronRightIcon className="rotate-180 text-xl" />
          </Link>
          <div><p className="font-display text-sm font-semibold">NimbusStack</p><p className="text-[10px] font-semibold tracking-[0.18em] text-on-navy-muted uppercase">Knowledge portal · Dev</p></div>
        </div>
        <span className="rounded-full border border-green-500/40 bg-green-50 px-3 py-1 text-xs font-semibold text-green-700">Shared database · live counters</span>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8 lg:py-12">
        <div className="mb-8 max-w-3xl"><p className="mb-3 text-xs font-bold tracking-[0.2em] text-orange-ink uppercase">Content operations</p><h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Knowledge base portal</h1><p className="mt-3 text-base leading-relaxed text-muted">Update approved product documents and keep a clear trail of issues found during review. Changes here feed the dev assistant after publication.</p></div>

        <section className="mb-6 grid gap-3 sm:grid-cols-3" aria-label="Knowledge base summary">
          <Stat label="Documents" value={data.stats.documentCount} detail="in the shared database" icon={<DocIcon />} />
          <Stat label="Published" value={data.stats.publishedCount} detail="available to the assistant" icon={<CheckIcon />} />
          <Stat label="Detections today" value={data.stats.observationsToday} detail={`${data.stats.newIssuesToday} open issues`} icon={<AlertIcon />} accent />
        </section>

        <div role="tablist" aria-label="Portal sections" className="mb-8 grid gap-2 rounded-2xl border border-border bg-surface-2 p-2 sm:grid-cols-2">
          <PortalTabButton active={activeTab === "issues"} onClick={() => setActiveTab("issues")} icon={<AlertIcon />} label="Issues" detail={`${data.stats.observationsToday} detections today`} count={data.reports.length} />
          <PortalTabButton active={activeTab === "knowledge-base"} onClick={() => setActiveTab("knowledge-base")} icon={<DocIcon />} label="Knowledge base" detail={`${data.stats.publishedCount} published documents`} />
        </div>

        {activeTab === "knowledge-base" && <div className="grid gap-6 xl:grid-cols-[minmax(250px,0.75fr)_minmax(0,1.7fr)]">
          <section className="rounded-2xl border border-border bg-surface shadow-sm">
            <div className="border-b border-border px-5 py-4"><div className="flex items-center justify-between gap-3"><div><h2 className="font-display text-base font-bold">Documents</h2><p className="mt-1 text-xs text-muted">Select a document to edit</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-muted">{data.documents.length}</span><button type="button" data-testid="new-document" onClick={startNewDocument} className="rounded-lg bg-orange-strong px-3 py-2 text-xs font-semibold text-white transition hover:bg-orange-deep">New document</button></div></div></div>
            <div className="divide-y divide-border">{data.documents.map((document) => <button type="button" key={document.id} onClick={() => selectDocument(document)} className={`flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition ${document.id === selectedId ? "bg-orange-soft" : "hover:bg-surface-2"}`}><span className="min-w-0"><span className="block truncate text-sm font-semibold">{document.title}</span><span className="mt-1 block truncate text-xs text-muted">{document.file}</span></span><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-bold uppercase ${document.status === "published" ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" : "bg-amber-soft text-amber"}`}>{document.status}</span></button>)}</div>
          </section>

          <form onSubmit={saveDocument} className="rounded-2xl border border-border bg-surface shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-6"><div><p className="text-xs font-bold tracking-[0.16em] text-orange-ink uppercase">Document editor</p><h2 className="mt-1 font-display text-lg font-bold">{selected?.file ?? (title ? "New document" : "Select or create a document")}</h2></div><div className="flex flex-wrap items-end gap-3"><label className="text-xs font-semibold text-muted">Product<select aria-label="Document product" value={documentProduct} onChange={(event) => setDocumentProduct(event.target.value)} className="mt-1 block rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text"><option value="">All products</option><option value="relay">Relay</option><option value="vault">Vault</option><option value="pulse">Pulse</option><option value="ledger">Ledger</option></select></label><label className="text-xs font-semibold text-muted">Publication status<select value={status} onChange={(event) => setStatus(event.target.value as KnowledgeDocumentStatus)} className="mt-1 block rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text"><option value="published">Published</option><option value="draft">Draft</option></select></label>{selected && <button type="button" onClick={() => void removeDocument()} className="rounded-lg border border-red/30 px-3 py-2 text-xs font-semibold text-red transition hover:bg-red-soft">Delete</button>}</div></div>
            <div className="space-y-4 px-5 py-5 sm:px-6"><label className="block text-sm font-semibold">Document title<input required value={title} onChange={(event) => setTitle(event.target.value)} className="mt-2 block w-full rounded-xl border border-border bg-surface-2 px-3 py-2.5 font-normal outline-none focus:border-orange-strong" /></label><label className="block text-sm font-semibold">Markdown content<textarea required value={content} onChange={(event) => setContent(event.target.value)} className="mt-2 block min-h-[390px] w-full resize-y rounded-xl border border-border bg-surface-2 px-3 py-3 font-mono text-xs leading-relaxed outline-none focus:border-orange-strong" /></label><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted">{message || (selected ? `Last updated ${dateLabel(selected.updatedAt)}` : "")}</p><button type="submit" disabled={saving || (!selected && !title.trim())} className="inline-flex items-center gap-2 rounded-xl bg-orange-strong px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-deep disabled:cursor-not-allowed disabled:opacity-50"><CheckIcon /> {saving ? "Saving…" : selected ? "Save document" : "Create document"}</button></div></div>
          </form>
        </div>}

        {activeTab === "issues" && <section className="rounded-2xl border border-border bg-surface shadow-sm">
          <div className="border-b border-border px-5 py-5 sm:px-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-bold tracking-[0.16em] text-orange-ink uppercase">Improvements control center</p><h2 className="mt-1 font-display text-xl font-bold">Review reports</h2><p className="mt-1 max-w-xl text-sm text-muted">Prioritize what needs attention, inspect the evidence, and move each improvement through review.</p></div><span className="inline-flex items-center gap-2 rounded-full bg-orange-soft px-3 py-1.5 text-xs font-bold text-orange-ink"><AlertIcon /> {data.stats.observationsToday} detected today</span></div>
            <div role="tablist" aria-label="Issue type" className="mt-5 flex flex-wrap gap-2">
              {visibleIssueTypes.map((type) => <IssueTypeTab key={type} label={ISSUE_TYPE_LABELS[type]} value={type} count={issueTypeCounts[type]} active={selectedIssueType === type} onClick={() => setIssueType(type)} />)}
              <IssueTypeTab label="All issues" value="all" count={issueTypeCounts.all} active={selectedIssueType === "all"} onClick={() => setIssueType("all")} />
            </div>
          </div>
          <div className="grid gap-6 px-5 py-5 sm:px-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(260px,0.65fr)]"><div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-3 py-3"><div><p className="text-xs font-bold text-text">{filteredReports.length} {filteredReports.length === 1 ? "issue" : "issues"} shown</p><p className="mt-0.5 text-xs text-muted">Sorted by priority and newest first</p></div><div className="flex flex-wrap items-end gap-2"><label className="text-[11px] font-semibold text-muted">From<input type="date" aria-label="Filter issues from date" value={issueDateFrom} onChange={(event) => setIssueDateFrom(event.target.value)} className="mt-1 block rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-semibold text-text" /></label><label className="text-[11px] font-semibold text-muted">To<input type="date" aria-label="Filter issues to date" value={issueDateTo} onChange={(event) => setIssueDateTo(event.target.value)} className="mt-1 block rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-semibold text-text" /></label><select aria-label="Filter issues by priority" value={issuePriority} onChange={(event) => setIssuePriority(event.target.value as IssuePriorityFilter)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-semibold"><option value="all">All priorities</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option></select><select aria-label="Filter issues by status" value={issueStatus} onChange={(event) => setIssueStatus(event.target.value as IssueStatusFilter)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-semibold"><option value="all">All statuses</option><option value="new">New</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option></select><select aria-label="Filter issues by product" value={issueProduct} onChange={(event) => setIssueProduct(event.target.value)} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs font-semibold"><option value="all">All products</option><option value="relay">Relay</option><option value="vault">Vault</option><option value="pulse">Pulse</option><option value="ledger">Ledger</option></select></div></div>
            {data.reports.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-surface-2 px-5 py-8 text-center"><p className="text-sm font-semibold">No review reports yet</p><p className="mt-1 text-xs text-muted">Create the first issue from the form to start a review trail.</p></div> : filteredReports.length === 0 ? <div className="rounded-xl border border-dashed border-border bg-surface-2 px-5 py-8 text-center"><p className="text-sm font-semibold">No issues match these filters</p><p className="mt-1 text-xs text-muted">Try another priority, status, product, or date.</p></div> : filteredReports.map((report) => <ReportRow key={report.id} report={report} onUpdate={updateReport} />)}
          </div><form onSubmit={createReport} className="rounded-xl border border-border bg-surface-2 p-4"><div className="mb-4 flex items-center gap-2"><PlusIcon className="text-orange-ink" /><h3 className="font-display text-sm font-bold">Log an issue</h3></div><div className="space-y-3"><input required value={reportTitle} onChange={(event) => setReportTitle(event.target.value)} placeholder="Issue title" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-orange-strong" /><div className="grid gap-3 sm:grid-cols-3"><select aria-label="Issue product" value={reportProduct} onChange={(event) => setReportProduct(event.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted"><option value="">All products</option><option value="relay">Relay</option><option value="vault">Vault</option><option value="pulse">Pulse</option><option value="ledger">Ledger</option></select><select aria-label="Issue type" value={reportCategory} onChange={(event) => setReportCategory(event.target.value as KnowledgeReportCategory)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"><option value="manual">Manual</option><option value="readiness">Readiness</option><option value="knowledge-gap">Knowledge gap</option><option value="irrelevant">Irrelevant</option></select><select aria-label="Issue priority" value={reportSeverity} onChange={(event) => setReportSeverity(event.target.value as KnowledgeReportSeverity)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></div><textarea required value={reportSummary} onChange={(event) => setReportSummary(event.target.value)} placeholder="What needs attention?" className="min-h-24 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-orange-strong" /><button type="submit" className="w-full rounded-lg border border-orange-strong bg-orange-soft px-3 py-2 text-sm font-semibold text-orange-ink transition hover:bg-orange-line">Add report</button></div></form></div>
        </section>}
      </main>
    </div>
  );
}

function Stat({ label, value, detail, icon, accent = false }: { label: string; value: number; detail: string; icon: ReactNode; accent?: boolean }) {
  return <div className="rounded-2xl border border-border bg-surface px-5 py-4 shadow-sm"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold text-muted">{label}</p><p className="mt-2 font-display text-3xl font-bold tracking-tight">{value}</p><p className="mt-1 text-xs text-muted">{detail}</p></div><span className={`grid h-9 w-9 place-items-center rounded-xl ${accent ? "bg-orange-soft text-orange-ink" : "bg-surface-2 text-muted"}`}>{icon}</span></div></div>;
}

function PortalTabButton({ active, onClick, icon, label, detail, count }: { active: boolean; onClick: () => void; icon: ReactNode; label: string; detail: string; count?: number }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`flex items-center gap-3 rounded-xl px-4 py-3 text-left transition ${active ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-muted hover:bg-surface/70 hover:text-text"}`}><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${active ? "bg-orange-soft text-orange-ink" : "bg-surface text-muted"}`}>{icon}</span><span className="min-w-0"><span className="flex items-center gap-2 text-sm font-bold">{label}{typeof count === "number" && <span className="rounded-full bg-orange-soft px-1.5 py-0.5 text-[10px] text-orange-ink">{count}</span>}</span><span className="mt-0.5 block text-xs text-muted">{detail}</span></span></button>;
}

function IssueTypeTab({ label, value, count, active, onClick }: { label: string; value: IssueTypeFilter; count: number; active: boolean; onClick: () => void }) {
  const color = value === "readiness" ? "text-orange-ink" : value === "knowledge-gap" ? "text-amber" : value === "manual" ? "text-muted" : "text-red";
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${active ? "border-orange-strong bg-orange-soft text-orange-ink" : "border-border bg-surface text-muted hover:border-orange-line hover:text-text"}`}><span className={active ? "text-orange-ink" : color}>{label}</span><span className={`ml-2 rounded-full px-1.5 py-0.5 ${active ? "bg-surface text-orange-ink" : "bg-surface-2 text-muted"}`}>{count}</span></button>;
}

function ReportRow({ report, onUpdate }: { report: KnowledgeReport; onUpdate: (report: KnowledgeReport, changes: Partial<Pick<KnowledgeReport, "category" | "severity" | "status" | "product">>) => void }) {
  const categoryLabel: Record<KnowledgeReportCategory, string> = { manual: "Manual", readiness: "Readiness", "knowledge-gap": "Knowledge gap", irrelevant: "Irrelevant" };
  return <article className="rounded-xl border border-border bg-surface px-4 py-4 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">{report.title}</h3><span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase text-muted">{categoryLabel[report.category]}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${report.severity === "high" ? "bg-red-soft text-red" : report.severity === "medium" ? "bg-amber-soft text-amber" : "bg-surface-2 text-muted"}`}>{report.severity}</span></div><p className="mt-2 text-sm leading-relaxed text-muted">{report.summary}</p>{report.question && <div className="mt-4 rounded-lg border border-border bg-surface-2 px-3 py-3"><p className="text-[11px] font-bold tracking-[0.12em] text-orange-ink uppercase">Question</p><p className="mt-1 text-sm leading-relaxed text-text">{report.question}</p>{report.analysis && <><p className="mt-3 text-[11px] font-bold tracking-[0.12em] text-orange-ink uppercase">Analysis · why the assistant could not answer</p><p className="mt-1 text-sm leading-relaxed text-muted">{report.analysis}</p></>}</div>}</div><div className="flex flex-wrap items-center gap-2"><select aria-label={`Type for ${report.title}`} value={report.category} onChange={(event) => void onUpdate(report, { category: event.target.value as KnowledgeReportCategory })} className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-semibold"><option value="manual">Manual</option><option value="readiness">Readiness</option><option value="knowledge-gap">Knowledge gap</option><option value="irrelevant">Irrelevant</option></select><select aria-label={`Priority for ${report.title}`} value={report.severity} onChange={(event) => void onUpdate(report, { severity: event.target.value as KnowledgeReportSeverity })} className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-semibold"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select><select aria-label={`Status for ${report.title}`} value={report.status} onChange={(event) => void onUpdate(report, { status: event.target.value as KnowledgeReportStatus })} className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-semibold"><option value="new">New</option><option value="investigating">Investigating</option><option value="resolved">Resolved</option></select><select aria-label={`Product for ${report.title}`} value={report.product ?? ""} onChange={(event) => void onUpdate(report, { product: event.target.value || null })} className="rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-xs font-semibold"><option value="">All products</option><option value="relay">Relay</option><option value="vault">Vault</option><option value="pulse">Pulse</option><option value="ledger">Ledger</option></select></div></div><div className="mt-3 text-[11px] text-muted"><span>{report.product ? `${report.product} · ` : "All products · "}{dateLabel(report.detectedAt)}</span></div></article>;
}
