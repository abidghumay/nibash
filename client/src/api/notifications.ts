import { apiClient } from "./client";

export interface InboxMessage {
  id: number;
  contract_id: number;
  payment_id: number | null;
  kind: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface InboxPage {
  notifications: InboxMessage[];
  nextCursor: number | null;
}

export function getInbox(unread: boolean, before?: number, signal?: AbortSignal) {
  const query = new URLSearchParams({ unread: String(unread) });
  if (before !== undefined) query.set("before",String(before));
  return apiClient.get<InboxPage>(`/notifications?${query}`, { signal });
}

export function notifyInboxChanged() {
  window.dispatchEvent(new Event("nibash:inbox-changed"));
}

export async function setMessageRead(id: number,read: boolean) {
  const result = await apiClient.patch<{ notification: { id: number; read_at: string | null } }>(`/notifications/${id}`,{read});
  notifyInboxChanged();
  return result.notification;
}

export async function markInboxRead() {
  await apiClient.patch("/notifications/read-all");
  notifyInboxChanged();
}
