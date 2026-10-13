import { Docket } from "@/components/Docket";
import { docketSummary, listDocket } from "@/lib/queries/docket";

// Always reads live state. The docket is a queue with deadlines on it; a
// cached copy would show a case as open after it had already been filed.
export const dynamic = "force-dynamic";

export default async function DocketPage() {
  const [rows, summary] = await Promise.all([listDocket(), docketSummary()]);
  return <Docket rows={rows} summary={summary} />;
}
