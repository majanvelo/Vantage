import { createFileRoute } from "@tanstack/react-router";
import EventWorkspace, { type EventLoad } from "~/components/EventWorkspace";
import { getEvent } from "~/lib/vantage";

export const Route = createFileRoute("/event/$id")({
  component: EventPage,
  loader: async ({ params }): Promise<EventLoad> => {
    const res = await getEvent({ data: { id: params.id } });
    return res as EventLoad;
  },
});

function EventPage() {
  const initial = Route.useLoaderData();
  const shareCode = initial.ok ? initial.event.share_code : "";
  return <EventWorkspace initial={initial} shareCode={shareCode} />;
}
