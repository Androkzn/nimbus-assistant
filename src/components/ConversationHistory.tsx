"use client";

import type { ConversationSummary } from "@/shared/history";
import { CloseIcon, HistoryIcon, TrashIcon } from "./icons";

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function ConversationHistory({
  open,
  conversations,
  activeId,
  loading,
  onClose,
  onSelect,
  onDelete,
}: {
  open: boolean;
  conversations: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-navy/60 backdrop-blur-[2px]" onClick={onClose} aria-hidden />}
      <aside
        id="chat-history"
        aria-label="Chat history"
        className={`fixed inset-y-0 left-0 z-40 flex w-[min(360px,88vw)] flex-col bg-navy text-on-navy shadow-2xl transition-[translate,visibility] duration-200 ease-out ${open ? "translate-x-0" : "-translate-x-full invisible"}`}
      >
        <div className="flex items-center justify-between border-b border-navy-3 px-5 py-5">
          <div className="flex items-center gap-2.5">
            <HistoryIcon className="text-orange" />
            <h2 className="font-display text-base font-bold">Chat history</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close chat history" className="grid h-9 w-9 place-items-center rounded-lg text-lg text-on-navy-muted transition-colors hover:bg-navy-2 hover:text-orange">
            <CloseIcon />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <p className="px-2 py-4 text-sm text-on-navy-muted">Loading saved conversations…</p>
          ) : conversations.length === 0 ? (
            <div className="rounded-xl border border-dashed border-navy-3 px-4 py-5 text-sm text-on-navy-muted">
              <p className="font-semibold text-on-navy">No saved conversations yet.</p>
              <p className="mt-1">Your completed chats will appear here.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {conversations.map((item) => (
                <li key={item.id} className={`flex items-center gap-2 rounded-xl border p-2 transition-colors ${item.id === activeId ? "border-orange/70 bg-orange/10" : "border-navy-3 bg-navy-2 hover:border-orange/50"}`}>
                  <button type="button" onClick={() => onSelect(item.id)} className="min-w-0 flex-1 px-2 py-1.5 text-left">
                    <span className="block truncate text-sm font-semibold">{item.title}</span>
                    <span className="mt-1 block text-xs text-on-navy-muted">{formatDate(item.updatedAt)} · {item.messageCount} messages</span>
                  </button>
                  <button type="button" onClick={() => onDelete(item.id)} aria-label={`Delete ${item.title}`} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-on-navy-muted transition-colors hover:bg-red/20 hover:text-red">
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
