import { createFileRoute } from "@tanstack/react-router";
import EventWorkspace, { type EventLoad } from "~/components/EventWorkspace";
import { getEventByCode } from "~/lib/vantage";

export const Route = createFileRoute("/e/$code")({
  component: JoinEvent,
  loader: async ({ params }): Promise<EventLoad> => {
    const res = await getEventByCode({ data: { code: params.code } });
    return res as EventLoad;
  },
});

function JoinEvent() {
  const { code } = Route.useParams();
  const initial = Route.useLoaderData();
  return <EventWorkspace initial={initial} shareCode={code.toUpperCase()} />;
}
