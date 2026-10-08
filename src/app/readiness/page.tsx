import { notFound } from "next/navigation";
import { ReadinessReport } from "@/components/readiness/ReadinessReport";
import { parseReadinessOptions } from "@/components/readiness/options";

/**
 * /readiness — the header's Readiness button opens /readiness?autostart=1 in a new window.
 * Query: autostart=1 · mode=local|replay|probes · speed=1|4|instant · probes=0.
 */
export default async function ReadinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NEXT_PUBLIC_DEV_SURFACE !== "1" && process.env.NEXT_PUBLIC_VERCEL_ENV === "production") notFound();
  const options = parseReadinessOptions(await searchParams);
  return <ReadinessReport options={options} />;
}
