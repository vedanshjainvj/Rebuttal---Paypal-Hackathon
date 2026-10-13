import { Placeholder } from "@/components/Placeholder";

export default function TimelinePage() {
  return (
    <Placeholder
      title="Deadlines"
      intent="Every open case plotted against its PayPal response deadline, so nothing expires unnoticed."
      items={[
        "One bar per dispute, running to seller_response_due_date from the Disputes API",
        "Lanes grouped by lifecycle stage — inquiry, chargeback, pre-arbitration",
        "Drag a case to reschedule the internal review, never the PayPal deadline",
        "Built on Bryntum Scheduler",
      ]}
    />
  );
}
