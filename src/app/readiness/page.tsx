import { ReadinessReport } from "@/components/readiness/ReadinessReport";
import { parseReadinessOptions } from "@/components/readiness/options";

/**
 * /readiness — the header's Readiness button opens /readiness?autostart=1 in a new window.
 * Query: autostart=1 · mode=local|replay|probes · speed=1|4|instant · answer=1 · probes=0.
 */
export default async function ReadinessPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const options = parseReadinessOptions(await searchParams);
  return <ReadinessReport options={options} />;
}
