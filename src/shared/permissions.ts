export const PERSONAS = [
  "platform_admin",
  "store_owner",
  "store_admin",
  "store_staff",
  "customer",
] as const;
export type Persona = (typeof PERSONAS)[number];

const ROLE_TO_PERSONA: Record<string, Persona> = {
  owner: "store_owner",
  admin: "store_admin",
  staff: "store_staff",
};

export function personasOf(user: {
  platformAdmin: boolean;
  roles: Record<string, string>;
}): Set<Persona> {
  const set = new Set<Persona>(["customer"]);
  if (user.platformAdmin) set.add("platform_admin");
  for (const role of Object.values(user.roles)) {
    const persona = ROLE_TO_PERSONA[role];
    if (persona) set.add(persona);
  }
  return set;
}
