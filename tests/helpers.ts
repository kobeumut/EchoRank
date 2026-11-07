import { prisma } from "@/lib/db";

export const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

export function req(path: string, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json" },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

export async function resetDb() {
  // Cascades remove all child rows.
  await prisma.site.deleteMany();
}
