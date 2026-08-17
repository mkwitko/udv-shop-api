import { Prisma, type PrismaClient } from "@prisma/client";

export async function storeWebhookEvent(
  db: PrismaClient,
  input: {
    provider: "stripe" | "woovi";
    eventId: string;
    type: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<boolean> {
  try {
    await db.webhookEvent.create({ data: input });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}
