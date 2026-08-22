import type { FastifyPluginAsync } from "fastify";
import { checkInRoute } from "./check-in/check-in.controller.js";
import { listAttendeesRoute } from "./list-attendees/list-attendees.controller.js";
import { listEventsRoute } from "./list-events/list-events.controller.js";

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(listEventsRoute);
  await app.register(listAttendeesRoute);
  await app.register(checkInRoute);
};
