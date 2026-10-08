import { notFound } from "next/navigation";
import { KnowledgeBasePortal } from "@/components/KnowledgeBasePortal";
import { devPortalEnabled } from "@/server/dev-portal/db";

export default function KnowledgeBasePage() {
  if (!devPortalEnabled()) notFound();
  return <KnowledgeBasePortal />;
}
