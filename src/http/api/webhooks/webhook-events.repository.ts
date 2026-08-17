import { Prisma, type PrismaClient } from "@prisma/client";

export async function storeWebhookEvent(
  db: PrismaClient,
  input: {
    provider: "stripe" | "woovi";
    eventId: string;
    type: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<{ id: string } | null> {
  try {
    const event = await db.webhookEvent.create({ data: input });
    return { id: event.id };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}
