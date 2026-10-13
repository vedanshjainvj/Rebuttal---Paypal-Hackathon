import Link from "next/link";
import { notFound } from "next/navigation";
import { CaseView } from "@/components/CaseView";
import { getCase } from "@/lib/queries/docket";
import styles from "./case.module.css";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: PageProps<"/disputes/[id]">) {
  const { id } = await params;
  const detail = await getCase(id);
  if (!detail) notFound();

  return (
    <article className={styles.case}>
      <Link href="/" className={styles.back}>
        Docket
      </Link>
      <CaseView detail={detail} />
    </article>
  );
}
