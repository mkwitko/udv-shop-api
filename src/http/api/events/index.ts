import type { FastifyPluginAsync } from "fastify";
import { archiveEventRoute } from "./archive-event/archive-event.controller.js";
import { checkInRoute } from "./check-in/check-in.controller.js";
import { createEventRoute } from "./create-event/create-event.controller.js";
import { getEventRoute } from "./get-event/get-event.controller.js";
import { listAttendeesRoute } from "./list-attendees/list-attendees.controller.js";
import { listEventResultsRoute } from "./list-event-results/list-event-results.controller.js";
import { listEventsRoute } from "./list-events/list-events.controller.js";
import { listStoreEventsRoute } from "./list-store-events/list-store-events.controller.js";
import { restoreEventRoute } from "./restore-event/restore-event.controller.js";
import { updateEventRoute } from "./update-event/update-event.controller.js";

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listEventsRoute);
  await app.register(listStoreEventsRoute);
  await app.register(listEventResultsRoute);
  await app.register(getEventRoute);
  await app.register(createEventRoute);
  await app.register(updateEventRoute);
  await app.register(archiveEventRoute);
  await app.register(restoreEventRoute);
  await app.register(listAttendeesRoute);
  await app.register(checkInRoute);
};
